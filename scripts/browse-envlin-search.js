/**
 * SEARCHING ENVELOPE LINEARS, IN A REAL BROWSER.
 *
 *   node scripts/browse-envlin-search.js
 *
 * Types into the box the way somebody would and checks what comes back is
 * what they asked for - not merely that something came back.
 *
 * Runs against a throwaway database it builds and tags itself. Never live.
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const mysql = require('mysql2/promise');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DB = process.env.ENVLIN_DB || 'arabella_envlin_search';
const LIVE_DB = process.env.DB_NAME;
const SOURCE = process.env.LINER_PDFS || 'C:\\Users\\user\\Downloads\\Liners\\untitled folder';

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
  if (!fs.existsSync(SOURCE)) {
    throw new Error('no liner PDFs at ' + SOURCE + ' - set LINER_PDFS');
  }

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  const app = require(path.join(ROOT, 'server.js'));
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  // The office's own liners, imported and tagged the way they would be.
  // Fixtures would prove the markup compiles and nothing about whether
  // "blue flower" finds a blue flower.
  console.log('Importing the real PDFs into ' + TEST_DB + ' (slow, once)...');
  const imp = spawnSync('python', [
    path.join(ROOT, 'scripts/import-envelope-linears.py'), SOURCE,
    '--confirm', '--no-upload', '--db', TEST_DB,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (imp.status !== 0) throw new Error('import failed: ' + (imp.stderr || '').slice(0, 400));

  const tag = spawnSync('node', [
    path.join(ROOT, 'scripts/tag-envelope-linears.js'), '--write', '--db', TEST_DB,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (tag.status !== 0) throw new Error('tagging failed: ' + (tag.stderr || '').slice(0, 400));

  const [[counts]] = await db.query(
    `SELECT COUNT(*) AS designs, SUM(tags <> '') AS tagged FROM envelope_linear_items`);
  console.log('in this database: ' + counts.designs + ' designs, ' + counts.tagged + ' tagged');

  const bcryptSeed = require('bcryptjs');
  await db.query(
    "INSERT INTO users (username, email, password, role) VALUES ('Probe', ?, ?, 'SuperAdmin') "
    + 'ON DUPLICATE KEY UPDATE password = VALUES(password), role = VALUES(role)',
    [process.env.ADMIN_EMAIL, await bcryptSeed.hash(process.env.ADMIN_PASSWORD, 10)]);

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'envsearch-'));
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
      } catch (e) {}
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
    await send('Page.navigate', { url: BASE + '/app/envelope-linears' });
    for (let i = 0; i < 80; i++) {
      if (await ev("typeof el_search === 'function'").catch(() => false)) break;
      await sleep(250);
    }
    await sleep(800);
    errors.length = 0;

    // Types it the way a person does, then waits for the answer rather than
    // sleeping a guessed amount.
    const typeAndWait = async (text) => {
      await ev("var b=document.getElementById('el_q');b.value=" + JSON.stringify(text)
        + ";b.dispatchEvent(new Event('input',{bubbles:true}));");
      for (let i = 0; i < 60; i++) {
        const hint = await ev("document.getElementById('el_qHint').innerText");
        if (hint && !/Looking/.test(hint)) break;
        await sleep(200);
      }
      await sleep(300);
    };

    const resultCodes = () => ev(
      "JSON.stringify([...document.querySelectorAll('#el_body .el-lbl')].map(e=>e.innerText.trim()))")
      .then(JSON.parse);

    // ──────────────────────────────────────────────
    console.log(NL + '"blue flower"');
    await typeAndWait('blue flower');
    const blue = await resultCodes();
    check('it finds something', blue.length > 0, blue);
    // Every hit has to be BOTH, which is the whole difference between this
    // and a box that just matches any word.
    const [blueRows] = await db.query(
      `SELECT code, tags FROM envelope_linear_items WHERE code IN (?)`, [blue.length ? blue : ['']]);
    check('every one of them is a floral',
      blueRows.length > 0 && blueRows.every(r => /floral|botanical/.test(r.tags)),
      blueRows.map(r => r.code + ': ' + r.tags));
    check('and every one of them is blue',
      blueRows.every(r => /\b(blue|sky|teal|navy)\b/.test(r.tags)),
      blueRows.filter(r => !/\b(blue|sky|teal|navy)\b/.test(r.tags)).map(r => r.code));
    check('the heading says what was asked',
      /blue flower/i.test(await ev("document.querySelector('#el_body .el-head').innerText")));
    check('and each result says which category it came from',
      (await ev("document.querySelectorAll('#el_body .el-where').length")) === blue.length);

    // ──────────────────────────────────────────────
    // "sea" used to reach "seasonal" and a search for coastal liners came
    // back full of Christmas.
    console.log(NL + '"sea" is not "seasonal"');
    await typeAndWait('sea');
    const sea = await resultCodes();
    check('it finds coastal liners', sea.length > 0, sea.length);
    check('and no Holiday & Seasonal ones',
      !sea.some(c => /^CP-HS-/.test(c)), sea.filter(c => /^CP-HS-/.test(c)));

    // ──────────────────────────────────────────────
    console.log(NL + 'Both words have to land');
    await typeAndWait('flower');
    const flowers = (await resultCodes()).length;
    await typeAndWait('blue flower');
    const both = (await resultCodes()).length;
    check('"blue flower" is fewer than "flower"', both < flowers, { flowers, both });

    // ──────────────────────────────────────────────
    console.log(NL + 'Nonsense says so rather than showing everything');
    await typeAndWait('zzzz qqqq');
    check('nothing comes back',
      /Nothing matches that/.test(await ev("document.getElementById('el_body').innerText")));

    // ──────────────────────────────────────────────
    console.log(NL + 'The pictures really load');
    await typeAndWait('gold');
    // Waited for rather than guessed at: the browser fetches every thumbnail
    // in the grid and "not yet" is not the same as "never".
    for (let i = 0; i < 80; i++) {
      const left = await ev(
        "[...document.querySelectorAll('#el_body .el-pic img')]"
        + ".filter(i=>!(i.complete&&i.naturalWidth>0)).length");
      if (left === 0) break;
      await sleep(250);
    }
    const loaded = await ev(
      "JSON.stringify([...document.querySelectorAll('#el_body .el-pic img')]"
      + ".map(i=>i.complete&&i.naturalWidth>0))").then(JSON.parse);
    check('every result shows its thumbnail',
      loaded.length > 0 && loaded.every(Boolean),
      loaded.filter(x => !x).length + ' of ' + loaded.length + ' did not');

    console.log(NL + 'And it lets go again');
    await ev('el_clearSearch();');
    await sleep(600);
    check('clearing it puts the category list back',
      (await ev("document.querySelectorAll('.el-catlink').length")) > 20,
      await ev("document.querySelectorAll('.el-catlink').length"));
    check('and the box is empty',
      (await ev("document.getElementById('el_q').value")) === '');

    console.log(NL + 'Nothing shouted');
    const noisy = errors.filter(l => l && !/favicon/i.test(l));
    check('no console errors on this tab', noisy.length === 0, noisy.slice(0, 3));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
