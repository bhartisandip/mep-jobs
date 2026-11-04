import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createLinkedInClient } from './linkedin.js';
import { createApp } from './server.js';

const log = (event, fields = {}) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');

let config;
try {
  config = loadConfig();
} catch (e) {
  log('config_error', { error: e.message });
  process.exit(1);
}

const store = openDb(config.dbPath);
const linkedin = createLinkedInClient(config, { log });
const server = createApp({ config, store, linkedin, log });

function runBackup() {
  try { log('backup', { file: store.backup(config.backupDir, config.backupKeepDays) }); }
  catch (e) { log('backup_error', { error: e.message }); }
}
function runExpire() {
  try { log('expire', { expired: store.expire(config.expiryDays) }); }
  catch (e) { log('expire_error', { error: e.message }); }
}
runBackup();
runExpire();
const timers = [setInterval(runBackup, 24 * 3600 * 1000), setInterval(runExpire, 6 * 3600 * 1000)];

server.listen(config.port, () => log('listening', { port: config.port }));

function shutdown(sig) {
  log('shutdown', { signal: sig });
  timers.forEach(clearInterval);
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
