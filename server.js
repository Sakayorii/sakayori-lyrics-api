const express = require("express")
const cors = require("cors")
const crypto = require("crypto")
const path = require("path")
const fs = require("fs")
const initSqlJs = require("sql.js")

const app = express()
const PORT = 1010
const DB_PATH = path.join(__dirname, "lyrics.db")

app.use(cors())
app.use(express.json({ limit: "5mb" }))

let db

async function initDb() {
  const SQL = await initSqlJs()
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS lyrics (
      id TEXT PRIMARY KEY,
      videoId TEXT NOT NULL UNIQUE,
      songTitle TEXT NOT NULL DEFAULT '',
      artistName TEXT NOT NULL DEFAULT '',
      albumName TEXT NOT NULL DEFAULT '',
      durationSeconds INTEGER NOT NULL DEFAULT 0,
      plainLyric TEXT NOT NULL DEFAULT '',
      syncedLyrics TEXT,
      richSyncLyrics TEXT,
      vote INTEGER NOT NULL DEFAULT 0,
      contributor TEXT NOT NULL DEFAULT '',
      contributorEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS translated_lyrics (
      id TEXT PRIMARY KEY,
      videoId TEXT NOT NULL,
      language TEXT NOT NULL,
      plainLyric TEXT NOT NULL DEFAULT '',
      syncedLyrics TEXT,
      vote INTEGER NOT NULL DEFAULT 0,
      contributor TEXT NOT NULL DEFAULT '',
      contributorEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(videoId, language)
    )
  `)
  saveDb()
}

function saveDb() {
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
}

function queryOne(sql, params) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    stmt.free()
    const row = {}
    cols.forEach((c, i) => (row[c] = vals[i]))
    return row
  }
  stmt.free()
  return null
}

app.get("/v1/:videoId", (req, res) => {
  const row = queryOne("SELECT * FROM lyrics WHERE videoId = ?", [req.params.videoId])
  if (!row) return res.status(404).json({ error: "Not found" })
  res.json(row)
})

app.get("/v1/translated/:videoId/:language", (req, res) => {
  const row = queryOne("SELECT * FROM translated_lyrics WHERE videoId = ? AND language = ?", [req.params.videoId, req.params.language])
  if (!row) return res.status(404).json({ error: "Not found" })
  res.json(row)
})

app.post("/v1", (req, res) => {
  try {
    const b = req.body
    const id = crypto.randomUUID()
    db.run(
      "INSERT OR REPLACE INTO lyrics (id, videoId, songTitle, artistName, albumName, durationSeconds, plainLyric, syncedLyrics, richSyncLyrics, vote, contributor, contributorEmail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      [id, b.videoId, b.songTitle || "", b.artistName || "", b.albumName || "", b.durationSeconds || 0, b.plainLyric || "", b.syncedLyrics || null, b.richSyncLyrics || null, b.contributor || "", b.contributorEmail || ""]
    )
    saveDb()
    res.json({ id, status: "ok" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/v1/translated", (req, res) => {
  try {
    const b = req.body
    const id = crypto.randomUUID()
    db.run(
      "INSERT OR REPLACE INTO translated_lyrics (id, videoId, language, plainLyric, syncedLyrics, vote, contributor, contributorEmail) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      [id, b.videoId, b.language, b.plainLyric || "", b.syncedLyrics || null, b.contributor || "", b.contributorEmail || ""]
    )
    saveDb()
    res.json({ id, status: "ok" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/v1/vote", (req, res) => {
  try {
    const delta = req.body.vote === 1 ? 1 : -1
    db.run("UPDATE lyrics SET vote = vote + ? WHERE id = ?", [delta, req.body.id])
    saveDb()
    res.json({ status: "ok" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/v1/translated/vote", (req, res) => {
  try {
    const delta = req.body.vote === 1 ? 1 : -1
    db.run("UPDATE translated_lyrics SET vote = vote + ? WHERE id = ?", [delta, req.body.id])
    saveDb()
    res.json({ status: "ok" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/health", (_, res) => res.json({ status: "ok", service: "sakayori-lyrics" }))

app.get("/", (_, res) => res.json({
  service: "SakayoriLyrics API",
  version: "1.0.0",
  endpoints: [
    "GET /v1/:videoId",
    "GET /v1/translated/:videoId/:language",
    "POST /v1",
    "POST /v1/translated",
    "POST /v1/vote",
    "POST /v1/translated/vote",
  ],
  docs: "https://music.sakayori.dev/docs",
}))

initDb().then(() => {
  app.listen(PORT, () => console.log(`SakayoriLyrics API running on :${PORT}`))
})
