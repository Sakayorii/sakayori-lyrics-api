# SakayoriLyrics

**Self-hosted lyrics API server for SakayoriMusic**

[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A lightweight lyrics storage and retrieval API built with Express and SQLite. Provides synced lyrics, rich-sync lyrics, translated lyrics, and community voting for [SakayoriMusic](https://music.sakayori.dev).

## Features

- Store and retrieve synced, rich-sync, and plain lyrics by YouTube video ID
- Translated lyrics support with per-language storage
- Community voting on lyrics quality
- SQLite database with automatic persistence
- Zero native dependencies (pure JavaScript SQLite via sql.js)
- CORS enabled for cross-origin access

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/:videoId` | Get lyrics by video ID |
| `GET` | `/v1/translated/:videoId/:language` | Get translated lyrics |
| `POST` | `/v1` | Submit new lyrics |
| `POST` | `/v1/translated` | Submit translated lyrics |
| `POST` | `/v1/vote` | Vote on lyrics |
| `POST` | `/v1/translated/vote` | Vote on translated lyrics |
| `GET` | `/health` | Health check |

## Setup

```bash
npm install
node server.js
```

Server runs on port **1010** by default.

## Production

Route via Cloudflare Tunnel to `lyrics.sakayori.dev`:

```yaml
- hostname: lyrics.sakayori.dev
  service: http://127.0.0.1:1010
```

## Data

Lyrics are stored in `lyrics.db` (SQLite). The file is created automatically on first run. Back up this file to preserve all submitted lyrics.

## License

MIT License — Sakayori Studio
