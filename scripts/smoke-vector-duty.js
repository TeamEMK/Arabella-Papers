/**
 * The vector-file rule, driven against a throwaway database.
 *
 * The thing worth proving here is not that the count is right - it is that
 * the rule cannot trap somebody. A gate on the way out of a system is the
 * kind of feature that, wrong, stops the whole office going home, so most of
 * what follows is about what it must NOT hold: orders from before the start
 * date, orders with nobody named on them, orders punched this evening, and
 * anybody at all when the database is unwell.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_vector_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.CRON_SECRET = 'probe-cron-secret';

// The mailer is stubbed, so the report can be read rather than posted.
let sent = [];
const mailerPath = require.resolve(path.join(ROOT, 'utils/mailer.js'));
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async (m) => { sent.push(m); return { sent: true }; },
    verifyMail: async () => ({ ok: true }),
    isMailConfigured: () => true,
  },
};

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

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
  const duty = require(path.join(ROOT, 'utils/vectorDuty.js'));
  const report = require(path.join(ROOT, 'utils/vectorReport.js'));

  const today = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 86400000));
  const longAgo = ymd(new Date(Date.now() - 90 * 86400000));

  const setRule = (v) => db.query(
    `INSERT INTO app_settings (name, value, updated_by) VALUES (?, ?, 'probe')
     ON DUPLICATE KEY UPDATE value = VALUES(value)`, [duty.SETTING, v]);

  // `at` is a full datetime so the evening cutoff can be aimed at.
  const mk = async (id, designer, at, extra) => {
    const cols = Object.assign({ india_designer: designer, timestamp: at }, extra || {});
    const keys = Object.keys(cols);
    await db.query(
      `INSERT INTO orders (order_id, client_name, ${keys.join(',')})
       VALUES (?,?${keys.map(() => ',?').join('')})`,
      [id, 'Client ' + id, ...keys.map(k => cols[k])]);
  };
  const vectorFor = (id) => db.query(
    `INSERT INTO order_vector_files (order_id, version, file_url, file_name, uploaded_by)
     VALUES (?, 1, 'http://x/y.ai', 'y.ai', 'probe')`, [id]);

  const RAKESH = { username: 'Rakesh', role: 'India Designer', domain: '', email: 'rakesh@test.local' };

  console.log('The rule is off until somebody dates it');
  await setRule('');
  await mk('V-1', 'Rakesh', yesterday + ' 10:00:00');
  let r = await duty.pendingFor(RAKESH);
  check('no date means nobody is held', r.count === 0 && r.on === false, r);

  console.log('\nWhat it counts once it is on');
  await setRule(longAgo);
  r = await duty.pendingFor(RAKESH);
  check('an order with no vector file counts', r.count === 1, r);
  check('and says which one', r.orders[0].orderId === 'V-1', r.orders);
  await vectorFor('V-1');
  r = await duty.pendingFor(RAKESH);
  check('uploading the file clears it', r.count === 0, r);

  console.log('\nThe start date');
  // The reason this exists: 7,828 orders predate the upload button.
  await mk('V-OLD', 'Rakesh', '2020-01-01 10:00:00');
  await setRule(longAgo);
  r = await duty.pendingFor(RAKESH);
  check('an order from before the start date is not held against anybody', r.count === 0, r);
  await setRule('2019-01-01');
  r = await duty.pendingFor(RAKESH);
  check('and is, if the date is moved back', r.count === 1, r);
  await setRule(longAgo);

  console.log('\nOrders nobody is named on');
  await mk('V-OTHER', 'Other', yesterday + ' 10:00:00');
  await mk('V-BLANK', '', yesterday + ' 10:00:00');
  await mk('V-LOCAL', 'local order', yesterday + ' 10:00:00');
  const all = await duty.pendingByDesigner();
  const named = all.rows.map(x => x.designer);
  check('"Other" is not a person', named.indexOf('Other') < 0, named);
  check('nor is a blank', named.every(n => String(n || '').trim() !== ''), named);
  check('nor "local order"', named.indexOf('local order') < 0, named);

  console.log('\nThe evening cutoff');
  // An order punched at five to six is not something somebody failed to do.
  await mk('V-TONIGHT', 'Rakesh', today + ' 23:30:00');
  r = await duty.pendingFor(RAKESH);
  check('an order punched this evening is not held against today',
    r.orders.every(o => o.orderId !== 'V-TONIGHT'), r.orders);
  // Same order, yesterday evening: by now it is overdue.
  await mk('V-LASTNIGHT', 'Rakesh', yesterday + ' 23:30:00');
  r = await duty.pendingFor(RAKESH);
  check('but the same order a day later is',
    r.orders.some(o => o.orderId === 'V-LASTNIGHT'), r.orders);

  // Somebody carrying work from more than one day, which is the case the
  // single "oldest" date used to flatten.
  const d2 = ymd(new Date(Date.now() - 2 * 86400000));
  const d3 = ymd(new Date(Date.now() - 3 * 86400000));
  await mk('V-D1', 'Dinesh', d3 + ' 10:00:00');
  await mk('V-D2', 'Dinesh', d2 + ' 10:00:00');
  await mk('V-D3', 'Dinesh', d2 + ' 15:00:00');
  await mk('V-D4', 'Dinesh', yesterday + ' 10:00:00');

  console.log('\nWhose order is whose');
  await mk('V-ARUSHI', 'Arushi', yesterday + ' 10:00:00');
  r = await duty.pendingFor(RAKESH);
  check('one designer is not held for another\'s work',
    r.orders.every(o => o.orderId !== 'V-ARUSHI'), r.orders);
  r = await duty.pendingFor({ username: 'arushi' });
  check('and the name matches whatever the case', r.count === 1, r);
  // Overseas designers are held to the same rule.
  await db.query(`INSERT INTO orders (order_id, client_name, overseas_designer, timestamp)
                  VALUES ('V-SEA', 'Client V-SEA', 'Cassie', ?)`, [yesterday + ' 10:00:00']);
  r = await duty.pendingFor({ username: 'Cassie' });
  check('an overseas designer counts too', r.count === 1, r);

  console.log('\nA cancelled order is not work outstanding');
  await mk('V-DEAD', 'Rakesh', yesterday + ' 10:00:00',
    { design_approval_status_from_client: 'Cancel Order' });
  r = await duty.pendingFor(RAKESH);
  check('a cancelled order stops counting',
    r.orders.every(o => o.orderId !== 'V-DEAD'), r.orders);

  console.log('\nThe way out');
  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  // VERCEL=1 above makes the session cookie `secure`, so every request has to
  // look like it arrived over https or no cookie is ever set - which reads
  // exactly like a logout gate that does not work.
  const HTTPS = { 'X-Forwarded-Proto': 'https' };
  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({}, HTTPS, opts.headers || {});
    opts.redirect = opts.redirect || 'manual';
    return fetch(BASE + url, opts);
  };

  const login = async () => {
    const res = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  };

  // The seeded admin owns nothing, so give them a name that does.
  await db.query(`UPDATE users SET username = 'Rakesh' WHERE email = ?`, [process.env.ADMIN_EMAIL]);
  let jar = await login();

  let out = await go('/logout', { method: 'POST', headers: { cookie: jar, accept: 'application/json' } });
  check('logout is refused while files are owed', out.status === 409, out.status);
  const body = await out.json();
  check('and says how many', body.count > 0, body);
  check('and which', Array.isArray(body.orders) && body.orders.length === body.count, body.orders && body.orders.length);

  // The GET is a plain link; leaving it open would make the whole thing
  // a suggestion.
  out = await go('/logout', { headers: { cookie: jar } });
  check('the plain logout link is held too', out.status === 302
    && /vectors=due/.test(out.headers.get('location') || ''), out.headers.get('location'));

  const peek = await (await go('/api/account/vector-pending', { headers: { cookie: jar } })).json();
  check('the app can ask what it owes', peek.success && peek.count > 0, peek.count);

  // Clear them all and the door opens.
  const [owed] = await db.query(
    `SELECT order_id FROM orders WHERE LOWER(india_designer) = 'rakesh' OR LOWER(overseas_designer) = 'rakesh'`);
  for (const o of owed) await vectorFor(o.order_id).catch(() => {});
  out = await go('/logout', { method: 'POST', headers: { cookie: jar, accept: 'application/json' } });
  check('and lets go once the files are in', out.status === 302, out.status);

  console.log('\nIt must never be the reason nobody can leave');
  // Somebody with no orders at all - most of the office - is never held.
  jar = await login();
  await db.query(`UPDATE users SET username = 'Nobody At All' WHERE email = ?`, [process.env.ADMIN_EMAIL]);
  jar = await login();
  out = await go('/logout', { method: 'POST', headers: { cookie: jar, accept: 'application/json' } });
  check('somebody with no orders walks straight out', out.status === 302, out.status);

  console.log('\nThe seven o\'clock mail');
  await setRule(longAgo);
  sent = [];
  let res = await report.sendVectorReport();
  check('it goes when somebody is behind', sent.length === 1, res);
  check('to both owners',
    /amita@arabellapapers\.com/.test(sent[0].to) && /sagar@arabellapapers\.com/.test(sent[0].to), sent[0] && sent[0].to);
  check('naming the designer', /Arushi/.test(sent[0].html), (sent[0] || {}).subject);
  // Four orders from one afternoon and four spread over three days are not
  // the same message, and the mail has to be able to tell them apart.
  const spread = (await duty.pendingByDesigner()).rows.find(r => r.designer === 'Dinesh');
  check('a designer is split by the day the orders came in',
    Array.isArray(spread.days) && spread.days.length === spread.dayCount, spread);
  check('four orders over three days reads as three days',
    spread.count === 4 && spread.dayCount === 3, { count: spread.count, days: spread.dayCount });
  check('and every order is in exactly one of those days',
    spread.days.reduce((n, d) => n + d.count, 0) === spread.count, spread.days);
  check('the mail carries the dates, not just a count',
    spread.days.every(d => sent[0].html.indexOf(d.date) >= 0), spread.days.map(d => d.date));
  check('and never an order nobody is named on',
    !/V-OTHER|V-BLANK|V-LOCAL/.test(sent[0].html), 'unnamed order leaked into the mail');
  check('nor one punched this evening', !/V-TONIGHT/.test(sent[0].html), 'tonight leaked in');

  sent = [];
  await setRule('');
  res = await report.sendVectorReport();
  check('and not at all when the rule is off', sent.length === 0 && res.reason === 'rule-off', res);

  // A mail that mostly says "all clear" stops being opened.
  await setRule('2099-01-01');
  sent = [];
  res = await report.sendVectorReport();
  check('nor on a day when nobody is behind',
    sent.length === 0 && res.reason === 'nothing-pending', res);

  console.log('\nThe scheduled call is not a public button');
  await setRule(longAgo);
  let c = await go('/api/cron/vector-report');
  check('a stranger cannot set it off', c.status === 401, c.status);
  c = await go('/api/cron/vector-report', { headers: { authorization: 'Bearer wrong' } });
  check('nor with the wrong secret', c.status === 401, c.status);
  sent = [];
  c = await go('/api/cron/vector-report',
    { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
  check('the scheduler can', c.status === 200 && sent.length === 1, c.status);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
