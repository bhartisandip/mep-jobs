// Public LinkedIn job search (logged-out "guest" endpoint). No cookies, no login.
//
// Verified on 2026-11-04:
//   - location=<text> filters results (India tested with several keywords)
//   - f_TPR=r86400 (past 24 h) and f_TPR=r604800 (past week) filter by posting date
//   - start=0,10,20... pages through results, 10 cards per page
// Anything else (experience level, job type) is NOT exposed until verified.

const ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_SIZE = 10;

export const DATE_POSTED = Object.freeze({ any: null, '24h': 'r86400', week: 'r604800' });

export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = true, upstreamStatus } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
    this.upstreamStatus = upstreamStatus;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function text(html) {
  return decode(String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function pick(block, re) {
  const m = block.match(re);
  return m ? m[1] : '';
}

// Strip tracking parameters but keep LinkedIn's own host and path.
export function cleanJobUrl(href, id) {
  try {
    const u = new URL(decode(href));
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !u.pathname.includes('/jobs/view/')) throw new Error('not a job url');
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return `https://www.linkedin.com/jobs/view/${id}/`;
  }
}

export function parseJobCards(html) {
  const jobs = [];
  const seen = new Set();
  const blocks = String(html).split(/<li[\s>]/i).slice(1);
  for (const block of blocks) {
    const id = pick(block, /urn:li:jobPosting:(\d+)/);
    if (!id || seen.has(id)) continue;
    const title = text(pick(block, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i));
    const company = text(pick(block, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i));
    const location = text(pick(block, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/i));
    const posted = pick(block, /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i) || null;
    const href = pick(block, /href="([^"]*\/jobs\/view\/[^"]*)"/i);
    if (!title) continue; // never invent a title
    seen.add(id);
    jobs.push({
      id,
      title,
      company: company || null,
      location: location || null,
      posted_date: posted,
      job_url: cleanJobUrl(href, id),
      source: 'LinkedIn',
    });
  }
  return jobs;
}

// Public job detail page (logged out). Returns only what is on the page; missing items are null.
const DETAIL_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

function blockText(html) {
  return decode(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+(?=- )/g, '\n')
    .trim();
}

export function parseJobDetail(html) {
  const h = String(html);
  const descHtml = pick(h, /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i);
  const criteria = {};
  for (const m of h.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi)) {
    criteria[text(m[1]).toLowerCase()] = text(m[2]) || null;
  }
  const logoRaw = pick(h, /(https:\/\/media\.licdn\.com\/dms\/image\/[^"'\s]*company-logo[^"'\s]*)/i);
  const applicants = text(pick(h, /num-applicants__caption[^>]*>([\s\S]*?)<\/(?:figcaption|span)>/i)) || null;
  return {
    logo_url: logoRaw ? decode(logoRaw) : null,
    seniority: criteria['seniority level'] ?? null,
    employment_type: criteria['employment type'] ?? null,
    job_function: criteria['job function'] ?? null,
    industries: criteria['industries'] ?? null,
    applicants,
    description_text: descHtml ? blockText(descHtml).slice(0, 20000) : null,
  };
}

export function buildSearchUrl({ keywords, location, datePosted = 'any', start = 0 }) {
  const u = new URL(ENDPOINT);
  u.searchParams.set('keywords', keywords);
  if (location) u.searchParams.set('location', location);
  const tpr = DATE_POSTED[datePosted];
  if (tpr) u.searchParams.set('f_TPR', tpr);
  u.searchParams.set('start', String(start));
  return u.toString();
}

export function createLinkedInClient(config, { fetchImpl = globalThis.fetch, sleep, now = () => Date.now(), log = () => {} } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cache = new Map();
  let lastRequestAt = 0;
  let chain = Promise.resolve();

  // Serialise all upstream requests and keep a minimum gap between them.
  function throttled(fn) {
    const run = chain.then(async () => {
      const gap = lastRequestAt + config.linkedinDelayMs - now();
      if (gap > 0) await wait(gap);
      try { return await fn(); } finally { lastRequestAt = now(); }
    });
    chain = run.catch(() => {});
    return run;
  }

  async function fetchPage(params) {
    const url = buildSearchUrl(params);
    const key = url;
    const hit = cache.get(key);
    if (hit && now() - hit.at < config.cacheTtlMs) return hit.jobs;

    const jobs = await throttled(async () => {
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { 'user-agent': config.userAgent, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
          redirect: 'manual',
          signal: AbortSignal.timeout(config.linkedinTimeoutMs),
        });
      } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        throw new UpstreamError(timeout ? 'LinkedIn request timed out' : 'LinkedIn request failed', { status: timeout ? 504 : 502 });
      }
      log('linkedin_request', { start: params.start, status: res.status });
      if (res.status === 429) throw new UpstreamError('LinkedIn rate limit reached (HTTP 429)', { status: 503, upstreamStatus: 429 });
      if (res.status >= 300 && res.status < 400) {
        throw new UpstreamError('LinkedIn redirected the guest search (possible login wall)', { status: 502, upstreamStatus: res.status });
      }
      if (res.status === 400 || res.status === 404) return []; // past the last page
      if (!res.ok) throw new UpstreamError(`LinkedIn returned HTTP ${res.status}`, { status: 502, upstreamStatus: res.status });
      return parseJobCards(await res.text());
    });
    cache.set(key, { at: now(), jobs });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return jobs;
  }

  // Returns up to `limit` jobs starting at `offset`, fetching 10-card pages as needed.
  async function search({ keywords, location, datePosted = 'any', limit = 25, offset = 0 }) {
    const out = [];
    const ids = new Set();
    let start = Math.floor(offset / PAGE_SIZE) * PAGE_SIZE;
    let skip = offset - start;
    let pages = 0;
    let exhausted = false;
    const maxPages = Math.max(config.maxPagesPerSearch, Math.ceil((limit + skip) / PAGE_SIZE));
    while (out.length < limit && pages < maxPages) {
      const page = await fetchPage({ keywords, location, datePosted, start });
      pages++;
      if (page.length === 0) { exhausted = true; break; }
      for (const j of page) {
        if (skip > 0) { skip--; continue; }
        if (ids.has(j.id)) continue;
        ids.add(j.id);
        out.push(j);
        if (out.length >= limit) break;
      }
      if (page.length < PAGE_SIZE) { exhausted = true; break; }
      start += PAGE_SIZE;
    }
    return { jobs: out, hasMore: !exhausted, pagesFetched: pages };
  }

  async function fetchDetail(id) {
    if (!/^\d{5,20}$/.test(String(id))) throw new UpstreamError('Invalid LinkedIn job id', { status: 400, retryable: false });
    return throttled(async () => {
      let res;
      try {
        res = await fetchImpl(DETAIL_ENDPOINT + id, {
          headers: { 'user-agent': config.userAgent, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
          redirect: 'manual',
          signal: AbortSignal.timeout(config.linkedinTimeoutMs),
        });
      } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        throw new UpstreamError(timeout ? 'LinkedIn request timed out' : 'LinkedIn request failed', { status: timeout ? 504 : 502 });
      }
      log('linkedin_detail', { id, status: res.status });
      if (res.status === 429) throw new UpstreamError('LinkedIn rate limit reached (HTTP 429)', { status: 503, upstreamStatus: 429 });
      if (res.status === 404 || res.status === 410) throw new UpstreamError('Job is no longer on LinkedIn', { status: 404, retryable: false, upstreamStatus: res.status });
      if (res.status >= 300 && res.status < 400) throw new UpstreamError('LinkedIn redirected the job page (possible login wall)', { status: 502, upstreamStatus: res.status });
      if (!res.ok) throw new UpstreamError(`LinkedIn returned HTTP ${res.status}`, { status: 502, upstreamStatus: res.status });
      return parseJobDetail(await res.text());
    });
  }

  return { search, fetchPage, fetchDetail };
}
