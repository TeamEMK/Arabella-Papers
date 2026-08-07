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

async function run() {
  const [existing] = await db.query("SHOW TABLES LIKE 'users'");
  let created = false;

  if (!existing.length) {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = statementsFrom(sql);
    for (const statement of statements) {
      await db.query(statement);
    }
    created = true;
  }

  // Checked even when the tables already exist, so a database that lost its
  // users can still be recovered by setting ADMIN_PASSWORD and restarting.
  const admin = await seedAdmin();
  return { created, admin };
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
