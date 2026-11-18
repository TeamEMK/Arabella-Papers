/**
 * A NAME WITH SCRIPT IN IT, PUT ON A REAL BOARD.
 *
 *   node scripts/browse-xss.js
 *
 * The dispatch board prints the dealer, the client, the courier, the docket
 * and the invoice number into a row of HTML, and the view box prints every
 * field of the order. All of them are typed by a person on another screen.
 *
 * So this saves an order whose dealer is
 *     <img src=x onerror="...">
 * and opens the board in a real browser. The test is not "is there an
 * escape function" - it is whether that tag became an ELEMENT in the page
 * and whether its handler ran. A page that prints the angle brackets as
 * text has passed; anything else is script running in the dispatch
 * manager's session.
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
const TEST_DB = 'arabella_xss_probe';
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

// The payload. An <img> with a broken src, because onerror fires on its own
// the moment the browser tries to load it - no click, no hover, nothing for
// the dispatch manager to do but open the page.
const PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

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

  // An order sitting on the dispatch board, with the payload in every field
  // that board prints.
  await db.query(
    `INSERT INTO orders (order_id, dealer_name, client_name, design_status,
                         design_approval_status_from_client, actual_2,
                         courier, ups_dhl_fedex_tracking_number, invoice_number,
                         status_4, remarks)
     VALUES ('K-XSS-1', ?, ?, 'Approved', 'Final Approval For Production',
             NOW(), ?, ?, ?, 'Ready', ?)`,
    [PAYLOAD, 'Client ' + PAYLOAD, PAYLOAD, PAYLOAD, PAYLOAD, 'Remark ' + PAYLOAD]);

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xss-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run', '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws, id = 0;
  const waiting = new Map();

  const tidy = async () => {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    try { server.close(); } catch (e) {}
    try { await db.end(); } catch (e) {}
    try {
      await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
      await admin.end();
    } catch (e) {}
  };

  try {
    let targets;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await fetch('http://127.0.0.1:' + dbg + '/json/list').then(r => r.json());
        if (targets.some(t => t.webSocketDebuggerUrl)) break;
      } catch (e) { /* not up yet */ }
      await sleep(250);
    }
    ws = new WebSocket(targets.find(t => t.webSocketDebuggerUrl).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    };
    const send = (method, params) => new Promise(res => {
      const n = ++id; waiting.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result && r.result.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: BASE + '/login' });
    await sleep(1200);
    await ev("document.querySelector('input[type=email],input[name=email]').value='"
      + process.env.ADMIN_EMAIL + "';"
      + "document.querySelector('input[type=password]').value='"
      + process.env.ADMIN_PASSWORD + "';"
      + "document.querySelector('form').submit();");
    await sleep(2500);

    console.log(NL + 'The dispatch board, with script in a dealer name');
    await send('Page.navigate', { url: BASE + '/app/dispatch-bd' });
    for (let i = 0; i < 80; i++) {
      if (await ev("!!document.querySelector('#dsp_tbody tr')").catch(() => false)) break;
      await sleep(250);
    }

    check('the order is on the board',
      await ev("!!Array.from(document.querySelectorAll('#dsp_tbody tr'))"
        + ".find(function(r){return r.innerText.indexOf('K-XSS-1') > -1;})"));
    // THE WHOLE TEST. Did the tag become an element, and did it fire?
    check('no image was smuggled into the board',
      (await ev("document.querySelectorAll('#dsp_tbody img').length")) === 0,
      await ev("document.querySelectorAll('#dsp_tbody img').length"));
    check('and nothing ran', !(await ev('window.__xss || 0')), await ev('window.__xss || 0'));
    // And the office still SEES the name - escaping is not deleting.
    check('the dealer name is still shown, as text',
      await ev("document.querySelector('#dsp_tbody tr').innerText.indexOf('<img') > -1"));

    console.log(NL + 'The box that prints every field');
    await ev("dsp_openView('K-XSS-1')");
    await sleep(2500);
    check('the view box opened',
      await ev("!!document.getElementById('dsp_viewBody').innerText.trim()"));
    check('no image was smuggled into it either',
      (await ev("document.querySelectorAll('#dsp_viewBody img').length")) === 0,
      await ev("document.getElementById('dsp_viewBody').innerHTML.slice(0,160)"));
    check('and still nothing ran', !(await ev('window.__xss || 0')), await ev('window.__xss || 0'));
    check('the remark is readable', await ev(
      "document.getElementById('dsp_viewBody').innerText.indexOf('Remark') > -1"));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
