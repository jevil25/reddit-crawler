# Reddit Lead Agent

Finds relevant Reddit posts for your product, uses AI to score relevance and draft helpful comments. You review, edit, and copy to post manually.

## Features

- **Reddit scanning** — Fetches new posts from configured subreddits via Reddit OAuth
- **AI relevance scoring** — Scores each post as high/med/low fit using OpenRouter (free model)
- **AI comment drafting** — Drafts genuine, helpful comments mentioning your product naturally
- **Cron scheduler** — Automatic scanning on a configurable interval (default: every 2 hours)
- **Dashboard** — Review queue, approve/skip posts, edit comments, copy to clipboard
- **SQLite persistence** — All data persists across restarts

## Setup

### 1. Clone & install

```bash
git clone <repo-url>
cd reddit-crawler
npm install
```

### 2. Create a Reddit app

1. Go to https://www.reddit.com/prefs/apps
2. Click "create another app..."
3. Choose **"script"** type
4. Set redirect URI to `http://localhost:3000` (not used, but required)
5. Note the **client ID** (under the app name) and **secret**

### 3. Get an OpenRouter API key

1. Go to https://openrouter.ai/keys
2. Create a free API key
3. The default model (`google/gemini-2.0-flash-exp:free`) has no cost

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=reddit-lead-agent/1.0
OPENROUTER_API_KEY=your_openrouter_key
PORT=3000
```

### 5. Start

```bash
npm start
```

Open http://localhost:3000

## Usage

1. **Configure** — Go to Settings tab, set your subreddits, product URL, description, and comment style
2. **Scan** — Click "Scan Reddit" or wait for the cron scheduler
3. **Score** — Click "Score" on unscored posts to get AI relevance ratings
4. **Draft** — Click "Draft comment" to generate an AI comment
5. **Review** — Edit the drafted comment if needed
6. **Approve & Copy** — Approve good comments, copy to clipboard, paste on Reddit manually

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/posts` | List posts (query: `status`, `subreddit`, `score`) |
| `PATCH` | `/api/posts/:id` | Update post status or comment |
| `POST` | `/api/posts/:id/draft` | Draft AI comment for a post |
| `POST` | `/api/posts/:id/score` | Score a post's relevance |
| `POST` | `/api/scan` | Trigger a manual scan |
| `GET` | `/api/stats` | Dashboard metrics |
| `GET/PUT` | `/api/config` | Get/update settings |
| `GET` | `/api/scan-log` | Scan history |
| `GET` | `/api/scheduler` | Scheduler status |

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via better-sqlite3)
- **AI**: OpenRouter API (google/gemini-2.0-flash-exp:free)
- **Reddit**: OAuth2 script app (app-only auth)
- **Scheduler**: node-cron
- **Frontend**: Vanilla HTML/CSS/JS
