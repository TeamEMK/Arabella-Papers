const fs = require('fs');
const path = require('path');
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

async function run() {
  const [existing] = await db.query("SHOW TABLES LIKE 'users'");
  if (existing.length) return { created: false };

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = statementsFrom(sql);
  for (const statement of statements) {
    await db.query(statement);
  }
  return { created: true, statements: statements.length };
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
