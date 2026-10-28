/**
 * Bring the prospect spreadsheet into the system.
 *
 *   node scripts/import-prospects.js "C:\\path\\Arabella SCOT Data.xlsx"          (dry run)
 *   node scripts/import-prospects.js "C:\\path\\Arabella SCOT Data.xlsx" --write
 *
 * Dry by default, and it prints what it would do. An import that changes
 * nothing until it is asked twice is the only kind worth running against a
 * list somebody spent years building.
 *
 * It replaces what it imported before rather than appending: run it again
 * after the office edits the sheet and the table matches the sheet, instead
 * of holding two copies of every row.
 */
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../config/db');

const FILE = process.argv[2];
const WRITE = process.argv.includes('--write');

if (!FILE) {
  console.error('Give the spreadsheet: node scripts/import-prospects.js "<file.xlsx>" [--write]');
  process.exit(1);
}

// The sheet's columns, by position. By position and not by header because
// three of them are headed "SAMPLE SENT" and one has no header at all.
const COL = {
  pricing: 1, lead_source: 2, outreach_note: 3,
  status: 7, company_name: 8, contact_person: 9,
  address: 10, city: 11, state: 12, country: 13, zipcode: 14,
  phone: 15, cell: 16, second_phone: 17, fax: 18,
  email: 19, second_email: 20,
  website: 21, facebook: 22, instagram: 23,
  comments: 24,
  sample_1: 25, sample_2: 26, sample_3: 27,
  text_message_sent: 28, mail_outcome: 29,
};

/**
 * A cell as text.
 *
 * Recurses rather than calling String(): ExcelJS nests rich text inside
 * `text`, and a formula's answer inside `result`. Flattening those with
 * String() is how 1,136 rows of an earlier import arrived as
 * "[object Object]".
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

// "ARB pricing", "KPC PRICING", "ARB Pricing" are one answer each written
// three ways. Only the casing is settled here; which statuses mean the same
// thing is the office's call, not an import's.
function tidyCase(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s.replace(/\b[a-z]/g, c => c.toUpperCase());
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];
  console.log('Reading "' + ws.name + '" — ' + ws.rowCount + ' rows allocated\n');

  const rows = [];
  const seen = new Map();
  let blank = 0, noName = 0;
  const noNameRescued = [];

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (key, max) => clean(row.getCell(COL[key]).value, max);

    // The sheet is 4,319 rows long and 932 of them have anything in them.
    const anything = Object.keys(COL).some(k => clean(row.getCell(COL[k]).value, 400));
    if (!anything) { blank++; continue; }

    // Three rows carry a full contact - address, phone, email, website - and
    // no company name, because whoever added them knew the person rather
    // than the shop. Dropping those for a missing name would throw away a
    // real lead over a blank cell, so the person's name stands in and the
    // row is flagged for somebody to finish.
    let name = get('company_name', 255);
    let unnamed = false;
    if (!name) {
      const person = get('contact_person', 200);
      const site = get('website', 400) || get('email', 255) || '';
      const fromSite = (site.match(/@([\w.-]+)|\/\/(?:www\.)?([\w.-]+)/) || [])
        .slice(1).find(Boolean);
      name = person || (fromSite ? fromSite.replace(/\.(com|net|org|co\.uk).*$/i, '') : '');
      if (!name) { noName++; continue; }
      unnamed = true;
      noNameRescued.push(r + ': ' + name);
    }

    const key = name.toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);

    rows.push({
      company_name: name,
      contact_person: get('contact_person', 200),
      address: get('address', 400),
      city: get('city', 120),
      state: get('state', 120),
      country: get('country', 120),
      zipcode: get('zipcode', 40),
      phone: get('phone', 80),
      cell: get('cell', 80),
      second_phone: get('second_phone', 80),
      fax: get('fax', 80),
      email: get('email', 255),
      second_email: get('second_email', 255),
      website: get('website', 400),
      facebook: get('facebook', 400),
      instagram: get('instagram', 400),
      status: tidyCase(get('status', 120)),
      pricing: tidyCase(get('pricing', 60)),
      lead_source: get('lead_source', 160),
      sample_1: get('sample_1', 2000),
      sample_2: get('sample_2', 2000),
      sample_3: get('sample_3', 2000),
      text_message_sent: get('text_message_sent', 255),
      mail_outcome: get('mail_outcome', 255),
      outreach_note: get('outreach_note', 2000),
      comments: get('comments', 2000),
      source_row: r,
      // A name this import invented, not one the sheet gave.
      needs_name: unnamed ? 1 : 0,
    });
  }

  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  const withEmail = rows.filter(r => r.email).length;
  const dead = rows.filter(r => /not found|fail|bounce/i.test(r.mail_outcome || '')).length;

  console.log('  rows to import      ' + rows.length);
  console.log('  blank rows skipped  ' + blank);
  console.log('  no company name     ' + noName + '  (nothing else in them either)');
  if (noNameRescued.length) {
    console.log('  named from the contact instead  ' + noNameRescued.length);
    noNameRescued.forEach(x => console.log('      row ' + x));
  }
  console.log('  with an email       ' + withEmail);
  console.log('  email known bad     ' + dead + '  (not found / failed / bounced)');
  console.log('  names appearing more than once  ' + dupes.length);
  if (dupes.length) {
    console.log('      ' + dupes.slice(0, 6).map(d => d[0] + ' x' + d[1]).join(', '));
    console.log('      kept as they are - merging two rows for one company is the');
    console.log('      office\'s decision, and an import cannot tell which is current.');
  }

  if (!WRITE) {
    console.log('\nDry run. Nothing written. Add --write to import.');
    await db.end();
    return;
  }

  const cols = Object.keys(rows[0]);
  await db.query('DELETE FROM prospects');
  let done = 0;
  // In batches: 928 single inserts over a remote database is a minute of
  // round trips for no reason.
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await db.query(
      `INSERT INTO prospects (${cols.join(',')}) VALUES ` +
      batch.map(() => '(' + cols.map(() => '?').join(',') + ')').join(','),
      batch.flatMap(r => cols.map(c => r[c])),
    );
    done += batch.length;
    process.stdout.write('\r  imported ' + done + ' / ' + rows.length);
  }

  const [[n]] = await db.query('SELECT COUNT(*) AS n FROM prospects');
  console.log('\n\nDone. ' + n.n + ' prospects in the table.');
  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
