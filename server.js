const express = require("express")
const cors = require("cors")
const crypto = require("crypto")
const path = require("path")
const fs = require("fs")
const initSqlJs = require("sql.js")
const iconv = require("iconv-lite")

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
      qualityScore INTEGER NOT NULL DEFAULT 0,
      syncTimestampCount INTEGER NOT NULL DEFAULT 0,
      richSyncWordCount INTEGER NOT NULL DEFAULT 0,
      contributor TEXT NOT NULL DEFAULT '',
      contributorEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
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
      qualityScore INTEGER NOT NULL DEFAULT 0,
      contributor TEXT NOT NULL DEFAULT '',
      contributorEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(videoId, language)
    )
  `)
  migrateSchema()
  db.run(`CREATE INDEX IF NOT EXISTS idx_lyrics_title_artist ON lyrics(songTitle, artistName)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_lyrics_quality ON lyrics(qualityScore DESC, vote DESC)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_lyrics_created ON lyrics(createdAt DESC)`)
  saveDb()
}

function migrateSchema() {
  try {
    const cols = db.exec("PRAGMA table_info(lyrics)")[0]?.values || []
    const names = cols.map((c) => c[1])
    if (!names.includes("qualityScore")) {
      db.run("ALTER TABLE lyrics ADD COLUMN qualityScore INTEGER NOT NULL DEFAULT 0")
    }
    if (!names.includes("syncTimestampCount")) {
      db.run("ALTER TABLE lyrics ADD COLUMN syncTimestampCount INTEGER NOT NULL DEFAULT 0")
    }
    if (!names.includes("richSyncWordCount")) {
      db.run("ALTER TABLE lyrics ADD COLUMN richSyncWordCount INTEGER NOT NULL DEFAULT 0")
    }
    if (!names.includes("updatedAt")) {
      db.run("ALTER TABLE lyrics ADD COLUMN updatedAt TEXT NOT NULL DEFAULT (datetime('now'))")
    }
    const tCols = db.exec("PRAGMA table_info(translated_lyrics)")[0]?.values || []
    const tNames = tCols.map((c) => c[1])
    if (!tNames.includes("qualityScore")) {
      db.run("ALTER TABLE translated_lyrics ADD COLUMN qualityScore INTEGER NOT NULL DEFAULT 0")
    }
  } catch (e) {
    console.warn("Schema migration warning:", e.message)
  }
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
    cols.forEach((c, i) => (row[c] = fixMojibake(vals[i])))
    return row
  }
  stmt.free()
  return null
}

function queryAll(sql, params = []) {
  const result = db.exec(sql, params)
  if (!result[0]) return []
  const cols = result[0].columns
  return result[0].values.map((row) => {
    const obj = {}
    cols.forEach((c, i) => (obj[c] = fixMojibake(row[i])))
    return obj
  })
}

const MOJIBAKE_PATTERN = /[\u00c2-\u00ef][\u0080-\u00bf\u2122\u20ac\u201a-\u201e\u2020-\u2026\u2030\u2039\u203a\u0152\u0160\u017d\u0153\u0161\u017e\u0178]/
function fixMojibake(value) {
  if (typeof value !== "string") return value
  if (!MOJIBAKE_PATTERN.test(value)) return value
  try {
    const bytes = iconv.encode(value, "win1252")
    const fixed = bytes.toString("utf8")
    return fixed.includes("\ufffd") ? value : fixed
  } catch {
    return value
  }
}

const LRC_LINE_REGEX = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g

function parseSyncedTimestamps(syncedLyrics) {
  if (!syncedLyrics || typeof syncedLyrics !== "string") return []
  const timestamps = []
  const lines = syncedLyrics.split(/\r?\n/)
  for (const line of lines) {
    let match
    LRC_LINE_REGEX.lastIndex = 0
    while ((match = LRC_LINE_REGEX.exec(line)) !== null) {
      const minutes = parseInt(match[1], 10)
      const seconds = parseInt(match[2], 10)
      const ms = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0
      const totalMs = minutes * 60000 + seconds * 1000 + ms
      timestamps.push(totalMs)
    }
  }
  return timestamps.sort((a, b) => a - b)
}

function countRichSyncWords(richSyncLyrics) {
  if (!richSyncLyrics || typeof richSyncLyrics !== "string") return 0
  try {
    const parsed = JSON.parse(richSyncLyrics)
    if (!Array.isArray(parsed)) return 0
    let wordCount = 0
    for (const entry of parsed) {
      if (entry && Array.isArray(entry.l)) wordCount += entry.l.length
      else if (entry && Array.isArray(entry.words)) wordCount += entry.words.length
    }
    return wordCount
  } catch {
    return 0
  }
}

function computeQualityScore({ syncedLyrics, richSyncLyrics, plainLyric, durationSeconds }) {
  let score = 0
  const timestamps = parseSyncedTimestamps(syncedLyrics)
  const timestampCount = timestamps.length
  const wordCount = countRichSyncWords(richSyncLyrics)

  if (plainLyric && plainLyric.length > 20) score += 10
  if (timestampCount >= 5) score += 20
  if (timestampCount >= 15) score += 20
  if (timestampCount >= 30) score += 20
  if (wordCount >= 50) score += 15
  if (wordCount >= 200) score += 15

  if (timestampCount >= 2 && durationSeconds > 0) {
    const coverageSpan = timestamps[timestampCount - 1] - timestamps[0]
    const coverageFraction = coverageSpan / (durationSeconds * 1000)
    if (coverageFraction > 0.5) score += 10
    if (coverageFraction > 0.8) score += 10
  }

  if (timestampCount >= 3) {
    let monotonic = true
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        monotonic = false
        break
      }
    }
    if (monotonic) score += 5
  }

  return { score, timestampCount, wordCount }
}

function validateSubmission(body) {
  if (!body.videoId || typeof body.videoId !== "string" || body.videoId.length > 64) {
    return "videoId required and must be a string ≤ 64 chars"
  }
  if (!body.plainLyric && !body.syncedLyrics && !body.richSyncLyrics) {
    return "at least one of plainLyric, syncedLyrics, richSyncLyrics required"
  }
  if (body.syncedLyrics) {
    const ts = parseSyncedTimestamps(body.syncedLyrics)
    if (ts.length < 2) {
      return "syncedLyrics must contain at least 2 valid LRC timestamps"
    }
  }
  if (body.richSyncLyrics) {
    try {
      const parsed = JSON.parse(body.richSyncLyrics)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return "richSyncLyrics must be a non-empty JSON array"
      }
    } catch {
      return "richSyncLyrics must be valid JSON"
    }
  }
  if (body.durationSeconds && (body.durationSeconds < 0 || body.durationSeconds > 36000)) {
    return "durationSeconds out of range (0-36000)"
  }
  return null
}

const rateLimitMap = new Map()
function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown"
  const now = Date.now()
  const window = 3600_000
  const maxRequests = 30
  const bucket = rateLimitMap.get(ip) || { count: 0, resetAt: now + window }
  if (now > bucket.resetAt) {
    bucket.count = 0
    bucket.resetAt = now + window
  }
  bucket.count++
  rateLimitMap.set(ip, bucket)
  if (bucket.count > maxRequests) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
    res.setHeader("Retry-After", String(retryAfter))
    return res.status(429).json({ error: "Rate limit exceeded. Try again later.", retryAfter })
  }
  next()
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, bucket] of rateLimitMap.entries()) {
    if (now > bucket.resetAt) rateLimitMap.delete(ip)
  }
}, 600_000)

function apiError(code, message, extra = {}) {
  return { error: { code, message, ...extra } }
}

app.post("/v1/analyze", (req, res) => {
  try {
    const b = req.body || {}
    const timestamps = parseSyncedTimestamps(b.syncedLyrics)
    const wordCount = countRichSyncWords(b.richSyncLyrics)
    const { score, timestampCount } = computeQualityScore({
      syncedLyrics: b.syncedLyrics,
      richSyncLyrics: b.richSyncLyrics,
      plainLyric: b.plainLyric,
      durationSeconds: b.durationSeconds || 0,
    })
    const issues = []
    if (b.syncedLyrics && timestampCount < 2) issues.push("syncedLyrics has fewer than 2 valid timestamps")
    if (b.richSyncLyrics) {
      try {
        const parsed = JSON.parse(b.richSyncLyrics)
        if (!Array.isArray(parsed)) issues.push("richSyncLyrics is not a JSON array")
      } catch {
        issues.push("richSyncLyrics is not valid JSON")
      }
    }
    if (timestampCount >= 2) {
      const duration = (b.durationSeconds || 0) * 1000
      const span = timestamps[timestamps.length - 1] - timestamps[0]
      if (duration > 0 && span / duration < 0.3) {
        issues.push("timestamps cover less than 30% of song duration")
      }
      let nonMonotonic = 0
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i] < timestamps[i - 1]) nonMonotonic++
      }
      if (nonMonotonic > 0) issues.push(`${nonMonotonic} out-of-order timestamps detected`)
    }
    const tier = score >= 100 ? "excellent" : score >= 70 ? "good" : score >= 40 ? "acceptable" : "poor"
    res.json({ qualityScore: score, timestampCount, wordCount, tier, issues })
  } catch (e) {
    res.status(500).json(apiError("ANALYZE_FAILED", e.message))
  }
})

app.get("/v1/trending", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100)
  const days = Math.min(parseInt(req.query.days || "7", 10), 90)
  const rows = queryAll(
    `SELECT videoId, songTitle, artistName, albumName, vote, qualityScore, syncTimestampCount, richSyncWordCount, createdAt
     FROM lyrics
     WHERE createdAt >= datetime('now', '-${days} days')
     ORDER BY vote DESC, qualityScore DESC, createdAt DESC
     LIMIT ${limit}`,
  )
  res.json({ days, count: rows.length, trending: rows })
})

app.get("/v1/contributors", (_, res) => {
  const rows = queryAll(
    `SELECT contributor, COUNT(*) as contributions, SUM(qualityScore) as totalQuality, AVG(qualityScore) as avgQuality, MAX(createdAt) as lastContribution
     FROM lyrics
     WHERE contributor != ''
     GROUP BY contributor
     ORDER BY contributions DESC
     LIMIT 50`,
  )
  res.json({ contributors: rows })
})

app.get("/v1/top-quality", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100)
  const rows = queryAll(
    `SELECT videoId, songTitle, artistName, qualityScore, vote, syncTimestampCount, richSyncWordCount
     FROM lyrics
     WHERE qualityScore > 80
     ORDER BY qualityScore DESC, vote DESC
     LIMIT ${limit}`,
  )
  res.json({ count: rows.length, lyrics: rows })
})

app.post("/v1/duplicate-check", (req, res) => {
  try {
    const b = req.body || {}
    if (!b.plainLyric && !b.syncedLyrics) {
      return res.status(400).json(apiError("INPUT_REQUIRED", "plainLyric or syncedLyrics required"))
    }
    const normalizedPlain = (b.plainLyric || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "")
      .trim()
      .slice(0, 500)
    if (normalizedPlain.length < 20) {
      return res.json({ duplicates: [], checked: false, reason: "input too short for meaningful comparison" })
    }
    const rows = queryAll(
      "SELECT videoId, songTitle, artistName, plainLyric FROM lyrics WHERE length(plainLyric) > 20 LIMIT 500",
    )
    const duplicates = rows
      .map((r) => {
        const normalized = (r.plainLyric || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .replace(/[^\w\s]/g, "")
          .trim()
          .slice(0, 500)
        const similarity = stringSimilarity(normalizedPlain, normalized)
        return { videoId: r.videoId, songTitle: r.songTitle, artistName: r.artistName, similarity }
      })
      .filter((r) => r.similarity > 0.85)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
    res.json({ duplicates, checked: true })
  } catch (e) {
    res.status(500).json(apiError("DUPLICATE_CHECK_FAILED", e.message))
  }
})

function stringSimilarity(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  const setA = new Set(a.split(" ").filter((w) => w.length > 2))
  const setB = new Set(b.split(" ").filter((w) => w.length > 2))
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const w of setA) if (setB.has(w)) intersection++
  return intersection / Math.max(setA.size, setB.size)
}

app.get("/v1/:videoId", (req, res) => {
  const row = queryOne("SELECT * FROM lyrics WHERE videoId = ?", [req.params.videoId])
  if (!row) return res.status(404).json(apiError("LYRIC_NOT_FOUND", "No lyrics stored for this videoId"))
  res.json(row)
})

app.get("/v1/search", (req, res) => {
  const title = (req.query.title || "").toString().trim().toLowerCase()
  const artist = (req.query.artist || "").toString().trim().toLowerCase()
  const duration = parseInt(req.query.duration || "0", 10)
  if (!title && !artist) return res.status(400).json({ error: "title or artist query required" })
  const rows = queryAll(
    "SELECT id, videoId, songTitle, artistName, albumName, durationSeconds, qualityScore, vote FROM lyrics ORDER BY qualityScore DESC, vote DESC LIMIT 500",
  )
  const scored = rows
    .map((r) => {
      const titleScore = title ? overlapScore(r.songTitle.toLowerCase(), title) : 0
      const artistScore = artist ? overlapScore(r.artistName.toLowerCase(), artist) : 0
      const durationScore =
        duration && r.durationSeconds
          ? Math.max(0, 1 - Math.abs(r.durationSeconds - duration) / Math.max(duration, 1))
          : 0
      const total = titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.2
      return { ...r, matchScore: total }
    })
    .filter((r) => r.matchScore > 0.3)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 20)
  res.json(scored)
})

function overlapScore(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.9
  const aWords = new Set(a.split(/\s+/).filter((w) => w.length > 1))
  const bWords = new Set(b.split(/\s+/).filter((w) => w.length > 1))
  if (aWords.size === 0 || bWords.size === 0) return 0
  let intersection = 0
  for (const w of aWords) if (bWords.has(w)) intersection++
  return intersection / Math.max(aWords.size, bWords.size)
}

app.get("/v1/translated/:videoId/:language", (req, res) => {
  const row = queryOne(
    "SELECT * FROM translated_lyrics WHERE videoId = ? AND language = ?",
    [req.params.videoId, req.params.language],
  )
  if (!row) return res.status(404).json({ error: "Not found" })
  res.json(row)
})

app.post("/v1", rateLimit, (req, res) => {
  try {
    const b = req.body
    const validationError = validateSubmission(b)
    if (validationError) return res.status(400).json({ error: validationError })

    const { score, timestampCount, wordCount } = computeQualityScore({
      syncedLyrics: b.syncedLyrics,
      richSyncLyrics: b.richSyncLyrics,
      plainLyric: b.plainLyric,
      durationSeconds: b.durationSeconds || 0,
    })

    const existing = queryOne(
      "SELECT id, qualityScore, vote FROM lyrics WHERE videoId = ?",
      [b.videoId],
    )
    if (existing && existing.vote >= 3 && score < existing.qualityScore - 10) {
      return res.status(409).json({
        error: "Existing lyric has higher quality and community approval. Vote or submit better sync instead.",
        existingScore: existing.qualityScore,
        submittedScore: score,
      })
    }

    const id = existing?.id || crypto.randomUUID()
    db.run(
      `INSERT INTO lyrics (id, videoId, songTitle, artistName, albumName, durationSeconds, plainLyric, syncedLyrics, richSyncLyrics, vote, qualityScore, syncTimestampCount, richSyncWordCount, contributor, contributorEmail, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(videoId) DO UPDATE SET
         songTitle = excluded.songTitle,
         artistName = excluded.artistName,
         albumName = excluded.albumName,
         durationSeconds = excluded.durationSeconds,
         plainLyric = excluded.plainLyric,
         syncedLyrics = excluded.syncedLyrics,
         richSyncLyrics = excluded.richSyncLyrics,
         qualityScore = excluded.qualityScore,
         syncTimestampCount = excluded.syncTimestampCount,
         richSyncWordCount = excluded.richSyncWordCount,
         contributor = excluded.contributor,
         contributorEmail = excluded.contributorEmail,
         updatedAt = datetime('now')`,
      [
        id,
        b.videoId,
        b.songTitle || "",
        b.artistName || "",
        b.albumName || "",
        b.durationSeconds || 0,
        b.plainLyric || "",
        b.syncedLyrics || null,
        b.richSyncLyrics || null,
        score,
        timestampCount,
        wordCount,
        b.contributor || "",
        b.contributorEmail || "",
      ],
    )
    saveDb()
    res.json({
      id,
      status: "ok",
      qualityScore: score,
      syncTimestampCount: timestampCount,
      richSyncWordCount: wordCount,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/v1/translated", rateLimit, (req, res) => {
  try {
    const b = req.body
    if (!b.videoId || !b.language) return res.status(400).json({ error: "videoId and language required" })
    if (!b.plainLyric && !b.syncedLyrics) return res.status(400).json({ error: "plainLyric or syncedLyrics required" })

    const { score } = computeQualityScore({
      syncedLyrics: b.syncedLyrics,
      richSyncLyrics: null,
      plainLyric: b.plainLyric,
      durationSeconds: 0,
    })

    const id = crypto.randomUUID()
    db.run(
      `INSERT INTO translated_lyrics (id, videoId, language, plainLyric, syncedLyrics, vote, qualityScore, contributor, contributorEmail)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(videoId, language) DO UPDATE SET
         plainLyric = excluded.plainLyric,
         syncedLyrics = excluded.syncedLyrics,
         qualityScore = excluded.qualityScore,
         contributor = excluded.contributor,
         contributorEmail = excluded.contributorEmail`,
      [id, b.videoId, b.language, b.plainLyric || "", b.syncedLyrics || null, score, b.contributor || "", b.contributorEmail || ""],
    )
    saveDb()
    res.json({ id, status: "ok", qualityScore: score })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/v1/vote", rateLimit, (req, res) => {
  try {
    const delta = req.body.vote === 1 ? 1 : -1
    db.run("UPDATE lyrics SET vote = vote + ?, updatedAt = datetime('now') WHERE id = ?", [delta, req.body.id])
    saveDb()
    res.json({ status: "ok" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/v1/translated/vote", rateLimit, (req, res) => {
  try {
    const delta = req.body.vote === 1 ? 1 : -1
    db.run("UPDATE translated_lyrics SET vote = vote + ? WHERE id = ?", [delta, req.body.id])
    saveDb()
    res.json({ status: "ok" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/health", (_, res) =>
  res.json({
    status: "ok",
    service: "sakayori-lyrics",
    uptime: process.uptime(),
    version: "1.1.0",
  }),
)

app.get("/stats", (_, res) => {
  try {
    const totalLyrics = queryOne("SELECT COUNT(*) as count FROM lyrics", [])
    const totalTranslated = queryOne("SELECT COUNT(*) as count FROM translated_lyrics", [])
    const withSync = queryOne("SELECT COUNT(*) as count FROM lyrics WHERE syncedLyrics IS NOT NULL AND syncedLyrics != ''", [])
    const withRichSync = queryOne("SELECT COUNT(*) as count FROM lyrics WHERE richSyncLyrics IS NOT NULL AND richSyncLyrics != ''", [])
    const avgQuality = queryOne("SELECT AVG(qualityScore) as avg FROM lyrics WHERE qualityScore > 0", [])
    const topContributors = db.exec(
      "SELECT contributor, COUNT(*) as count FROM lyrics WHERE contributor != '' GROUP BY contributor ORDER BY count DESC LIMIT 10",
    )
    const recentLyrics = db.exec(
      "SELECT videoId, songTitle, artistName, qualityScore, createdAt FROM lyrics ORDER BY createdAt DESC LIMIT 10",
    )
    res.json({
      totalLyrics: totalLyrics?.count || 0,
      totalTranslated: totalTranslated?.count || 0,
      syncedCount: withSync?.count || 0,
      richSyncCount: withRichSync?.count || 0,
      avgQualityScore: Math.round(avgQuality?.avg || 0),
      topContributors: topContributors[0]?.values || [],
      recentLyrics: recentLyrics[0]?.values || [],
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/stats/growth", (_, res) => {
  try {
    const growth = db.exec(
      "SELECT date(createdAt) as day, COUNT(*) as count FROM lyrics GROUP BY date(createdAt) ORDER BY day DESC LIMIT 30",
    )
    res.json({ growth: growth[0]?.values || [] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/", (req, res) => {
  if (req.headers.accept?.includes("text/html")) {
    res.send(renderHomePage())
  } else {
    res.json({
      service: "SakayoriLyrics API",
      version: "1.1.0",
      endpoints: [
        "GET /v1/:videoId",
        "GET /v1/search?title=...&artist=...&duration=...",
        "GET /v1/translated/:videoId/:language",
        "POST /v1",
        "POST /v1/translated",
        "POST /v1/vote",
        "POST /v1/translated/vote",
        "GET /stats",
        "GET /stats/growth",
        "GET /health",
      ],
      docs: "https://music.sakayori.dev/docs",
    })
  }
})

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SakayoriLyrics API</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 24px; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
    h1 span { color: #00bcd4; }
    .subtitle { color: #666; margin-bottom: 32px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 20px; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #00bcd4; }
    .stat-label { font-size: 0.8rem; color: #666; margin-top: 4px; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.15em; color: #00bcd4; margin-bottom: 12px; }
    .endpoint { background: #141414; border: 1px solid #222; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .method { font-family: monospace; font-size: 0.75rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
    .get { background: #1a3a2a; color: #4ade80; }
    .post { background: #3a2a1a; color: #fbbf24; }
    .path { font-family: monospace; font-size: 0.85rem; color: #ccc; }
    .desc { font-size: 0.75rem; color: #666; margin-left: auto; }
    .recent { background: #141414; border: 1px solid #222; border-radius: 6px; overflow: hidden; }
    .recent-item { padding: 10px 16px; border-bottom: 1px solid #1a1a1a; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .recent-item:last-child { border-bottom: none; }
    .recent-title { font-size: 0.85rem; }
    .recent-artist { font-size: 0.75rem; color: #666; }
    .recent-date { font-size: 0.7rem; color: #444; }
    .quality-badge { display: inline-block; font-family: monospace; font-size: 0.65rem; padding: 2px 6px; border-radius: 3px; background: #1a2a3a; color: #60a5fa; margin-left: 6px; }
    a { color: #00bcd4; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #1a1a1a; font-size: 0.8rem; color: #444; }
  </style>
</head>
<body>
  <div class="container">
    <h1><span>Sakayori</span>Lyrics <span style="font-size:0.6em;color:#666;font-weight:400">v1.1.0</span></h1>
    <p class="subtitle">Community-powered lyrics API with quality scoring · For SakayoriMusic</p>
    <div class="stats" id="stats"></div>
    <div class="section">
      <div class="section-title">API Endpoints</div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/v1/:videoId</span><span class="desc">Fetch lyrics by video ID</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/v1/search?title=&amp;artist=&amp;duration=</span><span class="desc">Fuzzy search by metadata</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/v1/translated/:videoId/:language</span><span class="desc">Translated lyrics</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/v1</span><span class="desc">Submit lyrics (validated + scored)</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/v1/translated</span><span class="desc">Submit translation</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/v1/vote</span><span class="desc">Vote on lyrics quality</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/stats</span><span class="desc">Aggregate statistics</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/stats/growth</span><span class="desc">Daily submission growth</span></div>
    </div>
    <div class="section">
      <div class="section-title">Recent Contributions</div>
      <div class="recent" id="recent"></div>
    </div>
    <div class="footer">
      <a href="https://music.sakayori.dev">SakayoriMusic</a> &middot;
      <a href="https://music.sakayori.dev/docs">Documentation</a> &middot;
      <a href="https://github.com/Sakayorii/sakayori-music">GitHub</a>
    </div>
  </div>
  <script>
    fetch('/stats').then(r=>r.json()).then(d=>{
      document.getElementById('stats').innerHTML=
        '<div class="stat"><div class="stat-value">'+d.totalLyrics+'</div><div class="stat-label">Total Lyrics</div></div>'+
        '<div class="stat"><div class="stat-value">'+d.syncedCount+'</div><div class="stat-label">Synced (LRC)</div></div>'+
        '<div class="stat"><div class="stat-value">'+d.richSyncCount+'</div><div class="stat-label">Word-Level Sync</div></div>'+
        '<div class="stat"><div class="stat-value">'+d.totalTranslated+'</div><div class="stat-label">Translations</div></div>'+
        '<div class="stat"><div class="stat-value">'+d.avgQualityScore+'</div><div class="stat-label">Avg Quality</div></div>';
      const recent=d.recentLyrics.map(r=>
        '<div class="recent-item"><div><div class="recent-title">'+r[1]+'<span class="quality-badge">Q'+r[3]+'</span></div><div class="recent-artist">'+r[2]+'</div></div><div class="recent-date">'+r[4]+'</div></div>'
      ).join('');
      document.getElementById('recent').innerHTML=recent||'<div class="recent-item"><div class="recent-title" style="color:#666">No lyrics yet</div></div>';
    });
  </script>
</body>
</html>`
}

initDb().then(() => {
  app.listen(PORT, () => console.log(`SakayoriLyrics API v1.1.0 running on :${PORT}`))
})
