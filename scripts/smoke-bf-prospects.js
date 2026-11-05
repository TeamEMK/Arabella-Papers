/**
 * BELLA FIGURA DEALERS — the third prospect list.
 *
 * 395 shops read off a competitor's public find-us map. Two things make
 * this list different from the other two, and both are where the checks
 * are:
 *
 *   MOST FIELDS ARE BLANK, AND THAT IS THE DATA. The map shows only what
 *   each dealer chose to publish - 314 give a website, 136 an email, 47 a
 *   phone, and half have no street address at all because they work from
 *   home by appointment. A row with nothing but a name and a city is a
 *   real listing. So the useful question is not "has a phone" but "how do
 *   I reach this one at all", and the screen has to answer it.
 *
 *   IT IS A SEPARATE LIST. prospects is the office's own 930 and
 *   cc_prospects is 7,041 Carlson Craft retailers. Mixing any of the three
 *   would make every count on every one of those screens a question about
 *   which rows it meant.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_bf_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

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

// Invented, but shaped like the real sheet: one with everything, one with
// only a website, one reachable only on Instagram, one with nothing at all,
// one in Canada, one with no state.
const DEALERS = [
  { store_name: 'Fenwick & Vine', address: '14 Market St', city: 'Albany', state: 'NY', zip: '12207',
    country: 'USA', phone: '(518) 555-0101', email: 'hello@fenwickvine.com',
    website: 'https://fenwickvine.com', instagram: 'https://instagram.com/fenwickvine',
    facebook: '', visitor_policy: '' },
  { store_name: 'Rosemary Press', address: '', city: 'Brooklyn', state: 'NY', zip: '11201',
    country: 'USA', phone: '', email: '', website: 'https://rosemarypress.com',
    instagram: '', facebook: '', visitor_policy: 'Clients by Appointment' },
  { store_name: 'The Linen Fold', address: '', city: 'Austin', state: 'TX', zip: '78701',
    country: 'USA', phone: '', email: '', website: '',
    instagram: 'https://instagram.com/linenfold', facebook: '', visitor_policy: '' },
  { store_name: 'Quiet Quarter Studio', address: '', city: 'Dallas', state: 'TX', zip: '',
    country: 'USA', phone: '', email: '', website: '', instagram: '', facebook: '',
    visitor_policy: 'Visitors By Appointment Only' },
  { store_name: 'Maple & Thread', address: '88 Queen St W', city: 'Toronto', state: 'ON', zip: 'M5H 2N2',
    country: 'Canada', phone: '(416) 555-0199', email: 'studio@maplethread.ca',
    website: '', instagram: '', facebook: 'https://facebook.com/maplethread', visitor_policy: '' },
  { store_name: 'Unplaced Paper Co', address: '', city: '', state: '', zip: '',
    country: 'USA', phone: '', email: 'hi@unplaced.co', website: '',
    instagram: '', facebook: '', visitor_policy: '' },
];

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

  const cols = Object.keys(DEALERS[0]);
  for (const [i, d] of DEALERS.entries()) {
    await db.query(
      `INSERT INTO bf_prospects (${cols.join(',')}, source_row) VALUES (${cols.map(() => '?').join(',')}, ?)`,
      [...cols.map(c => d[c] || null), i + 2]);
  }

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
  const get = async (url) => (await go(url, { headers: { cookie: jar } })).json();
  const put = async (url, body) => {
    const r = await go(url, {
      method: 'PUT',
      headers: { cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  console.log('\nThe tab');
  const { defaultSectionIds, SECTIONS } = require(path.join(ROOT, 'utils/nav.js'));
  check('it sits in ASMP with the other two lists',
    (SECTIONS.find(s => s.id === 'bfProspects') || {}).group === 'ASMP');
  check('and like them it is SuperAdmin\'s',
    defaultSectionIds('SuperAdmin', 'Head').includes('bfProspects')
    && !defaultSectionIds('Accounts', 'Head').includes('bfProspects')
    && !defaultSectionIds('India Designer', '').includes('bfProspects'));
  // A stranger must not be able to read other people's contact details by
  // guessing the URL.
  const stranger = await go('/api/bf-prospects');
  check('a stranger gets nothing', stranger.status === 302 || stranger.status === 401, stranger.status);

  console.log('\nThe board');
  const board = await get('/api/bf-prospects/board');
  check('it comes back', board.success === true, board.error);
  const t = board.totals;
  check('counting every dealer', Number(t.dealers) === DEALERS.length, t);
  check('the states, not counting the one with none',
    Number(t.states) === 3, t.states);
  check('and the countries', Number(t.countries) === 2, t.countries);
  check('with an email', Number(t.with_email) === 3, t.with_email);
  check('with a phone', Number(t.with_phone) === 2, t.with_phone);
  check('with a website', Number(t.with_website) === 2, t.with_website);
  check('on Instagram or Facebook', Number(t.with_social) === 3, t.with_social);
  // THE ONE THAT MATTERS on this list: nowhere to write, nowhere to ring,
  // nothing to look up. Worth knowing before anybody plans a round.
  check('and the ones with no way to reach them at all',
    Number(t.unreachable) === 1, t.unreachable);
  check('nobody starts with a status', Number(t.no_status) === DEALERS.length, t.no_status);

  // Added up a second way. A count that is quietly wrong is worse than one
  // that is missing.
  const sum = board.states.reduce((a, s) => a + Number(s.dealers), 0);
  check('the states add back up to the total', sum === DEALERS.length, sum);
  check('a dealer with no state is still on the board, not dropped',
    board.states.some(s => s.state === '—'), board.states.map(s => s.state));
  check('and Canada is marked as Canada',
    board.states.some(s => s.state === 'ON' && s.country === 'Canada'));

  console.log('\nFinding them');
  check('by state', (await get('/api/bf-prospects?state=NY')).total === 2);
  check('the stateless one by its own tile',
    (await get('/api/bf-prospects?state=%E2%80%94')).total === 1);
  check('by country', (await get('/api/bf-prospects?country=Canada')).total === 1);
  check('by search, on the name', (await get('/api/bf-prospects?q=Linen')).total === 1);
  check('and on the city', (await get('/api/bf-prospects?q=Toronto')).total === 1);
  check('those with an email', (await get('/api/bf-prospects?has=email')).total === 3);
  check('those reachable only online',
    (await get('/api/bf-prospects?has=social')).total === 3);
  const none = await get('/api/bf-prospects?has=none');
  check('and the unreachable one by name',
    none.total === 1 && none.rows[0].store_name === 'Quiet Quarter Studio', none.rows);
  // Half of these cannot be walked in on. It decides whether somebody can
  // be visited or has to be written to first.
  check('by visitor policy', (await get('/api/bf-prospects?visit=appointment')).total === 2);
  check('and by not having one', (await get('/api/bf-prospects?visit=open')).total === 4);
  check('a dealer with no address still comes back',
    (await get('/api/bf-prospects?q=Rosemary')).rows[0].address === null);

  console.log('\nMarking one');
  const [[one]] = await db.query("SELECT id FROM bf_prospects WHERE store_name = 'Fenwick & Vine'");
  const read = async (id) => (await db.query(
    'SELECT status, remark, status_updated_by FROM bf_prospects WHERE id = ?', [id]))[0][0];

  let w = await put('/api/bf-prospects/' + one.id, { status: 'active', remark: 'Spoke to Dana, send samples.' });
  check('it saves', w.json && w.json.success === true, w.json);
  let row = await read(one.id);
  check('status, remark and who did it',
    row.status === 'active' && /send samples/.test(row.remark || '')
    && row.status_updated_by === process.env.ADMIN_EMAIL, row);

  w = await put('/api/bf-prospects/' + one.id, { status: 'Maybe' });
  check('a status nobody agreed to is refused', w.json && w.json.success === false, w.json);
  check('and the row is left as it was', (await read(one.id)).status === 'active');

  w = await put('/api/bf-prospects/' + one.id, { status: '', remark: 'Spoke to Dana, send samples.' });
  check('clearing it is allowed, so a mis-click is not permanent',
    w.json.success === true && (await read(one.id)).status === null);

  check('a row that does not exist is a 404',
    (await put('/api/bf-prospects/999999', { status: 'active' })).status === 404);

  console.log('\nMarking a batch');
  const [all] = await db.query('SELECT id FROM bf_prospects ORDER BY id');
  const three = all.slice(0, 3).map(r => r.id);
  await put('/api/bf-prospects/' + three[0], { status: 'active', remark: 'keep me' });
  w = await put('/api/bf-prospects/bulk/status', { ids: three, status: 'inactive' });
  check('three at once', w.json && w.json.changed === 3, w.json);
  check('all three carry it',
    (await db.query("SELECT COUNT(*) n FROM bf_prospects WHERE status = 'inactive'"))[0][0].n === 3);
  // One note is about one dealer. Writing the same sentence onto a batch
  // would destroy whatever each of them already said.
  check('and the remarks are untouched', (await read(three[0])).remark === 'keep me');
  check('the rest of the list is untouched',
    (await db.query("SELECT COUNT(*) n FROM bf_prospects WHERE IFNULL(status,'') = ''"))[0][0].n
      === DEALERS.length - 3);
  check('an empty selection is refused rather than rewriting everything',
    (await put('/api/bf-prospects/bulk/status', { ids: [], status: 'active' })).json.success === false);
  check('and so is a status nobody agreed to',
    (await put('/api/bf-prospects/bulk/status', { ids: three, status: 'nonsense' })).json.success === false);
  check('by status, afterwards', (await get('/api/bf-prospects?status=inactive')).total === 3);
  check('and the ones nobody has touched',
    (await get('/api/bf-prospects?status=none')).total === DEALERS.length - 3);

  console.log('\nThe screen');
  const fs = require('fs');
  const view = fs.readFileSync(path.join(ROOT, 'views/views/bfProspects.ejs'), 'utf8');
  check('the counts open what they count', /bf_tile\(/.test(view) && /role="button"/.test(view));
  check('there is a way to edit one', /bf_edit\(/.test(view) && /bf_saveEdit/.test(view));
  check('and a way to do a batch', /bf_bulk\(/.test(view) && /bulk\/status/.test(view));
  check('the row opens the editor, because the pen is off the right-hand edge',
    view.includes("getElementById('bf_body').addEventListener('click'")
    && view.includes("closest('tr.bf-row')"));
  check('a link or a tick box inside the row is left alone',
    view.includes("closest('a, button, input, label')"));
  check('selection survives the list being refetched, because it is held by id',
    /PICKS = new Set\(\)/.test(view) && /PICKS\.has\(r\.id\)/.test(view));
  // Half of them have no address. Saying so is better than an empty cell
  // that reads as a loading failure.
  check('a missing address says so rather than being left blank',
    /no address published/.test(view));
  check('the export carries the office\'s own work, not just the source file',
    /'Status', 'Remark'/.test(view));

  console.log('\nIt is a list of its own');
  const [[other]] = await db.query('SELECT COUNT(*) AS n FROM cc_prospects');
  const [[ours]] = await db.query('SELECT COUNT(*) AS n FROM prospects');
  check('the Carlson Craft list is untouched', other.n === 0, other.n);
  check('and the office\'s own 930 are too', ours.n === 0, ours.n);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
