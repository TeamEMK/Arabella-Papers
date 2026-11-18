/**
 * THE SECURITY CONTROLS, PROVED ONE AT A TIME.
 *
 *   node scripts/smoke-security.js
 *
 * Each block here is one hardening item from the office's checklist. The
 * rule for every one of them is the same and it is the only reason this
 * file is worth having: show the attack being REFUSED, and show the normal
 * flow still working. A check that only does the second half passes just as
 * well on a server with the guard deleted.
 *
 * Builds its own throwaway database. Never live.
 */
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_security_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.PORT = '0';
// Every request re-reads the account, so a change made in the table is
// seen on the next call rather than up to half a minute later.
process.env.ROLE_RECHECK_MS = '0';

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

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };

  try {
    // ══════════════════════════════════════════════════
    // 1. THE SESSION SECRET HAS NO FALLBACK
    //
    // The string that signs the "who you are" cookie. A literal in the
    // source is a literal on GitHub, and anybody holding it can mint a
    // cookie for the SuperAdmin without a password. The attack being
    // refused here is a SERVER THAT BOOTS AT ALL without one.
    console.log(NL + 'The session secret');
    // The variable is handed over EMPTY rather than deleted. dotenv fills in
    // a name that is MISSING from the environment, so deleting it would have
    // the child read SESSION_SECRET straight out of .env and boot happily -
    // and this test would pass just as well against a server with no guard.
    const bootWithout = (env) => spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(ROOT, 'server.js').replace(/\\/g, '/'))});
      setTimeout(() => process.exit(0), 300);
    `], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { SESSION_SECRET: '' }, env || {}),
    });

    const live = bootWithout({ VERCEL: '1' });
    check('live refuses to start without SESSION_SECRET', live.status === 1, live.status);
    check('and says why', /SESSION_SECRET is not set/.test((live.stderr || '') + (live.stdout || '')),
      (live.stderr || '').slice(0, 120));

    const laptop = bootWithout({ VERCEL: '', NODE_ENV: 'development' });
    check('a laptop still starts, on a secret made up for the run',
      laptop.status === 0, { status: laptop.status, err: (laptop.stderr || '').slice(0, 120) });

    const src = require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('and no secret is written in the source at all',
      !/secret:\s*process\.env\.SESSION_SECRET\s*\|\|\s*['"]/.test(src));

    // ── and the normal flow still works ──
    const r = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
      }),
    });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    check('signing in still works and still sets a cookie', !!cookie, r.status);
    const who = await go('/api/orders', { headers: { cookie } });
    check('and the cookie opens the app', who.status === 200, who.status);

    // ══════════════════════════════════════════════════
    // 2. THE SCHEDULED JOBS ARE NOT PUBLIC URLs
    //
    // /api/cron/* are plain GETs on a public domain, and each one mails the
    // whole office. Before this, two doors stood open: with CRON_SECRET
    // unset the only test was an `x-vercel-cron: 1` header, which any
    // caller can type, and with the secret set that header STILL let them
    // through. The attack is somebody firing the nightly report a hundred
    // times, from anywhere.
    console.log(NL + 'The scheduled jobs');
    const cron = (headers) => go('/api/cron/stage-report', { headers: headers || {} });

    process.env.CRON_SECRET = 'a-secret-only-the-scheduler-has';
    check('a stranger with nothing is refused', (await cron()).status === 401);
    // The one that used to work.
    check('and a stranger typing the platform header is refused too',
      (await cron({ 'x-vercel-cron': '1' })).status === 401);
    check('a wrong token is refused',
      (await cron({ authorization: 'Bearer not-the-secret-but-same-len' })).status === 401);
    check('a token of the right length but wrong bytes is refused',
      (await cron({ authorization: 'Bearer ' + 'x'.repeat(process.env.CRON_SECRET.length) })).status === 401);

    const ran = await cron({ authorization: 'Bearer ' + process.env.CRON_SECRET });
    check('and the scheduler itself gets through', ran.status === 200, ran.status);

    // No secret configured: nothing runs at all, including anything waving
    // the platform header. A job that can be triggered by a stranger is
    // worse than a job that does not run.
    const had = process.env.CRON_SECRET;
    process.env.CRON_SECRET = '';
    check('with no secret set, even the platform header is refused',
      (await cron({ 'x-vercel-cron': '1' })).status === 401);
    check('and so is an empty bearer',
      (await cron({ authorization: 'Bearer ' })).status === 401);
    process.env.CRON_SECRET = had;

    const cronSrc = require('fs').readFileSync(path.join(ROOT, 'routes/api/cron.js'), 'utf8');
    check('the comparison is constant time, not ===',
      /timingSafeEqual/.test(cronSrc) && !/got === want/.test(cronSrc));

    // ══════════════════════════════════════════════════
    // 3. THE HEADERS, AND WHAT /api IS ALLOWED TO KEEP
    console.log(NL + 'The headers every answer carries');
    const page = await go('/login');
    const h = (r, k) => (r.headers.get(k) || '');

    // The app inside somebody else's iframe, with their buttons drawn over
    // ours.
    check('a page cannot be framed by another site',
      /SAMEORIGIN|DENY/i.test(h(page, 'x-frame-options')), h(page, 'x-frame-options'));
    // A browser deciding an upload "looks like" a script and running it.
    check('nothing is sniffed into another type',
      h(page, 'x-content-type-options') === 'nosniff');
    // Order numbers and tokens in our URLs, posted to whatever site
    // somebody clicks through to.
    check('our URLs do not travel to other sites',
      /no-referrer/.test(h(page, 'referrer-policy')), h(page, 'referrer-policy'));
    check('the first http request is refused by the browser afterwards',
      /max-age=\d+/.test(h(page, 'strict-transport-security')), h(page, 'strict-transport-security'));
    check('and the server stops naming itself', !h(page, 'x-powered-by'), h(page, 'x-powered-by'));

    // MOUNTED BEFORE THE STATIC FILES. After them, the pages carry the
    // headers and the files - most of what a browser loads - carry none.
    const asset = await go('/js/orderId.js');
    check('a static file carries them too',
      h(asset, 'x-content-type-options') === 'nosniff' && !h(asset, 'x-powered-by'),
      { nosniff: h(asset, 'x-content-type-options'), powered: h(asset, 'x-powered-by') });

    // Every /api answer is about one person. A browser or a CDN holding one
    // can hand it to the next person at that machine.
    const api = await go('/api/orders', { headers: { cookie } });
    check('nothing under /api is kept by the browser',
      /no-store/.test(h(api, 'cache-control')), h(api, 'cache-control'));
    check('and it is not revalidated into a 304 either',
      /must-revalidate|no-cache/.test(h(api, 'cache-control')), h(api, 'cache-control'));

    // The three shared scripts are public and unchanging, and they are
    // deliberately NOT no-store: they are the same file for everybody.
    check('the shared browser scripts may still be cached',
      /max-age/.test(h(asset, 'cache-control')), h(asset, 'cache-control'));

    // CSP stays off until the inline handlers are gone. Said here so the
    // next person reads it as a decision rather than a miss.
    check('CSP is deliberately not on yet (inline handlers)',
      !h(page, 'content-security-policy'));

    // ══════════════════════════════════════════════════
    // 4. GUESSING PASSWORDS
    //
    // The office's staff emails are not a secret, and a login form with
    // nothing in front of it lets a script try a thousand passwords against
    // each of them in a minute. Two limits, because they stop two different
    // attacks - a slow grind at one account, and a burst from one caller.
    console.log(NL + 'Guessing passwords');
    const tryLogin = (email, password) => go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }),
    });
    const signedIn = (r) => !!(r.headers.get('set-cookie') || '').includes('connect.sid');

    // ── per account ──
    const victim = process.env.ADMIN_EMAIL;
    for (let i = 0; i < 10; i++) await tryLogin(victim, 'not-the-password-' + i);
    const locked = await tryLogin(victim, process.env.ADMIN_PASSWORD);
    // THE POINT OF THE LOCK: the eleventh try is refused even though it is
    // RIGHT. Without that, ten wrong guesses cost an attacker nothing.
    check('after ten wrong answers even the right password is refused',
      !signedIn(locked), 'signed in anyway');
    const [[row]] = await db.query(
      'SELECT tries, locked_until FROM login_attempts WHERE email = ?', [victim]);
    check('and the account is written down as locked',
      row && row.tries >= 10 && row.locked_until, row);
    // It must not say WHICH of the two went wrong: "that account is locked"
    // tells a guesser the address is real.
    const lockedBody = await locked.text();
    check('the page does not say whether the account exists',
      !/locked|exists|no such/i.test(lockedBody), lockedBody.slice(0, 80));

    // ── an address nobody owns is counted too ──
    // Otherwise the throttle itself answers "does this email exist?" - the
    // real ones get slower, the invented ones never do.
    for (let i = 0; i < 10; i++) await tryLogin('nobody@example.com', 'x' + i);
    const [[ghost]] = await db.query(
      "SELECT tries FROM login_attempts WHERE email = 'nobody@example.com'");
    check('an address nobody owns is counted the same way', ghost && ghost.tries >= 10, ghost);

    // ── the lock lets go, and a success wipes the slate ──
    await db.query('UPDATE login_attempts SET locked_until = NOW() - INTERVAL 1 MINUTE WHERE email = ?',
      [victim]);
    const back = await tryLogin(victim, process.env.ADMIN_PASSWORD);
    check('when the lock expires the right password works again', signedIn(back));
    const [[gone]] = await db.query(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE email = ?', [victim]);
    check('and signing in clears the count', gone.n === 0, gone);

    // ── the caller cannot hand itself a new identity ──
    // A limiter keyed on a header the caller writes is a limiter with no
    // key: every attempt looks like a new person. Off the platform the
    // socket address is the only thing that is true, so these headers must
    // change nothing at all.
    const guardSrc = require('fs').readFileSync(path.join(ROOT, 'utils/loginGuard.js'), 'utf8');
    check('the raw X-Forwarded-For is never used as the key',
      !/headers\['x-forwarded-for'\]/.test(guardSrc));
    // On an address that is NOT already locked - a locked one is refused
    // before anything is counted, so it would prove nothing.
    await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'fresh@example.com', password: 'x' }),
    });
    const [[one]] = await db.query(
      "SELECT tries FROM login_attempts WHERE email = 'fresh@example.com'");
    await go('/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': '203.0.113.' + Math.floor(Math.random() * 250),
      },
      body: new URLSearchParams({ email: 'fresh@example.com', password: 'x' }),
    });
    const [[two]] = await db.query(
      "SELECT tries FROM login_attempts WHERE email = 'fresh@example.com'");
    check('and a made-up one does not buy a fresh count',
      two.tries === one.tries + 1, { before: one.tries, after: two.tries });

    // ── the normal flow, which all of this must not touch ──
    await db.query('DELETE FROM login_attempts');
    const fine = await tryLogin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
    check('a normal sign-in is untouched', signedIn(fine));

    // ══════════════════════════════════════════════════
    // 5. WHAT AN ERROR IS ALLOWED TO SAY
    //
    // A hundred and thirteen routes answer a failure with `err.message` -
    // the driver's own words, which name the table, the database user and
    // the host. A stranger who can make a page fail gets a map of the
    // system; the person reading it can do nothing with it either.
    //
    // The failure is REAL here: a table is renamed out from under a route,
    // which is as close to a production fault as a test can honestly get.
    console.log(NL + 'What an error says');
    const bcrypt = require('bcryptjs');
    await db.query(
      `INSERT INTO users (emp_id, username, email, password, role, domain)
       VALUES ('E-PROBE','Probe Designer','designer-probe@test.local',?,'Designer','Design')`,
      [await bcrypt.hash('designer-probe-123', 10)]);
    const asDesigner = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'designer-probe@test.local', password: 'designer-probe-123',
      }),
    });
    const deskCookie = (asDesigner.headers.get('set-cookie') || '').split(';')[0];
    check('the probe designer is signed in', !!deskCookie);

    await db.query('RENAME TABLE orders TO orders_hidden_for_test');
    const broke = await go('/api/orders', { headers: { cookie: deskCookie } });
    const brokeBody = await broke.json().catch(() => ({}));
    check('a broken route answers 500', broke.status === 500, broke.status);
    check('and tells a designer nothing about the database',
      !/orders|table|sql|mysql/i.test(String(brokeBody.error || '')), brokeBody);
    check('it says something a person can act on',
      /try again/i.test(String(brokeBody.error || '')), brokeBody);

    // The driver's words are taken off EVERYBODY, admin included: they name
    // the database user and the host, and "busy" is what the sentence means.
    const asAdmin = await go('/api/orders', { headers: { cookie } });
    const adminBody = await asAdmin.json().catch(() => ({}));
    check('and a SuperAdmin is not shown the database either',
      !/orders_hidden_for_test|railway|doesn't exist/i.test(String(adminBody.error || '')),
      adminBody);
    await db.query('RENAME TABLE orders_hidden_for_test TO orders');

    // The app's OWN sentences, which are 4xx, have to come through
    // untouched - they are written for the person reading them.
    const refused = await go('/api/orders', {
      method: 'POST',
      headers: { cookie: deskCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'x@test.local', punchedBy: 'India Team',
        dealer: 'D', client: 'C', remarks: 'r', designer: 'Rakesh', designTime: '1 Hour' }),
    });
    const refusedBody = await refused.json().catch(() => ({}));
    check('a 4xx the app wrote is passed through word for word',
      refused.status === 400 && /RUSH or a Normal/i.test(String(refusedBody.error || '')),
      refusedBody);

    // And the shapes the driver speaks in, checked directly.
    const { fromTheDriver } = require(path.join(ROOT, 'middleware/apiErrors.js'));
    for (const said of [
      "Table 'railway.orders' doesn't exist",
      "Access denied for user 'arabella'@'10.0.0.4'",
      'User arabella already has more than max_user_connections active connections',
      'connect ETIMEDOUT',
      'ER_BAD_FIELD_ERROR: Unknown column x',
    ]) check('recognised as the database talking: ' + said.slice(0, 34), fromTheDriver(said));
    check('and an ordinary sentence is left alone',
      !fromTheDriver('Order Quantity must be 1 or more.'));

    // The normal flow, untouched.
    const ok = await go('/api/orders', { headers: { cookie } });
    check('a working route still answers normally', ok.status === 200, ok.status);

    // ══════════════════════════════════════════════════
    // 6. A DELETE BUTTON THAT KEEPS THE COPY
    //
    // Fourteen endpoints end in DELETE FROM. Before this, a mistaken delete
    // and a deliberate one left the same trace - none - and a punched order,
    // 130 columns of it, could not be typed back in.
    //
    // Two halves, and the second is the one that matters: the copy has to be
    // there, AND a delete that cannot be copied has to be refused.
    console.log(NL + 'What a delete leaves behind');
    await db.query(
      `INSERT INTO orders (order_id, dealer_name, client_name, remarks, status_4)
       VALUES ('K-ARCH-1', 'Dealer Archive', 'Client Archive', 'the remark', 'Ready')`);

    const archGone = await go('/api/orders/K-ARCH-1', { method: 'DELETE', headers: { cookie } });
    check('a SuperAdmin can still delete an order', archGone.status === 200, archGone.status);
    const [[archStill]] = await db.query(
      "SELECT COUNT(*) c FROM orders WHERE order_id = 'K-ARCH-1'");
    check('and the order is really gone', archStill.c === 0, archStill);

    const [[archKept]] = await db.query(
      "SELECT * FROM deleted_records WHERE table_name = 'orders' AND record_key = 'K-ARCH-1'");
    check('the row was kept', !!archKept);
    check('with every field in it, readable',
      !!archKept && /Client Archive/.test(archKept.payload) && /the remark/.test(archKept.payload),
      archKept && archKept.payload && archKept.payload.slice(0, 120));
    check('and the name of whoever pressed the button',
      !!archKept && archKept.deleted_by_email === 'probe@test.local',
      archKept && archKept.deleted_by_email);
    check('and the route it came in on',
      !!archKept && /DELETE .*orders\/K-ARCH-1/.test(archKept.route), archKept && archKept.route);

    // Image bytes are deliberately NOT kept - a 16MB blob per deleted row is
    // an archive nobody can open. The row around them still is.
    await db.query(
      `INSERT INTO catalogue_items (category, name, bytes, mime_type)
       VALUES ('Patterns', 'Archive Probe Design', ?, 'image/png')`,
      [Buffer.alloc(4096, 7)]);
    const [[pic]] = await db.query(
      "SELECT id FROM catalogue_items WHERE name = 'Archive Probe Design'");
    const picGone = await go('/api/catalogue/' + pic.id, { method: 'DELETE', headers: { cookie } });
    check('a catalogue design can still be deleted', picGone.status === 200, picGone.status);
    const [[picKept]] = await db.query(
      "SELECT payload FROM deleted_records WHERE table_name = 'catalogue_items' ORDER BY id DESC LIMIT 1");
    check('its name was kept', !!picKept && /Archive Probe Design/.test(picKept.payload));
    check('and its image bytes were not',
      !!picKept && /bytes of binary, not kept/.test(picKept.payload)
      && picKept.payload.length < 3000,
      picKept && picKept.payload.length);

    // ── THE HALF THAT MATTERS ──
    // The archive is taken away, and the delete must refuse rather than go
    // ahead uncopied. Without this check the whole item passes on a server
    // where the copy quietly swallows its own failure.
    await db.query(
      `INSERT INTO orders (order_id, dealer_name, client_name, status_4)
       VALUES ('K-ARCH-2', 'Dealer Two', 'Client Two', 'Ready')`);
    await db.query('RENAME TABLE deleted_records TO deleted_records_hidden');
    const blocked = await go('/api/orders/K-ARCH-2', { method: 'DELETE', headers: { cookie } });
    check('with nowhere to keep the copy, the delete is refused',
      blocked.status >= 500, blocked.status);
    const [[survived]] = await db.query(
      "SELECT COUNT(*) c FROM orders WHERE order_id = 'K-ARCH-2'");
    check('and the order is still there', survived.c === 1, survived);
    await db.query('RENAME TABLE deleted_records_hidden TO deleted_records');

    const nowWorks = await go('/api/orders/K-ARCH-2', { method: 'DELETE', headers: { cookie } });
    check('with the archive back, the same delete goes through',
      nowWorks.status === 200, nowWorks.status);

    // ══════════════════════════════════════════════════
    // 7. AN UPLOAD IS WHAT ITS BYTES SAY, NOT WHAT IT CLAIMS
    //
    // Every upload check read req.file.mimetype - a line the browser types
    // into the request. So a Windows program posted as "image/png" was a
    // catalogue design, a CV mailed to the office, a file on Drive for
    // somebody to double-click.
    //
    // The attack here is exactly that: real executable bytes, labelled
    // image/png, with a .png on the end. And the normal flow next to it: a
    // real PNG, which must still go up.
    console.log(NL + 'What an upload really is');

    const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x41)]);
    // A one-pixel PNG, header and all - a genuine file, not a stand-in.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64');

    const postFile = async (url, field, name, type, bytes, extra) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(extra || {})) form.append(k, v);
      form.append(field, new Blob([bytes], { type }), name);
      return go(url, { method: 'POST', headers: { cookie }, body: form });
    };

    const dressed = await postFile('/api/catalogue', 'image', 'design.png', 'image/png',
      EXE, { category: 'Patterns', name: 'Dressed up' });
    const dressedBody = await dressed.json().catch(() => ({}));
    check('a program posted as image/png is refused',
      dressed.status === 400, dressed.status);
    check('and the sentence names the file, not the format it really is',
      /design\.png/.test(String(dressedBody.error || ''))
      && !/exe|executable|windows/i.test(String(dressedBody.error || '')), dressedBody);
    const [[none]] = await db.query(
      "SELECT COUNT(*) c FROM catalogue_items WHERE name = 'Dressed up'");
    check('and nothing was stored', none.c === 0, none);

    // The other way round: a real PNG wearing somebody else's extension.
    const misnamed = await postFile('/api/catalogue', 'image', 'design.pdf', 'image/png',
      PNG, { category: 'Patterns', name: 'Misnamed' });
    check('a real PNG called .pdf is refused too', misnamed.status === 400, misnamed.status);

    // An SVG is a document that can carry script, and this picture is handed
    // back out from our own address. It is no longer a picture here at all.
    const svg = await postFile('/api/catalogue', 'image', 'art.svg', 'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      { category: 'Patterns', name: 'Scripted' });
    check('an SVG is refused', svg.status === 400, svg.status);

    // ── AND THE NORMAL FLOW ──
    const real = await postFile('/api/catalogue', 'image', 'design.png', 'image/png',
      PNG, { category: 'Patterns', name: 'Genuine Design' });
    const realBody = await real.json().catch(() => ({}));
    check('a real PNG still goes up', real.status === 200 && !!realBody.id, realBody);
    const [[saved]] = await db.query(
      "SELECT mime_type FROM catalogue_items WHERE name = 'Genuine Design'");
    check('and the type stored is the one read out of the bytes',
      !!saved && saved.mime_type === 'image/png', saved);

    // Handing it back: told what it is, and told not to guess.
    const shown = await go('/catalogue/image/' + realBody.id);
    check('the picture is served', shown.status === 200, shown.status);
    check('with its type stated and sniffing turned off',
      shown.headers.get('content-type') === 'image/png'
      && shown.headers.get('x-content-type-options') === 'nosniff',
      [shown.headers.get('content-type'), shown.headers.get('x-content-type-options')]);

    // An SVG uploaded before any of this existed is still in the table. It
    // must come back as bytes to save, never as a page the browser opens.
    await db.query(
      `INSERT INTO catalogue_items (category, name, file_name, mime_type, bytes)
       VALUES ('Patterns', 'Old SVG', 'old.svg', 'image/svg+xml', ?)`,
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]);
    const [[old]] = await db.query(
      "SELECT id FROM catalogue_items WHERE name = 'Old SVG'");
    const oldOne = await go('/catalogue/image/' + old.id);
    check('an SVG already in the table is not served as one',
      oldOne.headers.get('content-type') === 'application/octet-stream',
      oldOne.headers.get('content-type'));
    check('and the browser is told to save it, not open it',
      /^attachment/.test(String(oldOne.headers.get('content-disposition'))),
      oldOne.headers.get('content-disposition'));

    // ══════════════════════════════════════════════════
    // 8. ONE DESIGNER, ANOTHER DESIGNER'S ORDER
    //
    // The Orders Dashboard was always careful - a designer's list holds the
    // orders carrying their name, and the View box asks the same question.
    // Every other route taking an order id in its address asked nothing,
    // and ids run in sequence, so changing the number WAS the attack.
    // Measured before the fix, signed in as a designer with no board
    // access: order-details handed back the whole order, and status, edit,
    // production and till-approval all answered 200 - one designer could
    // cancel another's order and overwrite its dealer.
    //
    // The refusal is 404 with the same sentence as a missing order: ids are
    // sequential, and "not allowed" would confirm which ones exist.
    console.log(NL + "Another designer's order");

    await db.query(
      `INSERT INTO users (emp_id, username, email, password, role, domain)
       VALUES ('E-MINE','Designer Mine','mine-probe@test.local',?,'Designer','Design')`,
      [await bcrypt.hash('mine-probe-123', 10)]);
    await db.query(
      `INSERT INTO orders (order_id, dealer_name, client_name, india_designer, remarks)
       VALUES ('K-MINE-1','Dealer M','Client Mine','Designer Mine','my remark'),
              ('K-THEIRS-1','Dealer T','Client Theirs','Designer Other','their remark')`);

    const asMine = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'mine-probe@test.local', password: 'mine-probe-123' }),
    });
    const mineCookie = (asMine.headers.get('set-cookie') || '').split(';')[0];
    check('the probe designer is signed in', !!mineCookie);

    const asDesignerGo = (url, opts) => go(url, Object.assign(
      { headers: { cookie: mineCookie } }, opts || {}));
    const form = (fields) => ({
      method: 'PUT',
      headers: { cookie: mineCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const jsonPut = (body) => ({
      method: 'PUT',
      headers: { cookie: mineCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // ── THE ATTACK ──
    const peek = await asDesignerGo('/api/dashboards/order-details/K-THEIRS-1');
    const peekBody = await peek.text();
    check('the full order of somebody else is refused', peek.status === 404, peek.status);
    check('and none of it came back',
      !/Client Theirs|their remark/.test(peekBody), peekBody.slice(0, 140));
    check('the refusal reads like a missing order',
      /Order not found/.test(peekBody), peekBody.slice(0, 140));

    const cancel = await asDesignerGo('/api/orders/K-THEIRS-1/status',
      form({ designStatus: 'Cancelled', remark: 'taken over', userEmail: 'mine-probe@test.local' }));
    check('their order cannot be cancelled', cancel.status === 404, cancel.status);

    const rewrite = await asDesignerGo('/api/orders/K-THEIRS-1/edit',
      form({ dealer: 'Dealer M', client: 'Client Mine', remarks: 'mine now' }));
    check('their order cannot be rewritten', rewrite.status === 404, rewrite.status);

    const stage = await asDesignerGo('/api/dashboards/production/K-THEIRS-1',
      jsonPut({ Paper_Cutting: 'Done', userEmail: 'mine-probe@test.local' }));
    check('their stages cannot be marked done', stage.status === 404, stage.status);

    const approve = await asDesignerGo('/api/dashboards/till-approval/K-THEIRS-1',
      jsonPut({ approvalStatus: 'Final Approval For Production', remark: 'x' }));
    check('their approval cannot be set', approve.status === 404, approve.status);

    const [[untouched]] = await db.query(
      "SELECT design_status, dealer_name, remarks FROM orders WHERE order_id = 'K-THEIRS-1'");
    // 'Fresh Design' is the column's own default, never written here - what
    // matters is that Cancelled, the dealer and the remark are untouched.
    check('and their order is exactly as it was',
      untouched.dealer_name === 'Dealer T' && untouched.remarks === 'their remark'
      && untouched.design_status === 'Fresh Design', untouched);

    // ── AND THE NORMAL FLOW, WHICH IS THE POINT ──
    const own = await asDesignerGo('/api/dashboards/order-details/K-MINE-1');
    const ownBody = await own.text();
    check('their OWN order still opens', own.status === 200, own.status);
    check('with its details in it', /Client Mine/.test(ownBody), ownBody.slice(0, 140));

    const ownStatus = await asDesignerGo('/api/orders/K-MINE-1/status',
      form({ designStatus: 'Fresh Design', remark: 'working on it',
             userEmail: 'mine-probe@test.local' }));
    check('and they can still set a status on it', ownStatus.status === 200, ownStatus.status);
    const [[mineNow]] = await db.query(
      "SELECT design_status FROM orders WHERE order_id = 'K-MINE-1'");
    check('which is written', mineNow.design_status === 'Fresh Design', mineNow);

    // A SuperAdmin works the whole floor and must notice nothing.
    const admins = await go('/api/dashboards/order-details/K-THEIRS-1', { headers: { cookie } });
    check('a SuperAdmin still reads any order', admins.status === 200, admins.status);

    // ══════════════════════════════════════════════════
    // 9. A ROLE TAKEN AWAY IS TAKEN AWAY NOW
    //
    // Every permission in the app was read from req.session.user.role,
    // written once at sign-in and never looked at again for eight hours. So
    // somebody taken off SuperAdmin at ten o'clock still deleted orders at
    // five, and a deleted account kept its open tab working.
    //
    // The attack being refused is a session OUTLIVING the permission behind
    // it; the normal flow is that nobody else is disturbed by the check.
    console.log(NL + 'A role taken away');

    await db.query(
      `INSERT INTO users (emp_id, username, email, password, role, domain)
       VALUES ('E-DEMO','Probe Demote','demote-probe@test.local',?,'SuperAdmin','Head')`,
      [await bcrypt.hash('demote-probe-123', 10)]);
    const demoteLogin = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'demote-probe@test.local', password: 'demote-probe-123' }),
    });
    const demoteCookie = (demoteLogin.headers.get('set-cookie') || '').split(';')[0];
    check('the probe SuperAdmin is signed in', !!demoteCookie);

    await db.query(
      `INSERT INTO orders (order_id, dealer_name, client_name, status_4)
       VALUES ('K-DEMO-1','Dealer D','Client D','Ready'),
              ('K-DEMO-2','Dealer D','Client D','Ready')`);

    // While they still hold it, the SuperAdmin-only button works.
    const whileAdmin = await go('/api/orders/K-DEMO-1',
      { method: 'DELETE', headers: { cookie: demoteCookie } });
    check('a SuperAdmin can delete an order', whileAdmin.status === 200, whileAdmin.status);

    // Taken off the role in the table - the way it is really done, by
    // somebody editing the account - with the session left alone.
    await db.query(
      "UPDATE users SET role = 'Designer', domain = 'Design' WHERE email = 'demote-probe@test.local'");

    const afterDemote = await go('/api/orders/K-DEMO-2',
      { method: 'DELETE', headers: { cookie: demoteCookie } });
    check('after the demotion the same cookie is refused',
      afterDemote.status === 403, afterDemote.status);
    const [[survivor]] = await db.query(
      "SELECT COUNT(*) c FROM orders WHERE order_id = 'K-DEMO-2'");
    check('and the order is still there', survivor.c === 1, survivor);

    // They are still signed in - this is a demotion, not a lock-out.
    const whoami = await go('/api/orders', { headers: { cookie: demoteCookie } });
    check('they are still signed in', whoami.status === 200, whoami.status);

    // The window is a real one, not zero: this run sets it to zero so the
    // demotion above is seen on the next request, but what ships is half a
    // minute - a query per session per thirty seconds, not one per tile.
    delete require.cache[require.resolve(path.join(ROOT, 'middleware/freshUser.js'))];
    const savedWindow = process.env.ROLE_RECHECK_MS;
    delete process.env.ROLE_RECHECK_MS;
    const { RECHECK_MS } = require(path.join(ROOT, 'middleware/freshUser.js'));
    process.env.ROLE_RECHECK_MS = savedWindow;
    check('the shipped window is half a minute', RECHECK_MS === 30000, RECHECK_MS);

    // A deleted account is a different answer: the session goes with it.
    await db.query("DELETE FROM users WHERE email = 'demote-probe@test.local'");
    const afterDelete = await go('/api/orders', { headers: { cookie: demoteCookie } });
    check('a deleted account is turned away', afterDelete.status === 401, afterDelete.status);
    const stillDead = await go('/api/orders', { headers: { cookie: demoteCookie } });
    check('and stays turned away', stillDead.status === 401, stillDead.status);

    // ── AND EVERYBODY ELSE ──
    const adminStill = await go('/api/orders', { headers: { cookie } });
    check('an untouched session carries on working',
      adminStill.status === 200, adminStill.status);

    // ══════════════════════════════════════════════════
    // 10. A LIMIT A CALLER CANNOT KEY FOR THEMSELVES
    //
    // Four public endpoints - the client portal's register, verify, login
    // and reset, the quote page, the catalogue's email box and the
    // tracking page - counted attempts against the first entry of
    // `x-forwarded-for`. The caller writes that header. One line of change
    // per request and every attempt looked like the first visit of a new
    // person, so twenty became as many as they liked.
    //
    // The attack is exactly that: the same caller, a new address each
    // time. The normal flow is the one honest visitor, who must still get
    // through.
    console.log(NL + 'A limit that cannot be shrugged off');

    const spoofed = async (n) => {
      let refused = 0;
      for (let i = 0; i < n; i++) {
        const r = await go('/track/api?order=K-1&name=someone', {
          headers: { 'X-Forwarded-For': '203.0.113.' + i },
        });
        if (r.status === 429) refused++;
      }
      return refused;
    };

    // Twelve a minute is the tracking page's limit; thirty tries with a new
    // address each time must still run into it.
    check('a new X-Forwarded-For every time does not buy more tries',
      (await spoofed(30)) > 0);

    // And the honest visitor, from an address that has not been spending
    // the allowance, is still served. A fresh window is what the next
    // minute gives them; here it is enough that the answer is not a 429
    // for a caller the limiter has not seen - which is the socket, the
    // same one the burst above was counted against, so this check is the
    // one that would break if the fix were simply "refuse everybody".
    const honest = await go('/track');
    check('the tracking page itself still opens', honest.status === 200, honest.status);

    // The portal's own limiter reads the same helper rather than keeping a
    // second, spoofable copy - checked directly, because its window is ten
    // minutes and a hundred requests is a slow way to prove a require.
    const portalSrc = require('fs').readFileSync(
      path.join(ROOT, 'routes/clientPortal.js'), 'utf8');
    const quoteSrc = require('fs').readFileSync(
      path.join(ROOT, 'routes/quote.js'), 'utf8');
    const catSrc = require('fs').readFileSync(
      path.join(ROOT, 'routes/catalogue.js'), 'utf8');
    const trackSrc = require('fs').readFileSync(
      path.join(ROOT, 'routes/track.js'), 'utf8');
    for (const [name, src] of [['the client portal', portalSrc], ['the quote page', quoteSrc],
      ['the catalogue', catSrc], ['the tracking page', trackSrc]]) {
      check(name + ' reads the shared helper',
        /require\('\.\.\/utils\/callerIp'\)/.test(src));
      check('and ' + name + ' no longer reads the raw header',
        !/headers\['x-forwarded-for'\]/.test(src));
    }

    // The helper itself: the header is ignored off the platform, and on it
    // only what the platform wrote is read.
    delete require.cache[require.resolve(path.join(ROOT, 'utils/callerIp.js'))];
    const { callerIp } = require(path.join(ROOT, 'utils/callerIp.js'));
    const pretend = {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-vercel-forwarded-for': '9.9.9.9',
      },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    };
    check('off the platform, only the socket counts',
      callerIp(pretend) === '127.0.0.1', callerIp(pretend));
    process.env.VERCEL = '1';
    check('on the platform, only what the platform wrote counts',
      callerIp(pretend) === '9.9.9.9', callerIp(pretend));
    delete process.env.VERCEL;

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    try { server.close(); } catch (e) {}
    try { await db.end(); } catch (e) {}
    try {
      await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
      await admin.end();
    } catch (e) {}
    console.log('Throwaway database dropped.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
