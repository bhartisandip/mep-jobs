import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,               -- LinkedIn job ID (dedupe key)
  job_url             TEXT NOT NULL UNIQUE,           -- original LinkedIn URL, tracking params removed
  title               TEXT NOT NULL,
  company             TEXT,
  location            TEXT,
  posted_date         TEXT,                           -- YYYY-MM-DD as given by LinkedIn
  discipline          TEXT,
  search_keywords     TEXT,
  search_location     TEXT,
  first_discovered_at TEXT NOT NULL,
  last_checked_at     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','publishing','published','failed','skipped')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  claim_token         TEXT,
  claimed_at          TEXT,
  published_at        TEXT,
  mepmate_job_id      INTEGER,
  mepmate_url         TEXT,
  share_status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (share_status IN ('pending','queued','done','skipped')),
  share_updated_at    TEXT,
  expired_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_date);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  job_id  TEXT,
  type    TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  searches    INTEGER,
  fetched     INTEGER,
  relevant    INTEGER,
  new_jobs    INTEGER,
  errors      TEXT
);
`;

export class ConflictError extends Error {
  constructor(message, details) { super(message); this.name = 'ConflictError'; this.status = 409; this.details = details; }
}
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = 'NotFoundError'; this.status = 404; }
}

export function openDb(path, { now = () => new Date() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const iso = () => now().toISOString();
  const today = () => iso().slice(0, 10);
  const daysAgo = (d) => new Date(now().getTime() - d * 86400000).toISOString().slice(0, 10);

  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO jobs
      (id, job_url, title, company, location, posted_date, discipline, search_keywords, search_location,
       first_discovered_at, last_checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    touch: db.prepare('UPDATE jobs SET last_checked_at = ? WHERE id = ? OR job_url = ?'),
    get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    event: db.prepare('INSERT INTO events (at, job_id, type, detail) VALUES (?,?,?,?)'),
  };

  function logEvent(jobId, type, detail) {
    q.event.run(iso(), jobId ?? null, type, detail == null ? null : String(detail).slice(0, 2000));
  }

  function get(id) {
    const row = q.get.get(String(id));
    if (!row) throw new NotFoundError(`Job ${id} not found`);
    return row;
  }

  // Inserts unseen jobs; returns only those that were new.
  function upsertJobs(jobs, { keywords, location, discipline }) {
    const fresh = [];
    const t = iso();
    db.exec('BEGIN');
    try {
      for (const j of jobs) {
        const r = q.insert.run(j.id, j.job_url, j.title, j.company, j.location, j.posted_date,
          discipline(j.title), keywords ?? null, location ?? null, t, t);
        if (r.changes === 1) { fresh.push(j.id); logEvent(j.id, 'discovered', `${keywords} | ${location}`); }
        else q.touch.run(t, j.id, j.job_url);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return fresh;
  }

  // Jobs that may be (re)published: new, failed with attempts left, or a stale claim.
  function pending({ limit = 50, maxAttempts = 3, claimTimeoutMin = 30, expiryDays = 7 } = {}) {
    const staleBefore = new Date(now().getTime() - claimTimeoutMin * 60000).toISOString();
    return db.prepare(`SELECT * FROM jobs
      WHERE expired_at IS NULL
        AND (posted_date IS NULL OR posted_date > ?)
        AND ( status = 'new'
           OR (status = 'failed' AND attempts < ?)
           OR (status = 'publishing' AND claimed_at < ? AND attempts < ?) )
      ORDER BY posted_date DESC, first_discovered_at ASC
      LIMIT ?`).all(daysAgo(expiryDays), maxAttempts, staleBefore, maxAttempts, limit);
  }

  // Atomic claim: only one caller can move a job into 'publishing'.
  function claim(id, { maxAttempts = 3, claimTimeoutMin = 30 } = {}) {
    const token = randomUUID();
    const t = iso();
    const staleBefore = new Date(now().getTime() - claimTimeoutMin * 60000).toISOString();
    const r = db.prepare(`UPDATE jobs SET status = 'publishing', claim_token = ?, claimed_at = ?, attempts = attempts + 1
      WHERE id = ? AND expired_at IS NULL AND attempts < ?
        AND ( status IN ('new','failed') OR (status = 'publishing' AND claimed_at < ?) )`)
      .run(token, t, String(id), maxAttempts, staleBefore);
    if (r.changes !== 1) {
      const row = get(id);
      throw new ConflictError(`Job ${id} cannot be claimed (status ${row.status}, attempts ${row.attempts})`,
        { status: row.status, attempts: row.attempts, mepmate_url: row.mepmate_url });
    }
    logEvent(id, 'claimed', token);
    return { ...get(id), claim_token: token };
  }

  function markPublished(id, { claimToken, mepmateJobId, mepmateUrl }) {
    const row = get(id);
    if (row.status === 'published') {
      if (Number(row.mepmate_job_id) === Number(mepmateJobId)) return row; // idempotent retry
      throw new ConflictError(`Job ${id} is already published as mepmate job ${row.mepmate_job_id}`, { status: row.status });
    }
    const r = db.prepare(`UPDATE jobs SET status = 'published', published_at = ?, mepmate_job_id = ?, mepmate_url = ?,
        last_error = NULL, claim_token = NULL
      WHERE id = ? AND status = 'publishing' AND claim_token = ?`)
      .run(iso(), mepmateJobId, mepmateUrl, String(id), claimToken);
    if (r.changes !== 1) throw new ConflictError(`Job ${id} is not claimed with this token`, { status: row.status });
    logEvent(id, 'published', `${mepmateJobId} ${mepmateUrl}`);
    return get(id);
  }

  function markFailed(id, { claimToken, error }) {
    const row = get(id);
    const r = db.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, claim_token = NULL
      WHERE id = ? AND status = 'publishing' AND claim_token = ?`).run(String(error).slice(0, 1000), String(id), claimToken);
    if (r.changes !== 1) throw new ConflictError(`Job ${id} is not claimed with this token`, { status: row.status });
    logEvent(id, 'failed', error);
    return get(id);
  }

  function setShare(id, status) {
    get(id);
    db.prepare('UPDATE jobs SET share_status = ?, share_updated_at = ? WHERE id = ?').run(status, iso(), String(id));
    logEvent(id, `share_${status}`, null);
    return get(id);
  }

  function skip(id, reason) {
    const r = db.prepare(`UPDATE jobs SET status = 'skipped', last_error = ? WHERE id = ? AND status IN ('new','failed')`)
      .run(reason ?? null, String(id));
    if (r.changes !== 1) throw new ConflictError(`Job ${id} cannot be skipped in its current status`, { status: get(id).status });
    logEvent(id, 'skipped', reason);
    return get(id);
  }

  function expire(days) {
    const r = db.prepare('UPDATE jobs SET expired_at = ? WHERE expired_at IS NULL AND posted_date IS NOT NULL AND posted_date <= ?')
      .run(iso(), daysAgo(days));
    if (r.changes) logEvent(null, 'expired', `${r.changes} jobs posted on or before ${daysAgo(days)}`);
    return r.changes;
  }

  function list({ status, limit = 50, offset = 0 } = {}) {
    return status
      ? db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY first_discovered_at DESC LIMIT ? OFFSET ?').all(status, limit, offset)
      : db.prepare('SELECT * FROM jobs ORDER BY first_discovered_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  function stats() {
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all().map((r) => [r.status, r.n]));
    const total = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const lastRun = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null;
    return { total, byStatus, lastRun, today: today() };
  }

  function startRun() {
    return Number(db.prepare('INSERT INTO runs (started_at) VALUES (?)').run(iso()).lastInsertRowid);
  }
  function finishRun(runId, s) {
    db.prepare('UPDATE runs SET finished_at = ?, searches = ?, fetched = ?, relevant = ?, new_jobs = ?, errors = ? WHERE id = ?')
      .run(iso(), s.searches, s.fetched, s.relevant, s.newJobs, s.errors.length ? JSON.stringify(s.errors) : null, runId);
  }

  function events(jobId, limit = 50) {
    return db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(String(jobId), limit);
  }

  // Consistent snapshot into backupDir, then prune old files.
  function backup(backupDir, keepDays) {
    mkdirSync(backupDir, { recursive: true });
    const file = join(backupDir, `jobs-${iso().replace(/[:.]/g, '-')}.db`);
    db.prepare('VACUUM INTO ?').run(file);
    const cutoff = now().getTime() - keepDays * 86400000;
    for (const f of readdirSync(backupDir)) {
      if (!/^jobs-.*\.db$/.test(f)) continue;
      const p = join(backupDir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
    return file;
  }

  return { db, get, upsertJobs, pending, claim, markPublished, markFailed, setShare, skip, expire, list, stats,
    startRun, finishRun, events, logEvent, backup, close: () => db.close() };
}
