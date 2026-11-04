import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobCards, buildSearchUrl, createLinkedInClient, cleanJobUrl } from '../src/linkedin.js';
import { isRelevant, mapDiscipline } from '../src/relevance.js';
import { openDb } from '../src/db.js';
import { page, card } from './fixtures.js';

test('parses job cards and strips tracking parameters', () => {
  const jobs = parseJobCards(page([
    { id: '4000000001', title: 'HVAC Design Engineer &amp; Modeller' },
    { id: '4000000002', title: 'Plumbing Site Engineer', company: 'Beta &amp; Co', location: 'Greater Hyderabad Area' },
  ]));
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    id: '4000000001', title: 'HVAC Design Engineer & Modeller', company: 'Acme Building Services',
    location: 'Pune, Maharashtra, India', posted_date: '2026-11-03',
    job_url: 'https://in.linkedin.com/jobs/view/some-slug-4000000001', source: 'LinkedIn',
  });
  assert.equal(jobs[1].company, 'Beta & Co');
  assert.equal(jobs[1].location, 'Greater Hyderabad Area');
});

test('missing fields stay null; cards without a title are dropped', () => {
  const html = card({ id: '4000000003', title: 'BIM Modeller' }).replace(/<time[^>]*>.*?<\/time>/, '')
    + card({ id: '4000000004', title: '' });
  const jobs = parseJobCards(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].posted_date, null);
});

test('non-LinkedIn hrefs fall back to the canonical job URL', () => {
  assert.equal(cleanJobUrl('https://evil.example/jobs/view/1', '123'), 'https://www.linkedin.com/jobs/view/123/');
});

test('builds the verified search URL', () => {
  const u = new URL(buildSearchUrl({ keywords: 'HVAC Engineer', location: 'India', datePosted: '24h', start: 10 }));
  assert.equal(u.pathname, '/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.equal(u.searchParams.get('keywords'), 'HVAC Engineer');
  assert.equal(u.searchParams.get('location'), 'India');
  assert.equal(u.searchParams.get('f_TPR'), 'r86400');
  assert.equal(u.searchParams.get('start'), '10');
  assert.equal(new URL(buildSearchUrl({ keywords: 'x', datePosted: 'any' })).searchParams.has('f_TPR'), false);
});

test('relevance filter and discipline mapping', () => {
  assert.equal(isRelevant('Senior HVAC Design Engineer'), true);
  assert.equal(isRelevant('Revit MEP Modeller'), true);
  assert.equal(isRelevant('Embedded Software Engineer - Electrical'), false);
  assert.equal(isRelevant('Marketing Manager'), false);
  assert.equal(isRelevant('Firefighting Engineer'), true);
  assert.equal(mapDiscipline('Senior HVAC Design Engineer'), 'HVAC Design');
  assert.equal(mapDiscipline('HVAC Site Supervisor'), 'HVAC Site');
  assert.equal(mapDiscipline('HVAC Engineer'), 'Other');
  assert.equal(mapDiscipline('BIM Coordinator (Revit)'), 'BIM');
  assert.equal(mapDiscipline('Fire Fighting Engineer'), 'Firefighting');
  assert.equal(mapDiscipline('Electrical Design Engineer'), 'Electrical Design');
  assert.equal(mapDiscipline('MEP Engineer'), 'MEP Coordination');
});

test('client paginates, throttles and caches', async () => {
  const calls = [];
  const pages = {
    0: page(Array.from({ length: 10 }, (_, i) => ({ id: String(4100000000 + i), title: `HVAC Engineer ${i}` }))),
    10: page(Array.from({ length: 4 }, (_, i) => ({ id: String(4100000100 + i), title: `MEP Engineer ${i}` }))),
  };
  const fetchImpl = async (url) => {
    const start = Number(new URL(url).searchParams.get('start'));
    calls.push(start);
    return new Response(pages[start] ?? '', { status: 200 });
  };
  const slept = [];
  let t = 0;
  const client = createLinkedInClient(
    { linkedinDelayMs: 4000, linkedinTimeoutMs: 1000, maxPagesPerSearch: 3, cacheTtlMs: 60000, userAgent: 'x' },
    { fetchImpl, sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t },
  );
  const r = await client.search({ keywords: 'HVAC', location: 'India', limit: 50 });
  assert.equal(r.jobs.length, 14);
  assert.equal(r.hasMore, false);
  assert.deepEqual(calls, [0, 10]);
  assert.ok(slept.length >= 1 && slept.every((ms) => ms > 0));
  await client.search({ keywords: 'HVAC', location: 'India', limit: 5 });
  assert.deepEqual(calls, [0, 10], 'second search served from cache');
});

test('client maps 429 and redirects to upstream errors', async () => {
  const mk = (status) => createLinkedInClient(
    { linkedinDelayMs: 1000, linkedinTimeoutMs: 1000, maxPagesPerSearch: 1, cacheTtlMs: 0, userAgent: 'x' },
    { fetchImpl: async () => new Response('', { status, headers: status === 302 ? { location: '/authwall' } : {} }), sleep: async () => {} },
  );
  await assert.rejects(mk(429).search({ keywords: 'x' }), (e) => e.upstreamStatus === 429 && e.status === 503);
  await assert.rejects(mk(302).search({ keywords: 'x' }), (e) => e.upstreamStatus === 302);
});

function freshStore(clock) {
  return openDb(':memory:', { now: () => new Date(clock.t) });
}
const J = (id, posted = '2026-11-04') => ({ id, job_url: `https://www.linkedin.com/jobs/view/${id}/`, title: `HVAC Design Engineer ${id}`, company: 'A', location: 'Pune, India', posted_date: posted });

test('dedupe: the same job is only new once', () => {
  const clock = { t: Date.parse('2026-11-04T06:00:00Z') };
  const s = freshStore(clock);
  const meta = { keywords: 'HVAC', location: 'India', discipline: mapDiscipline };
  assert.deepEqual(s.upsertJobs([J('1001'), J('1002')], meta), ['1001', '1002']);
  assert.deepEqual(s.upsertJobs([J('1001'), J('1003')], meta), ['1003']);
  assert.equal(s.stats().total, 3);
});

test('claim is atomic and publishing is idempotent', () => {
  const clock = { t: Date.parse('2026-11-04T06:00:00Z') };
  const s = freshStore(clock);
  s.upsertJobs([J('2001')], { discipline: mapDiscipline });
  const c = s.claim('2001');
  assert.throws(() => s.claim('2001'), { name: 'ConflictError' }, 'second claim must fail');
  assert.throws(() => s.markPublished('2001', { claimToken: 'wrong', mepmateJobId: 9, mepmateUrl: 'https://m/9' }), { name: 'ConflictError' });
  s.markPublished('2001', { claimToken: c.claim_token, mepmateJobId: 9, mepmateUrl: 'https://mepmate.com/jobs?job=9' });
  // retry of the same "published" call is fine; a different mepmate id is rejected
  assert.equal(s.markPublished('2001', { claimToken: c.claim_token, mepmateJobId: 9, mepmateUrl: 'x' }).status, 'published');
  assert.throws(() => s.markPublished('2001', { claimToken: c.claim_token, mepmateJobId: 10, mepmateUrl: 'x' }), { name: 'ConflictError' });
  assert.throws(() => s.claim('2001'), { name: 'ConflictError' }, 'published job can never be claimed again');
  assert.equal(s.pending().length, 0);
});

test('failed jobs retry up to the limit; stale claims are recoverable', () => {
  const clock = { t: Date.parse('2026-11-04T06:00:00Z') };
  const s = freshStore(clock);
  s.upsertJobs([J('3001'), J('3002')], { discipline: mapDiscipline });
  for (let i = 0; i < 3; i++) {
    const c = s.claim('3001', { maxAttempts: 3 });
    s.markFailed('3001', { claimToken: c.claim_token, error: 'mepmate 500' });
  }
  assert.throws(() => s.claim('3001', { maxAttempts: 3 }), { name: 'ConflictError' });
  assert.deepEqual(s.pending({ maxAttempts: 3 }).map((j) => j.id), ['3002']);

  s.claim('3002', { claimTimeoutMin: 30 });             // worker dies after claiming
  assert.equal(s.pending({ claimTimeoutMin: 30 }).length, 0);
  clock.t += 31 * 60000;                                // claim goes stale
  assert.deepEqual(s.pending({ claimTimeoutMin: 30 }).map((j) => j.id), ['3002']);
  assert.ok(s.claim('3002', { claimTimeoutMin: 30 }).claim_token);
});

test('expiry hides old jobs from pending and blocks claims', () => {
  const clock = { t: Date.parse('2026-11-12T06:00:00Z') };
  const s = freshStore(clock);
  s.upsertJobs([J('4001', '2026-11-04'), J('4002', '2026-11-10')], { discipline: mapDiscipline });
  assert.deepEqual(s.pending({ expiryDays: 7 }).map((j) => j.id), ['4002'], '8-day-old job is not offered');
  assert.equal(s.expire(7), 1);
  assert.throws(() => s.claim('4001'), { name: 'ConflictError' });
});

import { parseJobDetail } from '../src/linkedin.js';
test('parses the public job detail page', () => {
  const html = `<img data-delayed-url="https://media.licdn.com/dms/image/v2/X/company-logo_100_100/a?e=2147483647&amp;v=beta&amp;t=abc" />
    <figcaption class="num-applicants__caption">Be among the first 25 applicants</figcaption>
    <div class="show-more-less-html__markup">Intro &amp; context<br><ul><li>Heat load calcs</li><li>P&amp;IDs</li></ul><p>B.Tech, 5-8 years</p></div>
    <li><h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text">Mid-Senior level</span></li>
    <li><h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text">Full-time</span></li>
    <li><h3 class="description__job-criteria-subheader">Industries</h3><span class="description__job-criteria-text">Construction</span></li>`;
  const d = parseJobDetail(html);
  assert.equal(d.logo_url, 'https://media.licdn.com/dms/image/v2/X/company-logo_100_100/a?e=2147483647&v=beta&t=abc');
  assert.equal(d.seniority, 'Mid-Senior level');
  assert.equal(d.employment_type, 'Full-time');
  assert.equal(d.industries, 'Construction');
  assert.equal(d.job_function, null, 'missing criteria stay null');
  assert.equal(d.applicants, 'Be among the first 25 applicants');
  assert.match(d.description_text, /Intro & context\n+- Heat load calcs\n- P&IDs/);
  assert.match(d.description_text, /B\.Tech, 5-8 years/);
  const empty = parseJobDetail('<html></html>');
  assert.deepEqual(empty, { logo_url: null, seniority: null, employment_type: null, job_function: null, industries: null, applicants: null, description_text: null });
});
