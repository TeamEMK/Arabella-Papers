/**
 * S.C.O.T. — THE SHEET'S LIST, AND THE OFFICE'S OWN NOTE ON IT.
 *
 * The sheet does the thinking: the ordering rhythm, when a client is due
 * again, how late they are. Nothing here recalculates any of that, and
 * nothing here writes back into it - our rows beside their formulas is one
 * bad cell reference away from changing a number a meeting relies on.
 *
 * What is new is a status and a remark of our own, joined onto the list by
 * name. Most of this suite is about that join, because a join on a name
 * typed into a spreadsheet by hand is the part that will go wrong.
 *
 * Google is stubbed. The sheet read is three seconds over the network and
 * belongs to the office, not to a test.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_scot_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

// The sheet, as the office might have typed it: spacing all over the place,
// because that is what a hand-filled column looks like.
const SHEET_ROWS = [
  ['#', 'Client', '', 'Orders every', '', 'Last order', '', 'Days since', 'Orders so far', '', '', 'Expected'],
  ['1', 'Smith & Co', '', 'Monthly', '', '02-Oct-2026', '', '34', '12', '', '', '01-Nov-2026'],
  ['2', '  Harper   Paper ', '', 'Weekly', '', '28-Oct-2026', '', '8', '40', '', '', '04-Nov-2026'],
  ['3', 'Vale Stationers', '', '', '', '', '', '', '', '', '', ''],
];
{
  const p = require.resolve(path.join(ROOT, 'utils/sheets.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      readValues: async () => SHEET_ROWS,
      serviceAccountEmail: () => 'probe@iam.gserviceaccount.com',
      loadCredentials: () => ({ client_email: 'probe', private_key: 'x' }),
    },
  };
}
{
  const p = require.resolve(path.join(ROOT, 'utils/mailer.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      sendMail: async () => ({ sent: true }),
      verifyMail: async () => ({ ok: true }),
      isMailConfigured: () => true,
    },
  };
}

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

(async () => {
  if (!LIVE_DB || LIVE_DB === TEST_DB) throw new Error('refusing to run against DB_NAME');

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  const app = require(path.join(ROOT, 'server.js'));
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  const login = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const jar = (login.headers.get('set-cookie') || '').split(';')[0];
  const list = async () => (await (await go('/api/scot/calling-list?fresh=1', { headers: { cookie: jar } })).json());
  const note = async (body) => {
    const r = await go('/api/scot/note', {
      method: 'PUT',
      headers: { cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  console.log('\nThe sheet, read');
  let j = await list();
  check('the list comes back', j.success === true, j.error);
  check('every client on it', j.list.length === 3, j.list.length);
  check('and nobody carries a note yet', j.list.every(c => !c.status && !c.remark));

  console.log('\nA note of our own');
  let w = await note({ client: 'Smith & Co', status: 'active', remark: 'Rang on the 5th, call back after Diwali.' });
  check('it saves', w.json && w.json.success === true, w.json);
  j = await list();
  let smith = j.list.find(c => c.client === 'Smith & Co');
  check('and comes back on the client it was written about', smith.status === 'active', smith);
  check('with the remark', /call back after Diwali/.test(smith.remark || ''), smith.remark);
  check('and who wrote it', smith.noteBy === process.env.ADMIN_EMAIL, smith.noteBy);
  check('nobody else picked it up', j.list.filter(c => c.status === 'active').length === 1);

  // THE JOIN IS ON A HAND-TYPED NAME. The sheet has '  Harper   Paper ' in
  // it; somebody writing a note from the screen sends whatever the screen
  // showed. Both have to land on one row, or the office writes a note and
  // watches it not appear.
  console.log('\nThe same client, spelled differently');
  await note({ client: 'harper paper', status: 'inactive', remark: 'Gone quiet.' });
  j = await list();
  const harper = j.list.find(c => /Harper/.test(c.client));
  check('a different spelling finds the same client', harper.status === 'inactive', harper);
  const [[rows]] = await db.query('SELECT COUNT(*) n FROM scot_notes');
  check('and does not leave two notes behind', rows.n === 2, rows.n);

  console.log('\nWhat is refused, and what is allowed');
  w = await note({ client: 'Smith & Co', status: 'Maybe' });
  check('a status nobody agreed to', w.json && w.json.success === false, w.json);
  j = await list();
  check('and the note is left as it was',
    j.list.find(c => c.client === 'Smith & Co').status === 'active');

  w = await note({ client: '', status: 'active' });
  check('a note about nobody', w.status === 400, w.status);

  // Emptying both fields is how somebody undoes a note. Leaving the row
  // behind would make this table a list of everybody anyone ever opened.
  w = await note({ client: 'Smith & Co', status: '', remark: '' });
  check('clearing both takes the note away', w.json && w.json.success === true);
  const [[left]] = await db.query('SELECT COUNT(*) n FROM scot_notes');
  check('and the row with it', left.n === 1, left.n);

  console.log('\nThe sheet is not written to');
  const sheetsSrc = require('fs').readFileSync(path.join(ROOT, 'routes/api/scot.js'), 'utf8');
  check('this route only ever reads it',
    /sheets\.readValues/.test(sheetsSrc) && !/writeValues|appendValues|sheets\.write/.test(sheetsSrc));

  console.log('\nThe screen');
  const fs = require('fs');
  const panel = fs.readFileSync(path.join(ROOT, 'views/partials/scot.ejs'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'views/views/scot.ejs'), 'utf8');
  check('Status and Remark are columns', />Status</.test(panel) && />Remark</.test(panel));
  check('there is a box to write one in', /scot_noteModal/.test(panel) && /scot_saveNote/.test(panel));
  check('the row opens it, because the pen is off the right-hand edge',
    panel.includes("getElementById('scot_tbody').addEventListener('click'")
    && panel.includes("closest('tr.scot-row')"));
  check('and a link or a button inside the row is left alone',
    panel.includes("closest('a, button, input, label')"));
  check('the box says where the note is kept, so nobody expects it in the sheet',
    /not in the sheet/i.test(panel));
  check('the export carries the office\'s own two as well',
    /'Status', 'Remark'/.test(panel));
  // All three counts across the top open the list they count. "Due now" is
  // not a statistic, it is the morning's calls.
  check('all three tiles are pressable', (page.match(/scot_pick\('/g) || []).length === 6,
    (page.match(/scot_pick\('/g) || []).length);
  check('and they move the one filter rather than keeping a second',
    /getElementById\('scot_when'\)/.test(page) && /scot_render\(\)/.test(page));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
