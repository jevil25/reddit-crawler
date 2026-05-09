const express = require('express');
const router = express.Router();
const db = require('../db');
const { scanAllSubreddits, postComment, isUserAuthConfigured, getAuthUrl, getUserInfo } = require('../reddit');
const { scoreAndDraftPosts, draftComment, scorePost } = require('../openrouter');
const scheduler = require('../scheduler');

// --- Posts ---
router.get('/posts', (req, res) => {
  const { status, subreddit, score } = req.query;
  const posts = db.getPosts({ status, subreddit, score });
  res.json(posts);
});

router.get('/posts/:id', (req, res) => {
  const post = db.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

router.patch('/posts/:id', async (req, res) => {
  const post = db.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const { status, drafted_comment } = req.body;
  const updates = {};
  if (status && ['pending', 'approved', 'skipped'].includes(status)) {
    updates.status = status;
  }
  if (typeof drafted_comment === 'string') {
    updates.drafted_comment = drafted_comment;
  }

  db.updatePost(req.params.id, updates);

  // Auto-post comment to Reddit when approved
  const updatedPost = db.getPost(req.params.id);
  if (status === 'approved' && updatedPost.drafted_comment) {
    if (!isUserAuthConfigured()) {
      return res.json({ ...updatedPost, post_warning: 'Comment approved but not posted — click "Login to Reddit" in Settings first' });
    }
    try {
      console.log(`[Reddit] Auto-posting comment on ${updatedPost.id}...`);
      await postComment(updatedPost.id, updatedPost.drafted_comment);
      console.log(`[Reddit] ✓ Comment posted on ${updatedPost.id}`);
      return res.json({ ...updatedPost, posted: true });
    } catch (err) {
      console.error(`[Reddit] ✗ Failed to post comment on ${updatedPost.id}:`, err.message);
      // Revert status since posting failed
      db.updatePost(req.params.id, { status: 'pending' });
      return res.status(500).json({ error: `Approved but posting failed: ${err.message}`, post: db.getPost(req.params.id) });
    }
  }

  res.json(updatedPost);
});

router.post('/posts/:id/draft', async (req, res) => {
  const post = db.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  try {
    const comment = await draftComment(post);
    db.updatePost(post.id, { drafted_comment: comment });
    res.json({ id: post.id, drafted_comment: comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/posts/:id/score', async (req, res) => {
  const post = db.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  try {
    const { score, reason } = await scorePost(post);
    db.updatePost(post.id, { score, score_reason: reason });
    res.json({ id: post.id, score, reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Scan ---
router.post('/scan', async (req, res) => {
  try {
    const result = await scheduler.runScan();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats ---
router.get('/stats', (req, res) => {
  res.json(db.getStats());
});

// --- Config ---
router.get('/config', (req, res) => {
  const cfg = db.getAllConfig();
  // Don't expose API keys
  res.json(cfg);
});

router.put('/config', (req, res) => {
  const allowed = ['subreddits', 'product_url', 'product_desc', 'comment_style', 'scan_interval', 'max_post_age_hours'];
  const body = req.body;

  for (const key of allowed) {
    if (body[key] !== undefined) {
      db.setConfig(key, typeof body[key] === 'string' ? body[key] : JSON.stringify(body[key]));
    }
  }

  // Restart scheduler if interval changed
  if (body.scan_interval) {
    scheduler.restart();
  }

  res.json(db.getAllConfig());
});

// --- Scan log ---
router.get('/scan-log', (req, res) => {
  res.json(db.getScanLogs());
});

// --- Scheduler status ---
router.get('/scheduler', (req, res) => {
  res.json(scheduler.getStatus());
});

// --- Reddit auth ---
router.get('/reddit-auth', (req, res) => {
  res.json(getUserInfo());
});

router.get('/reddit-auth/url', (req, res) => {
  res.json({ url: getAuthUrl() });
});

module.exports = router;
