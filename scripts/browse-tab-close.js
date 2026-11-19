/**
 * CLOSING THE TAB, IN A REAL BROWSER.
 *
 *   node scripts/browse-tab-close.js
 *
 * scripts/smoke-tab-close.js proves the server's half by posting the beacon
 * by hand. The half it cannot reach is the one that decides WHETHER to send
 * it: a register of open tabs kept in localStorage, so that closing one of
 * two is not somebody leaving. That only exists in a browser with more than
 * one tab in it, so here are two real ones.
 *
 * Chrome closes the tabs. Nothing is simulated: the pages are opened, signed
 * in, reloaded and crossed off through the debugging protocol, and the
 * question each time is what ended up in the activity log.
 *
 * Throwaway database of its own. Never live.
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const mysql = require('mysql2/promise');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_tabclose_browse';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.PORT = '0';
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

// Long enough that a reload comfortably comes back inside it, short enough
// that this suite is not sitting still for twenty seconds.
process.env.TAB_GRACE_MS = '2500';

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

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};
const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

(async () => {
  if (!CHROME) throw new Error('Chrome not found.');
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

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tabclose-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run', '--window-size=1400,900',
    BASE + '/login',
  ], { stdio: 'ignore' });

  const sockets = [];
  const tidy = async () => {
    for (const s of sockets) { try { s.close(); } catch (e) {} }
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    try { server.close(); } catch (e) {}
    try { await db.end(); } catch (e) {}
    try {
      await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
      await admin.end();
    } catch (e) {}
  };

  // One connection per tab. Each has its own message numbering, which is why
  // this is a factory and not three globals.
  const attach = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    sockets.push(ws);
    await new Promise(r => { ws.onopen = r; });
    const waiting = new Map();
    let n = 0;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    };
    const send = (method, params) => new Promise(res => {
      const k = ++n; waiting.set(k, res);
      ws.send(JSON.stringify({ id: k, method, params: params || {} }));
    });
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result && r.result.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    return { id: target.id, ws, send, ev };
  };

  // Jaipur, give or take twenty metres - a believable phone.
  const PIN = { lat: 26.9124, lng: 75.7873, acc: 20 };

  const tabs = () => fetch('http://127.0.0.1:' + dbg + '/json/list').then(r => r.json());
  const openTab = async (url) => {
    const t = await fetch('http://127.0.0.1:' + dbg + '/json/new?' + encodeURIComponent(url),
      { method: 'PUT' }).then(r => r.json());
    await sleep(1500);
    const all = await tabs();
    return attach(all.find(x => x.id === t.id));
  };
  const closeTab = (id) => fetch('http://127.0.0.1:' + dbg + '/json/close/' + id).then(r => r.text());

  // Waits for the shell to be running, not merely for the HTML to arrive.
  const waitForShell = async (tab) => {
    for (let i = 0; i < 80; i++) {
      if (await tab.ev("typeof loadPage === 'function'").catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const logoutRows = async () => {
    const [rows] = await db.query(
      "SELECT action, screen FROM activity_log WHERE action LIKE 'Logout%' ORDER BY id");
    return rows;
  };

  try {
    let list;
    for (let i = 0; i < 60; i++) {
      try {
        list = await tabs();
        if (list.some(t => t.webSocketDebuggerUrl)) break;
      } catch (e) { /* not up yet */ }
      await sleep(250);
    }

    const first = await attach(list.find(t => t.webSocketDebuggerUrl));
    // A REAL BROWSER THAT HAS BEEN ALLOWED TO SAY WHERE IT IS.
    //
    // Headless Chrome refuses geolocation by default, which is the same
    // silence as a person clicking Block - so without these two lines this
    // suite would prove the pin works by never testing it. Granted, and then
    // given a position to report.
    await first.send('Browser.grantPermissions',
      { origin: BASE, permissions: ['geolocation'] });
    await first.send('Emulation.setGeolocationOverride',
      { latitude: PIN.lat, longitude: PIN.lng, accuracy: PIN.acc });
    await first.send('Page.navigate', { url: BASE + '/login' });
    await sleep(1200);
    await first.ev("document.querySelector('input[type=email],input[name=email]').value='"
      + process.env.ADMIN_EMAIL + "';"
      + "document.querySelector('input[type=password]').value='"
      + process.env.ADMIN_PASSWORD + "';"
      + "document.querySelector('form').submit();");
    await sleep(2500);
    await first.send('Page.navigate', { url: BASE + '/app/production-bd' });
    await waitForShell(first);
    await sleep(800);

    console.log(NL + 'One tab, signed in');
    check('the shell is running', await first.ev("typeof loadPage === 'function'"));
    check('and it has written itself into the register of open tabs',
      (await first.ev("Object.keys(JSON.parse(localStorage.getItem('openTabs_arabella')||'{}')).length")) === 1,
      await first.ev("localStorage.getItem('openTabs_arabella')"));

    // ──────────────────────────────────────────────
    console.log(NL + 'A reload is not a leaving');
    await first.send('Page.reload');
    await waitForShell(first);
    await sleep(3000);  // past the grace window, so a mistake would show
    check('still signed in', await first.ev(
      "fetch('/api/orders').then(function(r){return r.status;})") === 200);
    check('and nothing was written down', (await logoutRows()).length === 0, await logoutRows());

    // ──────────────────────────────────────────────
    console.log(NL + 'Closing one of two tabs is not a leaving either');
    const second = await openTab(BASE + '/app/dashboard');
    await waitForShell(second);
    await sleep(800);
    check('both tabs are in the register',
      (await first.ev("Object.keys(JSON.parse(localStorage.getItem('openTabs_arabella')||'{}')).length")) === 2,
      await first.ev("localStorage.getItem('openTabs_arabella')"));

    await closeTab(second.id);
    await sleep(3000);
    check('the one left is still signed in', await first.ev(
      "fetch('/api/orders').then(function(r){return r.status;})") === 200);
    check('and still nothing written down', (await logoutRows()).length === 0, await logoutRows());

    // ──────────────────────────────────────────────
    console.log(NL + 'Closing the last one signs them out');
    // Opened fresh so there is somewhere to look afterwards, and because a
    // person closing their last tab usually comes back to a new one.
    await closeTab(first.id);
    await sleep(2000);

    const rows = await logoutRows();
    check('a row was written', rows.length === 1, rows);
    const [[spot]] = await db.query(
      "SELECT latitude, longitude, accuracy_m FROM activity_log"
      + " WHERE action LIKE 'Logout%' ORDER BY id DESC LIMIT 1");
    check('and it carries the spot the browser reported',
      spot && Math.abs(Number(spot.latitude) - PIN.lat) < 0.001
      && Math.abs(Number(spot.longitude) - PIN.lng) < 0.001, spot);
    check('it says the tab closed',
      rows[0] && rows[0].action === 'Logout (tab closed)', rows[0]);
    // The screen the LAST tab was on - Production, not the dashboard the
    // other one had open.
    check('and names the screen that tab was on',
      rows[0] && rows[0].screen === 'Production Dashboard', rows[0]);

    // Past the grace window first. Inside it, a new tab is indistinguishable
    // from the page coming back - that is what the window is FOR - and this
    // is asking the other question: what happens to somebody who closed the
    // app and came back later.
    await sleep(Number(process.env.TAB_GRACE_MS) + 500);
    const back = await openTab(BASE + '/app/dashboard');
    await sleep(2500);
    const where = await back.ev('location.pathname');
    check('and the next tab lands on the login page, carrying the same cookie',
      where === '/login', where);

    // ──────────────────────────────────────────────
    // The same row, read back on the screen that exists to read it.
    console.log(NL + 'User Activity shows where they were');
    // Given a town. Nothing has one when this runs on a desk - the city is
    // worked out by Vercel at the edge and there is no edge here - so it is
    // put on by hand, which is exactly what the office's rows carry.
    await db.query(
      "UPDATE activity_log SET location = 'Jaipur, RJ, IN', ip_address = '103.54.13.254'"
      + " WHERE action LIKE 'Logout%'");  // the pin on the row is the browser's own

    await back.send('Page.navigate', { url: BASE + '/login' });
    await sleep(1200);
    await back.ev("document.querySelector('input[type=email],input[name=email]').value='"
      + process.env.ADMIN_EMAIL + "';"
      + "document.querySelector('input[type=password]').value='"
      + process.env.ADMIN_PASSWORD + "';"
      + "document.querySelector('form').submit();");
    await sleep(2500);
    await back.send('Page.navigate', { url: BASE + '/app/user-activity' });
    await waitForShell(back);
    for (let i = 0; i < 60; i++) {
      if (await back.ev("!!document.getElementById('ua_user')").catch(() => false)) break;
      await sleep(250);
    }
    await back.ev(`
      (function () {
        var sel = document.getElementById('ua_user');
        sel.value = Array.from(sel.options).map(function (o) { return o.value; })
          .filter(Boolean)[0];
        sel.dispatchEvent(new Event('change'));
      })()
    `);
    await sleep(2500);

    const pinned = await back.ev(`
      (function () {
        var tr = Array.from(document.querySelectorAll('tbody tr'))
          .find(function (r) { return r.innerText.indexOf('tab closed') > -1; });
        if (!tr) return null;
        var a = tr.querySelector('a[href*="maps?q="]');
        return a ? { text: a.textContent, href: a.getAttribute('href') } : null;
      })()
    `);
    check('the exact spot is a link on the row', !!pinned, pinned);
    check('it opens that very point',
      !!pinned && pinned.href.indexOf(String(PIN.lat)) > -1, pinned && pinned.href);
    check('and says how good the fix was, so a 3km guess is not read as a doorstep',
      !!pinned && /±\d/.test(pinned.text), pinned && pinned.text);

    const row = await back.ev(`
      (function () {
        var tr = Array.from(document.querySelectorAll('tbody tr'))
          .find(function (r) { return /tab closed/.test(r.innerText); });
        if (!tr) return null;
        var a = tr.querySelector('a[href*="maps"]');
        return { text: tr.innerText.split(String.fromCharCode(10)).join(' | '),
                 href: a ? a.getAttribute('href') : '', link: a ? a.textContent : '' };
      })()
    `);
    check('the closed-tab row is on the timeline', !!row, row);
    check('it says which screen they were on',
      !!row && /Production Dashboard/.test(row.text), row && row.text);
    check('the town is a link', !!row && !!row.href, row);
    check('and the link opens a map of that town',
      !!row && row.href.indexOf('google.com/maps') > -1
      && decodeURIComponent(row.href).indexOf('Jaipur') > -1, row && row.href);
    // The address is beside it and is NOT a link: it is the line the town was
    // worked out from, not a place anybody can open.
    check('the address is shown but not clickable',
      !!row && /103\.54\.13\.254/.test(row.text) && row.link.indexOf('103.54') === -1, row);

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
