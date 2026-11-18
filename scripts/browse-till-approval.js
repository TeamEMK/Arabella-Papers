/**
 * THE APPROVAL BOX, OPENED IN A REAL BROWSER.
 *
 *   node scripts/browse-till-approval.js
 *
 * RUSH or Normal is answered on the punch form and nowhere else. This box
 * used to ask it a second time, which is a second place for the two answers
 * to disagree. So what is checked here is what the approval box SHOWS now:
 *
 *   Final Approval For Production asks for the days for dispatch, and asks
 *   nothing about RUSH or about the client's date.
 *
 *   A final approval still goes through, and the order's own RUSH and its
 *   delivery date - set at the punch - are exactly as they were afterwards.
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
const TEST_DB = 'arabella_ta_probe';
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

  // An order waiting on the client, punched as a RUSH with a date.
  await db.query(
    `INSERT INTO orders (order_id, dealer_name, client_name, design_status,
                         design_approval_status_from_client, no_of_design_revision,
                         order_type, delivery_due_date, timestamp, actual_2)
     VALUES ('K-TA-1','Dealer T','Client T','Approved','Proofing Done', 1,
             'RUSH Order', '2026-12-25', NOW(), NOW())`);

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
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

    console.log(NL + 'The approval box');
    await send('Page.navigate', { url: BASE + '/app/till-approval' });
    for (let i = 0; i < 80; i++) {
      if (await ev("!!document.querySelector('#ta_tbody tr, #ta_body tr, table tbody tr')")) break;
      await sleep(250);
    }
    check('the board lists the order',
      await ev("document.body.innerText.indexOf('K-TA-1') > -1"));
    check('and shows it as a RUSH',
      await ev("document.body.innerText.indexOf('RUSH') > -1"));

    // Open the approval box for it, however the row offers it.
    await ev("ta_openEdit('K-TA-1');");
    await sleep(1500);

    check('the box is open',
      await ev("!!document.querySelector('#ta_editModal.show')"));
    check('it does not ask RUSH or Normal',
      !(await ev("!!document.getElementById('ta_ot_rush')")));
    check('and it does not ask for the client date',
      !(await ev("!!document.getElementById('ta_deliveryDue')")));

    // Tick the final approval: the days box appears, and nothing else does.
    await ev("document.getElementById('ta_st_final').click();");
    await sleep(600);
    check('a final approval asks for the days for dispatch',
      await ev("!document.getElementById('ta_daysWrap').classList.contains('d-none')"));
    check('and still nothing about RUSH',
      !(await ev("!!document.getElementById('ta_typeWrap')")));

    await ev("document.getElementById('ta_dispatchDays').value = '7';");
    await ev("taHandleApprovalSubmit();");
    await sleep(3000);

    const [[row]] = await db.query(
      `SELECT order_type, DATE_FORMAT(delivery_due_date, '%Y-%m-%d') AS due,
              dispatch_days, design_approval_status_from_client AS status
         FROM orders WHERE order_id = 'K-TA-1'`);
    check('the approval went through',
      row.status === 'Final Approval For Production', row);
    check('the days for dispatch were saved', Number(row.dispatch_days) === 7, row);
    // The point of the change: the punch's answer is still the answer.
    check('the order is still a RUSH', row.order_type === 'RUSH Order', row);
    check('with the date the punch gave it', row.due === '2026-12-25', row);

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
