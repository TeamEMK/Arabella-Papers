/**
 * THE PUBLIC LINER BOOK, IN A REAL BROWSER AND WITH NO LOGIN.
 *
 *   node scripts/browse-linears-public.js
 *
 * The point is not only that it draws: it is that a stranger sees the liners
 * and NOTHING ELSE, and that nothing hidden reaches them.
 *
 * Builds and tags its own throwaway database. Never live.
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const mysql = require('mysql2/promise');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DB = process.env.ENVLIN_DB || 'arabella_linears_public';
const LIVE_DB = process.env.DB_NAME;
const SOURCE = process.env.LINER_PDFS || 'C:\\Users\\user\\Downloads\\Liners\\untitled folder';

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
  if (!fs.existsSync(SOURCE)) throw new Error('no liner PDFs at ' + SOURCE);

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  const app = require(path.join(ROOT, 'server.js'));
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

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

  // Something hidden, to prove hidden means hidden out here.
  const [[secret]] = await db.query(
    `SELECT i.id, i.code, c.id AS cat FROM envelope_linear_items i
       JOIN envelope_linears c ON c.id = i.category_id
      WHERE c.category = 'Chinoiserie' ORDER BY i.sort_order LIMIT 1`);
  await db.query('UPDATE envelope_linear_items SET is_active = 0 WHERE id = ?', [secret.id]);
  const [[closedCat]] = await db.query(
    "SELECT id, category FROM envelope_linears WHERE category = 'Playful & Whimsical'");
  await db.query('UPDATE envelope_linears SET is_active = 0 WHERE id = ?', [closedCat.id]);
  const [[hiddenInClosed]] = await db.query(
    'SELECT id FROM envelope_linear_items WHERE category_id = ? LIMIT 1', [closedCat.id]);

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'linpub-'));
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
    // ── Before the browser: what answers to a stranger with a URL ──
    console.log(NL + 'With no session at all');
    const bare = (u) => fetch(BASE + u, { redirect: 'manual' });
    check('the page itself opens', (await bare('/linears')).status === 200);
    check('so does the shelf', (await bare('/linears/api/board')).status === 200);
    check('and the search', (await bare('/linears/api/search?q=blue')).status === 200);
    // The portal's own routes must stay shut to the same stranger.
    const portal = await bare('/api/envelope-linears/board');
    check('the staff version is still shut', [302, 401, 403].includes(portal.status), portal.status);
    const manage = await fetch(BASE + '/api/envelope-linears', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'X', category: 'Y' }), redirect: 'manual',
    });
    check('and nobody can add a category from outside',
      [302, 401, 403].includes(manage.status), manage.status);

    console.log(NL + 'Hidden means hidden');
    const hiddenPic = await bare('/linears/thumb/' + secret.id);
    check('a hidden design serves no picture', hiddenPic.status === 404, hiddenPic.status);
    const hiddenFull = await bare('/linears/image/' + secret.id);
    check('nor a full-size one', hiddenFull.status === 404, hiddenFull.status);
    const inClosed = await bare('/linears/thumb/' + hiddenInClosed.id);
    check('a design in a closed category serves nothing either',
      inClosed.status === 404, inClosed.status);
    const board = await (await bare('/linears/api/board')).json();
    check('the closed category is not even listed',
      !board.sections.some(s => s.items.some(i => i.category === 'Playful & Whimsical')));
    const chin = board.sections
      .flatMap(s => s.items).find(i => i.category === 'Chinoiserie');
    check('and the count drops by the one taken down', chin && chin.count === 14, chin);

    // Nothing about the business may ride along in the reply.
    const cat = await (await bare('/linears/api/category/' + secret.cat)).json();
    const asText = JSON.stringify(cat);
    check('the reply carries no tags, no file names, no internals',
      !/tags|source_file|sourceFile|file_url/.test(asText), asText.slice(0, 200));

    // ── Now the page, in a browser ──
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
    await send('Page.navigate', { url: BASE + '/linears' });
    for (let i = 0; i < 80; i++) {
      if (await ev("!!document.querySelector('#field .piece')").catch(() => false)) break;
      await sleep(250);
    }
    errors.length = 0;

    console.log(NL + 'What a customer sees');
    check('the liners are on the page',
      (await ev("document.querySelectorAll('#field .piece').length")) > 0);
    check('with the categories beside them',
      (await ev("document.querySelectorAll('.cat').length")) > 15,
      await ev("document.querySelectorAll('.cat').length"));
    check('the closed category is not among them',
      !/Playful/.test(await ev("document.getElementById('rail').innerText")));
    for (let i = 0; i < 60; i++) {
      const left = await ev("[...document.querySelectorAll('#field .piece img')]"
        + ".filter(i=>!(i.complete&&i.naturalWidth>0)).length");
      if (left === 0) break;
      await sleep(250);
    }
    const pics = await ev("JSON.stringify([...document.querySelectorAll('#field .piece img')]"
      + ".map(i=>i.complete&&i.naturalWidth>0))").then(JSON.parse);
    check('and every picture really loads', pics.length > 0 && pics.every(Boolean),
      pics.filter(x => !x).length + ' of ' + pics.length + ' did not');
    check('each is named by its own code',
      /^[A-Z]{2,3}-[A-Z]{2,3}-\d{2}$/.test(
        await ev("document.querySelector('#field .piece .cap b').innerText")),
      await ev("document.querySelector('#field .piece .cap b').innerText"));

    console.log(NL + 'Searching, from outside');
    await ev("var b=document.getElementById('q');b.value='blue flower';"
      + "b.dispatchEvent(new Event('input',{bubbles:true}));");
    for (let i = 0; i < 60; i++) {
      const note = await ev("document.getElementById('qnote').innerText");
      if (note && !/Looking/.test(note)) break;
      await sleep(200);
    }
    await sleep(400);
    const hits = await ev(
      "JSON.stringify([...document.querySelectorAll('#field .piece .cap b')].map(e=>e.innerText))")
      .then(JSON.parse);
    check('it finds the blue florals', hits.length > 0 && hits.every(c => /^CT-FB-/.test(c)), hits);
    // Case-insensitive on purpose: the caption is uppercased in CSS and
    // innerText hands back what is RENDERED, not what is in the markup.
    const where = await ev("document.querySelector('#field .piece .cap').innerText");
    check('and says where each one lives', /floral/i.test(where || ''), where);

    console.log(NL + 'Opening one full size');
    await ev("document.querySelector('#field .piece').click();");
    for (let i = 0; i < 60; i++) {
      if (await ev("(function(){var i=document.getElementById('lbImg');"
        + "return !!i && i.complete && i.naturalWidth>0;})()").catch(() => false)) break;
      await sleep(200);
    }
    check('the picture opens', await ev("document.getElementById('lb').classList.contains('on')"));
    const big = await ev("JSON.stringify((function(){var i=document.getElementById('lbImg');"
      + "return {src:i.getAttribute('src'),w:i.naturalWidth};})())").then(JSON.parse);
    check('it is the full-size one, not the thumbnail',
      /\/linears\/image\/\d+$/.test(big.src || '') && big.w > 400, big);

    console.log(NL + 'Nothing shouted');
    const noisy = errors.filter(l => l && !/favicon/i.test(l));
    check('no console errors on this page', noisy.length === 0, noisy.slice(0, 3));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
