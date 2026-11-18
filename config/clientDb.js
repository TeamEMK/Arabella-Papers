// ══════════════════════════════════════════════════════
// THE CUSTOMER'S SIDE GETS ITS OWN LOGIN TO THE DATABASE
//
// The client portal is the one part of this system a stranger can walk into
// and open an account on. Everything else is behind the office's sign-in.
// Until now both used the same MySQL user - the one that can read every
// table, write every table and drop any of them.
//
// That means the portal's code COULD read orders, staff password hashes and
// candidates' ID documents. It does not, because nobody wrote that query -
// but "nobody wrote that query" is a promise the code makes, not a wall the
// database keeps. A single injection or a careless route on the customer's
// side would turn the promise into the whole order book.
//
// So the portal connects as its own user, which is granted exactly what the
// customer's three screens need and nothing else:
//
//   SELECT                  catalogue_items, envelope_linears,
//                           envelope_linear_items   (the pictures they browse)
//   SELECT, INSERT, UPDATE  client_users            (their own account)
//   INSERT                  pricing_quotes          (the quote they ask for)
//
// After that, `SELECT * FROM orders` from the portal is not a bug with
// consequences - it is MySQL saying "SELECT command denied". No DELETE
// anywhere, no DROP, no ALTER.
//
// WHEN THE SETTING IS NOT THERE. The user has to be created on the server
// before this can be used, and a deployment that happens first must not take
// the customer's page down. So with CLIENT_DB_USER unset this falls back to
// the ordinary pool and SAYS SO, loudly, once per boot. That is a smaller
// harm than a dead portal, and the line in the log is what stops the
// fallback from becoming the arrangement.
//
// The host, port and database default to the main ones, because the user is
// the thing that differs. Setting CLIENT_DB_HOST/NAME as well is what a move
// to a separate server would need, and nothing here would have to change.
// ══════════════════════════════════════════════════════
const mysql = require('mysql2/promise');

const isServerless = !!process.env.VERCEL;
const separate = !!String(process.env.CLIENT_DB_USER || '').trim();

function createPool() {
  const p = mysql.createPool({
    host: process.env.CLIENT_DB_HOST || process.env.DB_HOST,
    port: process.env.CLIENT_DB_PORT || process.env.DB_PORT || 3306,
    user: process.env.CLIENT_DB_USER,
    password: process.env.CLIENT_DB_PASSWORD,
    database: process.env.CLIENT_DB_NAME || process.env.DB_NAME,
    waitForConnections: true,
    // Smaller than the office pool on purpose. Railway counts connections
    // per user and the whole office shares the other one; the customer's
    // side is three read-only screens and has run out of nothing.
    connectionLimit: isServerless ? 1 : 4,
    queueLimit: 0,
    timezone: '+05:30',
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    idleTimeout: 30000,
  });
  // The same pinning as the office pool: the driver's `timezone` tells MySQL
  // nothing, so NOW() would run in the server's own zone and be read back as
  // IST. See config/db.js for the five and a half hours this cost once.
  p.on('connection', (conn) => conn.query("SET time_zone = '+05:30'", () => {}));
  return p;
}

let pool;
if (separate) {
  pool = globalThis.__arabellaClientPool || createPool();
  if (isServerless) globalThis.__arabellaClientPool = pool;
} else {
  if (!globalThis.__arabellaClientPoolWarned) {
    globalThis.__arabellaClientPoolWarned = true;
    console.warn('[clientDb] CLIENT_DB_USER is not set, so the customer portal '
      + 'is using the office database login. It can read every table until '
      + 'the restricted user is created and the variables are set.');
  }
  pool = require('./db');
}

// Which one is in use, for the boot line and for the tests - a thing that
// can be asked rather than guessed at from behaviour.
pool.isSeparateClientUser = separate;

module.exports = pool;
