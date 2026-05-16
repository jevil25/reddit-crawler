const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'reddit_leads.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    subreddit TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    url TEXT NOT NULL,
    upvotes INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    score TEXT DEFAULT 'pending',
    score_reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    drafted_comment TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    scanned_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    posts_found INTEGER DEFAULT 0,
    subreddits_scanned INTEGER DEFAULT 0
  );
`);

// --- Seed defaults ---
const defaults = {
  subreddits: JSON.stringify([
    // High traffic dev/API/tools
    'programming',
    'webdev',
    'node',
    'Python',
    'javascript',
    'typescript',
    
    // Automation & no-code adjacent (higher traffic alternatives)
    'n8n',
    'zapier',
    'automation',
    'selfhosted',
    
    // Builder/founder communities
    'startups',
    'SideProject',
    'indiehackers',
    'EntrepreneurRideAlong',
    'microsaas',
    
    // API/messaging specific
    'chatbots',
    'botdevelopment',
    'twilio',   // devs looking for messaging alternatives

    // Broad tech
    'technology',
    'opensource'
  ]),
  product_url: 'whatsapp-messaging.retentionstack.agency',
  product_desc: 'A WhatsApp Messaging Bot API on RapidAPI that lets developers send messages, build bots, and automate WhatsApp workflows without the hassle of setting up their own infrastructure. The Mega plan offers 1,000,000 requests per month for just $100 USD.',
  comment_style: 'Be helpful and genuine. Answer their actual question first. Mention the API naturally at the end only if it directly solves their problem. No hard sell.',
  scan_interval: '0 */2 * * *',
  max_post_age_hours: '48'
};

const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaults)) {
  insertConfig.run(key, value);
}

// --- Helpers ---
const queries = {
  getConfig(key) {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setConfig(key, value) {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  },

  getAllConfig() {
    const rows = db.prepare('SELECT key, value FROM config').all();
    const cfg = {};
    for (const r of rows) cfg[r.key] = r.value;
    return cfg;
  },

  postExists(id) {
    return !!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
  },

  insertPost(post) {
    db.prepare(`
      INSERT OR IGNORE INTO posts (id, subreddit, title, body, url, upvotes, comments_count, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(post.id, post.subreddit, post.title, post.body, post.url, post.upvotes, post.comments_count);
  },

  getPosts({ status, subreddit, score } = {}) {
    let sql = 'SELECT * FROM posts WHERE 1=1';
    const params = [];
    if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
    if (subreddit && subreddit !== 'all') { sql += ' AND subreddit = ?'; params.push(subreddit); }
    if (score === 'high') { sql += " AND score = 'high'"; }
    else if (score === 'med') { sql += " AND score IN ('high','med')"; }
    sql += ' ORDER BY scanned_at DESC';
    return db.prepare(sql).all(...params);
  },

  getPost(id) {
    return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  },

  updatePost(id, fields) {
    const allowed = ['status', 'score', 'score_reason', 'drafted_comment'];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (!sets.length) return;
    params.push(id);
    db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
    const relevant = db.prepare("SELECT COUNT(*) as c FROM posts WHERE score IN ('high','med')").get().c;
    const approved = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status = 'approved'").get().c;
    const skipped = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status = 'skipped'").get().c;
    return { scanned: total, relevant, approved, skipped };
  },

  createScanLog() {
    const info = db.prepare("INSERT INTO scan_log (started_at) VALUES (datetime('now'))").run();
    return info.lastInsertRowid;
  },

  completeScanLog(id, postsFound, subredditsScanned) {
    db.prepare("UPDATE scan_log SET finished_at = datetime('now'), posts_found = ?, subreddits_scanned = ? WHERE id = ?")
      .run(postsFound, subredditsScanned, id);
  },

  getScanLogs(limit = 20) {
    return db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT ?').all(limit);
  }
};

module.exports = { db, ...queries };
