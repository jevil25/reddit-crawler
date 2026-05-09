require('dotenv').config();
const express = require('express');
const path = require('path');
const apiRoutes = require('./routes/api');
const scheduler = require('./scheduler');
const { exchangeCode } = require('./reddit');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Reddit OAuth callback
app.get('/auth/reddit/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.send(`<h2>Reddit auth denied</h2><p>${error}</p><p><a href="/">Back to dashboard</a></p>`);
  }

  const savedState = db.getConfig('reddit_oauth_state');
  if (state !== savedState) {
    return res.status(400).send('<h2>Invalid state</h2><p>CSRF check failed. <a href="/">Try again</a></p>');
  }

  try {
    await exchangeCode(code);
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[Reddit] OAuth callback error:', err.message);
    res.status(500).send(`<h2>Auth failed</h2><p>${err.message}</p><p><a href="/">Back to dashboard</a></p>`);
  }
});

app.use('/api', apiRoutes);

// SPA fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Reddit Lead Agent running at http://localhost:${PORT}`);
  scheduler.start();
});
