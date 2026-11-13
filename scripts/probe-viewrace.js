/**
 * Does clicking tabs quickly throw, and did the routing change cause it?
 *
 * Deliberately knows nothing about addresses. It logs in, clicks five tabs
 * one after another, and reports whatever the page complained about. Run it
 * on this build and on the build before the routing change and the answer is
 * the same number or it is not - which is the only way to tell a bug you
 * introduced from one you merely uncovered.
 *
 *   node scripts/probe-viewrace.js
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const mysql = require('mysql2/promise');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_race_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

{
  const p = require.resolve(path.join(ROOT, 'utils/mailer.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: { sendMail: async () => ({ sent: true }), verifyMail: async () => ({ ok: true }), isMailConfigured: () => true },
  };
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

const ROUNDS = Number(process.argv[2] || 6);
const GAP = Number(process.argv[3] || 220);

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

  const port = await freePort();
  const server = app.listen(port);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + port;

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arabella-race-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });

  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await fetch('http://127.0.0.1:' + cdpPort + '/json/list').then(r => r.json());
      const p = list.find(t => t.type === 'page');
      if (p) wsUrl = p.webSocketDebuggerUrl;
    } catch (e) {}
    if (!wsUrl) await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { res, rej } = waiting.get(m.id); waiting.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error');
  };
  const send = (method, params) => new Promise((res, rej) => {
    const n = ++id; waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');

  await send('Page.navigate', { url: BASE + '/login' });
  await sleep(1200);
  await ev("document.getElementById('email').value=" + JSON.stringify(process.env.ADMIN_EMAIL)
    + ";document.getElementById('password').value=" + JSON.stringify(process.env.ADMIN_PASSWORD)
    + ";document.getElementById('loginForm').submit();");
  await sleep(2000);

  let raw = '';
  for (let i = 0; i < 40 && !raw; i++) {
    raw = await ev("typeof NAV_MENU !== 'undefined' ? JSON.stringify(NAV_MENU.map(t=>t.id)) : ''");
    if (!raw) await sleep(250);
  }
  if (!raw) throw new Error('never reached the app shell - did the login go through?');
  const menu = JSON.parse(raw);
  const walk = ['dashboard', 'tillApproval', 'stock', 'bfProspects', 'productionBD', 'prospects']
    .filter(x => menu.indexOf(x) !== -1);
  console.log('clicking ' + walk.length + ' tabs, ' + ROUNDS + ' times round');

  errors.length = 0;
  for (let r = 0; r < ROUNDS; r++) {
    for (const t of walk) {
      await ev("(document.getElementById(" + JSON.stringify(t + 'Tab') + ")||{click:function(){}}).click()");
      // Short on purpose: the race only shows when the next page is opened
      // before the last one's fetch has come back.
      await sleep(GAP);
    }
  }
  await sleep(1500);

  console.log('uncaught errors during the walk: ' + errors.length);
  errors.slice(0, 5).forEach(e => console.log('   ' + String(e).split('\n')[0]));

  try { chrome.kill(); } catch (e) {}
  server.close(); await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`'); await admin.end();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
