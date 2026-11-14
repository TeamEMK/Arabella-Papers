/**
 * Can the person whose order it is actually mark the correction done?
 *
 * The case that bit: a SuperAdmin signs in as "Probe", but the order sheet
 * spells the designer out in full, so the correction sits on "Probe Gupta".
 * The screen used to compare those two strings and hide the button.
 *
 * Runs against the DEV database, makes its own correction and takes it away
 * again. Never points at live.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3500';
const EMAIL = 'probe@test.local';
const PASS = 'probe-pass-123';
const ON_THE_ORDER = 'Probe Gupta';   // how the order sheet spells them
const LOGIN_NAME = 'Probe';           // how they sign in

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

(async () => {
  if (!CHROME) throw new Error('Chrome not found.');
  const db = require(path.join(ROOT, 'config/db.js'));
  const bcrypt = require('bcryptjs');

  if (process.env.DB_NAME && /railway|prod/i.test(process.env.DB_NAME)) {
    throw new Error('refusing to run against ' + process.env.DB_NAME);
  }

  const [[order]] = await db.query(
    'SELECT order_id FROM orders WHERE is_deleted = 0 ORDER BY id DESC LIMIT 1');
  if (!order) throw new Error('no order in the dev database to hang a correction on');

  await db.query(
    "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, 'SuperAdmin') "
    + 'ON DUPLICATE KEY UPDATE username = VALUES(username), password = VALUES(password), role = VALUES(role)',
    [LOGIN_NAME, EMAIL, await bcrypt.hash(PASS, 10)]);

  const [ins] = await db.query(
    "INSERT INTO corrections (order_id, designer, fault, raised_by, status) VALUES (?, ?, 'change', ?, 'pending')",
    [order.order_id, ON_THE_ORDER, LOGIN_NAME]);
  const madeId = ins.insertId;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cranswer-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run', '--window-size=1500,950',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const waiting = new Map();
  const errors = [];
  let id = 0;

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
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
    };
    const send = (method, params) => new Promise(res => {
      const n = ++id; waiting.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result && r.result.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');

    await send('Page.navigate', { url: BASE + '/login' });
    await sleep(1500);
    await ev("document.querySelector('input[type=email],input[name=email]').value=" + JSON.stringify(EMAIL)
      + ";document.querySelector('input[type=password]').value=" + JSON.stringify(PASS)
      + ";document.querySelector('form').submit();");
    await sleep(3000);

    await send('Page.navigate', { url: BASE + '/app/corrections' });
    for (let i = 0; i < 80; i++) {
      if (await ev("!!document.querySelector('#cr_rows tr, #cr_tableBody tr, table tbody tr')").catch(() => false)) break;
      await sleep(250);
    }
    errors.length = 0;

    console.log(NL + 'The order is theirs, the order sheet spells them out in full');
    const row = "[...document.querySelectorAll('table tbody tr')]"
      + ".find(r => r.innerText.indexOf(" + JSON.stringify(ON_THE_ORDER) + ") !== -1)";
    check('the correction is on the screen', await ev('!!(' + row + ')'));
    check('the designer on it is not the name they sign in with',
      ON_THE_ORDER.toLowerCase() !== LOGIN_NAME.toLowerCase());
    check('and there is an Answer button on it',
      await ev('!!(' + row + ' || {}).querySelector && !!(' + row + ').querySelector("button.btn-success")'));

    console.log(NL + 'It really closes it');
    await ev('(' + row + ').querySelector("button.btn-success").click();');
    await sleep(900);
    await ev("var b=document.getElementById('cr_workNote');"
      + "if(b){b.value='Fixed by the probe';b.dispatchEvent(new Event('input',{bubbles:true}));}");
    await sleep(300);
    const saved = await ev(
      "(function(){var m=document.getElementById('cr_doModal');"
      + "var b=m && [...m.querySelectorAll('button')].find(x=>/save|done|submit/i.test(x.innerText));"
      + "if(b){b.click();return b.innerText;}return null;})()");
    await sleep(2000);
    const [[after]] = await db.query('SELECT status, work_note FROM corrections WHERE id = ?', [madeId]);
    check('the correction is marked done in the database',
      after && after.status === 'done', { clicked: saved, after });

    console.log(NL + 'Nothing shouted');
    check('no uncaught errors', errors.length === 0, errors.slice(0, 2));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    await db.query('DELETE FROM corrections WHERE id = ?', [madeId]);
    await db.query('DELETE FROM users WHERE email = ?', [EMAIL]);
    console.log('Probe correction and probe account removed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
