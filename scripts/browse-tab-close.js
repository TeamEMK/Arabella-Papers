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

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
