/**
 * PUNCHING AN URGENT ORDER, ON A SCREEN.
 *
 *   node scripts/browse-urgent-punch.js
 *
 * scripts/smoke-urgent-order.js proves the route: what it stores and what it
 * refuses. This proves the part the office actually touches - the form.
 *
 * Four things, in the order somebody meets them: the question is there and
 * starts unanswered, the date appears only on a Yes, the form refuses a Yes
 * with no date instead of posting it, and the order comes back onto the
 * dashboard already saying RUSH and how long it has.
 *
 * Throwaway database of its own. Never touches the live one.
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const mysql = require('mysql2/promise');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_urgent_browse';
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
  const urgency = require(path.join(ROOT, 'utils/urgency.js'));

  // The form checks the dealer and the designer against the lists, so the
  // lists have to hold them.
  await db.query("INSERT INTO dealers (name, email) VALUES ('Probe Dealer', 'dealer@test.local')");
  await db.query("INSERT INTO designers (india_name, india_email) VALUES ('Probe Designer', 'des@test.local')");

  const today = urgency.today();
  const inDays = (n) => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'urgent-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run', '--window-size=1500,950',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws, id = 0;
  const waiting = new Map();
  const errors = [];

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
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push('UNCAUGHT: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
      }
    };
    const send = (method, params) => new Promise(res => {
      const n = ++id; waiting.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
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

    await send('Page.navigate', { url: BASE + '/app/dashboard' });
    for (let i = 0; i < 80; i++) {
      if (await ev("typeof handleFormSubmit === 'function' && !!document.getElementById('punchUrgent')")
        .catch(() => false)) break;
      await sleep(250);
    }
    errors.length = 0;

    // ──────────────────────────────────────────────
    console.log(NL + 'The question is on the punch form');
    check('there is an Urgent Order dropdown',
      await ev("!!document.getElementById('punchUrgent')"));
    check('it starts unanswered, so nobody answers it by not looking',
      (await ev("document.getElementById('punchUrgent').value")) === '');
    check('and it offers exactly Yes and No',
      (await ev("Array.from(document.getElementById('punchUrgent').options)"
        + ".map(o=>o.value).filter(Boolean).join('|')")) === 'Yes|No');
    check('the date is out of the way until it is needed',
      await ev("document.getElementById('punchDueWrap').classList.contains('d-none')"));

    console.log(NL + 'Answering Yes asks for the day');
    await ev("document.getElementById('punchUrgent').value='Yes';punchUrgentSync();");
    check('the date appears',
      !(await ev("document.getElementById('punchDueWrap').classList.contains('d-none')")));
    check('and will not take a day that has already gone',
      (await ev("document.getElementById('punchDueDate').min")) === today);

    console.log(NL + 'Going back to No forgets it');
    await ev("document.getElementById('punchDueDate').value='" + inDays(4) + "';"
      + "document.getElementById('punchUrgent').value='No';punchUrgentSync();");
    check('the date is hidden again',
      await ev("document.getElementById('punchDueWrap').classList.contains('d-none')"));
    // Left behind, it would ride along on an order nobody called urgent.
    check('and emptied, not just hidden',
      (await ev("document.getElementById('punchDueDate').value")) === '');

    console.log(NL + 'A Yes with no date does not get posted');
    const before = (await db.query('SELECT COUNT(*) AS n FROM orders'))[0][0].n;
    // Opened the way a person opens it. Filling the fields of a modal that
    // was never shown gets as far as saving the order and then throws on the
    // line that closes it - which the form reports as "Server error" and
    // which left this suite looking at a dashboard that had never refreshed.
    await ev("new bootstrap.Modal(document.getElementById('orderPunchModal')).show();");
    await sleep(600);
    await ev(`
      document.getElementById('punchDealerInput').value='Probe Dealer';
      document.getElementById('designerInput').disabled=false;
      document.getElementById('designerInput').value='Probe Designer';
      document.getElementById('punchClientInput').value='Probe Client';
      document.getElementById('punchRemarks').value='Urgent probe';
      document.getElementById('punchDesignTime').value='1 Hour';
      document.getElementById('punchUrgent').value='Yes';
      punchUrgentSync();
      void handleFormSubmit();
    `);
    await sleep(1500);
    const after = (await db.query('SELECT COUNT(*) AS n FROM orders'))[0][0].n;
    check('nothing was written', after === before, { before, after });
    check('and the screen said what was missing',
      /date/i.test(await ev("(document.body.innerText.match(/[^\\n]*date[^\\n]*/i)||[''])[0]")),
      await ev("document.body.innerText.slice(0,200)"));

    console.log(NL + 'With the date, the order is taken');
    const due = inDays(2);
    await ev("document.getElementById('punchDueDate').value='" + due + "';void handleFormSubmit();");
    for (let i = 0; i < 40; i++) {
      if ((await db.query('SELECT COUNT(*) AS n FROM orders'))[0][0].n > before) break;
      await sleep(250);
    }
    const [[row]] = await db.query(
      'SELECT order_id, order_type, delivery_due_date FROM orders ORDER BY id DESC LIMIT 1');
    check('it is a RUSH order', row && row.order_type === 'RUSH Order', row);
    check('with the day the client was promised',
      row && urgency.day(row.delivery_due_date) === due, row);

    console.log(NL + 'And the dashboard says so without being asked twice');
    await sleep(2000);
    const shown = await ev(`
      (function () {
        var cells = Array.from(document.querySelectorAll('#ordersTableBody tr td'));
        var cell = cells.find(function (c) { return c.textContent.indexOf('${row.order_id}') === 0; });
        return cell ? cell.innerText.replace(/\\n/g, ' | ') : '';
      })()
    `);
    check('the row carries RUSH', /RUSH/.test(shown), shown);
    check('and says how long it has, in days', /Due in 2 days/.test(shown), shown);

    console.log(NL + 'Nothing shouted');
    check('no console errors on the page', errors.length === 0, errors.slice(0, 3));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
