import { createServer } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { DATE_POSTED, UpstreamError } from './linkedin.js';
import { isRelevant, mapDiscipline, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } from './relevance.js';

class HttpError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const bad = (message, details) => new HttpError(400, 'invalid_request', message, details);

// ── validation helpers ────────────────────────────────────────────────────
const TEXT_RE = /^[\p{L}\p{N} .,&+\-/#()']+$/u;
function str(v, name, { required = false, min = 1, max = 100, pattern = TEXT_RE } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`'${name}' is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`'${name}' must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`'${name}' must be ${min}-${max} characters`);
  if (pattern && !pattern.test(s)) throw bad(`'${name}' contains unsupported characters`);
  return s;
}
function intParam(v, name, def, min, max) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`'${name}' must be an integer between ${min} and ${max}`);
  return n;
}
function enumParam(v, name, allowed, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!allowed.includes(v)) throw bad(`'${name}' must be one of: ${allowed.join(', ')}`);
  return v;
}
function termList(v, name, def) {
  if (v === undefined || v === null) return def;
  if (!Array.isArray(v) || v.length > 100) throw bad(`'${name}' must be an array of at most 100 strings`);
  return v.map((t, i) => str(t, `${name}[${i}]`, { required: true, max: 60 }));
}
function jobIdParam(id) {
  if (!/^\d{5,20}$/.test(id)) throw bad('Job id must be a numeric LinkedIn job ID');
  return id;
}

const DATE_KEYS = Object.keys(DATE_POSTED);
const UNSUPPORTED = {
  experienceLevel: 'experienceLevel is not supported: LinkedIn public search results do not expose it, so the filter cannot be verified.',
  jobType: 'jobType is not supported: LinkedIn public search results do not expose it, so the filter cannot be verified.',
};

const publicJob = (j) => ({
  id: j.id, title: j.title, company: j.company, location: j.location,
  posted_date: j.posted_date, job_url: j.job_url, source: 'LinkedIn',
});
const storedJob = (j) => ({
  ...publicJob(j), discipline: j.discipline, status: j.status, attempts: j.attempts, last_error: j.last_error,
  first_discovered_at: j.first_discovered_at, last_checked_at: j.last_checked_at, published_at: j.published_at,
  mepmate_job_id: j.mepmate_job_id, mepmate_url: j.mepmate_url, share_status: j.share_status, expired_at: j.expired_at,
  logo_url: j.logo_url ?? null, details_fetched_at: j.details_fetched_at ?? null,
});
const detailsOf = (j) => ({
  logo_url: j.logo_url ?? null, seniority: j.seniority ?? null, employment_type: j.employment_type ?? null,
  job_function: j.job_function ?? null, industries: j.industries ?? null, applicants: j.applicants ?? null,
  description_text: j.description_text ?? null,
});

// ── request plumbing ──────────────────────────────────────────────────────
async function readJson(req, limit = 64 * 1024) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const ct = req.headers['content-type'] || '';
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body too large');
    chunks.push(c);
  }
  if (size === 0) return {};
  if (!ct.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw bad('Body must be a JSON object'); }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function createApp({ config, store, linkedin, log = () => {} }) {
  const keyDigest = digest(config.apiKey);
  const buckets = new Map();

  function authorised(req) {
    const k = req.headers['x-api-key'];
    return typeof k === 'string' && timingSafeEqual(digest(k), keyDigest);
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // Fixed one-minute window per IP.
  function rateLimited(ip) {
    const minute = Math.floor(Date.now() / 60000);
    const b = buckets.get(ip);
    if (!b || b.minute !== minute) { buckets.set(ip, { minute, n: 1 }); if (buckets.size > 10000) buckets.clear(); return false; }
    b.n++;
    return b.n > config.rateLimitPerMin;
  }

  // ── handlers ────────────────────────────────────────────────────────────
  async function liveSearch(url) {
    const p = Object.fromEntries(url.searchParams);
    for (const k of Object.keys(p)) {
      if (UNSUPPORTED[k]) throw new HttpError(400, 'unsupported_filter', UNSUPPORTED[k]);
      if (!['keywords', 'location', 'datePosted', 'limit', 'page'].includes(k)) throw bad(`Unknown parameter '${k}'`);
    }
    const query = {
      keywords: str(p.keywords, 'keywords', { required: true, min: 2 }),
      location: str(p.location, 'location'),
      datePosted: enumParam(p.datePosted, 'datePosted', DATE_KEYS, 'any'),
    };
    const limit = intParam(p.limit, 'limit', 25, 1, 100);
    const page = intParam(p.page, 'page', 1, 1, 50);
    const r = await linkedin.search({ ...query, limit, offset: (page - 1) * limit });
    return { success: true, source: 'LinkedIn', query, page, limit, count: r.jobs.length, hasMore: r.hasMore, jobs: r.jobs.map(publicJob) };
  }

  async function collect(body) {
    if (!Array.isArray(body.searches) || body.searches.length === 0 || body.searches.length > 30) {
      throw bad("'searches' must be an array of 1-30 {keywords, location} objects");
    }
    const searches = body.searches.map((s, i) => ({
      keywords: str(s?.keywords, `searches[${i}].keywords`, { required: true, min: 2 }),
      location: str(s?.location, `searches[${i}].location`),
    }));
    const datePosted = enumParam(body.datePosted, 'datePosted', DATE_KEYS, '24h');
    const perSearchLimit = intParam(body.perSearchLimit, 'perSearchLimit', 20, 1, 100);
    const publishLimit = intParam(body.publishLimit, 'publishLimit', 30, 0, 200);
    const include = termList(body.include, 'include', DEFAULT_INCLUDE);
    const exclude = termList(body.exclude, 'exclude', DEFAULT_EXCLUDE);

    const runId = store.startRun();
    const s = { searches: 0, fetched: 0, relevant: 0, newJobs: 0, errors: [] };
    const perSearch = [];
    for (const q of searches) {
      try {
        const r = await linkedin.search({ ...q, datePosted, limit: perSearchLimit });
        const relevant = r.jobs.filter((j) => isRelevant(j.title, include, exclude));
        const fresh = store.upsertJobs(relevant, { ...q, discipline: mapDiscipline });
        s.searches++; s.fetched += r.jobs.length; s.relevant += relevant.length; s.newJobs += fresh.length;
        perSearch.push({ ...q, fetched: r.jobs.length, relevant: relevant.length, new: fresh.length });
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        s.errors.push({ ...q, error: e.message });
        store.logEvent(null, 'search_error', `${q.keywords} | ${q.location}: ${e.message}`);
        if (e.upstreamStatus === 429) break; // stop hammering when rate limited
      }
    }
    store.finishRun(runId, s);
    if (s.searches === 0) {
      throw new HttpError(502, 'upstream_failed', 'Every LinkedIn search failed', { errors: s.errors });
    }
    const pending = store.pending({ limit: publishLimit, maxAttempts: config.maxPublishAttempts,
      claimTimeoutMin: config.claimTimeoutMin, expiryDays: config.expiryDays });
    return { success: true, runId, summary: { ...s, perSearch }, count: pending.length, pending: pending.map(storedJob) };
  }

  const opts = () => ({ maxAttempts: config.maxPublishAttempts, claimTimeoutMin: config.claimTimeoutMin });

  async function route(req, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (path === '/health' && (m === 'GET' || m === 'HEAD')) {
      store.stats();
      return [200, { status: 'ok', uptime_s: Math.round(process.uptime()) }];
    }
    if (!path.startsWith('/api/v1/')) throw new HttpError(404, 'not_found', 'Not found');
    if (!authorised(req)) throw new HttpError(401, 'unauthorized', 'Missing or invalid X-API-Key header');

    const body = await readJson(req);

    if (path === '/api/v1/jobs' && m === 'GET') return [200, await liveSearch(url)];
    if (path === '/api/v1/collect' && m === 'POST') return [200, await collect(body)];
    if (path === '/api/v1/stats' && m === 'GET') return [200, { success: true, ...store.stats() }];
    if (path === '/api/v1/jobs/pending' && m === 'GET') {
      const limit = intParam(url.searchParams.get('limit'), 'limit', 50, 1, 200);
      const rows = store.pending({ limit, ...opts(), expiryDays: config.expiryDays });
      return [200, { success: true, count: rows.length, jobs: rows.map(storedJob) }];
    }
    if (path === '/api/v1/jobs/stored' && m === 'GET') {
      const status = enumParam(url.searchParams.get('status') || undefined, 'status',
        ['new', 'publishing', 'published', 'failed', 'skipped'], undefined);
      const limit = intParam(url.searchParams.get('limit'), 'limit', 50, 1, 500);
      const offset = intParam(url.searchParams.get('offset'), 'offset', 0, 0, 1e6);
      const rows = store.list({ status, limit, offset });
      return [200, { success: true, count: rows.length, jobs: rows.map(storedJob) }];
    }
    if (path === '/api/v1/maintenance/expire' && m === 'POST') {
      const days = intParam(body.days, 'days', config.expiryDays, 1, 365);
      return [200, { success: true, expired: store.expire(days) }];
    }
    if (path === '/api/v1/maintenance/backup' && m === 'POST') {
      return [200, { success: true, file: store.backup(config.backupDir, config.backupKeepDays).split(/[\\/]/).pop() }];
    }

    const jm = path.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/([a-z-]+))?$/);
    if (jm) {
      const id = jobIdParam(jm[1]);
      const action = jm[2];
      if (!action && m === 'GET') return [200, { success: true, job: storedJob(store.get(id)), events: store.events(id) }];
      if (m === 'POST') {
        if (action === 'claim') {
          const j = store.claim(id, opts());
          return [200, { success: true, claim_token: j.claim_token, job: storedJob(j) }];
        }
        if (action === 'published') {
          const claimToken = str(body.claim_token, 'claim_token', { required: true, max: 64, pattern: /^[0-9a-f-]+$/ });
          const mepmateJobId = intParam(body.mepmate_job_id, 'mepmate_job_id', undefined, 1, 2 ** 31);
          if (mepmateJobId === undefined) throw bad("'mepmate_job_id' is required");
          const mepmateUrl = str(body.mepmate_url, 'mepmate_url', { required: true, max: 300, pattern: /^https:\/\/[^\s]+$/ });
          return [200, { success: true, job: storedJob(store.markPublished(id, { claimToken, mepmateJobId, mepmateUrl })) }];
        }
        if (action === 'failed') {
          const claimToken = str(body.claim_token, 'claim_token', { required: true, max: 64, pattern: /^[0-9a-f-]+$/ });
          const error = str(body.error, 'error', { required: true, max: 1000, pattern: null });
          return [200, { success: true, job: storedJob(store.markFailed(id, { claimToken, error })) }];
        }
        if (action === 'details') {
          const row = store.get(id);
          const fresh = row.details_fetched_at && Date.now() - Date.parse(row.details_fetched_at) < 24 * 3600 * 1000;
          const updated = fresh && body.force !== true ? row : store.saveDetails(id, await linkedin.fetchDetail(id));
          return [200, { success: true, cached: Boolean(fresh && body.force !== true), details: detailsOf(updated), job: storedJob(updated) }];
        }
        if (action === 'skip') {
          const reason = str(body.reason, 'reason', { max: 300, pattern: null });
          return [200, { success: true, job: storedJob(store.skip(id, reason)) }];
        }
        if (action === 'share') {
          const status = enumParam(body.status, 'status', ['queued', 'done', 'skipped'], undefined);
          if (!status) throw bad("'status' is required");
          return [200, { success: true, job: storedJob(store.setShare(id, status)) }];
        }
      }
    }
    throw new HttpError(404, 'not_found', 'Not found');
  }

  async function handler(req, res) {
    const started = Date.now();
    const reqId = randomUUID();
    const ip = clientIp(req);
    let status = 500;
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/health' && rateLimited(ip)) {
        res.setHeader('retry-after', '60');
        throw new HttpError(429, 'rate_limited', 'Too many requests; retry after 60 seconds');
      }
      const [s, body] = await route(req, url);
      status = s;
      send(res, s, body);
    } catch (e) {
      status = e.status || 500;
      const code = e.code || (e.name === 'ConflictError' ? 'conflict' : e.name === 'NotFoundError' ? 'not_found'
        : e instanceof UpstreamError ? 'upstream_error' : 'internal_error');
      const message = status >= 500 && !(e instanceof UpstreamError) && !(e instanceof HttpError) ? 'Internal server error' : e.message;
      if (status >= 500) log('error', { reqId, error: e.message, stack: e.stack?.split('\n').slice(0, 4).join(' | ') });
      if (!res.headersSent) send(res, status, { success: false, error: { code, message, ...(e.details ? { details: e.details } : {}) }, requestId: reqId });
    } finally {
      // Path only: query strings never contain secrets here, but keep logs small.
      log('request', { reqId, method: req.method, path: url?.pathname ?? '?', status, ms: Date.now() - started, ip });
    }
  }

  const server = createServer(handler);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = 30000;
  return server;
}
