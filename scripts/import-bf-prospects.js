/**
 * Bring the Bella Figura dealer list into the system.
 *
 *   node scripts/import-bf-prospects.js "<.xlsx>"                 what it would do
 *   node scripts/import-bf-prospects.js "<.xlsx>" --write         into the dev database
 *   node scripts/import-bf-prospects.js "<.xlsx>" --write --live  into the live one
 *
 * Dry by default, and it says which database it is about to write to before
 * it writes. An import that does not say is one that can be aimed at the
 * wrong thing twice before anybody notices.
 *
 * MOST FIELDS ARRIVE BLANK, AND THAT IS THE DATA. The list was read off
 * Bella Figura's public find-us map, which shows only what each dealer chose
 * to publish: 314 of the 395 give a website, 136 an email, 47 a phone. A row
 * with nothing but a name and a city is a real listing, not a broken one, so
 * only a missing NAME drops a row.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');

const TARGET = process.argv[2];
const WRITE = process.argv.includes('--write');
const LIVE = process.argv.includes('--live');

if (!TARGET) {
  console.error('Give the workbook:');
  console.error('  node scripts/import-bf-prospects.js "<.xlsx>" [--write] [--live]');
  process.exit(1);
}

const SHEET = 'Retailers';
const HEADER_ROW = 1;
const COL = {
  num: 1, store_name: 2, address: 3, city: 4, state: 5, zip: 6,
  country: 7, phone: 8, email: 9, website: 10, instagram: 11,
  facebook: 12, visitor_policy: 13,
};

/**
 * A cell as text. Recurses rather than calling String(): ExcelJS nests rich
 * text inside `text` and a formula's answer inside `result`, and flattening
 * those gives "[object Object]" in a column nobody checks.
 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text !== undefined) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(r => cellText(r.text)).join('');
    if (v.hyperlink) return cellText(v.hyperlink);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
}

const clean = (v, max) => {
  const s = cellText(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max || 255) : null;
};

async function connect() {
  if (!LIVE) {
    const db = require('../config/db');
    return { db, name: process.env.DB_NAME + ' (dev)' };
  }
  const line = fs.readFileSync(path.join(__dirname, '..', '.env.backup'), 'utf8')
    .split(/\r?\n/).find(l => l.startsWith('LIVE_DB_URL='));
  if (!line) throw new Error('No LIVE_DB_URL in .env.backup');
  const url = line.slice('LIVE_DB_URL='.length).trim();
  const conn = await mysql.createConnection(url);
  return { db: conn, name: (url.match(/\/([^/?]+)(\?|$)/) || [])[1] + ' (LIVE)' };
}

(async () => {
  console.log('Reading ' + path.basename(TARGET));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TARGET);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error('No "' + SHEET + '" sheet in that workbook');

  // Checked rather than assumed. A source that changes its column order
  // without changing its headings would otherwise load silently and wrongly,
  // and a phone number in the email column is not something anybody spots
  // until they try to use it.
  const expect = {
    store_name: 'Store Name', city: 'City', state: 'State/Prov.',
    country: 'Country', email: 'Email', visitor_policy: 'Visitor Policy',
  };
  for (const [field, want] of Object.entries(expect)) {
    const got = clean(ws.getRow(HEADER_ROW).getCell(COL[field]).value, 60) || '';
    if (got !== want) {
      throw new Error('Column ' + COL[field] + ' should read "' + want
        + '" and reads "' + got + '". The sheet has changed shape.');
    }
  }

  const rows = [];
  const byState = new Map();
  const byCountry = new Map();
  let blank = 0;
  for (let r = HEADER_ROW + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f, max) => clean(row.getCell(COL[f]).value, max);
    const store_name = get('store_name', 255);
    if (!store_name) { blank++; continue; }

    const o = {
      store_name,
      address: get('address', 400),
      city: get('city', 120),
      state: get('state', 80),
      zip: get('zip', 20),
      country: get('country', 60),
      phone: get('phone', 60),
      email: get('email', 255),
      website: get('website', 400),
      instagram: get('instagram', 400),
      facebook: get('facebook', 400),
      visitor_policy: get('visitor_policy', 160),
      source_row: r,
    };
    rows.push(o);
    byState.set(o.state || '(none)', (byState.get(o.state || '(none)') || 0) + 1);
    byCountry.set(o.country || '(none)', (byCountry.get(o.country || '(none)') || 0) + 1);
  }

  const has = (f) => rows.filter(r => r[f]).length;

  console.log('');
  console.log('  dealers        ' + rows.length);
  console.log('  states/provs   ' + byState.size);
  console.log('  with a website ' + has('website'));
  console.log('  with an email  ' + has('email'));
  console.log('  with a phone   ' + has('phone'));
  console.log('  with an address' + String(has('address')).padStart(4));
  console.log('  countries      ' + [...byCountry].map(([c, n]) => c + ' ' + n).join(', '));
  if (blank) console.log('  rows with no name, skipped: ' + blank);

  // Same name in two places is a second shop, not a duplicate - the sheet
  // says so itself. Reported so nobody reads the total as unique businesses.
  const names = new Map();
  for (const r of rows) names.set(r.store_name.toLowerCase(), (names.get(r.store_name.toLowerCase()) || 0) + 1);
  const repeats = [...names].filter(([, n]) => n > 1);
  if (repeats.length) {
    console.log('  names listed more than once: ' + repeats.length
      + ' (' + repeats.slice(0, 3).map(([n, c]) => n + ' x' + c).join(', ')
      + (repeats.length > 3 ? ', …' : '') + ') — separate locations, kept');
  }

  if (!WRITE) {
    console.log('\nDry run. Nothing was written.');
    console.log('  --write        into the dev database');
    console.log('  --write --live into the LIVE database');
    process.exit(0);
  }

  const { db, name } = await connect();
  console.log('\nWriting to: ' + name);

  await db.query(`CREATE TABLE IF NOT EXISTS bf_prospects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    store_name VARCHAR(255) NOT NULL,
    address VARCHAR(400) DEFAULT NULL,
    city VARCHAR(120) DEFAULT NULL,
    state VARCHAR(80) DEFAULT NULL,
    zip VARCHAR(20) DEFAULT NULL,
    country VARCHAR(60) DEFAULT NULL,
    phone VARCHAR(60) DEFAULT NULL,
    email VARCHAR(255) DEFAULT NULL,
    website VARCHAR(400) DEFAULT NULL,
    instagram VARCHAR(400) DEFAULT NULL,
    facebook VARCHAR(400) DEFAULT NULL,
    visitor_policy VARCHAR(160) DEFAULT NULL,
    status VARCHAR(20) DEFAULT NULL,
    remark TEXT,
    status_updated_by VARCHAR(150) DEFAULT '',
    status_updated_at DATETIME DEFAULT NULL,
    source_row INT DEFAULT NULL,
    INDEX idx_bf_state (state),
    INDEX idx_bf_store (store_name)
  )`);

  // Whatever the office has already written on these rows is theirs, and a
  // re-import must not wipe it. Kept by store name and city - the sheet has
  // no id of its own, and a dealer's row number moves when the list is
  // gathered again.
  const [kept] = await db.query(
    `SELECT store_name, city, status, remark, status_updated_by, status_updated_at
       FROM bf_prospects WHERE IFNULL(status,'') <> '' OR IFNULL(remark,'') <> ''`);
  const keyOf = (r) => (r.store_name || '').toLowerCase().trim() + '|' + (r.city || '').toLowerCase().trim();
  const work = new Map(kept.map(r => [keyOf(r), r]));
  if (work.size) console.log('  carrying over ' + work.size + " row(s) the office had marked");

  await db.query('DELETE FROM bf_prospects');

  const cols = ['store_name', 'address', 'city', 'state', 'zip', 'country', 'phone',
                'email', 'website', 'instagram', 'facebook', 'visitor_policy',
                'status', 'remark', 'status_updated_by', 'status_updated_at', 'source_row'];
  const CHUNK = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = slice.map(r => {
      const was = work.get(keyOf(r)) || {};
      return [r.store_name, r.address, r.city, r.state, r.zip, r.country, r.phone,
              r.email, r.website, r.instagram, r.facebook, r.visitor_policy,
              was.status || null, was.remark || null,
              was.status_updated_by || '', was.status_updated_at || null, r.source_row];
    });
    await db.query(
      `INSERT INTO bf_prospects (${cols.join(',')}) VALUES ?`, [values]);
    done += slice.length;
  }

  const [[n]] = await db.query('SELECT COUNT(*) AS n FROM bf_prospects');
  console.log('  written        ' + done);
  console.log('  table now has  ' + n.n);

  if (LIVE) await db.end(); else await db.end();
  process.exit(0);
})().catch(e => { console.error('\n' + e.message); process.exit(1); });
