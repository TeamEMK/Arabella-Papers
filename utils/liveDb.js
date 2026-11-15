// ══════════════════════════════════════════════════════
// HOW A SCRIPT REACHES THE LIVE DATABASE
//
// One place, because the password is in one place: .env.backup, which is
// gitignored, written by scripts/backup-live.js the first time somebody
// pastes the URL from Railway. Every script that has to touch live reads it
// from here rather than growing its own copy of the parsing.
//
// NOTHING CALLS THIS BY ACCIDENT. There is no default and no fallback to the
// dev database: a script asks for live in so many words, with --live, or it
// does not get live at all.
// ══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** The live connection settings, or a clear refusal. */
function liveSettings() {
  const file = path.join(ROOT, '.env.backup');
  if (!fs.existsSync(file)) {
    throw new Error('No .env.backup here, so there is no live connection string. '
      + 'Run: node scripts/backup-live.js "mysql://..." once to save it.');
  }
  const line = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('LIVE_DB_URL='));
  if (!line) throw new Error('.env.backup has no LIVE_DB_URL= line.');

  const url = new URL(line.slice('LIVE_DB_URL='.length).trim());
  return {
    host: url.hostname,
    port: Number(url.port) || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace('/', '') || 'railway',
    // The link to Railway goes over a TCP proxy from an office line and it
    // drops. Measured on 15 November: a plain TCP connect timed out once in
    // three. So a connection is allowed to take its time rather than being
    // called dead at the default.
    connectTimeout: 30000,
  };
}

/**
 * Open a connection to live, trying again when the link drops.
 *
 * Retried because it genuinely fails: ETIMEDOUT and ER_NET_READ_INTERRUPTED
 * on a healthy server, two tries in five, with nothing wrong at either end.
 * A script that gives up on the first of those is a script that works on a
 * good day.
 */
async function connectLive(mysql, tries = 6) {
  const cfg = liveSettings();
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const conn = await mysql.createConnection(cfg);
      await conn.query('SELECT 1');      // prove it can actually talk
      return conn;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw new Error('could not reach the live database after ' + tries
    + ' tries (' + (last && (last.code || last.message)) + ')');
}

module.exports = { liveSettings, connectLive };
