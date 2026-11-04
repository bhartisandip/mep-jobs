import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { UpstreamError } from '../src/linkedin.js';

const KEY = 'k'.repeat(40);
const config = {
  apiKey: KEY, rateLimitPerMin: 1000, requestTimeoutMs: 10000, maxPublishAttempts: 3, claimTimeoutMin: 30,
  expiryDays: 7, trustProxy: false, backupDir: '.', backupKeepDays: 1,
};
const today = new Date().toISOString().slice(0, 10);
let mode = 'ok';
const linkedin = {
  async search({ keywords }) {
    if (mode === 'down') throw new UpstreamError('LinkedIn returned HTTP 500');
    const base = keywords.startsWith('Plumbing') ? 50000 : 60000;
    return {
      hasMore: false,
      jobs: [
        { id: String(base + 1), title: `${keywords} - Design`, company: 'A', location: 'Mumbai, Maharashtra, India', posted_date: today, job_url: `https://in.linkedin.com/jobs/view/x-${base + 1}`, source: 'LinkedIn' },
        { id: String(base + 2), title: 'Software Developer', company: 'B', location: 'Pune, India', posted_date: today, job_url: `https://in.linkedin.com/jobs/view/x-${base + 2}`, source: 'LinkedIn' },
      ],
    };
  },
};
let server, base;
before(async () => {
  server = createApp({ config, store: openDb(':memory:'), linkedin });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { method = 'GET', body, key = KEY } = {}) => fetch(base + path, {
  method,
  headers: { ...(key ? { 'x-api-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('health needs no key', async () => {
  const r = await call('/health', { key: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('API key is required and checked', async () => {
  assert.equal((await call('/api/v1/jobs?keywords=HVAC', { key: null })).status, 401);
  assert.equal((await call('/api/v1/jobs?keywords=HVAC', { key: 'wrong' })).status, 401);
  assert.equal((await call('/api/v1/jobs?keywords=HVAC%20Engineer&location=India')).status, 200);
});

test('live search returns the target schema', async () => {
  const r = await call('/api/v1/jobs?keywords=HVAC%20Engineer&location=India&datePosted=week&limit=10');
  assert.equal(r.json.success, true);
  assert.equal(r.json.source, 'LinkedIn');
  assert.deepEqual(r.json.query, { keywords: 'HVAC Engineer', location: 'India', datePosted: 'week' });
  assert.deepEqual(Object.keys(r.json.jobs[0]).sort(), ['company', 'id', 'job_url', 'location', 'posted_date', 'source', 'title']);
});

test('useful validation errors', async () => {
  const cases = [
    ['/api/v1/jobs', 'keywords'],
    ['/api/v1/jobs?keywords=H', 'keywords'],
    ['/api/v1/jobs?keywords=HVAC&datePosted=year', 'datePosted'],
    ['/api/v1/jobs?keywords=HVAC&limit=500', 'limit'],
    ['/api/v1/jobs?keywords=HVAC&experienceLevel=2', 'experienceLevel'],
    ['/api/v1/jobs?keywords=HVAC&jobType=F', 'jobType'],
    ['/api/v1/jobs?keywords=HVAC&foo=1', 'foo'],
    ['/api/v1/jobs?keywords=%3Cscript%3E', 'keywords'],
  ];
  for (const [path, word] of cases) {
    const r = await call(path);
    assert.equal(r.status, 400, path);
    assert.equal(r.json.success, false);
    assert.match(r.json.error.message, new RegExp(word), path);
  }
  assert.equal((await call('/api/v1/collect', { method: 'POST', body: { searches: [] } })).status, 400);
  assert.equal((await call('/api/v1/nope')).status, 404);
});

test('collect → claim → published flow never double-publishes', async () => {
  const body = { searches: [{ keywords: 'HVAC Engineer', location: 'India' }, { keywords: 'Plumbing Engineer', location: 'India' }] };
  const r1 = await call('/api/v1/collect', { method: 'POST', body });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.summary.relevant, 2, 'software job filtered out');
  assert.equal(r1.json.summary.newJobs, 2);
  assert.deepEqual(r1.json.pending.map((j) => j.id).sort(), ['50001', '60001']);

  const r2 = await call('/api/v1/collect', { method: 'POST', body });
  assert.equal(r2.json.summary.newJobs, 0, 'second run finds nothing new');

  const c = await call('/api/v1/jobs/60001/claim', { method: 'POST' });
  assert.equal(c.status, 200);
  assert.equal((await call('/api/v1/jobs/60001/claim', { method: 'POST' })).status, 409);
  const p = await call('/api/v1/jobs/60001/published', { method: 'POST', body: { claim_token: c.json.claim_token, mepmate_job_id: 77, mepmate_url: 'https://mepmate.com/jobs?job=77' } });
  assert.equal(p.json.job.status, 'published');
  const r3 = await call('/api/v1/collect', { method: 'POST', body });
  assert.deepEqual(r3.json.pending.map((j) => j.id), ['50001'], 'published job is not offered again');
  assert.equal((await call('/api/v1/jobs/60001/share', { method: 'POST', body: { status: 'queued' } })).json.job.share_status, 'queued');
});

test('upstream failure gives a 502 the workflow can catch', async () => {
  mode = 'down';
  const r = await call('/api/v1/collect', { method: 'POST', body: { searches: [{ keywords: 'HVAC Engineer', location: 'India' }] } });
  mode = 'ok';
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'upstream_failed');
});
