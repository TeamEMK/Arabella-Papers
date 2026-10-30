/**
 * Bring the Carlson Craft retailer list into the system.
 *
 *   node scripts/import-cc-prospects.js "<folder or .xlsx>"                 what it would do
 *   node scripts/import-cc-prospects.js "<folder or .xlsx>" --write         into the dev database
 *   node scripts/import-cc-prospects.js "<folder or .xlsx>" --write --live  into the live one
 *
 * Dry by default. It says which database it is writing to before it writes,
 * because an import that does not is one that can be aimed at the wrong
 * thing twice without anybody noticing.
 *
 * Point it at the folder and it finds the combined workbook itself. The
 * fifty per-state files are the same rows split up, so importing the folder
 * file by file would give every retailer twice over - and the two extra
 * cuts in there (NY_CA_TX_FL, New_York_NY) would make some of them four
 * times over.
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
  console.error('Give the folder or the workbook:');
  console.error('  node scripts/import-cc-prospects.js "<folder>" [--write] [--live]');
  process.exit(1);
}

const SHEET = 'All States';
// Two title lines and a blank one sit above the headings.
const HEADER_ROW = 4;
const COL = {
  state: 2, region: 3, retailer: 4, address: 5, suite: 6, city: 7,
  state_code: 8, zip: 9, phone: 10, email: 11, website: 12,
  store_type: 13, notes: 14,
};

/** The combined workbook, whether a folder or the file itself was given. */
function findWorkbook(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return target;

  const wanted = /All_50_States.*\.xlsx$/i;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Mac resource forks: same names, 375 bytes each, not spreadsheets.
      if (entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.test(entry.name)) return full;
    }
  }
  throw new Error('No ..._All_50_States.xlsx under ' + target);
}

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
  const file = findWorkbook(TARGET);
  console.log('Reading ' + path.basename(file));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error('No "' + SHEET + '" sheet in that workbook');

  // Checked rather than assumed: a source that changes its column order
  // without changing its headings would otherwise load silently and wrongly.
  const headings = {};
  for (const [field, c] of Object.entries(COL)) {
    headings[field] = clean(ws.getRow(HEADER_ROW).getCell(c).value, 60) || '';
  }
  const expect = { state: 'State', retailer: 'Retailer', city: 'City', zip: 'ZIP', email: 'Email' };
  for (const [field, want] of Object.entries(expect)) {
    if (headings[field] !== want) {
      throw new Error('Column ' + COL[field] + ' should be "' + want
        + '" and reads "' + headings[field] + '". The sheet has changed shape.');
    }
  }

  const rows = [];
  const byState = new Map();
  let blank = 0;
  for (let r = HEADER_ROW + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f, max) => clean(row.getCell(COL[f]).value, max);
    const retailer = get('retailer', 255);
    if (!retailer) { blank++; continue; }

    const o = {
      retailer,
      state: get('state', 80) || '',
      state_code: get('state_code', 4),
      region: get('region', 160),
      city: get('city', 120),
      address: get('address', 400),
      suite: get('suite', 120),
      zip: get('zip', 20),
      phone: get('phone', 60),
      email: get('email', 255),
      website: get('website', 400),
      store_type: get('store_type', 40),
      notes: get('notes', 2000),
      source_row: r,
    };
    if (!o.state) { blank++; continue; }
    rows.push(o);
    byState.set(o.state, (byState.get(o.state) || 0) + 1);
  }

  const withEmail = rows.filter(r => r.email).length;
  const withPhone = rows.filter(r => r.phone).length;
  const online = rows.filter(r => /online/i.test(r.store_type || '')).length;

  console.log('');
  console.log('  retailers      ' + rows.length);
  console.log('  states         ' + byState.size);
  console.log('  with an email  ' + withEmail);
  console.log('  with a phone   ' + withPhone);
  console.log('  online only    ' + online + '  (no shop to walk into)');
  console.log('  skipped rows   ' + blank + '  (titles, blanks, no name)');
  const top = [...byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('  biggest        ' + top.map(s => s[0] + ' ' + s[1]).join(', '));

  if (byState.size !== 50) {
    console.log('');
    console.log('  NOTE: ' + byState.size + ' states, not 50. Worth a look before writing.');
  }

  if (!WRITE) {
    console.log('\nDry run. Nothing written.');
    console.log('  --write        into ' + process.env.DB_NAME + ' (dev)');
    console.log('  --write --live into the LIVE database');
    return;
  }

  const { db, name } = await connect();
  console.log('\nWriting to: ' + name);

  const cols = Object.keys(rows[0]);
  // Replaces rather than appends, so running it again after the list is
  // refreshed leaves one copy of each shop and not two.
  await db.query('DELETE FROM cc_prospects');
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    await db.query(
      `INSERT INTO cc_prospects (${cols.join(',')}) VALUES ` +
      batch.map(() => '(' + cols.map(() => '?').join(',') + ')').join(','),
      batch.flatMap(r => cols.map(c => r[c])),
    );
    done += batch.length;
    process.stdout.write('\r  imported ' + done + ' / ' + rows.length);
  }

  const [[n]] = await db.query('SELECT COUNT(*) AS n FROM cc_prospects');
  console.log('\n\nDone. ' + n.n + ' retailers in ' + name + '.');
  await db.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
