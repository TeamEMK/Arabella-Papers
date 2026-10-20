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
    header === 'Sr. No,Name,Contact Number,Email,Position,Status,Location,Expected Salary,Notice Period,Sourcing', header);

  res = await call('GET', '/api/bulk/columns/candidates');
  const statusCol = res.json.columns.find(c => c.key === 'status');
  // Deliberately not a closed set any more: the column takes call outcomes,
  // and printing the seven stages as "the values this takes" would send the
  // office off to rewrite a column the import already understands.
  check('the status column is not presented as a fixed list',
    statusCol.allowed === null, statusCol.allowed);
  check('only Name is required',
    res.json.columns.filter(c => c.required).map(c => c.header).join(', ') === 'Name',
    res.json.columns.filter(c => c.required).map(c => c.header));

  // A sheet of their own, and specifically the shape the office's real list
  // turned out to be: their header spellings, a sourcing column, a blank
  // status, a row with a phone number and no address, and a Status column
  // holding the outcome of a phone call rather than a stage. Plus the same
  // person twice, which is the one thing that should still be dropped.
  const sheet = [
    'Sr. No,Candidate Name,Contact no,Email ID,Position applied for,Stage,Current Location,Expected CTC,Notice,Sourcing',
    '1,Meera Joshi,9876500021,meera@example.com,Accounts Executive,offer sent,Jaipur,5 LPA,30 days,Indeed',
    '2,Vikram Rao,9876500022,vikram@example.com,Designer,,Udaipur,,Immediate,',
    '3,No Address,9876500023,,Designer,Selected,Kota,,,Naukri',
    '4,Said No,9876500024,no@example.com,Designer,not interested (location issue),Jaipur,,,',
    '5,Still Ringing,9876500025,ring@example.com,Designer,not responding,Jaipur,,,',
    '6,Meera Joshi,9876500021,meera@example.com,Accounts Executive,Selected,Jaipur,5 LPA,30 days,Indeed',
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
  // Not Scheduled: nothing is arranged for them, and a row that says it is
  // while the Interview column is empty is a row telling two stories.
  check('a blank status becomes Applied', line(3).data.status === 'Applied', line(3).data);
  // The row that used to be thrown out. 87 of the office's 206 rows look like
  // this - a name and a number off a job board - and refusing them kept 42% of
  // a real list out of the system to protect a letter nobody was sending.
  check('a row with only a phone number is accepted',
    (line(4).errors || []).length === 0, line(4).errors);
  check('a decline is read as Rejected', line(5).data.status === 'Rejected', line(5).data);
  check('and the caller\'s own wording is kept',
    line(5).data.statusRaw === 'not interested (location issue)', line(5).data);
  // The distinction the whole mapping turns on: nobody declined, the call just
  // did not happen. Filing these as Rejected would quietly throw away the
  // forty people the office has not actually spoken to yet.
  check('but an unanswered call stays Applied', line(6).data.status === 'Applied', line(6).data);
  check('an interpreted status is flagged, not silently applied',
    (line(6).warnings || []).some(w => /Read "not responding" as Applied/.test(w)), line(6).warnings);

  SENT.length = 0;
  res = await call('POST', '/api/bulk/import', { type: 'candidates', rows });
  // Five, not six: the last line is line 2 again, and the same mailbox twice
  // in one file is the file having the person twice.
  check('every usable row imports', res.json.success === true && res.json.imported === 5,
    { imported: res.json.imported, rejected: res.json.rejected });
  check('and nothing is rejected', (res.json.rejected || []).length === 0, res.json.rejected);
  // The point of the whole thing: this is an existing list arriving, not a
  // hiring round starting.
  check('and not one letter goes out', SENT.length === 0, SENT.map(s => s.subject));

  const [landed] = await db.query(
    `SELECT name, email, status, current_location, notice_period, salary,
            sourcing, internal_remark, created_by
       FROM recruit_candidates WHERE is_deleted = 0 ORDER BY name`);
  check('five people landed', landed.length === 5, landed.map(r => r.name));
  const meera = landed.find(r => r.name === 'Meera Joshi') || {};
  check('the new columns are filled in',
    meera.current_location === 'Jaipur' && meera.notice_period === '30 days' && meera.salary === '5 LPA', meera);
  check('the status came across', meera.status === 'Offer Sent', meera.status);
  check('sourcing came across', meera.sourcing === 'Indeed', meera.sourcing);
  // Nothing to explain: the cell already named a stage, so a remark repeating
  // it would be noise on every row the office had filled in properly.
  check('a literal stage leaves no remark behind', meera.internal_remark === null, meera.internal_remark);

  const said = landed.find(r => r.name === 'Said No') || {};
  check('the decline landed as Rejected', said.status === 'Rejected', said.status);
  check('with the call note kept against the person',
    said.internal_remark === 'not interested (location issue)', said.internal_remark);

  const phoneOnly = landed.find(r => r.name === 'No Address') || {};
  check('the phone-only candidate is on the list with a blank address',
    phoneOnly.email === '', JSON.stringify(phoneOnly.email));
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

  // ══════════════════════════════════════════════════
  // Applied, and what moves a row out of it
  // ══════════════════════════════════════════════════
  console.log('\nThe Applied stage');

  const statusOf = async (id) =>
    (await db.query('SELECT status FROM recruit_candidates WHERE id = ?', [id]))[0][0].status;

  SENT.length = 0;
  res = await call('POST', '/api/recruitment/candidates',
    { name: 'No Date Yet', email: 'nodate@example.com', sendEmail: true });
  const quietId = res.json.data.id;
  check('a candidate with no date starts as Applied', await statusOf(quietId) === 'Applied',
    await statusOf(quietId));
  check('and nobody is written to', SENT.length === 0, SENT);

  res = await call('POST', '/api/recruitment/candidates',
    { name: 'Has A Date', email: 'hasdate@example.com', interview_date: '2026-12-01',
      interview_time: '10:00', sendEmail: false });
  check('one booked with a date starts as Scheduled',
    await statusOf(res.json.data.id) === 'Scheduled', await statusOf(res.json.data.id));

  // Putting a date on somebody who was only on the list schedules them.
  await call('PUT', '/api/recruitment/candidates/' + quietId,
    { name: 'No Date Yet', email: 'nodate@example.com', interview_date: '2026-12-05', interview_time: '11:00' });
  check('setting a date moves them to Scheduled', await statusOf(quietId) === 'Scheduled',
    await statusOf(quietId));

  // But it must never drag a later stage backwards.
  await call('PUT', '/api/recruitment/candidates/' + quietId + '/status',
    { status: 'Selected', sendEmail: false });
  await call('PUT', '/api/recruitment/candidates/' + quietId,
    { name: 'No Date Yet', email: 'nodate@example.com', interview_date: '2026-12-06' });
  check('correcting a date does not drag Selected backwards', await statusOf(quietId) === 'Selected',
    await statusOf(quietId));

  // ══════════════════════════════════════════════════
  // Putting a CV on somebody already on the board
  // ══════════════════════════════════════════════════
  console.log('\nThe CV');

  // Give them an interviewer first, so there is somebody to send it to.
  await call('PUT', '/api/recruitment/candidates/' + quietId,
    { name: 'No Date Yet', email: 'nodate@example.com', interview_date: '2026-12-06',
      interviewer_email: 'panel@arabellapapers.com' });

  const cvUpload = (name, notify) => {
    const f = new FormData();
    f.append('resume_file', new Blob([Buffer.alloc(1800, 4)], { type: 'application/pdf' }), name);
    if (notify) f.append('notifyInterviewer', 'true');
    return call('POST', '/api/recruitment/candidates/' + quietId + '/cv', f, true);
  };

  SENT.length = 0;
  res = await cvUpload('quiet-cv.pdf', false);
  check('a CV goes on from the edit dialog', res.json.success === true, res.json);
  check('and nothing is sent unless it is asked for',
    SENT.length === 0 && res.json.data.sent === null, [SENT.length, res.json.data]);

  const [[onFile]] = await db.query(
    "SELECT file_name, size_bytes FROM recruit_files WHERE candidate_id = ? AND field = 'resume_file'", [quietId]);
  check('it is kept on the record', onFile.file_name === 'quiet-cv.pdf' && onFile.size_bytes === 1800, onFile);

  SENT.length = 0;
  res = await cvUpload('to-the-panel.pdf', true);
  check('ticking the box sends it to the interviewer',
    res.json.data.sent === true && SENT.length === 1 && SENT[0].to === 'panel@arabellapapers.com',
    { sent: res.json.data, to: SENT.map(s => s.to) });
  check('with the CV attached',
    SENT[0].attachments.some(a => a.filename === 'to-the-panel.pdf'),
    SENT[0].attachments.map(a => a.filename));

  res = await call('GET', '/api/recruitment/candidates/' + quietId + '/joining-details');
  check('and the panel lists it under Documents',
    (res.json.data.files || []).some(f => f.field === 'resume_file'), res.json.data.files);

  const notACv = new FormData();
  notACv.append('resume_file', new Blob([Buffer.alloc(40, 1)], { type: 'application/x-msdownload' }), 'cv.exe');
  res = await call('POST', '/api/recruitment/candidates/' + quietId + '/cv', notACv, true);
  check('an executable is refused', res.status === 400 && /PDF/.test(res.json.error), res.json);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');

  server.close();
  await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  console.log('Test database dropped.');
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('\nHARNESS ERROR:', err); process.exit(2); });
