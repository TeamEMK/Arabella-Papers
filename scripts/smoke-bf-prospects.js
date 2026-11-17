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

  // ── CORRECTING AN ADDRESS ──
  //
  // The map published one address line and no flat numbers at all, so every
  // one of the 395 starts with an empty Apartment No. - the office fills it
  // in as it learns them, and the column would be pointless without this.
  console.log('\nCorrecting an address');
  const where = async (id) => (await db.query(
    `SELECT address, suite, city, state, zip, address_edited_by
       FROM bf_prospects WHERE id = ?`, [id]))[0][0];

  w = await put('/api/bf-prospects/' + one.id, {
    address: 'Torres de las Americas, Torre B', suite: 'Suite 403',
    city: 'Panama City', state: 'Panama', zip: '0801',
  });
  check('an address can be corrected', w.json && w.json.success === true, w.json);
  let a = await where(one.id);
  check('the flat number lands on a list that never had one',
    a.suite === 'Suite 403', a);
  check('and the street, the town, the state and the ZIP with it',
    a.address === 'Torres de las Americas, Torre B' && a.city === 'Panama City'
    && a.state === 'Panama' && a.zip === '0801', a);
  check('and the row says who corrected it',
    a.address_edited_by === process.env.ADMIN_EMAIL, a);

  check('a flat number can be cleared again, so a mistake is not permanent',
    (await put('/api/bf-prospects/' + one.id, { suite: '' })).json.success === true
    && (await where(one.id)).suite === null);

  w = await put('/api/bf-prospects/' + one.id, { zip: 'x'.repeat(40) });
  check('something too long for the column is refused, not cut in half',
    w.json && w.json.success === false, w.json);

  const beforeName = (await db.query(
    'SELECT store_name, country FROM bf_prospects WHERE id = ?', [one.id]))[0][0];
  await put('/api/bf-prospects/' + one.id, { store_name: 'Somebody Else', country: 'Mars' });
  const afterName = (await db.query(
    'SELECT store_name, country FROM bf_prospects WHERE id = ?', [one.id]))[0][0];
  check('the dealer name and country still come off the map',
    afterName.store_name === beforeName.store_name && afterName.country === beforeName.country,
    afterName);

  await put('/api/bf-prospects/' + one.id, { status: 'active' });
  check('marking a dealer does not wipe the address beside it',
    (await where(one.id)).address === 'Torres de las Americas, Torre B');

  // ── ACTIVE OPENS IT ON THE PROSPECTS LIST ──
  //
  // Same rule as the Carlson Craft list: Active means somebody is going to
  // work this one, and that work is recorded on Prospects.
  console.log('\nActive opens it on the Prospects list');
  const prospectOf = async (id) => (await db.query(
    `SELECT p.* FROM prospects p
       JOIN bf_prospects b ON b.prospect_id = p.id WHERE b.id = ?`, [id]))[0][0];

  await db.query('DELETE FROM prospects');
  await db.query('UPDATE bf_prospects SET status = NULL, prospect_id = NULL');

  const [[live]] = await db.query(
    "SELECT id FROM bf_prospects WHERE store_name = 'Fenwick & Vine'");
  w = await put('/api/bf-prospects/' + live.id, { status: 'active' });
  check('marking a dealer Active says one was opened',
    w.json && w.json.openedProspects === 1, w.json);
  const pr = await prospectOf(live.id);
  check('it is on the Prospects list under its own name',
    pr && pr.company_name === 'Fenwick & Vine', pr);
  check('and says where it came from',
    pr && pr.lead_source === 'Bella Figura Data', pr);
  check('the dealer is still on this list too',
    (await db.query(
      'SELECT COUNT(*) n FROM bf_prospects WHERE id = ?', [live.id]))[0][0].n === 1);

  w = await put('/api/bf-prospects/' + live.id, { status: 'active' });
  check('marking it again opens nothing further',
    w.json.openedProspects === 0
    && (await db.query('SELECT COUNT(*) n FROM prospects'))[0][0].n === 1, w.json);

  await db.query('UPDATE bf_prospects SET status = NULL, prospect_id = NULL');
  await db.query('DELETE FROM prospects');

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
  // AS MANY CELLS AS THERE ARE HEADINGS.
  //
  // Four columns were added to a table of ten, and a row that builds one
  // cell too few does not look broken - it looks like every value from
  // there on is in the wrong column, which is the kind of thing somebody
  // reads a ZIP out of and dials.
  const headings = (view.match(/<thead[\s\S]*?<\/thead>/) || [''])[0];
  // From the <tr> onwards, so the little cell() helper above it - which
  // holds a <td> of its own - is not counted as a column.
  const rowFn = view.slice(view.indexOf('body.innerHTML = ROWS.map'));
  const rowOnly = rowFn.slice(rowFn.indexOf("return '<tr"), rowFn.indexOf('}).join'));
  const heads = (headings.match(/<th[ >]/g) || []).length;
  const cells = (rowOnly.match(/<td[ >]/g) || []).length
    + (rowOnly.match(/\+ cell\(/g) || []).length;
  check('every heading has a cell under it', heads === cells, { heads, cells });
  for (const col of ['Street Name', 'Apartment No.', 'State', 'Zip Code']) {
    check('"' + col + '" is a column of its own', view.includes('>' + col + '</th>'));
  }
  check('and each of them can be typed into',
    /bf_editAddress/.test(view) && /bf_editSuite/.test(view)
    && /bf_editState/.test(view) && /bf_editZip/.test(view));
  check('the flat number is in the export too, where it is new',
    /'Apartment No\.'/.test(view) && /r\.suite/.test(view));
  check('a missing address says so rather than being left blank',
    /none published/.test(view));
  check('the export carries the office\'s own work, not just the source file',
    /'Status', 'Remark'/.test(view));

  console.log('\nIt is a list of its own');
  const [[other]] = await db.query('SELECT COUNT(*) AS n FROM cc_prospects');
  check('the Carlson Craft list is untouched', other.n === 0, other.n);
  // The office's own list is no longer untouched, and that is the point:
  // marking a dealer Active opens it there. What still has to be true is
  // that ONLY those appear, and that none of them left this list.
  const [[ours]] = await db.query('SELECT COUNT(*) AS n FROM prospects');
  const [[linked]] = await db.query(
    'SELECT COUNT(*) AS n FROM bf_prospects WHERE prospect_id IS NOT NULL');
  check('nothing is on Prospects that was not marked Active',
    ours.n === linked.n, { ours: ours.n, linked: linked.n });
  const [[stillHere]] = await db.query('SELECT COUNT(*) AS n FROM bf_prospects');
  check('and nothing left this one', stillHere.n === DEALERS.length, stillHere.n);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
