/**
 * Loads the paper-stock workbook into the stock_items table.
 *
 *   node scripts/import-stock.js <path-to-xlsx>                  # dry run
 *   node scripts/import-stock.js <path-to-xlsx> --write          # local database
 *   node scripts/import-stock.js <path-to-xlsx> --write --live   # live one
 *
 * Every tab is a series and becomes the `category`. The columns are NOT laid
 * out the same way on every tab - SB Thick Boards puts thickness in C and stock
 * in D, PG Series has no name column at all, and the ribbon tabs have no header
 * row - so each tab's own header is read to work out which column is which,
 * rather than assuming A/B/C everywhere.
 *
 * --write replaces the whole table: this is a snapshot of a workbook, not a
 * merge, and a paper dropped from the sheet should disappear here too.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2/promise');

const XLSX = process.argv[2];
const WRITE = process.argv.includes('--write');
const LIVE = process.argv.includes('--live');

if (!XLSX || !fs.existsSync(XLSX)) {
  console.error('\nUsage: node scripts/import-stock.js <stock.xlsx> [--write] [--live]\n');
  process.exit(1);
}

const db = (() => {
  if (!LIVE) return require('../config/db');
  const file = path.join(__dirname, '..', '.env.backup');
  if (!fs.existsSync(file)) {
    console.error('\n--live needs .env.backup with the Railway connection string.\n');
    process.exit(1);
  }
  const line = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).find(l => l.startsWith('LIVE_DB_URL='));
  if (!line) { console.error('\n.env.backup has no LIVE_DB_URL= line.\n'); process.exit(1); }
  const url = new URL(line.slice('LIVE_DB_URL='.length).trim());
  return mysql.createPool({
    host: url.hostname, port: url.port || 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: url.pathname.replace('/', '') || 'railway',
    timezone: '+05:30', connectionLimit: 2,
  });
})();

// ── xlsx, read here rather than through a library ──
const ZIP = (() => {
  const buf = fs.readFileSync(XLSX);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('That file is not a valid .xlsx.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32), localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
})();

const txt = n => (ZIP[n] ? ZIP[n].toString('utf8') : '');
const unesc = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, '\n');

const shared = [...txt('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));

// Only <sheet .../> entries, never the <sheets> wrapper around them.
const SHEETS = [...txt('xl/workbook.xml').matchAll(/<sheet\s([^>]*?)\/>/g)]
  .map(m => ({
    name: unesc((m[1].match(/name="([^"]*)"/) || [])[1] || ''),
    rid: (m[1].match(/r:id="([^"]*)"/) || [])[1],
  }))
  .filter(s => s.rid);

const REL = {};
for (const m of txt('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s([^>]*?)\/>/g)) {
  REL[(m[1].match(/Id="([^"]*)"/) || [])[1]] = (m[1].match(/Target="([^"]*)"/) || [])[1];
}

function rowsOf(sheet) {
  const xml = txt('xl/' + REL[sheet.rid].replace(/^\/?xl\//, ''));
  const out = [];
  for (const r of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[2].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (c[1].match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (c[1].match(/\bt="([^"]*)"/) || [])[1];
      if (!ref) continue;
      const body = c[2] || '';
      let v = (body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      if (v == null) v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v == null) continue;
      if (type === 's') v = shared[Number(v)];
      if (v != null && String(v).trim() !== '') cells[ref] = unesc(v).trim();
    }
    if (Object.keys(cells).length) out.push(cells);
  }
  return out;
}

// A header cell says what the column is; a data cell happens to contain a
// similar word. "Stock" is a header, "In Stock" is a value - so these match the
// whole cell, not part of it.
const HEADER = [
  [/^\s*(paper|plexiglas|foil|ribbon|item)?\s*code\s*$/i, 'code'],
  [/^\s*(paper|plexiglas|foil|ribbon|item)?\s*name\s*$/i, 'name'],
  [/^\s*stock\s*$/i, 'status'],
  [/thick/i, 'thickness'],
];

function mapColumns(rows) {
  const first = rows[0] || {};
  const map = {};
  let isHeader = false;
  for (const [col, value] of Object.entries(first)) {
    for (const [re, field] of HEADER) {
      if (re.test(value)) { map[col] = field; isHeader = true; break; }
    }
  }
  // No header row - the ribbon tabs. They are always code in A, stock in C.
  if (!isHeader) return { map: { A: 'code', C: 'status' }, skipFirst: false };

  // Velvet's header row reads "4" over the codes and "Stock" over the values,
  // so nothing marks the code column and every row would be dropped for having
  // no code. Where the header does not say, the left-most unclaimed column is
  // the code - which is how all of these sheets are laid out.
  if (!Object.values(map).includes('code')) {
    const columns = new Set();
    rows.forEach(r => Object.keys(r).forEach(c => columns.add(c)));
    const free = [...columns].sort((x, y) => x.length - y.length || x.localeCompare(y))
      .find(c => !map[c]);
    if (free) map[free] = 'code';
  }
  return { map, skipFirst: true };
}

// The sheet spells the same three states half a dozen ways. Tidy those, and
// leave anything else ("Please confirm before placing an order") as written.
function tidyStatus(v) {
  const s = (v || '').trim();
  if (/^in\s*stock$/i.test(s)) return 'In Stock';
  if (/^out\s*(of\s*)?stock$/i.test(s)) return 'Out of Stock';
  return s;
}

(async () => {
  const items = [];
  const perTab = [];

  for (const sheet of SHEETS) {
    const rows = rowsOf(sheet);
    if (!rows.length) continue;
    const { map, skipFirst } = mapColumns(rows);

    let taken = 0;
    for (const cells of rows.slice(skipFirst ? 1 : 0)) {
      const item = { category: sheet.name, code: '', name: '', status: '', thickness: '', notes: [] };
      for (const [col, value] of Object.entries(cells)) {
        const field = map[col];
        if (field === 'code') item.code = value;
        else if (field === 'name') item.name = value;
        else if (field === 'status') item.status = value;
        else if (field === 'thickness') item.thickness = value;
        else item.notes.push(value);
      }
      // A row with neither a code nor a name is a stray note or a blank line.
      if (!item.code && !item.name) continue;
      item.status = tidyStatus(item.status);
      item.note = item.notes.join(' · ') || null;
      delete item.notes;
      items.push(item);
      taken++;
    }
    perTab.push([sheet.name, taken]);
  }

  console.log(`\nFound ${items.length} items across ${perTab.length} tabs.\n`);
  perTab.forEach(([name, n]) => console.log('  ' + name.padEnd(34) + String(n).padStart(5)));

  const states = {};
  items.forEach(i => { states[i.status || '(blank)'] = (states[i.status || '(blank)'] || 0) + 1; });
  console.log('\n  stock states:');
  Object.entries(states).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([k, v]) => console.log('   ' + String(v).padStart(5) + '  ' + k.slice(0, 56)));

  if (!WRITE) {
    console.log('\nDry run. Add --write to load these into stock_items.\n');
    process.exit(0);
  }

  console.log(`\nWriting to the ${LIVE ? 'LIVE' : 'local'} database...`);

  // A snapshot, not a merge: whatever is in the workbook is what the table
  // holds afterwards.
  await db.query('DELETE FROM stock_items');
  const values = items.map(i => [i.category, i.code || null, i.name || null,
    i.status || null, i.thickness || null, i.note]);
  for (let i = 0; i < values.length; i += 200) {
    await db.query(
      'INSERT INTO stock_items (category, code, name, status, thickness, note) VALUES ?',
      [values.slice(i, i + 200)]
    );
  }
  console.log(`\nLoaded ${items.length} items.\n`);
  process.exit(0);
})().catch(err => {
  console.error('\nImport failed:', err.message, '\n');
  process.exit(1);
});
