/**
 * ENVELOPE LINEARS, ON A SCREEN.
 *
 * The suite proves what the API answers. It cannot tell you whether the tab
 * draws, whether the covers actually appear in the tiles, or whether the
 * search box filters anything - the grid is built in the browser out of a
 * JSON body, so that part only exists in a browser.
 *
 *   node scripts/browse-envelope-linears.js
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
const TEST_DB = process.env.ENVLIN_DB || 'arabella_envlin_browse';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

// server.js listens on PORT by itself when it is not on Vercel, and this
// test runs while the dev server may already be on 3500. Pointed at a free
// one before it is required: the suite uses its own listener anyway, and a
// collision here reads as "the feature is broken" rather than "the port was
// taken".
process.env.PORT = '0';


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
  const OWNS_DB = !process.env.ENVLIN_DB;
  if (OWNS_DB) {
    await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
    await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');
  }

  const app = require(path.join(ROOT, 'server.js'));
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  // A real JPEG, so "did the cover appear" is a question about the page and
  // not about the picture being a fake one the browser refuses.
  let cover;
  try {
    const sharpless = require('child_process').spawnSync('python', ['-c',
      "import sys\n"
      + "try:\n import pymupdf\nexcept ImportError:\n import fitz as pymupdf\n"
      + "d=pymupdf.open(); p=d.new_page(); p.insert_text((40,80),'cover',fontsize=30)\n"
      + "sys.stdout.buffer.write(p.get_pixmap(dpi=40).tobytes('jpg'))\n"],
      { maxBuffer: 1 << 24 });
    cover = sharpless.stdout && sharpless.stdout.length > 100 ? sharpless.stdout : null;
  } catch (e) { cover = null; }
  if (!cover) throw new Error('could not render a test cover (is pymupdf installed?)');

  // Runs against the database the import filled, so what is on screen is
  // the office's own 21 categories and 316 designs rather than fixtures that
  // only prove the markup compiles.
  // When pointed at a database somebody else built - the one the import
  // filled - the probe account is not in it, and a login that silently fails
  // reads as "the tab is missing" rather than "there is nobody to log in as".
  const bcryptSeed = require('bcryptjs');
  await db.query(
    "INSERT INTO users (username, email, password, role) VALUES ('Probe', ?, ?, 'SuperAdmin') "
    + 'ON DUPLICATE KEY UPDATE password = VALUES(password), role = VALUES(role)',
    [process.env.ADMIN_EMAIL, await bcryptSeed.hash(process.env.ADMIN_PASSWORD, 10)]);

  const [[counts]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM envelope_linears WHERE is_active = 1) AS cats,
            (SELECT COUNT(*) FROM envelope_linear_items WHERE is_active = 1) AS designs`);
  console.log('in this database: ' + counts.cats + ' categories, ' + counts.designs + ' designs');

  const port = await freePort();
  const server = app.listen(port);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + port;

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arabella-envlin-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });

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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { res, rej } = waiting.get(m.id); waiting.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const n = ++id; waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr);
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');

  const tidy = async () => {
    try { chrome.kill(); } catch (e) {}
    server.close(); await db.end();
    if (OWNS_DB) await admin.query('DROP DATABASE `' + TEST_DB + '`');
    await admin.end();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  };

  try {
    await send('Page.navigate', { url: BASE + '/login' });
    await sleep(1200);
    await ev("document.getElementById('email').value=" + JSON.stringify(process.env.ADMIN_EMAIL)
      + ";document.getElementById('password').value=" + JSON.stringify(process.env.ADMIN_PASSWORD)
      + ";document.getElementById('loginForm').submit();");
    await sleep(2200);

    console.log(NL + 'The tab is in the side panel');
    const inNav = await ev("!!document.getElementById('envelopeLinearsTab')");
    check('Envelope Linears has a tab', inNav === true);
    const label = await ev("(document.getElementById('envelopeLinearsTab')||{}).innerText||''");
    check('named Envelope Linears', /Envelope Linears/i.test(label), label.trim());

    console.log(NL + 'Opening it');
    await send('Page.navigate', { url: BASE + '/app/envelope-linears' });
    for (let i = 0; i < 60; i++) {
      const ready = await ev("!!document.querySelector('.el-catlink')").catch(() => false);
      if (ready) break;
      await sleep(200);
    }
    errors.length = 0;   // the login page's own noise is not this tab's

    check('the address is its own', (await ev('location.pathname')) === '/app/envelope-linears',
      await ev('location.pathname'));

    const SEED = require(path.join(ROOT, 'config/initDb.js')).ENVELOPE_LINEAR_SEED;
    const heads = await ev(
      "JSON.stringify([...document.querySelectorAll('.el-sechead2 .flex-grow-1')]"
      + ".map(h=>h.innerText))").then(JSON.parse);
    check('all five sections are in the side list', heads.length === 5, heads);
    check('named and ordered as the office wrote them',
      JSON.stringify(heads) === JSON.stringify(SEED.map(s => s[0])), heads);
    // The names with a slash in them are the ones that could not survive
    // being a file on Windows, which is why they come from the seed.
    check('including the ones with slashes in',
      heads.includes('Nature / Places / Destinations'), heads);

    const links = await ev("document.querySelectorAll('.el-catlink').length");
    check('every category is under its section', links === counts.cats, [links, counts.cats]);
    const says = await ev(
      "(function(){var t=[...document.querySelectorAll('.el-catlink')]"
      // Doubled on purpose: this string is the EXPRESSION the browser will
      // run, so a single backslash is eaten by this file's own string
      // literal and the page ends up replacing every letter s.
      + ".find(e=>/Cityscapes/.test(e.innerText));"
      + "return t ? t.innerText.replace(/\\s+/g,' ').trim() : null;})()");
    check('and carries its own count', /Cityscapes & Maps 22/.test(says || ''), says);

    // Arriving on an empty panel that says "pick something" is a page that
    // makes you work before it shows you anything.
    console.log(NL + 'It opens on something by itself');
    for (let i = 0; i < 60; i++) {
      if (await ev("!!document.querySelector('#el_body .el-design')").catch(() => false)) break;
      await sleep(150);
    }
    check('a category is already showing',
      await ev("!!document.querySelector('#el_body .el-design')"));
    check('and it is marked as the one picked',
      (await ev("document.querySelectorAll('.el-catlink.on').length")) === 1);

    console.log(NL + 'Picking a category shows its designs');
    await ev("(function(){var t=[...document.querySelectorAll('.el-catlink')]"
      + ".find(e=>/Embossed/.test(e.innerText)); t && t.click();})()");
    for (let i = 0; i < 60; i++) {
      const t = await ev("(document.querySelector('#el_body .el-head h4')||{}).innerText")
        .catch(() => '');
      if (t === 'Embossed / Debossed') break;
      await sleep(150);
    }
    const title = await ev("document.querySelector('#el_body .el-head h4').innerText");
    check('the right category opened', title === 'Embossed / Debossed', title);
    const sub = await ev("document.querySelector('#el_body .el-head').innerText");
    check('with its section and count',
      /Speciality & Statement/.test(sub) && /6\s*designs/.test(sub), sub);
    const designs = await ev("document.querySelectorAll('#el_body .el-design').length");
    check('six designs are drawn', designs === 6, designs);
    const pics = await ev(
      "JSON.stringify([...document.querySelectorAll('#el_body .el-pic img')]"
      + ".map(i=>i.complete&&i.naturalWidth>0))").then(JSON.parse);
    check('and every picture loaded', pics.length === 6 && pics.every(Boolean), pics);
    check('the side list follows the pick',
      /Embossed/.test(await ev("document.querySelector('.el-catlink.on').innerText")));

    console.log(NL + 'A section folds away');
    const before = await ev("document.querySelectorAll('.el-catlink').length");
    await ev("el_toggleSection('Classic & Traditional');");
    await sleep(200);
    const after = await ev("document.querySelectorAll('.el-catlink').length");
    check('closing one hides its five categories', after === before - 5, [before, after]);
    await ev("el_toggleSection('Classic & Traditional');");
    await sleep(200);
    check('and opening it brings them back',
      (await ev("document.querySelectorAll('.el-catlink').length")) === before);

    // The whole point of the change: the design opens AS A PICTURE, here,
    // over the page - not as a Drive tab somewhere else.
    console.log(NL + 'Clicking a design opens it full size');
    await ev("document.querySelector('#el_body .el-design').click();");
    for (let i = 0; i < 60; i++) {
      const ok = await ev("(function(){var i=document.getElementById('el_lbImg');"
        + "return !!i && i.complete && i.naturalWidth > 0;})()").catch(() => false);
      if (ok) break;
      await sleep(150);
    }
    check('the lightbox is open',
      await ev("document.getElementById('el_lb').classList.contains('on')"));
    const big = await ev(
      "JSON.stringify((function(){var i=document.getElementById('el_lbImg');"
      + "return {src:i.getAttribute('src'),w:i.naturalWidth,h:i.naturalHeight};})())")
      .then(JSON.parse);
    check('it is serving the full design, not the thumbnail',
      /\/api\/envelope-linears\/image\/\d+$/.test(big.src || ''), big.src);
    // The thumbnails are made at 280px. Anything that small here would mean
    // the lightbox had quietly been handed the little copy.
    check('and the picture that loaded is a big one',
      big.w > 400 && big.h > 400, big);
    // Bootstrap's modals sit at 1055 and this app stacks other things high
    // too. Below any of it and the click looks like it did nothing at all.
    check('it is above everything else on the page',
      Number(await ev("getComputedStyle(document.getElementById('el_lb')).zIndex")) > 1055);

    const first = big.src;
    await ev("el_lbStep(null, 1);");
    await sleep(300);
    check('the arrow moves to the next design',
      (await ev("document.getElementById('el_lbImg').getAttribute('src')")) !== first);
    const cap = await ev("document.getElementById('el_lbCap').innerText");
    check('and says which one of how many', /2 of 6/.test(cap || ''), cap);

    await ev("el_lbClose(null, true);");
    await sleep(200);
    check('closing it leaves the category still showing',
      !(await ev("document.getElementById('el_lb').classList.contains('on')"))
      && !!(await ev("!!document.querySelector('#el_body .el-design')")));

    // On a phone picking a category hides the list, so without this there is
    // nothing to go back to but the browser's own back button - which leaves
    // the tab altogether.
    console.log(NL + 'Back returns to the list');
    check('the open category offers a way back',
      await ev("!!document.querySelector('#el_body .el-back')"));
    await ev("document.querySelector('#el_body .el-back').click();");
    await sleep(500);
    check('pressing it lets go of the category',
      /Pick a category from the list/.test(
        await ev("document.getElementById('el_body').innerText")),
      await ev("document.getElementById('el_body').innerText"));
    check('nothing is highlighted any more',
      (await ev("document.querySelectorAll('.el-catlink.on').length")) === 0);
    check('and the list is still all there',
      (await ev("document.querySelectorAll('.el-catlink').length")) === counts.cats);
    // Straight back in, so the rest of the suite has a category open.
    await ev("(function(){var t=[...document.querySelectorAll('.el-catlink')]"
      + ".find(e=>/Embossed/.test(e.innerText)); t && t.click();})()");
    await sleep(900);

    console.log(NL + 'Searching the side list');
    await ev("document.getElementById('el_q').value='chinois';el_render();");
    check('typing part of a category narrows it to one',
      (await ev("document.querySelectorAll('.el-catlink').length")) === 1);
    // A search that finds something inside a folded section and then leaves
    // it folded has not found it as far as anybody can tell.
    check('and opens the section it was found in',
      /Chinoiserie/.test(await ev("document.getElementById('el_nav').innerText")));
    await ev("document.getElementById('el_q').value='zzzz';el_render();");
    check('nothing matching says so',
      /Nothing matches/.test(await ev("document.getElementById('el_nav').innerText")));
    await ev("document.getElementById('el_q').value='';el_render();");
    check('clearing it brings the whole list back',
      (await ev("document.querySelectorAll('.el-catlink').length")) === counts.cats);

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
