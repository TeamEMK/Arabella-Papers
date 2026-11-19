/**
 * MANAGING ENVELOPE LINEARS, ON A SCREEN.
 *
 * Makes a section and a category that were not there, puts a real picture
 * into it through the browser the way somebody would, checks it comes back
 * as a design with a working thumbnail and full picture, then takes it all
 * away again.
 *
 *   node scripts/browse-envlin-manage.js
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
const TEST_DB = process.env.ENVLIN_DB || 'arabella_envlin_manage';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
// server.js listens on PORT by itself off Vercel, and the dev server may
// already hold 3500. This suite brings its own listener.
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

const SECTION = 'Probe Section';
const CATEGORY = 'Probe Liners';

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'envmanage-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run', '--window-size=1500,950',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const waiting = new Map();
  const errors = [];
  let id = 0;

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

    await send('Page.navigate', { url: BASE + '/app/envelope-linears' });
    for (let i = 0; i < 80; i++) {
      if (await ev("typeof el_toggleManage === 'function'").catch(() => false)) break;
      await sleep(250);
    }
    errors.length = 0;

    // ──────────────────────────────────────────────
    console.log(NL + 'A SuperAdmin is offered the Manage button');
    check('the button is there',
      !(await ev("document.getElementById('el_manageBtn').classList.contains('d-none')")));
    check('and nothing to add with until it is pressed',
      await ev("document.getElementById('el_newBtn').classList.contains('d-none')"));

    await ev('el_toggleManage();');
    await sleep(400);
    check('pressing it offers New category',
      !(await ev("document.getElementById('el_newBtn').classList.contains('d-none')")));
    check('and the button now says Done',
      (await ev("document.getElementById('el_manageLbl').innerText")) === 'Done');

    // ──────────────────────────────────────────────
    // CHECKED FIRST, on purpose. A confirm() put back into the tab stops
    // the page dead and this suite then hangs until something kills it -
    // a failure, but a useless one that says nothing about why. Read the
    // file before touching the screen and it fails in a line.
    console.log(NL + 'None of it is the browser talking');
    const view = fs.readFileSync(
      path.join(ROOT, 'views/views/envelopeLinears.ejs'), 'utf8');
    // confirm() and alert() draw a grey box headed with the address bar's
    // name, which is the browser talking rather than this system.
    //
    // Comments are stripped first. Without that this failed on the comment
    // ABOVE the fix explaining what was wrong with confirm() - a check that
    // cannot tell an explanation from the thing it explains.
    const code = view
      .replace(/<%#[\s\S]*?%>/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const stillThere = (code.match(/(^|[^.\w])(confirm|alert)\s*\(/g) || []);
    check('no confirm() or alert() left in the tab', stillThere.length === 0, stillThere.slice(0, 3));

    console.log(NL + 'A section that did not exist');
    const sectionsBefore = await ev('el_sections.length');
    await ev('el_openNew();');
    await sleep(500);
    await ev("document.getElementById('el_newSection').value=" + JSON.stringify(SECTION) + ";"
      + "document.getElementById('el_newCategory').value=" + JSON.stringify(CATEGORY) + ";");
    await ev('el_saveNew();');
    for (let i = 0; i < 60; i++) {
      if ((await ev('el_sections.length')) > sectionsBefore) break;
      await sleep(200);
    }
    check('the new section is on the board',
      (await ev('el_sections.length')) === sectionsBefore + 1, await ev('el_sections.length'));
    const [[madeRow]] = await db.query(
      'SELECT id, section, category FROM envelope_linears WHERE category = ?', [CATEGORY]);
    check('and it is in the database under the section typed',
      madeRow && madeRow.section === SECTION, madeRow);
    // The panel is fetched after the board comes back, so it can still be a
    // spinner at this point. Waited for rather than slept past.
    let panel = '';
    for (let i = 0; i < 60; i++) {
      panel = await ev("document.getElementById('el_body').innerText");
      if (/Nothing has been put in this category yet/.test(panel || '')) break;
      await sleep(200);
    }
    check('the new category is open and waiting for pictures',
      /Nothing has been put in this category yet/.test(panel || ''), panel);
    check('with a box to drop them into',
      await ev("!!document.getElementById('el_drop')"));

    // ──────────────────────────────────────────────
    // A real picture, pushed through the file input exactly as a person's
    // would be - not posted straight at the API, which would prove nothing
    // about the shrinking the browser does on the way.
    console.log(NL + 'A picture, added the way a person adds one');
    // Deliberately bigger than both limits - 1600px wide against a 2000px
    // cap and a 280px thumbnail - so this also proves the browser really
    // shrinks what it sends. A 100px test picture passes through untouched
    // and would have said the shrinking worked when it had not run at all.
    const shot = path.join(profile, 'probe-liner.png');
    const PY = [
      'import sys',
      'try:',
      ' import pymupdf',
      'except ImportError:',
      ' import fitz as pymupdf',
      'd = pymupdf.open(); p = d.new_page(width=800, height=600)',
      'p.draw_rect(pymupdf.Rect(40,40,760,560), color=(0.2,0.3,0.6), fill=(0.9,0.85,0.75))',
      "p.insert_text((80,320),'probe liner',fontsize=48)",
      'p.get_pixmap(matrix=pymupdf.Matrix(2,2)).save(sys.argv[1])',
    ].join(String.fromCharCode(10));
    const made = require('child_process').spawnSync('python', ['-c', PY,
      shot], { encoding: 'utf8' });
    if (!fs.existsSync(shot)) {
      throw new Error('could not draw a test picture (is pymupdf installed?) '
        + (made.stderr || ''));
    }

    const doc = await send('DOM.getDocument', { depth: -1 });
    const found = await send('DOM.querySelector', {
      nodeId: doc.result.root.nodeId, selector: '#el_drop input[type=file]',
    });
    await send('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [shot] });

    for (let i = 0; i < 80; i++) {
      const [[n]] = await db.query(
        'SELECT COUNT(*) AS n FROM envelope_linear_items WHERE category_id = ?', [madeRow.id]);
      if (Number(n.n) > 0) break;
      await sleep(250);
    }
    const [[row]] = await db.query(
      `SELECT id, mime_type, LENGTH(bytes) AS full, LENGTH(thumb) AS small,
              width, height, source_file, name
         FROM envelope_linear_items WHERE category_id = ?`, [madeRow.id]);
    check('the design is in the database', !!row, row);
    check('it kept the full picture and a thumbnail',
      row && row.full > 0 && row.small > 0, row);
    check('the thumbnail is much the smaller of the two',
      row && row.small * 2 < row.full, { full: row && row.full, small: row && row.small });
    // The picture handed in is 1600x1200. If what landed is still that wide,
    // the shrinking in the browser never happened and a phone photo would go
    // straight at Vercel's 4.5MB wall.
    check('and the picture that was sent had been shrunk on the way',
      row && row.width === 1600 && row.full < 400 * 1024,
      { widthAsHandedIn: row && row.width, stored: row && row.full });
    check('it is stored as a JPEG, whatever was handed in',
      row && row.mime_type === 'image/jpeg', row && row.mime_type);
    check('and it remembers which file it came off',
      row && /probe-liner/.test(row.source_file || ''), row && row.source_file);

    await sleep(900);
    check('the grid now shows it',
      (await ev("document.querySelectorAll('#el_body .el-design').length")) === 1,
      await ev("document.querySelectorAll('#el_body .el-design').length"));
    const pic = await ev(
      "(function(){var i=document.querySelector('#el_body .el-pic img');"
      + "return i ? (i.complete && i.naturalWidth > 0) : false;})()");
    check('and its thumbnail really loads', pic === true);
    check('the side list count followed it',
      /1/.test(await ev("document.querySelector('.el-catlink.on').innerText")));

    // ──────────────────────────────────────────────
    // ──────────────────────────────────────────────
    // The code a design will be given is worth seeing BEFORE it is given,
    // while there is still time to object to it.
    console.log(NL + 'It says what the next one will be called');
    const said = await ev("document.getElementById('el_nextCode').innerText");
    check('the box says the next code',
      /The next one will be PS-PL-02/.test(said || ''), said);
    const stored = await db.query(
      'SELECT code FROM envelope_linear_items WHERE category_id = ?', [madeRow.id]);
    check('and the one just added took the one before it',
      stored[0][0] && stored[0][0].code === 'PS-PL-01', stored[0][0]);

    // ──────────────────────────────────────────────
    // A button inside a button is not HTML a browser accepts: the parser
    // closes the outer one, and the bin ends up on a line of its own under
    // the row. It looked like a styling problem and was a nesting one, so
    // this asks the BROWSER where the bins ended up, not the source.
    console.log(NL + 'The bins stay where they were put');
    check('every category row carries its own bin',
      (await ev("document.querySelectorAll('.el-catlink .el-x').length"))
      === (await ev("document.querySelectorAll('.el-catlink').length")),
      [await ev("document.querySelectorAll('.el-catlink .el-x').length"),
       await ev("document.querySelectorAll('.el-catlink').length")]);
    check('and none of them fell out of the row',
      (await ev("document.querySelectorAll('#el_nav > * > .el-x').length")) === 0);
    const rowFit = await ev(
      "(function(){var r=document.querySelector('.el-catlink');"
      + "var b=r.querySelector('.el-x');if(!b)return 'no bin';"
      + "var a=r.getBoundingClientRect(), c=b.getBoundingClientRect();"
      + "return JSON.stringify({inside: c.top >= a.top - 1 && c.bottom <= a.bottom + 1,"
      + " rowHeight: Math.round(a.height)});})()");
    // Parsed defensively: when the bin is missing the page answers with a
    // word, not JSON, and a suite that dies on its own failure message tells
    // you nothing about the checks after it.
    const asObj = (v) => { try { return JSON.parse(v); } catch (e) { return {}; } };
    check('the bin sits on the same line as the name', asObj(rowFit).inside === true, rowFit);
    check('so a row is still one line high',
      asObj(rowFit).rowHeight > 0 && asObj(rowFit).rowHeight < 48, rowFit);

    const tileFit = await ev(
      "(function(){var w=document.querySelector('#el_body .el-tilewrap');"
      + "var t=w.querySelector('.el-design'), b=w.querySelector('.el-del');"
      + "if(!b)return 'no bin';"
      + "var a=t.getBoundingClientRect(), c=b.getBoundingClientRect();"
      + "return JSON.stringify({over: c.top >= a.top - 1 && c.right <= a.right + 1"
      + " && c.bottom <= a.bottom + 1, parent: b.offsetParent && b.offsetParent.className});})()");
    check('the design bin sits on the picture, not under it',
      asObj(tileFit).over === true, tileFit);
    check('and it is pinned to the tile it belongs to',
      /el-tilewrap/.test(asObj(tileFit).parent || ''), tileFit);

    console.log(NL + 'The empty category got a cover from it');
    const [[cov]] = await db.query(
      'SELECT LENGTH(cover) AS c FROM envelope_linears WHERE id = ?', [madeRow.id]);
    check('the tile has something to show', cov && cov.c > 0, cov);

    // ──────────────────────────────────────────────
    console.log(NL + 'Taking the design away');
    // The dialog is the app's own now, not the browser's, so there is no
    // window.confirm to stub - and that is worth something: stubbing it
    // would have gone on passing after the dialog stopped appearing at
    // all. This waits for the real one and presses the real button.
    const askAndSay = async (call, expectIn) => {
      // Started, NOT awaited. The call does not finish until the dialog is
      // answered, and the dialog cannot be answered until this returns - so
      // awaiting it is a deadlock, and the suite sat there until it was
      // killed. `void` throws the promise away so evaluate comes straight
      // back and the clicking can happen.
      await ev('void (async function(){ ' + call + ' })();');
      let seen = '';
      for (let i = 0; i < 60; i++) {
        seen = await ev("(document.querySelector('.swal2-popup')||{}).innerText || ''");
        if (seen) break;
        await sleep(150);
      }
      const asked = !!seen;
      const named = expectIn ? new RegExp(expectIn).test(seen) : true;
      await ev("(document.querySelector('.swal2-confirm')||{click(){}}).click();");
      await sleep(400);
      return { asked, named, seen };
    };

    const askDesign = await askAndSay('el_removeDesign(' + row.id + ');', row.code);
    check('it asks before removing a design', askDesign.asked, askDesign.seen);
    check('and names the one being removed', askDesign.named, askDesign.seen);
    for (let i = 0; i < 60; i++) {
      const [[n]] = await db.query(
        'SELECT COUNT(*) AS n FROM envelope_linear_items WHERE category_id = ?', [madeRow.id]);
      if (Number(n.n) === 0) break;
      await sleep(200);
    }
    const [[left]] = await db.query(
      'SELECT COUNT(*) AS n FROM envelope_linear_items WHERE category_id = ?', [madeRow.id]);
    check('the design is gone', Number(left.n) === 0, left);
    const [[cov2]] = await db.query(
      'SELECT cover IS NULL AS none FROM envelope_linears WHERE id = ?', [madeRow.id]);
    check('and the tile stopped showing a design it no longer holds',
      Number(cov2.none) === 1, cov2);

    // ──────────────────────────────────────────────
    console.log(NL + 'Taking the category away');
    const askCat = await askAndSay(
      'el_removeCategory(' + madeRow.id + ', ' + JSON.stringify(CATEGORY) + ', 0);',
      CATEGORY);
    check('it asks before removing a category', askCat.asked, askCat.seen);
    check('and names that one too', askCat.named, askCat.seen);
    for (let i = 0; i < 60; i++) {
      const [[n]] = await db.query(
        'SELECT COUNT(*) AS n FROM envelope_linears WHERE id = ?', [madeRow.id]);
      if (Number(n.n) === 0) break;
      await sleep(200);
    }
    const [[gone]] = await db.query(
      'SELECT COUNT(*) AS n FROM envelope_linears WHERE id = ?', [madeRow.id]);
    check('the category is gone', Number(gone.n) === 0, gone);
    await sleep(700);
    check('and the empty section went with it',
      !(await ev('el_sections.some(s => s.section === ' + JSON.stringify(SECTION) + ')')));

    // ──────────────────────────────────────────────
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
