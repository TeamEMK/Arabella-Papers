/**
 * "Proofing Done needs the vector file" — on every route that can set it.
 *
 * The rule shipped guarding one door. Four routes write that status, and the
 * two on the Orders Dashboard - where most of the office works - were never
 * checked, so the rule did nothing for most people who met it.
 *
 * So this suite is written the other way round from the usual one: it starts
 * by finding every route that can write the status and then insists each of
 * them refuses. A check that names only the doors somebody remembered is the
 * same mistake again.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_vgate_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

for (const mod of ['utils/mailer.js', 'utils/drive.js']) {
  const p = require.resolve(path.join(ROOT, mod));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: mod.endsWith('mailer.js')
      ? { sendMail: async () => ({ sent: true }), verifyMail: async () => ({ ok: true }), isMailConfigured: () => true }
      : { uploadToDrive: async () => 'https://drive.test/file' },
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

  console.log('Every route that can write the status');
  // Read off the source rather than listed by hand. A new route that sets
  // the status and forgets the gate shows up here as a failing count, which
  // is exactly how this was missed the first time.
  const writers = [];
  for (const file of ['routes/api/orders.js', 'routes/api/dashboards.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (/design_approval_status_from_client\s*[:=]/.test(l) && !/SELECT|FROM|WHERE|--|\*/.test(l)) {
        writers.push(file + ':' + (i + 1));
      }
    });
  }
  console.log('      ' + writers.join('\n      '));
  const gated = ['routes/api/orders.js', 'routes/api/dashboards.js']
    .every(f => /vectorGate\.blockProofing/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('both routers go through the shared gate', gated);

  const mk = (id) => db.query(
    `INSERT INTO orders (order_id, client_name, india_designer, design_status)
     VALUES (?,?,?,?)`, [id, 'Client ' + id, 'Rakesh', 'Fresh Design']);
  const vectorFor = (id) => db.query(
    `INSERT INTO order_vector_files (order_id, version, file_url, file_name, uploaded_by)
     VALUES (?, 1, 'http://x/y.ai', 'y.ai', 'probe')`, [id]);
  const statusOf = async (id) => {
    const [[r]] = await db.query(
      'SELECT design_approval_status_from_client AS s FROM orders WHERE order_id = ?', [id]);
    return r.s;
  };

  for (const id of ['G-1', 'G-2', 'G-3', 'G-4', 'G-5', 'G-6']) await mk(id);
  await vectorFor('G-2');
  await vectorFor('G-4');
  await vectorFor('G-6');

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const HTTPS = { 'X-Forwarded-Proto': 'https' };
  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({}, HTTPS, opts.headers || {});
    opts.redirect = opts.redirect || 'manual';
    return fetch(BASE + url, opts);
  };
  const out = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const jar = (out.headers.get('set-cookie') || '').split(';')[0];

  // ── The Orders Dashboard's own Design Status box ──
  // This is the one that was open. It takes a multipart form.
  const setStatus = async (id, status) => {
    const form = new FormData();
    form.append('designStatus', status);
    form.append('remark', 'probe');
    form.append('userEmail', process.env.ADMIN_EMAIL);
    const res = await go('/api/orders/' + id + '/status', { method: 'PUT', headers: { cookie: jar }, body: form });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  console.log('\nThe Orders Dashboard — Design Status');
  let r = await setStatus('G-1', 'Proofing Done');
  check('refused with no vector file', r.status === 400, r);
  check('and the order was not changed', (await statusOf('G-1')) !== 'Proofing Done', await statusOf('G-1'));
  r = await setStatus('G-2', 'Proofing Done');
  check('allowed once one is attached', r.json && r.json.success === true, r);
  check('and the order says so', (await statusOf('G-2')) === 'Proofing Done', await statusOf('G-2'));
  // A designer must still be able to record progress.
  r = await setStatus('G-3', 'Fresh Design');
  check('a designer can still record Fresh Design without one', r.json && r.json.success === true, r);
  // The side door: every status except Cancelled used to write "Proofing
  // Done" into the CLIENT's field as well, which walked straight past a gate
  // that only watches the Proofing Done button.
  check('and that does not claim the client has a proof',
    (await statusOf('G-3')) !== 'Proofing Done', await statusOf('G-3'));
  r = await setStatus('G-5', 'Cancelled');
  check('and can still cancel', r.json && r.json.success === true, r);

  console.log('\nThe Orders Dashboard — Bulk Update');
  const bulk = async (rows) => {
    const res = await go('/api/orders/bulk-status', {
      method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: rows }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  r = await bulk([{ id: 'G-4', status: 'Proofing Done' }, { id: 'G-6', status: 'Proofing Done' }]);
  check('a batch where every order has artwork goes through', r.json && r.json.success === true, r);
  r = await bulk([{ id: 'G-4', status: 'Proofing Done' }, { id: 'G-3', status: 'Proofing Done' }]);
  check('one without stops the batch', r.status === 400, r);
  check('and it is named, so somebody knows which to open',
    /G-3/.test((r.json || {}).error || ''), (r.json || {}).error);
  check('nothing in that batch was written',
    (await statusOf('G-3')) !== 'Proofing Done', await statusOf('G-3'));

  console.log('\nTill Approval — the door that was already guarded');
  const approve = async (id, status) => {
    const form = new FormData();
    form.append('approvalStatus', status);
    form.append('remark', 'probe');
    form.append('userEmail', process.env.ADMIN_EMAIL);
    const res = await go('/api/dashboards/till-approval/' + id,
      { method: 'PUT', headers: { cookie: jar }, body: form });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  r = await approve('G-1', 'Proofing Done');
  check('still refused with no vector file', r.status === 400, r);

  console.log('\nTill Approval — Bulk');
  const bulkApprove = async (rows) => {
    const res = await go('/api/dashboards/till-approval/bulk', {
      method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: rows }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  r = await bulkApprove([{ id: 'G-1', status: 'Proofing Done' }]);
  check('still refused there too', r.status === 400, r);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
