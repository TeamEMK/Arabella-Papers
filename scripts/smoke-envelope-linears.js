/**
 * ENVELOPE LINEARS.
 *
 * Five sections, twenty-one categories, and about three hundred designs
 * inside them. It looks like the design catalogue and is built differently
 * underneath on purpose: catalogue_items renders every page of every volume
 * into MySQL and is 54MB of a 60MB dump, which is why a nightly backup went
 * from 8MB to 127MB. Here the designs are in Drive and the database keeps
 * thumbnails.
 *
 * So a good part of this suite is about that difference holding - that
 * neither the board nor a category ships pictures inline, that the tables
 * have exactly the blob columns they are meant to and no more, and that the
 * thumbnails stay out of the nightly dump.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_envlin_probe';
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
const NL = String.fromCharCode(10);

(async () => {
  if (!LIVE_DB || LIVE_DB === TEST_DB) throw new Error('refusing to run against DB_NAME');

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  const app = require(path.join(ROOT, 'server.js'));
  const built = await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  // ──────────────────────────────────────────────
  console.log(NL + 'The structure is seeded, so the tab is not empty on day one');
  const { ENVELOPE_LINEAR_SEED } = require(path.join(ROOT, 'config/initDb.js'));
  check('a fresh database comes up with the categories already in it',
    built.envelopeLinears === 21, built.envelopeLinears);
  check('five sections', ENVELOPE_LINEAR_SEED.length === 5, ENVELOPE_LINEAR_SEED.length);
  const seededCats = ENVELOPE_LINEAR_SEED.reduce((n, s) => n + s[1].length, 0);
  check('twenty-one categories between them', seededCats === 21, seededCats);
  // These could never have come from a file name - Windows will not take a
  // slash - which is why the structure is seeded rather than derived from
  // the folder the PDFs arrive in.
  check('the names with slashes survive being a row',
    JSON.stringify(ENVELOPE_LINEAR_SEED).includes('Birds / Butterflies / Wildlife')
    && JSON.stringify(ENVELOPE_LINEAR_SEED).includes('Nature / Places / Destinations'));
  check('every category is named once', (() => {
    const all = ENVELOPE_LINEAR_SEED.flatMap(s => s[1]);
    return new Set(all).size === all.length;
  })());
  const [[seededRows]] = await db.query(
    'SELECT COUNT(*) c FROM envelope_linears WHERE is_active = 1');
  check('and they are really in the table', seededRows.c === 21, seededRows.c);

  // ── Fixtures this suite controls ──
  await db.query('DELETE FROM envelope_linear_items');
  await db.query('DELETE FROM envelope_linears');

  // A one-pixel JPEG stands in for a picture: this suite is about the
  // plumbing around it, not about the picture.
  const PIC = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

  const cats = [
    ['Classic & Traditional', 'Floral & Botanical', 0, 0, 1],
    ['Classic & Traditional', 'Chinoiserie', 0, 1, 1],
    ['Nature / Places / Destinations', 'Birds / Butterflies / Wildlife', 1, 0, 1],
    ['Nature / Places / Destinations', 'Nothing yet', 1, 1, 1],   // no designs
    ['Nature / Places / Destinations', 'Withdrawn', 1, 2, 0],     // taken down
  ];
  const catId = {};
  for (const [section, category, so, oo, active] of cats) {
    const [out] = await db.query(
      `INSERT INTO envelope_linears (section, category, cover, section_order, sort_order, is_active)
       VALUES (?,?,?,?,?,?)`,
      [section, category, category === 'Nothing yet' ? null : PIC, so, oo, active]);
    catId[category] = out.insertId;
  }
  const addItems = async (category, n) => {
    for (let i = 0; i < n; i++) {
      await db.query(
        `INSERT INTO envelope_linear_items
           (category_id, code, source_file, source_page, file_url, width, height,
            thumb, sort_order, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,1)`,
        [catId[category], 'CD-0' + (i + 1), category + '.pdf', i + 1,
         'https://drive.test/' + encodeURIComponent(category) + '-' + (i + 1),
         1254, 1254, PIC, i]);
    }
  };
  await addItems('Floral & Botanical', 3);
  await addItems('Chinoiserie', 2);
  await addItems('Birds / Butterflies / Wildlife', 4);
  await addItems('Withdrawn', 2);
  // One design hidden, so the board's count has to follow the live rows
  // rather than however many were imported.
  await db.query(
    'UPDATE envelope_linear_items SET is_active = 0 WHERE category_id = ? AND sort_order = 2',
    [catId['Floral & Botanical']]);

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  const signIn = async (email, password) => {
    const r = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }),
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const jar = await signIn(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  const get = (url, cookie) => go(url, { headers: { cookie: cookie === undefined ? jar : cookie } });
  const getJson = async (url, cookie) => {
    const r = await get(url, cookie);
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // ──────────────────────────────────────────────
  console.log(NL + 'The tab exists and has its own address');
  const { SECTION_IDS } = require(path.join(ROOT, 'utils/nav.js'));
  const SEC = require(path.join(ROOT, 'utils/sectionSlug.js'));
  check('it is a section', SECTION_IDS.includes('envelopeLinears'));
  check('its address is /app/envelope-linears',
    SEC.pathFor('envelopeLinears', 'dashboard') === '/app/envelope-linears',
    SEC.pathFor('envelopeLinears', 'dashboard'));
  check('and it clashes with no other section', SEC.collisions(SECTION_IDS).length === 0,
    SEC.collisions(SECTION_IDS));
  const view = await get('/views/envelopeLinears');
  const viewHtml = await view.text();
  check('the view renders', view.status === 200 && /Envelope Linears/.test(viewHtml), view.status);
  check('and is reachable at its own path', (await get('/app/envelope-linears')).status === 200);

  // ──────────────────────────────────────────────
  console.log(NL + 'The board is the shelf');
  const board = await getJson('/api/envelope-linears/board');
  check('it answers', board.json && board.json.success === true, board.json);
  const sections = board.json.sections;
  check('grouped into sections', sections.length === 2, sections.map(s => s.section));
  check('in the order given, not alphabetically',
    sections[0].section === 'Classic & Traditional', sections.map(s => s.section));
  check('a withdrawn category is not on it',
    !JSON.stringify(sections).includes('Withdrawn'));
  check('but its row is still there, not destroyed',
    (await db.query("SELECT 1 FROM envelope_linears WHERE category = 'Withdrawn'"))[0].length === 1);

  const floral = sections[0].items.find(i => i.category === 'Floral & Botanical');
  check('each category says how many designs it holds', floral.count === 2, floral.count);
  check('and a hidden design is not counted', floral.count !== 3, floral.count);
  const empty = sections[1].items.find(i => i.category === 'Nothing yet');
  check('a category with nothing in it says zero', empty && empty.count === 0, empty);

  console.log(NL + 'No pictures are shipped inline');
  const rawBoard = JSON.stringify(board.json);
  check('the board carries no image bytes',
    !/\/9j\/4AAQ/.test(rawBoard) && !/base64/.test(rawBoard));
  check('only whether a cover exists',
    floral.hasCover === true && empty.hasCover === false);
  check('and the whole board is small', rawBoard.length < 3000, rawBoard.length);

  const inside = await getJson('/api/envelope-linears/category/' + catId['Floral & Botanical']);
  check('a category lists its designs', inside.json.items.length === 2, inside.json.items.length);
  check('with the section and name on it',
    inside.json.section === 'Classic & Traditional'
    && inside.json.category === 'Floral & Botanical', inside.json.section);
  check('a hidden design is not in it',
    inside.json.items.every(i => i.page !== 3), inside.json.items.map(i => i.page));
  check('and no image bytes here either',
    !/\/9j\/4AAQ/.test(JSON.stringify(inside.json)));
  check('each design links to Drive, not to us',
    inside.json.items.every(i => /^https:\/\/drive\.test\//.test(i.url)),
    inside.json.items.map(i => i.url));

  check('an unknown category 404s',
    (await getJson('/api/envelope-linears/category/999999')).status === 404);
  check('and a non-number is refused',
    (await get('/api/envelope-linears/category/abc')).status === 400);

  console.log(NL + 'Pictures come one at a time, and are cached');
  const cover = await get('/api/envelope-linears/cover/' + catId['Floral & Botanical']);
  check('a cover comes back as a JPEG', cover.status === 200
    && /image\/jpeg/.test(cover.headers.get('content-type') || ''), cover.status);
  check('and is told to stay in the browser',
    /max-age=\d{3,}/.test(cover.headers.get('cache-control') || ''),
    cover.headers.get('cache-control'));
  check('privately, because this is behind a login',
    /private/.test(cover.headers.get('cache-control') || ''),
    cover.headers.get('cache-control'));
  check('a design thumbnail comes back too',
    (await get('/api/envelope-linears/thumb/' + inside.json.items[0].id)).status === 200);
  check('a category with no cover 404s rather than serving nothing',
    (await get('/api/envelope-linears/cover/' + catId['Nothing yet'])).status === 404);
  check('a made-up id is refused',
    (await get('/api/envelope-linears/thumb/999999')).status === 404);
  check('and so is a non-number',
    (await get('/api/envelope-linears/cover/abc')).status === 400);

  // ──────────────────────────────────────────────
  console.log(NL + 'Who can see it, and who can change it');
  const stranger = await getJson('/api/envelope-linears/board', null);
  check('a stranger gets nothing', stranger.status === 302 || stranger.status === 401, stranger.status);
  check('and cannot fetch a picture either',
    [302, 401].includes((await get('/api/envelope-linears/cover/' + catId['Chinoiserie'], null)).status));

  const bcrypt = require('bcryptjs');
  await db.query(
    "INSERT INTO users (username, email, password, role) VALUES ('Dee','dee@test.local',?,'Designer')",
    [await bcrypt.hash('dee-pass-123', 10)]);
  const deeJar = await signIn('dee@test.local', 'dee-pass-123');
  const deeBoard = await getJson('/api/envelope-linears/board', deeJar);
  check('a designer can browse it - it is reference material',
    deeBoard.json && deeBoard.json.success === true, deeBoard.status);
  const deeEdit = await go('/api/envelope-linears/' + catId['Chinoiserie'], {
    method: 'PUT', headers: { cookie: deeJar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'Hijacked' }),
  });
  check('but cannot rename a category', deeEdit.status === 403, deeEdit.status);
  const deeItem = await go('/api/envelope-linears/item/' + inside.json.items[0].id, {
    method: 'PUT', headers: { cookie: deeJar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'XX' }),
  });
  check('nor a design', deeItem.status === 403, deeItem.status);
  check('and cannot read the management list',
    (await getJson('/api/envelope-linears', deeJar)).status === 403);

  console.log(NL + 'Editing');
  const rename = await go('/api/envelope-linears/' + catId['Chinoiserie'], {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'Chinoiserie & Toile' }),
  }).then(r => r.json());
  check('a rename saves', rename.success === true, rename);
  const blank = await go('/api/envelope-linears/' + catId['Chinoiserie'], {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: '   ' }),
  }).then(r => r.json());
  check('but it cannot be emptied', blank.success === false, blank);

  const code = await go('/api/envelope-linears/item/' + inside.json.items[0].id, {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'FB-777' }),
  }).then(r => r.json());
  check('a design can be given a code', code.success === true, code);
  const [[coded]] = await db.query(
    'SELECT code FROM envelope_linear_items WHERE id = ?', [inside.json.items[0].id]);
  check('and it sticks', coded.code === 'FB-777', coded.code);

  const hideIt = await go('/api/envelope-linears/item/' + inside.json.items[0].id, {
    method: 'PUT', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  }).then(r => r.json());
  check('hiding a design works', hideIt.success === true, hideIt);
  const after = await getJson('/api/envelope-linears/board');
  const floral2 = after.json.sections[0].items.find(i => i.category === 'Floral & Botanical');
  check('and the count on the board follows it at once', floral2.count === 1, floral2.count);

  // ──────────────────────────────────────────────
  console.log(NL + 'Making and unmaking a category');
  const made = await go('/api/envelope-linears', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Suite Section', category: 'Suite Liners' }),
  }).then(r => r.json());
  check('a category can be made in a section that did not exist',
    made.success === true && made.id > 0, made);

  const withNew = await getJson('/api/envelope-linears/board');
  const newSection = withNew.json.sections.find(x => x.section === 'Suite Section');
  check('and the board shows the new section',
    !!newSection && newSection.items.length === 1, newSection);

  // Two tiles with the same name in the same section would be two things
  // nobody could tell apart, and the designs would go into whichever one
  // happened to be clicked.
  const again = await go('/api/envelope-linears', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'suite section  ', category: '  SUITE LINERS' }),
  });
  check('the same name in the same section is refused, whatever the case',
    again.status === 400, again.status);

  const noName = await go('/api/envelope-linears', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Suite Section', category: '   ' }),
  });
  check('and a category with no name is refused', noName.status === 400, noName.status);

  // ──────────────────────────────────────────────
  console.log(NL + 'Putting a design in through the API');
  // A real 2x2 JPEG. Small, but a genuine one - the point is that the route
  // reads a data URL and keeps the bytes, not that it can resize anything.
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA'
    + 'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW'
    + 'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx'
    + '8vP09fb3+Pn6/9oACAEBAAA/APn+iiiigD//2Q==';

  const putIn = await go('/api/envelope-linears/' + made.id + '/items', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: JPEG, thumb: JPEG, name: 'Suite design', width: 2, height: 2 }),
  }).then(r => r.json());
  check('a design goes in', putIn.success === true && putIn.id > 0, putIn);

  const nowIn = await getJson('/api/envelope-linears/category/' + made.id);
  check('and comes back with a picture to open',
    nowIn.json.items.length === 1 && nowIn.json.items[0].hasImage === true
    && nowIn.json.items[0].hasThumb === true, nowIn.json.items[0]);

  const pic = await get('/api/envelope-linears/image/' + putIn.id);
  check('the full picture is served', pic.status === 200, pic.status);

  // An empty category had no cover; the first design gives it one.
  const covered = await getJson('/api/envelope-linears/board');
  const stillNew = covered.json.sections.find(x => x.section === 'Suite Section');
  check('and the tile now has a cover to show',
    stillNew.items[0].hasCover === true && stillNew.items[0].count === 1, stillNew.items[0]);

  // Anything that is not a picture must bounce before it reaches the column.
  const junk = await go('/api/envelope-linears/' + made.id + '/items', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'hello', thumb: JPEG }),
  });
  check('something that is not a picture is refused', junk.status === 400, junk.status);

  const wrongKind = await go('/api/envelope-linears/' + made.id + '/items', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'data:application/pdf;base64,JVBERi0=', thumb: JPEG }),
  });
  check('and a PDF dressed as one is refused too', wrongKind.status === 400, wrongKind.status);

  // ──────────────────────────────────────────────
  console.log(NL + 'Only a manager may change any of it');
  const deeMake = await go('/api/envelope-linears', {
    method: 'POST', headers: { cookie: deeJar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Dee', category: 'Dee' }),
  });
  check('a designer cannot make a category', deeMake.status === 403, deeMake.status);
  const deeAdd = await go('/api/envelope-linears/' + made.id + '/items', {
    method: 'POST', headers: { cookie: deeJar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: JPEG, thumb: JPEG }),
  });
  check('nor put a design in one', deeAdd.status === 403, deeAdd.status);
  const deeKill = await go('/api/envelope-linears/' + made.id, {
    method: 'DELETE', headers: { cookie: deeJar },
  });
  check('nor take one away', deeKill.status === 403, deeKill.status);
  const deeBoard2 = await getJson('/api/envelope-linears/board', deeJar);
  check('and the board tells them so rather than offering the buttons',
    deeBoard2.json.canManage === false, deeBoard2.json.canManage);
  check('while a manager is told they may',
    (await getJson('/api/envelope-linears/board')).json.canManage === true);

  // ──────────────────────────────────────────────
  console.log(NL + 'Taking it all away again');
  const killItem = await go('/api/envelope-linears/item/' + putIn.id, {
    method: 'DELETE', headers: { cookie: jar },
  }).then(r => r.json());
  check('a design can be taken out', killItem.success === true, killItem);
  const bare = await getJson('/api/envelope-linears/board');
  const bareCat = bare.json.sections.find(x => x.section === 'Suite Section').items[0];
  check('and the tile stops showing a design it no longer holds',
    bareCat.count === 0 && bareCat.hasCover === false, bareCat);

  const killCat = await go('/api/envelope-linears/' + made.id, {
    method: 'DELETE', headers: { cookie: jar },
  }).then(r => r.json());
  check('the category goes', killCat.success === true, killCat);
  const gone = await getJson('/api/envelope-linears/board');
  check('and the section goes with it, having nothing left in it',
    !gone.json.sections.some(x => x.section === 'Suite Section'));

  // ──────────────────────────────────────────────
  console.log(NL + 'It cannot quietly become another catalogue_items');
  const [cols] = await db.query(
    `SELECT table_name AS t, column_name AS c, data_type AS d
       FROM information_schema.COLUMNS
      WHERE table_schema = ?
        AND table_name IN ('envelope_linears','envelope_linear_items')`, [TEST_DB]);
  const blobs = cols.filter(c => /blob/i.test(c.d)).map(c => c.t + '.' + c.c).sort();
  // Three, and they are the three that were meant. The full design was a
  // Drive link to begin with, and that was wrong for the job: clicking a
  // liner opened a Drive page in a new tab instead of showing the picture
  // over the grid the way the design catalogue does. So the bytes live here
  // now, deliberately - and this check is what stops a FOURTH blob arriving
  // by accident, which is the way catalogue_items got heavy.
  check('three picture columns, and nothing else',
    JSON.stringify(blobs) === JSON.stringify(
      ['envelope_linear_items.bytes', 'envelope_linear_items.thumb',
       'envelope_linears.cover']), blobs);
  check('the design opens from here, not from a Drive tab',
    cols.some(c => c.t === 'envelope_linear_items' && c.c === 'bytes' && /blob/i.test(c.d))
    && /envelope-linears\/image\//.test(
      require('fs').readFileSync(path.join(ROOT, 'routes/api/envelopeLinears.js'), 'utf8')));

  // The thumbnails can be made again from the PDFs in a few minutes, so they
  // do not need copying into every nightly dump - which is the mistake this
  // whole design exists to avoid.
  const fs = require('fs');
  const backup = fs.readFileSync(path.join(ROOT, 'scripts/backup-live.js'), 'utf8');
  check('and the thumbnails stay out of the nightly backup',
    /HEAVY_TABLES\s*=\s*\[[^\]]*'envelope_linear_items'/.test(backup));

  console.log(NL + 'The import script');
  const imp = fs.readFileSync(path.join(ROOT, 'scripts/import-envelope-linears.py'), 'utf8');
  check('it writes nothing without --confirm', /args\.confirm/.test(imp)
    && /Nothing was uploaded and nothing was written/.test(imp));
  check('it writes to the local database unless told otherwise', /--live/.test(imp));
  check('it attaches designs to seeded categories rather than creating the list',
    /INSERT INTO envelope_linear_items/.test(imp)
    && !/INSERT INTO envelope_linears/.test(imp));
  check('a file matching nothing is reported, not invented into a category',
    /nothing close enough/.test(imp));
  check('two files cannot land on the same category', /already taken by/.test(imp));
  check('it lifts the pictures out rather than re-rendering them',
    /extract_image/.test(imp));
  // Both: the picture goes into the row so it can be opened on the page, and
  // the mime type with it - a PNG lifted out of a PDF and labelled JPEG is a
  // broken picture with nothing said about why.
  check('it stores the full picture with the row',
    /bytes/.test(imp) && /mime_type/.test(imp));
  check('and a re-run replaces a category rather than doubling it',
    /DELETE FROM envelope_linear_items WHERE category_id/.test(imp));

  console.log(NL + 'The view');
  check('it fetches the board', /\/api\/envelope-linears\/board/.test(viewHtml));
  check('and a category only when one is picked',
    /\/api\/envelope-linears\/category\//.test(viewHtml) && /function el_pick/.test(viewHtml));
  // The side list is sections with their categories folded inside, which is
  // the whole shape of the page: five names, each opening onto its own.
  check('the sections fold open in the side list',
    /el_toggleSection/.test(viewHtml) && /el-catlink/.test(viewHtml));
  check('and it lands on a category rather than on an empty panel',
    /if \(!el_pickedId\)/.test(viewHtml));
  // A lazy image in a panel being drawn sometimes never starts loading at
  // all, which showed up as a grid of empty boxes in the browser test.
  check('the designs are not lazy-loaded',
    /thumb\/\$\{it\.id\}" alt="">/.test(viewHtml) && !/loading="lazy"/.test(viewHtml));
  check('a category with nothing in it says so rather than going blank',
    /Nothing has been put in this category yet/.test(viewHtml));
  // Two clicks in a row, the first slower than the second: without this the
  // first answer lands last and replaces the category being looked at.
  check('a slow answer cannot overwrite a newer pick',
    /if \(el_pickedId !== id\) return;/.test(viewHtml));
  check('nothing in it is a relative URL',
    !/(?:src|href)="(?!https?:|\/\/|\/|#|mailto:|tel:|data:|javascript:|<%|\$\{|')/.test(viewHtml));

  console.log(NL + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
