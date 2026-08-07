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

const pool = globalThis.__arabellaPool || createPool();
if (isServerless) globalThis.__arabellaPool = pool;

module.exports = pool;
