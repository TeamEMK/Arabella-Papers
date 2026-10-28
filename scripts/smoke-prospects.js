/**
 * The prospect list, against a throwaway database.
 *
 * A first pass built for the client to review, so what is tested is mostly
 * that nothing from their spreadsheet is lost or quietly changed on the way
 * in - that is the thing a review cannot check for itself, because a row
 * that never arrived does not appear on the screen to be noticed.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_prospect_probe';
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

  const mk = (cols) => {
    const keys = Object.keys(cols);
    return db.query(
      `INSERT INTO prospects (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map(k => cols[k]));
  };

  // Invented, deliberately. The real sheet is 928 named businesses with
  // their people's direct phone numbers and addresses, and a test fixture
  // committed to a repository is the wrong home for any of it. These four
  // carry the SHAPES that matter - a dead address, one that merely never
  // answered, a reply, and a row with no company name - which is what the
  // checks below are about.
  await mk({ company_name: 'Riverbend Paper Co', city: 'Los Angeles', state: 'CA',
             country: 'USA', email: 'studio@riverbend.example',
             website: 'www.riverbend.example',
             status: 'Active', pricing: 'ARB Pricing', lead_source: 'The Wed Data',
             mail_outcome: 'failed delivery', source_row: 3 });
  await mk({ company_name: 'Marlowe Stationers', contact_person: 'A. Marlowe',
             city: 'Needham', state: 'MA', country: 'USA',
             email: 'hello@marlowe.example', phone: '555-0100',
             status: 'IRO USD 500 Email Sent', pricing: 'ARB Pricing',
             sample_1: '9/19 - spoke to them - no interest at this time',
             text_message_sent: 'SENT', mail_outcome: 'no revert', source_row: 2 });
  await mk({ company_name: 'Thistle & Vane', city: 'Austin', state: 'TX', country: 'USA',
             email: 'hello@thistlevane.example', status: 'Prospect',
             pricing: 'KPC Pricing', mail_outcome: 'replied', source_row: 44 });
  await mk({ company_name: 'B. Quill', contact_person: 'B. Quill',
             city: 'Jacksonville', state: 'FL', country: 'USA',
             status: 'MailChimp Bounced', needs_name: 1, source_row: 929 });

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

  console.log('Not for whoever asks');
  let res = await go('/api/prospects');
  check('928 companies of contact details need a login',
    res.status === 401 || res.status === 302, res.status);

  const out = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const jar = (out.headers.get('set-cookie') || '').split(';')[0];
  const get = async (url) => (await go(url, { headers: { cookie: jar } })).json();

  const { defaultSectionIds } = require(path.join(ROOT, 'utils/nav.js'));
  check('the floor is not offered the tab',
    !defaultSectionIds('India Designer', '').includes('prospects'));
  check('nor dispatch', !defaultSectionIds('Production & Dispatch', '').includes('prospects'));
  check('a head of department is', defaultSectionIds('Accounts', 'Head').includes('prospects'));

  console.log('\nThe list');
  let j = await get('/api/prospects');
  check('it comes back', j.success && j.total === 4, j.total);
  // Checked against a sort rather than against a name, so renaming a fixture
  // cannot make this fail while the ordering is perfectly fine.
  const names = j.rows.map(r => r.company_name);
  check('in alphabetical order',
    JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), names);

  console.log('\nSearching');
  check('by company', (await get('/api/prospects?q=riverbend')).total === 1);
  check('by person', (await get('/api/prospects?q=Marlowe')).total === 1);
  check('by city', (await get('/api/prospects?q=Austin')).total === 1);
  check('by email', (await get('/api/prospects?q=thistlevane')).total === 1);
  check('by phone', (await get('/api/prospects?q=555-0100')).total === 1);
  check('and a miss finds nothing rather than everything',
    (await get('/api/prospects?q=zzzzz')).total === 0);

  console.log('\nFiltering');
  check('by status', (await get('/api/prospects?status=Active')).total === 1);
  check('by state', (await get('/api/prospects?state=CA')).total === 1);
  check('by price list', (await get('/api/prospects?pricing=KPC Pricing')).total === 1);
  check('by where the lead came from',
    (await get('/api/prospects?source=The Wed Data')).total === 1);

  console.log('\nEmail that is known to bounce');
  // 292 of the 928 are dead, which is worth seeing before sending again.
  j = await get('/api/prospects?mail=dead');
  const dead = j.rows.map(r => r.company_name);
  check('a "failed delivery" counts as dead', dead.indexOf('Riverbend Paper Co') >= 0, dead);
  check('so does a bounced status', dead.indexOf('B. Quill') >= 0, dead);
  check('but a reply does not', dead.indexOf('Thistle & Vane') < 0, dead);
  check('and neither does "no revert" - nobody answered, the address is fine',
    dead.indexOf('Marlowe Stationers') < 0, dead);
  j = await get('/api/prospects?mail=ok');
  check('the good ones are the ones with an address that works',
    j.rows.every(r => r.email && !Number(r.mail_dead)), j.rows.map(r => r.email));

  console.log('\nThe rows with no company name');
  j = await get('/api/prospects?needsName=1');
  check('they can be found and finished', j.total === 1, j.total);

  console.log('\nThe counts on the page');
  j = await get('/api/prospects/filters');
  check('the totals are counted, not guessed', Number(j.totals.all_rows) === 4, j.totals);
  check('and the dropdowns are built from what is really there',
    j.status.length === 4 && j.state.length === 4, { status: j.status.length, state: j.state.length });

  console.log('\nEditing');
  const [[riverbend]] = await db.query("SELECT id FROM prospects WHERE company_name = 'Riverbend Paper Co'");
  let r = await (await go('/api/prospects/' + riverbend.id, {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_person: 'Marta', status: 'Active' }),
  })).json();
  check('a correction saves', r.success === true, r);
  const [[after]] = await db.query('SELECT contact_person, company_name FROM prospects WHERE id = ?', [riverbend.id]);
  check('and only what was sent changed', after.contact_person === 'Marta'
    && after.company_name === 'Riverbend Paper Co', after);

  // What was sent and what bounced is a record of what happened, not a field.
  const [[thistle]] = await db.query("SELECT id FROM prospects WHERE company_name = 'Thistle & Vane'");
  await go('/api/prospects/' + thistle.id, {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mail_outcome: 'replied!!', sample_1: 'rewritten', source_row: 999 }),
  });
  const [[kept]] = await db.query('SELECT mail_outcome, sample_1, source_row FROM prospects WHERE id = ?', [thistle.id]);
  check('the sent-and-bounced history cannot be typed over',
    kept.mail_outcome === 'replied' && kept.sample_1 === null && kept.source_row === 44, kept);

  // Giving one of the rescued rows a real name is what settles it.
  const [[unnamed]] = await db.query("SELECT id FROM prospects WHERE needs_name = 1");
  await go('/api/prospects/' + unnamed.id, {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: 'Quill & Press' }),
  });
  check('naming a nameless row clears the flag',
    (await get('/api/prospects?needsName=1')).total === 0);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
