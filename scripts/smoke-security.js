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
