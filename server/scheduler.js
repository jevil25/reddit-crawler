const cron = require('node-cron');
const db = require('./db');
const { scanAllSubreddits } = require('./reddit');
const { scoreAndDraftPosts } = require('./openrouter');

let currentTask = null;
let isRunning = false;
let lastRun = null;

async function runScan() {
  if (isRunning) {
    console.log('[Scheduler] Scan already in progress, skipping');
    return { skipped: true };
  }

  isRunning = true;
  console.log('[Scheduler] Starting scan...');

  try {
    // 1. Fetch new posts from Reddit
    const scanResult = await scanAllSubreddits();
    console.log(`[Scheduler] Found ${scanResult.postsFound} new posts from ${scanResult.subredditsScanned} subreddits`);

    // 2. Score & draft comments for unscored posts
    const unscored = db.getPosts({ status: 'pending' })
      .filter(p => p.score === 'pending')
      .map(p => p.id);

    if (unscored.length > 0) {
      console.log(`[Scheduler] Scoring ${unscored.length} posts...`);
      await scoreAndDraftPosts(unscored);
    }

    lastRun = new Date().toISOString();
    return { ...scanResult, scored: unscored.length };
  } catch (err) {
    console.error('[Scheduler] Scan failed:', err.message);
    throw err;
  } finally {
    isRunning = false;
  }
}

function start() {
  const interval = db.getConfig('scan_interval') || '0 */2 * * *';

  if (currentTask) {
    currentTask.stop();
  }

  if (!cron.validate(interval)) {
    console.error(`[Scheduler] Invalid cron expression: ${interval}`);
    return;
  }

  currentTask = cron.schedule(interval, () => {
    runScan().catch(err => console.error('[Scheduler] Error:', err.message));
  });

  console.log(`[Scheduler] Started with interval: ${interval}`);
}

function restart() {
  start(); // start() already handles stopping the previous task
}

function getStatus() {
  return {
    running: isRunning,
    interval: db.getConfig('scan_interval') || '0 */2 * * *',
    lastRun,
    scheduled: !!currentTask,
  };
}

module.exports = { runScan, start, restart, getStatus };
