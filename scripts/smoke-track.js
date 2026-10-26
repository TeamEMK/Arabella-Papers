/**
 * Drives the public tracking page against a throwaway database, with no
 * login anywhere - which is the whole point of it, and therefore the thing
 * worth proving rather than assuming.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_track_probe';
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

  // Four orders, one at each stage.
  const mk = async (id, cols) => {
    const keys = Object.keys(cols);
    await db.query(
      `INSERT INTO orders (order_id, client_name, dealer_name, email_address${keys.length ? ',' + keys.join(',') : ''})
       VALUES (?,?,?,?${keys.map(() => ',?').join('')})`,
      [id, 'Client ' + id, 'Secret Dealer', 'x@y.com', ...keys.map(k => cols[k])]);
  };
  await mk('K-900001', {});                                                   // design
  await mk('K-900002', { design_approval_status_from_client: 'Final Approval For Production' }); // production
  await mk('K-900003', { status_4: 'Dispatched', actual_4: new Date(),
                         ups_dhl_fedex_tracking_number: '6654161953', courier: 'DHL' });         // dispatched
  await mk('K-900004', { design_approval_status_from_client: 'Cancel Order' });                  // cancelled

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('App on', BASE, '\n');

  console.log('The page itself, with nobody logged in');
  let r = await get('/track');
  check('opens without a login', r.status === 200, r.status);
  check('and is not a redirect to /login', !/login/i.test(r.text.slice(0, 400)), r.status);
  check('carries the order box', /id="t_id"/.test(r.text));

  console.log('\nLooking an order up');
  r = await get('/track/api/K-900001');
  check('a fresh order reads as design',
    r.json.success && r.json.data.stage === 'design', r.json);
  check('and the customer sees their own name',
    r.json.data.client === 'Client K-900001', r.json.data.client);

  r = await get('/track/api/K-900002');
  check('an approved order reads as production', r.json.data.stage === 'production', r.json.data);
  check('with production ticked',
    r.json.data.steps.filter(s => s.done).length === 3, r.json.data.steps);

  r = await get('/track/api/K-900003');
  check('a sent order reads as dispatched', r.json.data.stage === 'dispatched', r.json.data);
  check('and carries the docket', r.json.data.docket === '6654161953', r.json.data);

  r = await get('/track/api/K-900004');
  check('a cancelled order says so', r.json.data.cancelled === true, r.json.data);

  console.log('\nWhat it refuses to say');
  r = await get('/track/api/K-900001');
  const body = JSON.stringify(r.json);
  check('no dealer name', !/Secret Dealer/.test(body), body);
  check('no email address', !/x@y\.com/.test(body), body);
  check('a docket only once it has gone', !/6654161953/.test(body), body);

  console.log('\nTyping it badly');
  r = await get('/track/api/' + encodeURIComponent(' k- 900001 '));
  check('a space in the number still finds it',
    r.json.success && r.json.data.orderId === 'K-900001', r.json);

  r = await get('/track/api/K-999999');
  check('an unknown number is refused', r.json.success === false, r.json);
  r = await get('/track/api/K-900001');
  const miss = await get('/track/api/K-999998');
  check('and says the same thing as a real one would, so numbers cannot be fished for',
    miss.json.error === (await get('/track/api/K-999997')).json.error, miss.json);

  console.log('\nWalking the numbers');
  let blocked = 0;
  for (let i = 0; i < 20; i++) {
    const x = await get('/track/api/K-90000' + (i % 4 + 1));
    if (x.status === 429) blocked++;
  }
  check('guessing in bulk gets cut off', blocked > 0, { blocked });

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
