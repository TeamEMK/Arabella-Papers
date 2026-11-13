/**
 * A PAGE PER ADDRESS.
 *
 * Every tab of this app used to be the same URL, then /?tab=<id>, and now
 * /app/<slug>. The risk in moving the page into the path is not the happy
 * case - it is everything that was quietly relying on the old shape: the
 * mail that goes out at nine with a ?tab= link in it, the held logout that
 * comes back to /?vectors=due, the bookmarks on /, and the fact that the
 * server now has to answer for a family of paths without swallowing /api,
 * /views, /track or the static files.
 *
 * Most of what follows is about those, not about clicking a tab.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_routing_probe';
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
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  const SEC = require(path.join(ROOT, 'utils/sectionSlug.js'));
  const { SECTION_IDS } = require(path.join(ROOT, 'utils/nav.js'));
  const { safeNext } = require(path.join(ROOT, 'middleware/auth.js'));

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign(
      { 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Dest': 'document' },
      opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  const login = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Dest': 'document' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const jar = (login.headers.get('set-cookie') || '').split(';')[0];
  const get = (url) => go(url, { headers: { cookie: jar } });

  // ──────────────────────────────────────────────
  console.log(NL + 'The slug is derived, not remembered');
  check('no two sections share a path', SEC.collisions(SECTION_IDS).length === 0,
    SEC.collisions(SECTION_IDS));
  check('camelCase becomes kebab', SEC.slugFor('tillApproval') === 'till-approval');
  // Without the second replace in slugFor this comes out production-b-d,
  // which is the kind of thing nobody notices until a link is sent.
  check('a run of capitals stays together', SEC.slugFor('productionBD') === 'production-bd',
    SEC.slugFor('productionBD'));
  check('an already-lowercase id is left alone', SEC.slugFor('o2dsummary') === 'o2dsummary');
  check('every section slugs to a usable path segment',
    SECTION_IDS.every(id => /^[a-z0-9-]+$/.test(SEC.slugFor(id))),
    SECTION_IDS.filter(id => !/^[a-z0-9-]+$/.test(SEC.slugFor(id))));

  console.log(NL + 'Reading a page back out of an address');
  check('the home page is the bare base, not /app/dashboard',
    SEC.pathFor('dashboard', 'dashboard') === '/app', SEC.pathFor('dashboard', 'dashboard'));
  check('and it round-trips', SEC.idFromPath('/app/till-approval', SECTION_IDS) === 'tillApproval');
  check('a trailing slash is the same address',
    SEC.idFromPath('/app/till-approval/', SECTION_IDS) === 'tillApproval');
  check('an unknown name reads as nothing',
    SEC.idFromPath('/app/nope', SECTION_IDS) === '');
  check('a deeper path is not a page', SEC.idFromPath('/app/a/b', SECTION_IDS) === '');
  check('and neither is another route', SEC.idFromPath('/track', SECTION_IDS) === '');

  // ──────────────────────────────────────────────
  console.log(NL + 'The server answers for the new addresses');
  for (const url of ['/', '/app', '/app/till-approval', '/app/cc-prospects', '/app/production-bd']) {
    const r = await get(url);
    const html = r.status === 200 ? await r.text() : '';
    check(url + ' serves the app shell',
      r.status === 200 && /id="contentArea"/.test(html), r.status);
  }
  const unknown = await get('/app/not-a-page');
  check('/app/not-a-page still serves the shell, which falls back to home',
    unknown.status === 200, unknown.status);

  console.log(NL + 'And does not swallow anything else');
  // The whole danger of putting a wildcard near the root. Each of these has
  // its own answer and must keep it.
  const untouched = [
    ['/api/uploads/session', 'the API'],
    ['/views/dashboard', 'the view fetches'],
    ['/js/sectionSlug.js', 'the static scripts'],
    ['/logo.jpg', 'the images'],
    ['/quote/arabella', 'the public calculator'],
  ];
  for (const [url, what] of untouched) {
    const r = await get(url);
    const body = r.status === 200 ? await r.text() : '';
    check(what + ' (' + url + ') is not the shell',
      !/id="contentArea"/.test(body), r.status);
  }
  // Uppercase and odd shapes must not reach the shell route at all, or the
  // "one lowercase segment" rule is decorative.
  for (const url of ['/app/Till-Approval', '/app/till_approval', '/app/till approval']) {
    const r = await get(url);
    check('a name outside [a-z0-9-] 404s: ' + url, r.status === 404, r.status);
  }

  // ──────────────────────────────────────────────
  console.log(NL + 'Signed out, and sent back where they were going');
  const out = await go('/app/cc-prospects');
  const loc = out.headers.get('location') || '';
  check('a signed-out visit goes to login', out.status === 302 && /^\/login/.test(loc), loc);
  check('carrying where they were headed',
    decodeURIComponent((loc.split('next=')[1] || '')) === '/app/cc-prospects', loc);

  const form = await fetch(BASE + loc, { headers: { 'X-Forwarded-Proto': 'https' } }).then(r => r.text());
  check('and the login form holds on to it through the post',
    /name="next"\s+value="\/app\/cc-prospects"/.test(form));

  const back = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Dest': 'document' },
    body: new URLSearchParams({
      email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
      next: '/app/cc-prospects',
    }),
  });
  check('signing in lands on the page that was asked for',
    back.headers.get('location') === '/app/cc-prospects', back.headers.get('location'));

  // A fetch is not a navigation: answering it with a redirect to the login
  // page is how an expired session used to paint a login form inside the
  // sidebar.
  const bg = await fetch(BASE + '/api/corrections/pending-count', {
    headers: { 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Dest': 'empty' }, redirect: 'manual',
  });
  check('a background fetch still gets 401, not a redirect', bg.status === 401, bg.status);

  console.log(NL + 'next= cannot be used to send somebody off-site');
  const evil = [
    'https://evil.test/x', '//evil.test/x', '/\\evil.test', '\\/evil.test',
    '/track', '/login', '/api/users', '/app/../track', '/appfoo',
    '/app/cc-prospects/../../track', 'javascript:alert(1)', '',
  ];
  for (const v of evil) {
    check('refused: ' + JSON.stringify(v), safeNext(v) === '', safeNext(v));
  }
  check('our own page is allowed', safeNext('/app/cc-prospects') === '/app/cc-prospects');
  check('the base itself is allowed', safeNext('/app') === '/app');
  check('and a query on it is kept', safeNext('/app/dashboard?vectors=due') === '/app/dashboard?vectors=due',
    safeNext('/app/dashboard?vectors=due'));
  // The browser never sends a fragment to us, so carrying one would only be
  // a place to hide something.
  check('a fragment is dropped', safeNext('/app/stock#x') === '/app/stock', safeNext('/app/stock#x'));

  // A real redirect is the only thing that proves the guard is wired in, not
  // merely written.
  const tricked = await go('/login?next=' + encodeURIComponent('https://evil.test/x'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Dest': 'document' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  check('an off-site next= lands on home instead',
    tricked.headers.get('location') === '/', tricked.headers.get('location'));

  // ──────────────────────────────────────────────
  console.log(NL + 'The shell and the server agree');
  const fs = require('fs');
  const shell = fs.readFileSync(path.join(ROOT, 'views/app.ejs'), 'utf8');
  check('the shell loads the same slug helper the server routes on',
    /src="\/js\/sectionSlug\.js"/.test(shell));
  check('and loads it before the script that uses it',
    shell.indexOf('/js/sectionSlug.js') < shell.indexOf('window.ArabellaSections'));
  check('nothing hand-builds a tab address any more',
    !/searchParams\.set\(['"]tab['"]/.test(shell));
  check('there is one builder and one reader',
    (shell.match(/function pageUrl\(/g) || []).length === 1
    && (shell.match(/function pageInAddress\(/g) || []).length === 1);
  check('popstate opens the page and never pushes',
    /addEventListener\('popstate'[\s\S]{0,400}?replace: true[\s\S]{0,200}?\}\);/.test(shell)
    && !/addEventListener\('popstate'[\s\S]{0,400}?pushState/.test(shell));
  check('an old ?tab= or #hash link is read on init',
    /get\('tab'\)/.test(shell) && /location\.hash/.test(shell));
  check('and is not carried into the new address',
    /searchParams\.delete\('tab'\)/.test(shell));

  console.log(NL + 'The morning mail points at the new address');
  const report = fs.readFileSync(path.join(ROOT, 'utils/stageReport.js'), 'utf8');
  // The href itself, not the file: the comment above it still names the old
  // form, because explaining why the old link keeps working is the point of
  // the comment.
  const href = (report.match(/<a href="[^"]*"/g) || []).join(' ');
  check('the link is built from the helper, not typed',
    /pathFor\('productionBD'/.test(report) && !/\?tab=/.test(href), href);
  check('and it is the production board',
    SEC.pathFor('productionBD', 'dashboard') === '/app/production-bd');

  console.log(NL + 'Nothing relative is left to break under a deeper path');
  // /app/till-approval is one segment deeper than /, so a src="logo.jpg"
  // that worked at the root would 404 there. Swept rather than spot-checked.
  const tpls = fs.readdirSync(path.join(ROOT, 'views/views'))
    .filter(f => f.endsWith('.ejs'))
    .map(f => path.join(ROOT, 'views/views', f))
    .concat([path.join(ROOT, 'views/app.ejs')]);
  const RELATIVE = /(?:src|href|action)="(?!https?:|\/\/|\/|#|mailto:|tel:|data:|javascript:|<%|\$\{|'|")[^"]+"/;
  const offenders = tpls.filter(f => RELATIVE.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.basename(f));
  check('no relative src/href in any template', offenders.length === 0, offenders);
  const relFetch = tpls.filter(f => /fetch\(\s*['"`](?!https?:|\/)/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.basename(f));
  check('and no relative fetch()', relFetch.length === 0, relFetch);

  console.log(NL + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
