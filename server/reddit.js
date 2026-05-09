const db = require('./db');
const crypto = require('crypto');

// App-only token (for reading posts)
let appToken = null;
let appTokenExpiry = 0;

// User token (for posting comments) — stored in DB for persistence
const userAgent = process.env.REDDIT_USER_AGENT || 'reddit-lead-agent/1.0';

function getClientId() {
  return process.env.REDDIT_CLIENT_ID;
}

function getAuth() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be set in .env');
  }
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

// --- App-only auth (for reading) ---
async function getToken() {
  if (appToken && Date.now() < appTokenExpiry) return appToken;

  const auth = getAuth();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reddit app auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  appToken = data.access_token;
  appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return appToken;
}

// --- User OAuth (authorization code flow) ---
function getRedirectUri() {
  if (process.env.APP_URL) return `${process.env.APP_URL}/auth/reddit/callback`;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/auth/reddit/callback`;
}

function getAuthUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  db.setConfig('reddit_oauth_state', state);
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    state,
    redirect_uri: getRedirectUri(),
    duration: 'permanent',
    scope: 'submit identity',
  });
  return `https://www.reddit.com/api/v1/authorize?${params}`;
}

async function exchangeCode(code) {
  const auth = getAuth();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(getRedirectUri())}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reddit token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Reddit auth error: ${data.error}`);

  // Store tokens in DB
  db.setConfig('reddit_access_token', data.access_token);
  db.setConfig('reddit_refresh_token', data.refresh_token);
  db.setConfig('reddit_token_expiry', String(Date.now() + (data.expires_in - 60) * 1000));

  // Fetch username
  const me = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: { 'Authorization': `Bearer ${data.access_token}`, 'User-Agent': userAgent },
  });
  if (me.ok) {
    const meData = await me.json();
    db.setConfig('reddit_username', meData.name);
    console.log(`[Reddit] Logged in as u/${meData.name}`);
  }

  return data;
}

async function refreshUserToken() {
  const refreshToken = db.getConfig('reddit_refresh_token');
  if (!refreshToken) throw new Error('No Reddit refresh token. Please log in via /auth/reddit');

  const auth = getAuth();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reddit token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Reddit refresh error: ${data.error}`);

  db.setConfig('reddit_access_token', data.access_token);
  db.setConfig('reddit_token_expiry', String(Date.now() + (data.expires_in - 60) * 1000));
  console.log('[Reddit] User token refreshed');
  return data.access_token;
}

async function getUserToken() {
  const token = db.getConfig('reddit_access_token');
  const expiry = parseInt(db.getConfig('reddit_token_expiry') || '0', 10);

  if (token && Date.now() < expiry) return token;
  if (db.getConfig('reddit_refresh_token')) return await refreshUserToken();

  throw new Error('Not logged in to Reddit. Click "Login to Reddit" in Settings.');
}

function isUserAuthConfigured() {
  return !!db.getConfig('reddit_refresh_token');
}

function getUserInfo() {
  return {
    loggedIn: isUserAuthConfigured(),
    username: db.getConfig('reddit_username') || null,
  };
}

async function fetchSubredditPosts(subreddit, limit = 25) {
  const accessToken = await getToken();
  console.log(`Fetching r/${subreddit} with access token ${accessToken.slice(0, 6)}...`);
  const maxAgeHours = parseInt(db.getConfig('max_post_age_hours') || '48', 10);
  const cutoff = Date.now() / 1000 - maxAgeHours * 3600;

  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': process.env.REDDIT_USER_AGENT || 'reddit-lead-agent/1.0',
    },
  });

  if (!res.ok) {
    console.error(`Failed to fetch r/${subreddit}: ${res.status}`);
    return [];
  }

  const data = await res.json();
  const children = data?.data?.children || [];

  const posts = [];
  for (const child of children) {
    const d = child.data;
    if (d.created_utc < cutoff) continue;
    if (d.is_self === false && !d.selftext) continue; // skip link-only posts

    const post = {
      id: d.name, // e.g. t3_abc123
      subreddit: `r/${d.subreddit}`,
      title: d.title,
      body: (d.selftext || '').slice(0, 2000),
      url: `https://www.reddit.com${d.permalink}`,
      upvotes: d.ups,
      comments_count: d.num_comments,
    };

    if (!db.postExists(post.id)) {
      posts.push(post);
    }
  }

  return posts;
}

async function scanAllSubreddits() {
  const subs = JSON.parse(db.getConfig('subreddits') || '[]');
  const logId = db.createScanLog();
  let totalNew = 0;

  for (let i = 0; i < subs.length; i++) {
    try {
      const newPosts = await fetchSubredditPosts(subs[i]);
      for (const p of newPosts) {
        db.insertPost(p);
        totalNew++;
      }
    } catch (err) {
      console.error(`Error scanning r/${subs[i]}:`, err.message);
    }

    // Rate limit: wait 1.5s between subreddits
    if (i < subs.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  db.completeScanLog(logId, totalNew, subs.length);
  return { postsFound: totalNew, subredditsScanned: subs.length, logId };
}

async function postComment(postFullname, commentText) {
  const accessToken = await getUserToken();

  // postFullname is like "t3_abc123", Reddit API needs the thing_id
  const res = await fetch('https://oauth.reddit.com/api/comment', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: `thing_id=${encodeURIComponent(postFullname)}&text=${encodeURIComponent(commentText)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reddit comment failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Check for Reddit API errors in response
  if (data.json?.errors?.length) {
    const errors = data.json.errors.map(e => e.join(': ')).join('; ');
    throw new Error(`Reddit comment error: ${errors}`);
  }

  const commentData = data.json?.data?.things?.[0]?.data;
  console.log(`[Reddit] Comment posted on ${postFullname} — id: ${commentData?.name || 'unknown'}`);
  return commentData;
}

module.exports = { fetchSubredditPosts, scanAllSubreddits, postComment, isUserAuthConfigured, getAuthUrl, exchangeCode, getUserInfo };
