# MEP Jobs: LinkedIn → mepmate.com → WhatsApp

This service collects public LinkedIn job listings for MEP, HVAC and BIM roles, records which ones it has already seen, and serves them to n8n. n8n then publishes them on mepmate.com and sends you a ready-to-paste WhatsApp post on Telegram.

```
service/   Node.js 24 API (no npm dependencies, SQLite built in)
deploy/    docker-compose.yml for the Hostinger Docker Manager, .env.example
```

## Data source and limits

The service uses LinkedIn's logged-out job search (`/jobs-guest/jobs/api/seeMoreJobPostings/search`). It sends no cookies and does no login.

What was verified on 2026-11-04:

| Feature | Status |
|---|---|
| `keywords` | Works |
| `location` (for example `India`) | Works. Every result in the HVAC, Plumbing, MEP and BIM tests was located in India |
| `datePosted=24h` / `week` | Works (mapped to LinkedIn's `f_TPR=r86400` and `r604800`) |
| Pagination | Works: 10 cards per LinkedIn page, and the API combines pages up to `limit` |
| `experienceLevel`, `jobType` | **Not supported.** LinkedIn's search results don't show either field, so the filter can't be checked. The API returns `400 unsupported_filter` |
| Salary, experience, description | Not available in search results, so never returned |

The LinkedIn requests are serialized, at least 4 seconds apart, and cached for 15 minutes. LinkedIn's User Agreement restricts automated access, so keep the volume low. LinkedIn can change or block this endpoint at any time; when it does, the API returns `502` or `503` and n8n alerts you.

## Authentication

Every `/api/v1/*` call needs the header `X-API-Key: <API_KEY>`. The key is at least 32 characters, compared in constant time and never logged. `/health` needs no key. Generate a key with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In n8n, store the key as a **Header Auth** credential named `MEP Jobs API` (header name `X-API-Key`). It then never appears in workflow exports.

## API

Base URL: `https://jobs.srv2053249.hstgr.cloud` from outside, or `http://mep-jobs-api:3000` from n8n on the VPS.

Errors always look like this:

```json
{ "success": false, "error": { "code": "invalid_request", "message": "..." }, "requestId": "..." }
```

| Status | When |
|---|---|
| 400 | Invalid or unknown parameter |
| 401 | Missing or wrong API key |
| 404 | Unknown route or job |
| 409 | Job can't be claimed or published in its current state |
| 413 | Request body too large |
| 415 | Body isn't JSON |
| 429 | More than 60 requests a minute from one IP |
| 502, 503, 504 | LinkedIn failed (any status), rate-limited us, or timed out |

### `GET /health`
Returns `{"status":"ok","uptime_s":123}`.

### `GET /api/v1/jobs`: live search (nothing is stored)

| Param | Rules |
|---|---|
| `keywords` | Required, 2–100 characters |
| `location` | Optional, for example `India` |
| `datePosted` | `any` (default), `24h` or `week` |
| `limit` | 1–100, default 25 |
| `page` | 1–50, default 1 |

```
GET /api/v1/jobs?keywords=HVAC%20Engineer&location=India&datePosted=week&limit=10
```
```json
{ "success": true, "source": "LinkedIn",
  "query": { "keywords": "HVAC Engineer", "location": "India", "datePosted": "week" },
  "page": 1, "limit": 10, "count": 10, "hasMore": true,
  "jobs": [ { "id": "4483864008", "title": "...", "company": "...", "location": "Bengaluru, Karnataka, India",
              "posted_date": "2026-11-02", "job_url": "https://in.linkedin.com/jobs/view/...-4483864008", "source": "LinkedIn" } ] }
```

### `POST /api/v1/collect`: search, filter, store, and return jobs ready to publish

```json
{ "searches": [ { "keywords": "HVAC Engineer", "location": "India" } ],
  "datePosted": "24h", "perSearchLimit": 20, "publishLimit": 30,
  "include": ["hvac", "mep", "bim"], "exclude": ["software", "structural"] }
```

`include` and `exclude` are optional. When left out, the built-in MEP lists in `service/src/relevance.js` are used. The response has `summary` (searched, fetched, relevant, new, plus errors for each search) and `pending`: jobs not yet published, posted within `EXPIRY_DAYS` (7), and still within the retry limit. If one search fails, the rest still run. If every search fails, the call returns `502`.

### Publishing lifecycle (makes retries safe)

| Call | Effect |
|---|---|
| `POST /api/v1/jobs/{id}/claim` | Atomic `new`/`failed` → `publishing`. Returns `claim_token`. A second claim gets `409` |
| `POST /api/v1/jobs/{id}/published` `{claim_token, mepmate_job_id, mepmate_url}` | → `published`. Repeating the same call is fine; a different mepmate ID gets `409` |
| `POST /api/v1/jobs/{id}/failed` `{claim_token, error}` | → `failed`. Retried in later runs, at most 3 attempts in total |
| `POST /api/v1/jobs/{id}/skip` `{reason}` | → `skipped`. Never offered again |
| `POST /api/v1/jobs/{id}/share` `{status: queued \| done \| skipped}` | Records the WhatsApp sharing step |
| `GET /api/v1/jobs/{id}` | The stored job plus its event history |
| `GET /api/v1/jobs/pending?limit=` | Same list as `collect.pending` |
| `GET /api/v1/jobs/stored?status=&limit=&offset=` | Browse the stored jobs |
| `GET /api/v1/stats` | Counts by status and the last run |
| `POST /api/v1/maintenance/expire` `{days}` | Marks old jobs expired. This also runs automatically every 6 hours |
| `POST /api/v1/maintenance/backup` | Takes a backup now. This also runs daily, keeping 14 days |

A claim left in `publishing` for more than 30 minutes (for example because n8n crashed) can be claimed again. mepmate.com's `api/jobs.php` is idempotent on `linkedin:<id>`, so re-running a crashed step returns the same mepmate job and never creates a second one.

## Database (SQLite, `/data/jobs.db`)

- `jobs`: `id` (LinkedIn job ID, primary key), `job_url` (UNIQUE), `title`, `company`, `location`, `posted_date`, `discipline`, `search_keywords`, `search_location`, `first_discovered_at`, `last_checked_at`, `status`, `attempts`, `last_error`, `claim_token`, `claimed_at`, `published_at`, `mepmate_job_id`, `mepmate_url`, `share_status`, `share_updated_at`, `expired_at`
- `events`: per-job history (discovered, claimed, published, failed, share and expiry events) plus search errors
- `runs`: one row per collect run, with its counts and errors

Records are never deleted, so a job that has been seen before is always recognized.

## Run locally

```
cd service
npm test                         # 17 tests, no network access
API_KEY=<64 hex chars> DB_PATH=./jobs.db BACKUP_DIR=./backups npm start
```

## Deploy (Hostinger Docker Manager)

1. The repo is public at https://github.com/bhartisandip/mep-jobs and contains no secrets.
2. Create the project `mep-jobs` from that compose file, with the environment `API_KEY=<key>`.
3. Check that `https://jobs.srv2053249.hstgr.cloud/health` returns `{"status":"ok"}`.

Logs: Hostinger Docker Manager → `mep-jobs` → logs, or `docker logs mep-jobs-api`. The output is JSON lines, one per request, with no keys or cookies.
