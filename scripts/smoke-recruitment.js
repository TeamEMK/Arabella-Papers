/**
 * End-to-end smoke test for the Recruitment section.
 *
 *   npm run smoke:recruitment
 *
 * It builds a throwaway database of its own, runs the real app against it, and
 * drops it again — the database in .env is never touched, and the check at the
 * top refuses to run if the two names ever match. SMTP is stubbed, so no
 * letter leaves the machine however many the test sends.
 *
 * It lives in the repo on purpose. An earlier version of this sat in a temp
 * folder, which is exactly where a hundred and thirty checks go to be deleted
 * by the next reboot.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_recruit_smoke';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';              // skip app.listen(); we listen ourselves
process.env.APP_URL = 'http://localhost:9999';
process.env.ADMIN_EMAIL = 'smoke@test.local';
process.env.ADMIN_PASSWORD = 'smoke-pass-123';

// ── SMTP, stubbed before anything requires it ──
const SENT = [];
const mailerPath = require.resolve(path.join(ROOT, 'utils/mailer.js'));
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async ({ to, subject, attachments }) => {
      SENT.push({ to, subject, attachments: attachments || [] });
      return { sent: true };
    },
    verifyMail: async () => ({ ok: true }),
    isMailConfigured: () => true,
  },
};

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
}

let BASE = '';
let COOKIE = '';

async function call(method, url, body, isForm) {
  // trust proxy is on (we run in the serverless shape), so the session cookie
  // is Secure — tell Express the hop in front of it was HTTPS, as Vercel does.
  const opts = { method, headers: { Cookie: COOKIE, 'X-Forwarded-Proto': 'https' }, redirect: 'manual' };
  if (body && isForm) opts.body = body;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  const set = res.headers.get('set-cookie');
  if (set) COOKIE = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* csv or html */ }
  return { status: res.status, json, text, headers: res.headers };
}

/**
 * Log in, and wait until the session is actually in the store.
 *
 * express-session writes the top of the response before the store write has
 * finished. A redirect's whole body fits in that first write, so a script
 * firing its next request microseconds later can read the session before it
 * was saved and get a 401. A browser never comes close — it has a navigation
 * to do first.
 */
async function loginAs(email, password) {
  const db = require(path.join(ROOT, 'config/db.js'));
  const res = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
  });
  COOKIE = (res.headers.get('set-cookie') || '').split(';')[0];
  const sid = decodeURIComponent(COOKIE.replace(/^connect\.sid=/, '')).replace(/^s:/, '').split('.')[0];
  for (let i = 0; i < 100 && sid; i++) {
    const [[row]] = await db.query('SELECT data FROM sessions WHERE session_id = ?', [sid]);
    if (row && /"user"/.test(row.data || '')) break;
    await new Promise(done => setTimeout(done, 20));
  }
  return res.status;
}

(async () => {
  if (!LIVE_DB || LIVE_DB === TEST_DB) {
    throw new Error('refusing to run: DB_NAME is unset, or is the test database');
  }

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');
  console.log('Test database:', TEST_DB, ' (yours, untouched:', LIVE_DB + ')');

  const app = require(path.join(ROOT, 'server.js'));
  const { ensureSchema } = require(path.join(ROOT, 'config/initDb.js'));
  await ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('App on', BASE, '\n');

  check('logged in', await loginAs('smoke@test.local', 'smoke-pass-123') === 302);

  // ══════════════════════════════════════════════════
  // The bulk upload sheet
  // ══════════════════════════════════════════════════
  console.log('\nBulk upload');

  let res = await call('GET', '/api/bulk/template/candidates');
  const header = res.text.replace(/^\uFEFF/, '').split('\n')[0].trim();
  check('a template comes down', res.status === 200, res.status);
  check('with the columns the office asked for',
    header === 'Sr. No,Name,Contact Number,Email,Position,Status,Location,Expected Salary,Notice Period', header);

  res = await call('GET', '/api/bulk/columns/candidates');
  const statusCol = res.json.columns.find(c => c.key === 'status');
  check('the status column offers the pipeline',
    statusCol.allowed.join('|') === 'Scheduled|Rescheduled|Selected|Onboarding|Offer Sent|Rejected', statusCol.allowed);
  check('and only Name and Email are required',
    res.json.columns.filter(c => c.required).map(c => c.header).join(', ') === 'Name, Email',
    res.json.columns.filter(c => c.required).map(c => c.header));

  // A sheet of their own: their header spellings, a blank status, a row with
  // no address, a stage nobody has heard of, and the same person twice.
  const sheet = [
    'Sr. No,Candidate Name,Contact no,Email ID,Position applied for,Stage,Current Location,Expected CTC,Notice',
    '1,Meera Joshi,9876500021,meera@example.com,Accounts Executive,offer sent,Jaipur,5 LPA,30 days',
    '2,Vikram Rao,9876500022,vikram@example.com,Designer,,Udaipur,,Immediate',
    '3,No Address,9876500023,,Designer,Selected,Kota,,',
    '4,Bad Stage,9876500024,bad@example.com,Designer,Interviewing,Jaipur,,',
    '5,Meera Joshi,9876500021,meera@example.com,Accounts Executive,Selected,Jaipur,5 LPA,30 days',
  ].join('\n');

  const form = new FormData();
  form.append('type', 'candidates');
  form.append('file', new Blob([sheet], { type: 'text/csv' }), 'candidates.csv');
  res = await call('POST', '/api/bulk/preview', form, true);
  check('their own header spellings are understood', res.json.success === true, res.json && res.json.error);

  const rows = res.json.rows || [];
  const line = (n) => rows.find(r => r.line === n) || {};
  check('a good row reads clean', (line(2).errors || []).length === 0, line(2).errors);
  check('"offer sent" is read as Offer Sent', line(2).data.status === 'Offer Sent', line(2).data);
  check('a blank status becomes Scheduled', line(3).data.status === 'Scheduled', line(3).data);
  check('a row with no email is refused',
    (line(4).errors || []).some(e => /Email is required/i.test(e)), line(4).errors);
  check('a stage nobody has heard of is refused',
    (line(5).errors || []).some(e => /Status must be one of/.test(e)), line(5).errors);

  SENT.length = 0;
  res = await call('POST', '/api/bulk/import', { type: 'candidates', rows });
  // Two, not three: line 6 is line 2 again, and the same mailbox twice in one
  // file is the file having the person twice.
  check('the good rows import', res.json.success === true && res.json.imported === 2,
    { imported: res.json.imported, rejected: res.json.rejected });
  check('the two bad ones come back named', (res.json.rejected || []).length === 2, res.json.rejected);
  // The point of the whole thing: this is an existing list arriving, not a
  // hiring round starting.
  check('and not one letter goes out', SENT.length === 0, SENT.map(s => s.subject));

  const [landed] = await db.query(
    `SELECT name, status, current_location, notice_period, salary, created_by
       FROM recruit_candidates WHERE is_deleted = 0 ORDER BY name`);
  check('two people landed', landed.length === 2, landed.map(r => r.name));
  const meera = landed.find(r => r.name === 'Meera Joshi') || {};
  check('the new columns are filled in',
    meera.current_location === 'Jaipur' && meera.notice_period === '30 days' && meera.salary === '5 LPA', meera);
  check('the status came across', meera.status === 'Offer Sent', meera.status);
  check('the importer is recorded as the author', !!meera.created_by, meera.created_by);
  check('the same person twice in one file goes in once',
    landed.filter(r => r.name === 'Meera Joshi').length === 1, landed.map(r => r.name));

  // Running the same sheet again should add nobody.
  const again = new FormData();
  again.append('type', 'candidates');
  again.append('file', new Blob([sheet], { type: 'text/csv' }), 'candidates.csv');
  res = await call('POST', '/api/bulk/preview', again, true);
  check('a second run warns they are already on the list',
    (res.json.rows.find(r => r.line === 2).warnings || []).some(w => /Already on the list/.test(w)),
    res.json.rows.find(r => r.line === 2));
  res = await call('POST', '/api/bulk/import', { type: 'candidates', rows: res.json.rows });
  check('and nobody is added the second time',
    res.json.success !== true || res.json.imported === 0,
    { ok: res.json.success, imported: res.json.imported, error: res.json.error });

  // An imported candidate is an ordinary one: the board can act on them.
  res = await call('GET', '/api/recruitment/candidates');
  const fromSheet = (res.json.data || []).find(c => c.name === 'Vikram Rao');
  check('the board shows them', !!fromSheet, (res.json.data || []).map(c => c.name));
  check('with the sheet\u2019s details on the row',
    fromSheet.current_location === 'Udaipur' && fromSheet.notice_period === 'Immediate', fromSheet);

  SENT.length = 0;
  res = await call('PUT', '/api/recruitment/candidates/' + fromSheet.id + '/status',
    { status: 'Rejected', sendEmail: true });
  check('and a letter can be sent to them like anybody else',
    res.json.success === true && SENT.length === 1, { ok: res.json.success, sent: SENT.length });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');

  server.close();
  await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  console.log('Test database dropped.');
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('\nHARNESS ERROR:', err); process.exit(2); });
