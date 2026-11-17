/**
 * CLOSING THE TAB SIGNS YOU OUT.
 *
 *   node scripts/smoke-tab-close.js
 *
 * Three things, and the middle one is the whole reason this is not simply
 * "beacon ends session":
 *
 *   A CLOSED TAB ENDS THE SESSION, and the log says when, from where, and
 *   which screen the person was looking at.
 *
 *   A RELOAD DOES NOT. `pagehide` fires on F5 exactly as it does on a cross,
 *   and signing somebody out for pressing refresh would be worse than never
 *   signing them out at all. A page that comes back inside the grace window
 *   keeps its session - and the row written on the way out is withdrawn,
 *   because nobody went anywhere.
 *
 *   A SECOND TAB KEEPS THEM IN. Same session, same cookie: the server cannot
 *   tell two tabs apart, so this is the browser's job and the proof of it is
 *   that a request arriving behind the beacon revives the session.
 *
 * The grace window is cut to a fraction of a second here. In the office it is
 * twenty, which nobody is waiting on.
 *
 * Builds its own throwaway database. Never live.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_tabclose_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.PORT = '0';
process.env.TAB_GRACE_MS = '400';

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const tabClose = require(path.join(ROOT, 'middleware/tabClose.js'));

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  // Proved signed in before the cookie is believed: the session table is
  // created on startup and a brand new database can hand back a cookie that
  // was never stored.
  const signIn = async () => {
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const r = await go('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
        }),
      });
      const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      if (cookie) {
        const who = await go('/api/orders', { headers: { cookie } });
        last = who.status;
        if (who.status === 200) return cookie;
      }
      await sleep(200);
    }
    throw new Error('could not sign in (last answer ' + last + ')');
  };

  // The beacon, exactly as navigator.sendBeacon sends it.
  const beacon = (cookie, screen) => go('/api/session/closing', {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen }),
  });
  const stillIn = async (cookie) => (await go('/api/orders', { headers: { cookie } })).status === 200;
  const logoutRows = async () => {
    const [rows] = await db.query(
      "SELECT action, screen, email, logged_at FROM activity_log WHERE action LIKE 'Logout%' ORDER BY id");
    return rows;
  };

  try {
    // ──────────────────────────────────────────────
    console.log(NL + 'The screen is named, not guessed');
    check('a known tab becomes its own name',
      tabClose.screenName('productionBD') === 'Production Dashboard',
      tabClose.screenName('productionBD'));
    // Whatever arrives in that field came from a browser. Anything not in the
    // menu is nothing, so nobody can write a sentence of their own into the
    // activity log through it.
    check('an unknown one is nothing', tabClose.screenName('<script>') === '');
    check('and so is an empty one', tabClose.screenName('') === '' && tabClose.screenName(null) === '');

    // ──────────────────────────────────────────────
    console.log(NL + 'Closing the last tab signs you out');
    let jar = await signIn();
    check('signed in to start with', await stillIn(jar));
    const closed = await beacon(jar, 'productionBD');
    check('the beacon is accepted', closed.status === 204, closed.status);
    await sleep(600);
    check('the session is gone', !(await stillIn(jar)));

    let rows = await logoutRows();
    check('one row was written', rows.length === 1, rows);
    check('it says the tab closed',
      rows[0] && rows[0].action === 'Logout (tab closed)', rows[0]);
    check('and which screen they were on',
      rows[0] && rows[0].screen === 'Production Dashboard', rows[0]);
    check('against the right person',
      rows[0] && rows[0].email === process.env.ADMIN_EMAIL, rows[0]);
    // Dated when the tab closed, not when we noticed. Somebody who closes the
    // tab and goes home sends nothing else, so a row written on the next
    // request would carry whatever time they came back - or never be written.
    const wrote = new Date(rows[0].logged_at).getTime();
    check('dated the moment the tab closed, not the moment we noticed',
      Math.abs(Date.now() - wrote) < 60000, rows[0].logged_at);

    check('and signing in again works', !!(jar = await signIn()));

    // ──────────────────────────────────────────────
    console.log(NL + 'A reload does not');
    await db.query("DELETE FROM activity_log WHERE action LIKE 'Logout%'");
    jar = await signIn();
    await beacon(jar, 'dashboard');
    // The page comes straight back, which is what a reload looks like from
    // here. No wait: that is the point.
    check('the session survives', await stillIn(jar));
    check('and the row is withdrawn, because nobody left',
      (await logoutRows()).length === 0, await logoutRows());
    check('still in a moment later', await stillIn(jar));

    // ──────────────────────────────────────────────
    console.log(NL + 'A second tab keeps you in');
    await db.query("DELETE FROM activity_log WHERE action LIKE 'Logout%'");
    jar = await signIn();
    await beacon(jar, 'pms');
    // The other tab carrying on is what revives it - the browser half only
    // beacons when the last tab goes, and this is the server end of that.
    check('the other tab is served', await stillIn(jar));
    await sleep(600);
    check('and stays served', await stillIn(jar));
    check('with nothing written against them',
      (await logoutRows()).length === 0, await logoutRows());

    // ──────────────────────────────────────────────
    console.log(NL + 'Nothing leaks');
    const nobody = await go('/api/session/closing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'dashboard' }),
    });
    check('a beacon with no session is simply ignored', nobody.status === 204, nobody.status);
    check('and writes nothing', (await logoutRows()).length === 0);

    // ──────────────────────────────────────────────
    console.log(NL + 'The browser half is actually in the page');
    const fs = require('fs');
    const shell = fs.readFileSync(path.join(ROOT, 'views/app.ejs'), 'utf8');
    check('it beacons the closing address', shell.includes("'/api/session/closing'"));
    // On pagehide, not beforeunload: beforeunload is ignored on phones, where
    // the tab is closed by the operating system and the page never "unloads".
    // The shell does use beforeunload elsewhere - that is the warning shown
    // to a designer who still owes vector files - so this asks about the
    // listener that beacons, not about the word.
    check('it listens on pagehide',
      /addEventListener\('pagehide'/.test(shell));
    check('and nothing beacons from beforeunload',
      !/addEventListener\('beforeunload', *function[^]{0,400}sendBeacon/.test(shell));
    check('and keeps a register of open tabs, so one of two is not a leaving',
      shell.includes('openTabs_arabella'));

    console.log(NL + 'The activity screen can show it');
    const ua = fs.readFileSync(path.join(ROOT, 'views/views/userActivity.ejs'), 'utf8');
    check('the table prints the screen', ua.includes('r.Screen'));
    check('and the closed-tab row has a colour of its own',
      ua.includes("'Logout (tab closed)'"));

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
