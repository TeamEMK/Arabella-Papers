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
