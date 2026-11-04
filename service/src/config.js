// Environment-based configuration. No secrets have defaults.

function int(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Config ${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  const apiKey = env.API_KEY || '';
  if (apiKey.length < 32) {
    throw new Error('API_KEY must be set and at least 32 characters long');
  }
  return {
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    apiKey,
    dbPath: env.DB_PATH || '/data/jobs.db',
    backupDir: env.BACKUP_DIR || '/backups',
    backupKeepDays: int('BACKUP_KEEP_DAYS', 14, { min: 1, max: 365 }),
    linkedinTimeoutMs: int('LINKEDIN_TIMEOUT_MS', 20000, { min: 1000, max: 120000 }),
    linkedinDelayMs: int('LINKEDIN_DELAY_MS', 4000, { min: 1000, max: 60000 }),
    maxPagesPerSearch: int('MAX_PAGES_PER_SEARCH', 3, { min: 1, max: 10 }),
    cacheTtlMs: int('CACHE_TTL_MS', 15 * 60 * 1000, { min: 0, max: 24 * 3600 * 1000 }),
    rateLimitPerMin: int('RATE_LIMIT_PER_MIN', 60, { min: 1, max: 10000 }),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 300000, { min: 5000, max: 900000 }),
    maxPublishAttempts: int('MAX_PUBLISH_ATTEMPTS', 3, { min: 1, max: 20 }),
    claimTimeoutMin: int('CLAIM_TIMEOUT_MIN', 30, { min: 1, max: 1440 }),
    expiryDays: int('EXPIRY_DAYS', 7, { min: 1, max: 90 }),
    trustProxy: env.TRUST_PROXY === '1',
    userAgent: env.LINKEDIN_USER_AGENT ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  };
}
