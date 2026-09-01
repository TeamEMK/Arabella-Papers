const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Runs schema.sql on first boot so a fresh database sets itself up. There is no
// ORM here to sync models, and hosted MySQL (Railway, PlanetScale) hands you an
// already-created database — so the file's CREATE DATABASE/USE header has to go
// before the statements can run against whatever DB_NAME points at.
function statementsFrom(sql) {
  return sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/CREATE\s+DATABASE[^;]*;/i, '')
    .replace(/USE\s+[^;]*;/i, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

// The first admin is created from the environment, never from a hash in the
// repo — a committed hash is a password every reader of the repo knows. With no
// ADMIN_PASSWORD set, no account is created rather than falling back to a
// guessable default.
async function seedAdmin() {
  const [users] = await db.query('SELECT id FROM users LIMIT 1');
  if (users.length) return { seeded: false, reason: 'users already exist' };

  const password = process.env.ADMIN_PASSWORD;
  if (!password) return { seeded: false, reason: 'ADMIN_PASSWORD not set' };

  const email = process.env.ADMIN_EMAIL || 'admin@arabella.com';
  const hash = await bcrypt.hash(password, 10);
  await db.query(
    `INSERT INTO users (emp_id, username, email, password, role, domain)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['EMP001', 'Admin', email, hash, 'SuperAdmin', 'Head'],
  );
  return { seeded: true, email };
}

// Columns added to a table that already exists. schema.sql cannot deliver
// these: every CREATE in it is IF NOT EXISTS, so on a live database the whole
// file is a no-op and a new column inside `orders` never arrives. Twice now
// that has meant running an ALTER against production by hand before a deploy
// could work.
//
// Each entry is checked before it is applied, so this is safe to run on every
// boot and a database that already has the column is left alone.
const COLUMN_MIGRATIONS = [
  { table: 'orders', column: 'printing_type', type: 'VARCHAR(60)' },
  { table: 'orders', column: 'production_archived_at', type: 'DATETIME NULL' },
  // Which production board this order is pinned to, overriding the cutoff
  // date. NULL means the date decides. production_archived_at came first and
  // could only pin an order to the old board, which left no way to pull a
  // July order onto the live one; `after` carries those pins over.
  // When production handed the order to Dispatch. Separate from actual_4,
  // which is the day the parcel actually went.
  //
  // Orders already sitting on the dispatch board when this column arrived have
  // no handover time recorded anywhere - except the change log, which has been
  // writing down every status_4 change since the Logs tab went in. Take the
  // first one per order. Anything handed over before that is simply not
  // recoverable, and stays blank rather than being guessed at.
  {
    table: 'orders',
    column: 'dispatch_ready_at',
    type: 'DATETIME NULL',
    after: `UPDATE orders o
              JOIN (
                SELECT order_id, MIN(changed_at) AS first_set
                FROM order_logs
                WHERE field = 'Dispatch Status' AND IFNULL(new_value, '') <> ''
                GROUP BY order_id
              ) l ON l.order_id = o.order_id
              SET o.dispatch_ready_at = l.first_set
            WHERE o.dispatch_ready_at IS NULL`,
  },
  // Which dispatch board this order is pinned to, overriding the cutoff date.
  // Same three states as production_board: 'old', 'current', or NULL to let
  // the date decide.
  { table: 'orders', column: 'dispatch_board', type: "VARCHAR(10) NULL" },
  {
    table: 'orders',
    column: 'production_board',
    type: "VARCHAR(10) NULL",
    after: "UPDATE orders SET production_board = 'old' WHERE production_archived_at IS NOT NULL",
  },
];

async function addMissingColumns() {
  const added = [];
  for (const m of COLUMN_MIGRATIONS) {
    const [cols] = await db.query('SHOW COLUMNS FROM ?? LIKE ?', [m.table, m.column]);
    if (cols.length) continue;
    await db.query(`ALTER TABLE \`${m.table}\` ADD COLUMN \`${m.column}\` ${m.type}`);
    if (m.after) await db.query(m.after);
    added.push(`${m.table}.${m.column}`);
  }
  return added;
}

async function run() {
  const [existing] = await db.query("SHOW TABLES LIKE 'users'");
  const created = !existing.length;

  // Run every time, not only on an empty database. Each statement is a
  // CREATE TABLE IF NOT EXISTS, so an existing database keeps what it has and
  // a table added since it was set up - order_logs was one - arrives on its
  // own instead of being created by hand.
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const statement of statementsFrom(sql)) {
    await db.query(statement);
  }

  const columns = await addMissingColumns();

  // Checked even when the tables already exist, so a database that lost its
  // users can still be recovered by setting ADMIN_PASSWORD and restarting.
  const admin = await seedAdmin();
  return { created, admin, columns };
}

let ready = null;

// One shared promise per process, so concurrent requests during a cold start
// don't each try to build the schema. A failure clears it, letting the next
// request retry instead of leaving the app permanently broken.
function ensureSchema() {
  if (!ready) {
    ready = run().catch(err => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureSchema, statementsFrom };
