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
// The portal's restricted login belongs to the LIVE server, and a developer's
// .env carries it. This suite builds its own throwaway database where that
// user does not exist, so the variables are cleared and the portal falls back
// to the pool this suite did set up - see config/clientDb.js.
// Emptied rather than deleted: dotenv fills in a variable that is MISSING
// from the environment, and a helper that calls dotenv.config() again would
// hand the live login straight back - which is exactly what happened the
// first time this was written.
process.env.CLIENT_DB_USER = '';
process.env.CLIENT_DB_PASSWORD = '';

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

  // ASMP is SuperAdmin's, by the office's decision - every tab in the group
  // except FMS Task, which is where a person finds the work handed to them.
  // Written as a sweep over the group rather than one tab at a time: a tab
  // added here later with a looser rule is the thing this has to catch, and
  // naming them by hand is how that gets missed.
  const { defaultSectionIds, SECTIONS } = require(path.join(ROOT, 'utils/nav.js'));
  const asmp = SECTIONS.filter(s => s.group === 'ASMP').map(s => s.id);
  check('ccProspects sits in ASMP', asmp.includes('ccProspects'));
  for (const role of ['India Designer', 'Designer', 'Accounts', 'Production Manager']) {
    for (const domain of ['', 'Head', 'Designer']) {
      const seen = defaultSectionIds(role, domain).filter(id => asmp.includes(id));
      check(`${role || '-'}/${domain || '-'} gets FMS Task and nothing else in ASMP`,
        seen.length === 1 && seen[0] === 'fms', seen);
    }
  }
  check('a SuperAdmin gets all of it',
    asmp.every(id => defaultSectionIds('SuperAdmin', 'Head').includes(id)));

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

  // ── WORKING THE LIST ──
  //
  // Status, remark and the five address fields are what this screen may
  // write. The address was read off somebody else's find-a-retailer page and
  // some of it is wrong, so it is correctable; the retailer's own name, the
  // region and source_row still come from the workbook and are not, because
  // they are what a row is traced back by.
  console.log('\nMarking a shop');
  const put = async (url, body) => {
    const r = await go(url, {
      method: 'PUT',
      headers: { cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const [[one]] = await db.query("SELECT id FROM cc_prospects ORDER BY id LIMIT 1");
  const read = async (id) => (await db.query(
    'SELECT status, remark, status_updated_by FROM cc_prospects WHERE id = ?', [id]))[0][0];

  check('nothing starts with a status - nobody has looked at them',
    (await db.query("SELECT COUNT(*) n FROM cc_prospects WHERE IFNULL(status,'') <> ''"))[0][0].n === 0);

  let w = await put('/api/cc-prospects/' + one.id, { status: 'active', remark: 'Rang them, call back Tuesday.' });
  check('it saves', w.json && w.json.success === true, w.json);
  let row = await read(one.id);
  check('the status is on the row', row.status === 'active', row.status);
  check('and the remark', /call back Tuesday/.test(row.remark || ''), row.remark);
  check('and who did it', row.status_updated_by === process.env.ADMIN_EMAIL, row.status_updated_by);

  w = await put('/api/cc-prospects/' + one.id, { status: 'Maybe', remark: 'x' });
  check('a status nobody agreed to is refused', w.json && w.json.success === false, w.json);
  check('and the row is left as it was', (await read(one.id)).status === 'active');

  w = await put('/api/cc-prospects/' + one.id, { status: '', remark: 'Rang them, call back Tuesday.' });
  check('clearing it is allowed, so a mis-click is not permanent',
    w.json.success === true && (await read(one.id)).status === null);

  w = await put('/api/cc-prospects/999999', { status: 'active' });
  check('a row that does not exist is a 404', w.status === 404, w.status);

  // ── CORRECTING AN ADDRESS ──
  console.log('\nCorrecting an address');
  const where = async (id) => (await db.query(
    `SELECT address, suite, city, state, state_code, zip, address_edited_by
       FROM cc_prospects WHERE id = ?`, [id]))[0][0];

  w = await put('/api/cc-prospects/' + one.id, {
    address: '228 N Broad St', suite: 'Suite 403', city: 'Albany',
    state: 'New York', zip: '12205-1766',
  });
  check('an address can be corrected', w.json && w.json.success === true, w.json);
  let a = await where(one.id);
  check('the street is written', a.address === '228 N Broad St', a);
  check('and the flat number, which this list never had a column for',
    a.suite === 'Suite 403', a);
  check('and the ZIP', a.zip === '12205-1766', a);
  check('and the row says who corrected it',
    a.address_edited_by === process.env.ADMIN_EMAIL, a);

  // THE CODE FOLLOWS THE STATE. state_code is what the badge prints and what
  // the board groups by; a row reading "Texas" with a code of "NY" would sit
  // under the wrong heading on a board built from seven thousand rows.
  w = await put('/api/cc-prospects/' + one.id, { state: 'Texas' });
  a = await where(one.id);
  check('moving a shop to another state moves its code with it',
    a.state === 'Texas' && a.state_code === 'TX', a);
  w = await put('/api/cc-prospects/' + one.id, { state: 'Nowhere' });
  a = await where(one.id);
  check('and a state the list has never seen carries no code at all, rather than the last one',
    a.state === 'Nowhere' && a.state_code === null, a);
  await put('/api/cc-prospects/' + one.id, { state: 'New York' });

  // An empty box is a real answer - "no suite" - and has to be writable, or
  // a mistake could never be taken back out.
  w = await put('/api/cc-prospects/' + one.id, { suite: '' });
  check('a flat number can be cleared again', (await where(one.id)).suite === null);
  // But a shop has to be somewhere.
  w = await put('/api/cc-prospects/' + one.id, { state: '' });
  check('a shop cannot be left in no state', w.json && w.json.success === false, w.json);
  check('and the state is left as it was', (await where(one.id)).state === 'New York');

  w = await put('/api/cc-prospects/' + one.id, { zip: 'x'.repeat(40) });
  check('something too long for the column is refused, not cut in half',
    w.json && w.json.success === false, w.json);

  // Nothing else on the row may be reached through the same door.
  const beforeName = (await db.query(
    'SELECT retailer, region FROM cc_prospects WHERE id = ?', [one.id]))[0][0];
  await put('/api/cc-prospects/' + one.id, {
    retailer: 'Somebody Else', region: 'Made Up', source_row: 9999,
  });
  const afterName = (await db.query(
    'SELECT retailer, region FROM cc_prospects WHERE id = ?', [one.id]))[0][0];
  check('the retailer name and region are still the workbook\'s',
    afterName.retailer === beforeName.retailer && afterName.region === beforeName.region,
    afterName);

  // A request about the status alone must not blank an address, because the
  // two go through the same route.
  await put('/api/cc-prospects/' + one.id, { address: '228 N Broad St' });
  await put('/api/cc-prospects/' + one.id, { status: 'active' });
  check('marking a shop does not wipe its address',
    (await where(one.id)).address === '228 N Broad St');

  // ── ACTIVE OPENS IT ON THE PROSPECTS LIST ──
  //
  // Marking a shop Active is the office saying it will work this one, and
  // working a shop means samples, outreach and bounced mail - none of which
  // this table has a column for. So the row is opened on Prospects, and it
  // STAYS here: 7,041 that quietly becomes 6,800 is a list that can no
  // longer be checked against the page it was read from.
  console.log('\nActive opens it on the Prospects list');
  const prospectOf = async (id) => (await db.query(
    `SELECT p.* FROM prospects p
       JOIN cc_prospects c ON c.prospect_id = p.id WHERE c.id = ?`, [id]))[0][0];

  await db.query('DELETE FROM prospects');
  await db.query('UPDATE cc_prospects SET prospect_id = NULL');

  const [[fresh]] = await db.query(
    "SELECT id FROM cc_prospects WHERE retailer = 'Marlowe Cards'");
  check('nothing is on Prospects to start with',
    (await db.query('SELECT COUNT(*) n FROM prospects'))[0][0].n === 0);

  w = await put('/api/cc-prospects/' + fresh.id, { status: 'active' });
  check('marking it Active says one was opened',
    w.json && w.json.openedProspects === 1, w.json);
  let pr = await prospectOf(fresh.id);
  check('it is on the Prospects list under its own name',
    pr && pr.company_name === 'Marlowe Cards', pr);
  check('with the town and the ZIP it had here',
    pr && pr.city === 'Kingston' && pr.zipcode === '12401', pr);
  check('and the email, which is the point of working it at all',
    pr && pr.email === 'hi@marlowe.example', pr);
  check('it says where the name came from',
    pr && pr.lead_source === 'Carlson Craft List', pr);
  check('and the shop is still on this list too',
    (await db.query('SELECT COUNT(*) n FROM cc_prospects'))[0][0].n === rows.length);

  // Marking it again - or in a batch - must not open a second one. Two rows
  // for one shop is how two people send the same samples a week apart.
  w = await put('/api/cc-prospects/' + fresh.id, { status: 'active', remark: 'again' });
  check('marking it Active twice opens nothing further',
    w.json.openedProspects === 0
    && (await db.query('SELECT COUNT(*) n FROM prospects'))[0][0].n === 1, w.json);

  // Somebody writes on the prospect. Nothing here may overwrite that.
  await db.query(
    "UPDATE prospects SET status = 'Active', outreach_note = 'Samples sent' WHERE id = ?",
    [pr.id]);
  await put('/api/cc-prospects/' + fresh.id, { status: 'active' });
  pr = await prospectOf(fresh.id);
  check('what the office wrote on the prospect is left alone',
    pr.status === 'Active' && pr.outreach_note === 'Samples sent', pr);

  // Inactive is not a reason to open anything, and clearing a status is not
  // a reason to take a prospect back - by then somebody may be working it.
  const [[aloha]] = await db.query(
    "SELECT id FROM cc_prospects WHERE retailer = 'Aloha Invites'");
  w = await put('/api/cc-prospects/' + aloha.id, { status: 'inactive' });
  check('Inactive opens nothing', w.json.openedProspects === 0
    && (await db.query('SELECT COUNT(*) n FROM prospects'))[0][0].n === 1, w.json);
  await put('/api/cc-prospects/' + fresh.id, { status: '' });
  check('and clearing a status does not take the prospect away',
    (await db.query('SELECT COUNT(*) n FROM prospects'))[0][0].n === 1);

  // A company the office is ALREADY working is linked, not copied.
  const [already] = await db.query(
    "INSERT INTO prospects (company_name, city) VALUES ('Quill & Press', 'Dallas')");
  const [[quill]] = await db.query(
    "SELECT id FROM cc_prospects WHERE retailer = 'Quill & Press'");
  await put('/api/cc-prospects/' + quill.id, { status: 'active' });
  check('a shop already on the Prospects list is linked to it, not duplicated',
    (await db.query(
      "SELECT COUNT(*) n FROM prospects WHERE company_name = 'Quill & Press'"))[0][0].n === 1);
  check('and the two rows now know about each other',
    (await prospectOf(quill.id)).id === already.insertId, already.insertId);

  // The batch does it too, because that is how seven thousand get worked.
  const [batch] = await db.query(
    'SELECT id FROM cc_prospects WHERE prospect_id IS NULL LIMIT 3');
  w = await put('/api/cc-prospects/bulk/status',
    { ids: batch.map(r => r.id), status: 'active' });
  check('a batch marked Active opens them all',
    w.json.openedProspects === 3, w.json);
  check('and every one of them is linked',
    (await db.query(
      'SELECT COUNT(*) n FROM cc_prospects WHERE prospect_id IS NOT NULL'))[0][0].n === 5);

  // Put the list back as the checks below expect to find it.
  await db.query('UPDATE cc_prospects SET status = NULL, prospect_id = NULL');
  await db.query('DELETE FROM prospects');

  console.log('\nMarking a batch');
  const [all] = await db.query('SELECT id FROM cc_prospects ORDER BY id');
  const half = all.slice(0, 3).map(r => r.id);
  await put('/api/cc-prospects/' + half[0], { status: 'active', remark: 'keep me' });
  w = await put('/api/cc-prospects/bulk/status', { ids: half, status: 'inactive' });
  check('three at once', w.json && w.json.success === true && w.json.changed === 3, w.json);
  check('all three carry it',
    (await db.query("SELECT COUNT(*) n FROM cc_prospects WHERE status = 'inactive'"))[0][0].n === 3);
  // One note is about one shop. Writing the same sentence onto two hundred
  // rows would destroy whatever each of them already said.
  check('and the remarks are untouched', (await read(half[0])).remark === 'keep me');
  check('the rest of the list is untouched',
    (await db.query("SELECT COUNT(*) n FROM cc_prospects WHERE IFNULL(status,'') = ''"))[0][0].n
      === all.length - 3);

  w = await put('/api/cc-prospects/bulk/status', { ids: [], status: 'active' });
  check('an empty selection is refused rather than rewriting everything',
    w.json && w.json.success === false, w.json);
  w = await put('/api/cc-prospects/bulk/status', { ids: half, status: 'nonsense' });
  check('and so is a status nobody agreed to', w.json && w.json.success === false, w.json);

  console.log('\nFinding them again');
  check('by inactive', (await get('/api/cc-prospects?status=inactive')).total === 3);
  check('by active', (await get('/api/cc-prospects?status=active')).total === 0);
  // The useful one on a list of seven thousand: the pile nobody has been
  // through yet.
  check('and the ones nobody has touched',
    (await get('/api/cc-prospects?status=none')).total === all.length - 3);
  check('the list carries the status and the remark',
    (await get('/api/cc-prospects?status=inactive')).rows.every(r => 'status' in r && 'remark' in r));

  console.log('\nThe screen');
  const view = require('fs').readFileSync(path.join(ROOT, 'views/views/ccProspects.ejs'), 'utf8');
  const nav = require('fs').readFileSync(path.join(ROOT, 'utils/nav.js'), 'utf8');
  // ── THE ROOM IT LIVES IN ──
  //
  // The office calls this Bella Papers now, and CC Prospects is one line
  // inside it - the first of several they mean to add. The section id stays
  // ccProspects on purpose: the address and every saved grant are keyed on
  // it, and renaming it would sign people out of a screen they already have.
  check('the sidebar calls it Bella Papers',
    /id: 'ccProspects'[\s\S]{0,400}name: 'Bella Papers'/.test(nav));
  check('and the id it is granted by has not moved',
    /id: 'ccProspects'/.test(nav) && !/id: 'bellaPapers'/.test(nav));
  check('the room opens on an index, not on seven thousand shops',
    /id="bp_home"/.test(view) && /<div id="cc_board" hidden>/.test(view));
  check('with CC Prospects as a line in it',
    /ROOMS = \[/.test(view) && /name: 'CC Prospects'/.test(view));
  // The board counts every shop in the country; opening the room should not
  // pay for that, so it is fetched on the click and nowhere else.
  check('and the shops are only fetched once that line is pressed',
    /open: function \(\) \{ cc_boot\(\); \}/.test(view)
    && !/\n  cc_boot\(\);\n\}\)\(\);/.test(view));
  check('the "by state" subtitle is gone', !/Carlson Craft retailers, by state/.test(view));
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
  check('Status and Remark are columns', />Status</.test(view) && />Remark</.test(view));
  // Asked for by name. They were squeezed under the retailer and under the
  // town before, where a long street name pushed the row about.
  for (const col of ['Street Name', 'Apartment No.', 'State', 'Zip Code']) {
    check('"' + col + '" is a column of its own', view.includes('>' + col + '</th>'));
  }
  check('and each of them can be typed into',
    /cc_editAddress/.test(view) && /cc_editSuite/.test(view)
    && /cc_editState/.test(view) && /cc_editZip/.test(view));
  check('the state is picked from the ones already on the board, not typed fresh',
    /list="cc_stateList"/.test(view) && /cc_stateList.{0,200}STATES/s.test(view));
  check('there is a way to edit one', /cc_edit\(/.test(view) && /cc_saveEdit/.test(view));
  check('and a way to do a batch', /cc_bulk\(/.test(view) && /bulk\/status/.test(view));
  check('selection survives the list being refetched, because it is held by id',
    /PICKS = new Set\(\)/.test(view) && /PICKS\.has\(r\.id\)/.test(view));
  check('the export carries the office\'s own work, not just the source file',
    /'Status', 'Remark'/.test(view));
  // Ten columns now, so the pen sits off the right-hand edge until somebody
  // scrolls to it. The row opens the editor too - and a click on a phone
  // number, an email or the tick box still means that thing.
  check('the row itself opens the editor, because the pen is off-screen',
    view.includes("getElementById('cc_body').addEventListener('click'")
    && view.includes("closest('tr.cc-row')"));
  check('and a link or a tick box inside it is left alone',
    view.includes("closest('a, button, input, label')"));

  console.log('\nIt is still a separate list');
  // `prospects` is the office's own 930, worked for years, and this is
  // 7,041 names off a public page. They are not merged: only the ones
  // somebody marked Active are opened over there, and every one of those is
  // still here as well, which is what lets the list be checked against the
  // page it was read from.
  const [[overThere]] = await db.query('SELECT COUNT(*) AS n FROM prospects');
  const [[linked]] = await db.query(
    'SELECT COUNT(*) AS n FROM cc_prospects WHERE prospect_id IS NOT NULL');
  check('nothing is on Prospects that was not marked Active',
    overThere.n === linked.n, { overThere: overThere.n, linked: linked.n });
  const [[stillHere]] = await db.query('SELECT COUNT(*) AS n FROM cc_prospects');
  check('and nothing left this one', stillHere.n === rows.length, stillHere.n);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
