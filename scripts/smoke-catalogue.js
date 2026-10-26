/**
 * Drives the design catalogue: the admin half behind a login, the public
 * half with none, and the line between them.
 *
 * The check that matters most is that a hidden design does not travel to the
 * browser at all - 'not displayed' is not hidden when the reply is one
 * right-click away.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_catalogue_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

const mailerPath = require.resolve(path.join(ROOT, 'utils/mailer.js'));
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendMail: async () => ({ sent: true }), verifyMail: async () => ({ ok: true }), isMailConfigured: () => true },
};

let BASE = '';
const get = async (url) => {
  const res = await fetch(BASE + url, { headers: { 'X-Forwarded-Proto': 'https' }, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text };
};

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

// Logging in, which the admin half needs and the public half must not.
let COOKIE = '';
async function login() {
  const db = require(path.join(ROOT, 'config/db.js'));
  const res = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' },
    body: 'email=probe%40test.local&password=probe-pass-123',
  });
  COOKIE = (res.headers.get('set-cookie') || '').split(';')[0];
  // express-session flushes the response before the store write finishes.
  const sid = decodeURIComponent(COOKIE.replace(/^connect\.sid=/, '')).replace(/^s:/, '').split('.')[0];
  for (let i = 0; i < 100 && sid; i++) {
    const [[row]] = await db.query('SELECT data FROM sessions WHERE session_id = ?', [sid]);
    if (row && /"user"/.test(row.data || '')) break;
    await new Promise(d => setTimeout(d, 20));
  }
}

const asAdmin = async (method, url, body, isForm) => {
  const opts = { method, headers: { Cookie: COOKIE, 'X-Forwarded-Proto': 'https' }, redirect: 'manual' };
  if (body && isForm) opts.body = body;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text };
};

// A one-pixel PNG, so the suite carries its own picture rather than reaching
// for a file that may not be there.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

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
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('App on', BASE, '\n');

  console.log('The admin half is shut without a login');
  let r = await get('/api/catalogue');
  check('listing is refused', r.status === 401 || r.status === 403, r.status);
  r = await asAdmin('POST', '/api/catalogue');
  check('adding is refused', r.status === 401 || r.status === 403, r.status);

  await login();

  console.log('\nAdding a design');
  const form = new FormData();
  form.append('category', 'Motifs');
  form.append('name', 'Peacock border');
  form.append('code', 'MTF-021');
  form.append('image', new Blob([PNG], { type: 'image/png' }), 'peacock.png');
  r = await asAdmin('POST', '/api/catalogue', form, true);
  check('it goes in', r.json && r.json.success === true, r.json);
  const liveId = r.json.id;

  const hidden = new FormData();
  hidden.append('category', 'Patterns');
  hidden.append('name', 'Not for customers');
  hidden.append('code', 'SECRET-1');
  hidden.append('image', new Blob([PNG], { type: 'image/png' }), 'secret.png');
  r = await asAdmin('POST', '/api/catalogue', hidden, true);
  const hiddenId = r.json.id;
  await asAdmin('PUT', '/api/catalogue/' + hiddenId, { isActive: false });

  const bad = new FormData();
  bad.append('category', 'Motifs');
  bad.append('image', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'x.pdf');
  r = await asAdmin('POST', '/api/catalogue', bad, true);
  check('a PDF is refused - this is a gallery', r.json.success === false, r.json);

  const noCat = new FormData();
  noCat.append('category', 'Nonsense');
  noCat.append('image', new Blob([PNG], { type: 'image/png' }), 'x.png');
  r = await asAdmin('POST', '/api/catalogue', noCat, true);
  check('an unknown category is refused', r.json.success === false, r.json);

  console.log('\nThe public page, with nobody logged in');
  r = await get('/catalogue');
  check('opens without a login', r.status === 200, r.status);
  r = await get('/catalogue/api/items');
  check('lists the live design', r.json.success && r.json.data.length === 1, r.json);
  check('and names it', r.json.data[0].name === 'Peacock border', r.json.data);

  const body = JSON.stringify(r.json);
  check('the hidden one is not in the reply at all',
    !/SECRET-1/.test(body) && !/Not for customers/.test(body), body);

  console.log('\nThe pictures');
  r = await get('/catalogue/image/' + liveId);
  check('a live picture is served', r.status === 200, r.status);
  r = await get('/catalogue/image/' + hiddenId);
  check('a hidden one is not, even by its id', r.status === 404, r.status);
  r = await get('/catalogue/image/999999');
  check('and a missing one answers the same way, so ids cannot be fished for',
    r.status === 404, r.status);

  console.log('\nShowing it again');
  await asAdmin('PUT', '/api/catalogue/' + hiddenId, { isActive: true });
  r = await get('/catalogue/api/items');
  check('it comes back on the public page', r.json.data.length === 2, r.json.data.length);

  console.log('\nDeleting');
  r = await asAdmin('DELETE', '/api/catalogue/' + hiddenId);
  check('it goes', r.json.success === true, r.json);
  r = await get('/catalogue/api/items');
  check('and the public page is down to one', r.json.data.length === 1, r.json.data.length);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
