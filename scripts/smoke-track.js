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
// The checks below make more lookups than a customer ever would, and the
// limiter would answer 429 - which also reads as "not found" and would let
// the name checks pass for the wrong reason. Lifted high enough that the
// whole suite runs under it, and the one check that is about the limiter
// pushes past it deliberately at the end.
process.env.TRACK_MAX_PER_MIN = '32';

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
  await mk('K-900002', { design_approval_status_from_client: 'Final Approval For Production',
                         actual_2: new Date() });                                              // production
  await mk('K-900003', { status_4: 'Dispatched', actual_4: new Date(),
                         ups_dhl_fedex_tracking_number: '6654161953', courier: 'DHL' });         // dispatched
  await mk('K-900004', { design_approval_status_from_client: 'Cancel Order' });                  // cancelled

  // Approved, part way through the floor: one stage finished, one that was
  // never needed, the rest untouched.
  await mk('K-900005', {
    design_approval_status_from_client: 'Final Approval For Production',
    actual_2: new Date(),
    printing: 'Done', printing_actual_time: new Date(),
    dye_status: 'No Die',
  });
  // Approved long enough ago to be past the window four out of five finish in.
  await mk('K-900006', {
    design_approval_status_from_client: 'Final Approval For Production',
    actual_2: new Date(Date.now() - 40 * 86400000),
  });

  // The words the floor actually writes, taken from the orders rather than
  // imagined: stages that are not needed, a dropdown left on the column's
  // own label, and a real holdup that opens with the same letters.
  await mk('K-900007', {
    design_approval_status_from_client: 'Final Approval For Production',
    actual_2: new Date(),
    dye_status: 'No Dye',
    edges: 'No Edges',
    block_status: 'NO BLOCK',
    guest_name: 'No Guest List',
    printing: 'Dye Status',
    laser_cutting: 'DIE NOT RECEIVED',
  });

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('App on', BASE, '\n');

  // Both halves of the key, as the page sends them.
  let throttled = 0;
  const look = async (name, order) => {
    const r = await get('/track/api?order=' + encodeURIComponent(order) + '&name=' + encodeURIComponent(name));
    if (r.status === 429) throttled++;
    return r;
  };
  const stageOf = (list, label) => (list || []).find(s => s.label === label) || {};

  console.log('The page itself, with nobody logged in');
  let r = await get('/track');
  check('opens without a login', r.status === 200, r.status);
  check('and is not a redirect to /login', !/login/i.test(r.text.slice(0, 400)), r.status);
  check('asks for a name as well as a number',
    /id="t_name"/.test(r.text) && /id="t_id"/.test(r.text));

  console.log('\nThe name is half the key');
  r = await look('Client K-900001', 'K-900001');
  check('the right name opens it', r.json.success === true, r.json);
  r = await look('Somebody Else', 'K-900001');
  check('the wrong name does not', r.json.success === false, r.json);
  r = await get('/track/api?order=K-900001');
  check('and no name at all does not', r.json.success === false, r.json);
  // Order numbers run in sequence, so without this the whole book is
  // readable by counting upwards.
  check('which is what stops somebody walking the numbers',
    (await look('', 'K-900002')).json.success === false);

  console.log('\nTyped from memory');
  check('part of the name is enough', (await look('client k-900001', 'K-900001')).json.success === true);
  check('case and spacing do not matter',
    (await look('  CLIENT   K-900001 ', 'K-900001')).json.success === true);
  check('a space in the number still finds it',
    (await look('Client K-900001', ' k- 900001 ')).json.success === true);
  check('but two letters is not a name',
    (await look('Cl', 'K-900001')).json.success === false);

  console.log('\nThe nine stages');
  r = await look('Client K-900002', 'K-900002');
  check('all nine are reported', (r.json.data.production || []).length === 9,
    (r.json.data.production || []).length);
  check('an untouched stage waits rather than claiming to be pending',
    stageOf(r.json.data.production, 'Printing').state === 'waiting',
    stageOf(r.json.data.production, 'Printing'));

  r = await look('Client K-900005', 'K-900005');
  check('a finished stage is marked done',
    stageOf(r.json.data.production, 'Printing').state === 'done',
    stageOf(r.json.data.production, 'Printing'));
  check('and carries its date', !!stageOf(r.json.data.production, 'Printing').at,
    stageOf(r.json.data.production, 'Printing'));
  // "No die" is an answer, not an unfinished step.
  check('a stage that was never needed says so',
    stageOf(r.json.data.production, 'Die cutting').state === 'skipped',
    stageOf(r.json.data.production, 'Die cutting'));

  r = await look('Client K-900007', 'K-900007');
  const prod7 = r.json.data.production;
  check('"No Dye" is not needed, not in progress',
    stageOf(prod7, 'Die cutting').state === 'skipped', stageOf(prod7, 'Die cutting'));
  check('nor is "No Edges"',
    stageOf(prod7, 'Edges').state === 'skipped', stageOf(prod7, 'Edges'));
  check('nor "NO BLOCK"',
    stageOf(prod7, 'Block printing').state === 'skipped', stageOf(prod7, 'Block printing'));
  check('nor "No Guest List"',
    stageOf(prod7, 'Guest list (GNA)').state === 'skipped', stageOf(prod7, 'Guest list (GNA)'));
  // An untouched dropdown reads back as the column's own name.
  check('a dropdown nobody touched still waits',
    stageOf(prod7, 'Printing').state === 'waiting', stageOf(prod7, 'Printing'));
  // But a real holdup opens with the same letters and must not be swallowed.
  check('"DIE NOT RECEIVED" is a holdup, not a stage to skip',
    stageOf(prod7, 'Laser cutting').state === 'doing', stageOf(prod7, 'Laser cutting'));

  console.log('\nThe estimate');
  r = await look('Client K-900001', 'K-900001');
  check('before approval it says the clock has not started',
    r.json.data.estimate && r.json.data.estimate.kind === 'waiting-on-you', r.json.data.estimate);
  r = await look('Client K-900002', 'K-900002');
  check('after approval it gives dates',
    r.json.data.estimate && r.json.data.estimate.kind === 'on-the-way', r.json.data.estimate);
  r = await look('Client K-900006', 'K-900006');
  check('an order long past its window says so rather than a date',
    r.json.data.estimate && r.json.data.estimate.kind === 'running-late', r.json.data.estimate);
  r = await look('Client K-900003', 'K-900003');
  check('a dispatched order needs no estimate', r.json.data.estimate === null, r.json.data.estimate);

  // Many of the older orders went out with the approval column blank.
  console.log('\nOnce it has gone');
  r = await look('Client K-900003', 'K-900003');
  const before3 = r.json.data.before;
  check('a dispatched order is not still waiting on approval',
    stageOf(before3, 'Approved by you').state === 'done', stageOf(before3, 'Approved by you'));
  check('nor on a proof',
    stageOf(before3, 'Design proof ready').state === 'done', stageOf(before3, 'Design proof ready'));
  // A tick beside the word "Pending" is the same contradiction in small type.
  check('nor does a settled stage still say Pending underneath',
    (r.json.data.production || []).every(st => !/pending/i.test(st.note || '')),
    (r.json.data.production || []).filter(st => /pending/i.test(st.note || '')));
  check('nor does a workshop stage still read pending',
    (r.json.data.production || []).every(st => st.state === 'done' || st.state === 'skipped'),
    (r.json.data.production || []).filter(st => st.state !== 'done' && st.state !== 'skipped'));

  console.log('\nDispatch and cancellation');
  check('a sent order carries its docket',
    (await look('Client K-900003', 'K-900003')).json.data.docket === '6654161953');
  check('a cancelled order says so',
    (await look('Client K-900004', 'K-900004')).json.data.cancelled === true);

  console.log('\nWhat it refuses to say');
  r = await look('Client K-900001', 'K-900001');
  const body = JSON.stringify(r.json);
  check('no dealer name', !/Secret Dealer/.test(body), body);
  check('no email address', !/x@y\.com/.test(body), body);
  check('a docket only once it has gone', !/6654161953/.test(body), body);

  console.log('\nFishing for order numbers');
  const a = await look('Anybody', 'K-999999');
  const b = await look('Client K-900001', 'K-999998');
  const c2 = await look('Wrong Name', 'K-900001');
  check('a missing number, a wrong number and a wrong name all answer alike',
    a.json.error === b.json.error && b.json.error === c2.json.error,
    [a.json.error, b.json.error, c2.json.error]);

  console.log('\nWalking the numbers');
  let blocked = 0;
  for (let i = 0; i < 20; i++) {
    const x = await look('Client K-900001', 'K-90000' + (i % 4 + 1));
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
