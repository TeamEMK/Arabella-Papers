/**
 * The Carlson Craft retailer board, against a throwaway database.
 *
 * The board is counts, and a count that is quietly wrong is worse than one
 * that is missing - nobody checks a number that looks plausible. So most of
 * what follows adds the board up a second way and insists the two agree.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_cc_probe';
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

  // Invented. The real list is seven thousand named businesses with their
  // phone numbers, and a test file in a repository is the wrong home for any
  // of it; these carry only the shapes the checks are about.
  const mk = (o) => {
    const keys = Object.keys(o);
    return db.query(
      `INSERT INTO cc_prospects (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map(k => o[k]));
  };
  const rows = [
    { retailer: 'Riverbend Press', state: 'New York', state_code: 'NY', region: 'Capital Region',
      city: 'Albany', zip: '12205', phone: '555-0100', email: 'hello@riverbend.example', store_type: 'Store' },
    { retailer: 'Thistle & Vane', state: 'New York', state_code: 'NY', region: 'Capital Region',
      city: 'Albany', zip: '12206', phone: '555-0101', email: null, store_type: 'Store' },
    { retailer: 'Marlowe Cards', state: 'New York', state_code: 'NY', region: 'Hudson Valley',
      city: 'Kingston', zip: '12401', phone: null, email: 'hi@marlowe.example', store_type: 'Online only' },
    { retailer: 'Quill & Press', state: 'Texas', state_code: 'TX', region: 'North Texas',
      city: 'Dallas', zip: '75201', phone: '555-0102', email: 'sales@quill.example', store_type: 'Store' },
    { retailer: 'Bluebonnet Paper', state: 'Texas', state_code: 'TX', region: 'Hill Country',
      city: 'Austin', zip: '78701', phone: null, email: null, store_type: 'Store' },
    { retailer: 'Aloha Invites', state: 'Hawaii', state_code: 'HI', region: 'Oahu',
      city: 'Honolulu', zip: '96813', phone: '555-0103', email: 'aloha@invites.example', store_type: 'Store' },
  ];
  for (const r of rows) await mk(r);

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Forwarded-Proto': 'https' };
  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({}, H, opts.headers || {});
    opts.redirect = opts.redirect || 'manual';
    return fetch(BASE + url, opts);
  };

  console.log('Not for whoever asks');
  let r = await go('/api/cc-prospects/board');
  check('seven thousand businesses of contact details need a login',
    r.status === 401 || r.status === 302, r.status);

  const out = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const jar = (out.headers.get('set-cookie') || '').split(';')[0];
  const get = async (url) => (await go(url, { headers: { cookie: jar } })).json();

  const { defaultSectionIds } = require(path.join(ROOT, 'utils/nav.js'));
  check('the floor is not offered the tab',
    !defaultSectionIds('India Designer', '').includes('ccProspects'));
  check('a head of department is',
    defaultSectionIds('Accounts', 'Head').includes('ccProspects'));
  const { SECTIONS } = require(path.join(ROOT, 'utils/nav.js'));
  check('and it sits in ASMP',
    (SECTIONS.find(s => s.id === 'ccProspects') || {}).group === 'ASMP');

  console.log('\nThe board');
  const board = await get('/api/cc-prospects/board');
  check('it comes back', board.success === true, board.error);
  check('counting every retailer', Number(board.totals.retailers) === rows.length, board.totals);
  check('and every state', Number(board.totals.states) === 3, board.totals);
  check('and the regions between them', Number(board.totals.regions) === 5, board.totals);

  // Added up a second way. A count that is quietly wrong is worse than one
  // that is missing.
  const sum = (k) => board.states.reduce((n, s) => n + Number(s[k]), 0);
  check('the states add up to the total',
    sum('retailers') === Number(board.totals.retailers), sum('retailers'));
  check('and so do the emails',
    sum('with_email') === Number(board.totals.with_email), sum('with_email'));
  check('and the phones',
    sum('with_phone') === Number(board.totals.with_phone), sum('with_phone'));

  check('biggest state first', board.states[0].state === 'New York', board.states.map(s => s.state));
  const ny = board.states.find(s => s.state === 'New York');
  check('New York has three', Number(ny.retailers) === 3, ny);
  check('two of them have an email', Number(ny.with_email) === 2, ny);
  check('two have a phone', Number(ny.with_phone) === 2, ny);
  check('one is online only', Number(ny.online_only) === 1, ny);
  check('across two regions', Number(ny.regions) === 2, ny);
  check('and two towns', Number(ny.cities) === 2, ny);
  check('it carries the state code', ny.state_code === 'NY', ny);

  console.log('\nInside one state');
  let j = await get('/api/cc-prospects/regions?state=New%20York');
  check('its regions come back', j.success && j.rows.length === 2, j.rows);
  check('biggest region first', j.rows[0].region === 'Capital Region', j.rows);
  j = await get('/api/cc-prospects/regions');
  check('and asking for no state is refused', j.success === false, j);

  console.log('\nThe retailers');
  j = await get('/api/cc-prospects?state=New York');
  check('one state at a time', j.total === 3, j.total);
  check('and not the others',
    j.rows.every(x => x.state === 'New York'), j.rows.map(x => x.state));
  j = await get('/api/cc-prospects?state=New York&region=Hudson Valley');
  check('narrowed to one region', j.total === 1, j.total);

  console.log('\nAcross every state');
  // What the tiles above the board open: the same list with no state, which
  // has to come back rather than being treated as a missing argument.
  j = await get('/api/cc-prospects');
  check('no state at all lists everybody', j.total === rows.length, j.total);
  check('from more than one state',
    new Set(j.rows.map(x => x.state)).size === 3, [...new Set(j.rows.map(x => x.state))]);
  check('and every row says which, since the town alone does not',
    j.rows.every(x => x.state_code), j.rows.map(x => x.state_code));
  j = await get('/api/cc-prospects?type=online');
  check('a tile narrows it without a state', j.total === 1 && j.rows[0].state === 'New York', j.rows);

  console.log('\nFinding one');
  check('by name', (await get('/api/cc-prospects?q=Thistle')).total === 1);
  check('by town', (await get('/api/cc-prospects?q=Dallas')).total === 1);
  check('by ZIP', (await get('/api/cc-prospects?q=96813')).total === 1);
  check('by email', (await get('/api/cc-prospects?q=quill.example')).total === 1);
  check('and a miss finds nothing rather than everything',
    (await get('/api/cc-prospects?q=zzzzz')).total === 0);

  console.log('\nWho can be reached');
  check('those with an email', (await get('/api/cc-prospects?has=email')).total === 4);
  check('those with a phone', (await get('/api/cc-prospects?has=phone')).total === 4);
  // The ones worth knowing about: on the list and unreachable.
  j = await get('/api/cc-prospects?has=neither');
  check('and those with neither', j.total === 1 && j.rows[0].retailer === 'Bluebonnet Paper', j.rows);

  console.log('\nA shop or a website');
  check('online only', (await get('/api/cc-prospects?type=online')).total === 1);
  check('somewhere to walk into', (await get('/api/cc-prospects?type=store')).total === 5);

  console.log('\nIt is a separate list');
  // `prospects` is the office's own 930, worked for years. Mixing the two
  // would lose which is which.
  const [[other]] = await db.query('SELECT COUNT(*) AS n FROM prospects');
  check('the other prospect list is untouched', other.n === 0, other.n);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
