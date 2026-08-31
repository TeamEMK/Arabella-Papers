const mysql = require('mysql2/promise');

// On Vercel every warm lambda instance keeps its own pool, and many instances
// run at once — so each pool must stay small or Railway MySQL runs out of
// connections. Cache on globalThis so a re-required module reuses the pool
// instead of opening a second one.
const isServerless = !!process.env.VERCEL;

function createPool() {
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: isServerless ? 2 : 10,
    queueLimit: 0,
    timezone: '+05:30',
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    idleTimeout: 30000,
  });
}

// The `timezone` option above only tells this driver how to turn a JS Date
// into the string it sends, and how to read one back. It tells MySQL nothing,
// so NOW() and CURRENT_TIMESTAMP still run in whatever zone the server itself
// is set to - IST on a developer's machine, UTC on Railway. The driver then
// reads that UTC value back as though it were IST, and every timestamp the
// database wrote for itself lands five and a half hours early.
//
// Pin the session to match the driver, on each new connection, so the two
// agree wherever this runs. It has to be the callback form: the pool hands
// this event a plain connection, not the promise wrapper.
function createPinnedPool() {
  const p = createPool();
  p.on('connection', (conn) => conn.query("SET time_zone = '+05:30'", () => {}));
  return p;
}

const pool = globalThis.__arabellaPool || createPinnedPool();
if (isServerless) globalThis.__arabellaPool = pool;

module.exports = pool;
