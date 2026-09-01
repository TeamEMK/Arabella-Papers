/**
 * Loads the AMIPL tab of the HR sheet into the employees table.
 *
 *   node scripts/import-hr.js <path-to-xlsx>                  # dry run
 *   node scripts/import-hr.js <path-to-xlsx> --write           # into the local database
 *   node scripts/import-hr.js <path-to-xlsx> --write --live    # into the live one
 *
 * Export the sheet from Google as .xlsx first (File -> Download -> Microsoft
 * Excel). Rows are matched on name, so running it twice updates rather than
 * duplicating.
 *
 * --live reads the same .env.backup the backup script uses, so the production
 * password lives in one gitignored file instead of being pasted into commands.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2/promise');

const XLSX = process.argv[2];
const WRITE = process.argv.includes('--write');
const LIVE = process.argv.includes('--live');

const db = (() => {
  if (!LIVE) return require('../config/db');

  const file = path.join(__dirname, '..', '.env.backup');
  if (!fs.existsSync(file)) {
    console.error('\n--live needs .env.backup with the Railway connection string.');
    console.error('Set it up once: node scripts/backup-live.js "mysql://..."\n');
    process.exit(1);
  }
  const line = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).find(l => l.startsWith('LIVE_DB_URL='));
  if (!line) {
    console.error('\n.env.backup has no LIVE_DB_URL= line.\n');
    process.exit(1);
  }
  const url = new URL(line.slice('LIVE_DB_URL='.length).trim());
  return mysql.createPool({
    host: url.hostname,
    port: url.port || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace('/', '') || 'railway',
    timezone: '+05:30',
    connectionLimit: 2,
  });
})();

if (!XLSX || !fs.existsSync(XLSX)) {
  console.error('\nUsage: node scripts/import-hr.js <sheet.xlsx> [--write] [--live]\n');
  process.exit(1);
}

// An xlsx is a zip. Read it here rather than shelling out to unzip or tar:
// neither is reliably present on Windows, and this only needs a few entries.
// The central directory is walked rather than the local headers, because a
// local header can leave its sizes blank and put them after the data.
const ZIP = (() => {
  const buf = fs.readFileSync(XLSX);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('That file is not a valid .xlsx.');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra field, at its own lengths.
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
})();

const entry = name => {
  const b = ZIP[name];
  if (!b) throw new Error(`The file has no ${name} - is it really a spreadsheet?`);
  return b.toString('utf8');
};

const shared = (() => {
  if (!ZIP['xl/sharedStrings.xml']) return [];
  return [...entry('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')
  );
})();

const unesc = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, '\n');

// The tag and its attributes are parsed separately on purpose: doing it with
// one regex loses t="s" on some cells, and then a shared-string index arrives
// as a number - "Not Issued" read as 24.
function readSheet(file) {
  const xml = entry('xl/worksheets/' + file);
  const rows = [];
  for (const r of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[2].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (c[1].match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (c[1].match(/\bt="([^"]*)"/) || [])[1];
      if (!ref) continue;
      const body = c[2] || '';
      let val = (body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      if (val == null) val = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (val == null) continue;
      if (type === 's') val = shared[Number(val)];
      if (val != null && String(val).trim() !== '') cells[ref] = unesc(val).trim();
    }
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

// Which worksheet file the AMIPL tab lives in.
function sheetFileFor(tabName) {
  const wb = entry('xl/workbook.xml');
  const rels = entry('xl/_rels/workbook.xml.rels');
  const sheet = [...wb.matchAll(/<sheet([^>]*)\/?>/g)]
    .map(m => ({
      name: (m[1].match(/name="([^"]*)"/) || [])[1],
      rid: (m[1].match(/r:id="([^"]*)"/) || [])[1],
    }))
    .find(s => s.name === tabName);
  if (!sheet) throw new Error(`No tab called "${tabName}" in that file.`);
  const target = [...rels.matchAll(/<Relationship([^>]*)\/>/g)]
    .map(m => ({
      id: (m[1].match(/Id="([^"]*)"/) || [])[1],
      target: (m[1].match(/Target="([^"]*)"/) || [])[1],
    }))
    .find(r => r.id === sheet.rid);
  return path.basename(target.target);
}

// The date columns are half typed by hand ("11th Sept 2021") and half real
// dates, which arrive as Excel's day count since 1899-12-30. Only the second
// kind is converted; the rest is left exactly as somebody wrote it, because a
// hand-typed date is more use than one this script guessed at.
const DATE_FIELDS = new Set([
  'offer_letter_date', 'date_of_joining', 'probation_end_date',
  'confirmation_date', 'last_date_of_employment',
]);

function fromExcelDay(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Number(n) * 86400000);
  if (isNaN(d)) return null;
  return String(d.getUTCDate()).padStart(2, '0') + '/'
    + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}

// Google writes long numbers in scientific notation, so a mobile comes back as
// 9.782624436E9.
function tidy(v, field) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d(\.\d+)?E\d+$/i.test(s)) return Number(s).toFixed(0);
  if (DATE_FIELDS.has(field) && /^\d+(\.0+)?$/.test(s) && Number(s) > 20000 && Number(s) < 60000) {
    return fromExcelDay(s) || s;
  }
  return s;
}

// Sheet column -> table column.
const MAP = {
  A: 'name', B: 'emp_code', C: 'mobile', D: 'email', E: 'emergency_no',
  F: 'designation', G: 'department', H: 'kra', I: 'reporting_manager',
  J: 'work_location', K: 'offer_letter_date', L: 'date_of_joining',
  M: 'probation_end_date', N: 'confirmation_date', O: 'appointment_nda_status',
  P: 'code_of_conduct', Q: 'policy_handbook', R: 'background_verification',
  S: 'working_status', T: 'last_date_of_employment', U: 'record_log',
  V: 'performance_remarks', X: 'other_notes',
};

(async () => {
  const rows = readSheet(sheetFileFor('AMIPL'));
  const people = rows.slice(1)
    .map(cells => {
      const row = { company: 'AMIPL' };
      for (const [col, field] of Object.entries(MAP)) {
        const v = tidy(cells[col], field);
        if (v != null) row[field] = v;
      }
      return row;
    })
    .filter(r => r.name);

  console.log(`\nFound ${people.length} employees in the AMIPL tab.\n`);
  people.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${(p.name || '').padEnd(22)}`
      + `${(p.designation || '-').slice(0, 28).padEnd(30)}${p.mobile || '-'}`);
  });

  if (!WRITE) {
    console.log('\nDry run. Add --write to load these into the employees table.\n');
    process.exit(0);
  }

  console.log('Writing to the ' + (LIVE ? 'LIVE' : 'local') + ' database...');

  let added = 0, updated = 0;
  for (const p of people) {
    const [[existing]] = await db.query(
      'SELECT id FROM employees WHERE company = ? AND name = ? AND is_deleted = 0 LIMIT 1',
      [p.company, p.name]
    );
    const cols = Object.keys(p);
    if (existing) {
      await db.query(
        `UPDATE employees SET ${cols.map(c => '`' + c + '` = ?').join(', ')} WHERE id = ?`,
        [...cols.map(c => p[c]), existing.id]
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO employees (${cols.map(c => '`' + c + '`').join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map(c => p[c])
      );
      added++;
    }
  }
  console.log(`\nAdded ${added}, updated ${updated}.\n`);
  process.exit(0);
})().catch(err => {
  console.error('\nImport failed:', err.message, '\n');
  process.exit(1);
});
