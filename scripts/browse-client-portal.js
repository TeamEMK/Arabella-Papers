/**
 * THE CLIENT PORTAL, IN A REAL BROWSER.
 *
 *   node scripts/browse-client-portal.js
 *
 * scripts/smoke-client-portal.js proves the rules - what the routes refuse,
 * what they store, what they will not say. This walks the page a customer
 * actually meets: register, read the code out of the post, type it, and
 * arrive at the three doors.
 *
 * It also leaves screenshots on the Desktop, because "premium" is a thing
 * somebody has to look at rather than read a PASS line about.
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
const TEST_DB = 'arabella_client_browse';
const LIVE_DB = process.env.DB_NAME;
const SHOTS = path.join(os.homedir(), 'Desktop', 'client-portal');

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


const posted = [];
{
  const p = require.resolve(path.join(ROOT, 'utils/mailer.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      sendMail: async (m) => { posted.push(m); return { sent: true }; },
      verifyMail: async () => ({ ok: true }),
      isMailConfigured: () => true,
    },
  };
}
const lastCode = () => {
  for (let i = posted.length - 1; i >= 0; i--) {
    const hit = /\b(\d{6})\b/.exec(String(posted[i].text || ''));
    if (hit) return hit[1];
  }
  return '';
};

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'clientp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run',
    // The size the office actually looks at it on. The split page is
    // judged by eye from these screenshots, and a half judged at 1400
    // crops the photograph far harder than the same half at 1920.
    '--window-size=1920,1080',
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
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result && r.result.result.value;
    };
    const shot = async (name) => {
      const out = await send('Page.captureScreenshot', { format: 'png' });
      if (out.result && out.result.data) {
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(out.result.data, 'base64'));
      }
    };
    const type = (id, v) => ev(
      "document.getElementById('" + id + "').value = " + JSON.stringify(v) + ";");

    await send('Runtime.enable');
    await send('Page.enable');

    // ──────────────────────────────────────────────
    console.log(NL + 'The sign-in a customer is sent to');
    await send('Page.navigate', { url: BASE + '/client/arabella' });
    await sleep(1500);
    errors.length = 0;
    check('the card is there', await ev("!!document.querySelector('.card')"));
    check('signed Arabella Papers',
      /ARABELLA PAPERS/i.test(await ev(
        "document.querySelector('.crest-mark .nm').textContent")));
    // Premium is a look, and a look has to be checked by eye - but the two
    // faces that carry it are not an accident and can be. Bodoni cuts the
    // headings and the wordmark; Italiana answers it in capitals on the
    // trade line, the field labels and the buttons. A face that did not
    // load falls back to Georgia or to the browser's sans, which is exactly
    // how a page stops looking designed - so these ask what the browser
    // actually used, not what the stylesheet asked for.
    check('the headings are set in Bodoni',
      /Bodoni/.test(await ev(
        "getComputedStyle(document.querySelector('.card h1')).fontFamily")));
    check('the wordmark is set in the Didone, like the headings',
      /Bodoni/.test(await ev(
        "getComputedStyle(document.querySelector('.crest-mark .nm')).fontFamily")));
    check('and the trade line under it in wide thin capitals',
      /Italiana/.test(await ev(
        "getComputedStyle(document.querySelector('.crest-mark .trade')).fontFamily")));
    check('and all three faces really arrived, not just the fallbacks',
      await ev("document.fonts.ready.then(function(){"
        + "return ['Italiana','Bodoni Moda','Tenor Sans']"
        + ".every(function(f){return document.fonts.check('16px \"' + f + '\"');});})"));
    check('on the same near-black the liner book uses',
      (await ev("getComputedStyle(document.body).backgroundColor")) === 'rgb(21, 23, 26)');
    check('and the scrollbar is styled away, as it is there',
      (await ev("getComputedStyle(document.documentElement).scrollbarWidth")) === 'none');
    await shot('1-sign-in');

    console.log(NL + 'Registering');
    await ev("show('p-up')");
    await sleep(300);
    await shot('2-register');
    await type('up-name', 'Rosa Fields');
    await type('up-company', 'Fields & Co');
    await type('up-email', 'rosa@example.com');
    await type('up-pass', 'liner-book-2026');
    await ev("document.querySelector('#p-up .btn').click()");
    for (let i = 0; i < 40; i++) {
      if (await ev("document.getElementById('p-code').classList.contains('on')")) break;
      await sleep(250);
    }
    check('the code step opens', await ev("document.getElementById('p-code').classList.contains('on')"));
    check('and says where the code went',
      /rosa@example\.com/.test(await ev("document.getElementById('code-sub').textContent")));
    check('one code was posted', posted.length === 1, posted.length);
    await shot('3-code');

    console.log(NL + 'The code');
    await type('code', '000000');
    await ev("document.querySelector('#p-code .btn').click()");
    await sleep(900);
    check('a wrong one is refused on the page, not in a browser box',
      /not right/i.test(await ev("document.getElementById('says').textContent")));
    check('and the page is still the code step',
      await ev("document.getElementById('p-code').classList.contains('on')"));

    await type('code', lastCode());
    await ev("document.querySelector('#p-code .btn').click()");
    for (let i = 0; i < 40; i++) {
      if (await ev("!!document.querySelector('.doors')")) break;
      await sleep(250);
    }

    console.log(NL + 'The three doors');
    check('the liner book is one', await ev(
      "!!Array.from(document.querySelectorAll('.door h2')).find(h=>/Liner/i.test(h.textContent))"));
    check('the catalogue another', await ev(
      "!!Array.from(document.querySelectorAll('.door h2')).find(h=>/Catalogue/.test(h.textContent))"));
    check('and the calculator the third', await ev(
      "!!Array.from(document.querySelectorAll('.door h2')).find(h=>/Calculator/.test(h.textContent))"));
    check('it greets them by name',
      /Rosa/.test(await ev("document.querySelector('.welcome').textContent")));
    check('the calculator opens this brand, not the other',
      (await ev("document.querySelectorAll('.door')[2].getAttribute('href')"))
        === '/client/arabella/quote');
    // IN THE SAME TAB, AT THIS LINK. A new tab is a second window to find
    // the way back from, and the page it opened would not know who had
    // signed in.
    check('and none of the three opens a second window', await ev(
      "Array.from(document.querySelectorAll('.door')).every(function(a){"
      + "return !a.getAttribute('target');})"));
    await shot('4-signed-in');

    // ──────────────────────────────────────────────
    console.log(NL + 'The three rooms open inside the link');
    for (const [room, what, mark] of [
      ['liners', 'the liner book', /Envelope Liners|Collection/i],
      ['catalogue', 'the design catalogue', /Catalogue|Forms/i],
      ['quote', 'the price calculator', /estimate|quantit/i],
    ]) {
      await send('Page.navigate', { url: BASE + '/client/arabella/' + room });
      await sleep(2000);
      const where = await ev('location.pathname');
      check(what + ' opens at /client/arabella/' + room,
        where === '/client/arabella/' + room, where);
      const text = await ev('document.body.innerText');
      check('  and it is really that page', mark.test(String(text || '')),
        String(text || '').slice(0, 80));
      // The way back out. Without it the only road home is the browser's
      // own button, which is not something a page should make somebody
      // reach for.
      check('  with a way back to the account', await ev(
        "!!Array.from(document.querySelectorAll('a')).find(function(a){"
        + "return a.getAttribute('href') === '/client/arabella';})"));
    }

    // ── THE CALCULATOR DOES NOT ASK WHO THEY ARE ──
    //
    // Those three questions are how the office learned who was pricing
    // what, back when the calculator was a public address. In here the
    // account answers them, and asking a signed-in customer to introduce
    // themselves is the kind of thing that makes a portal feel like three
    // websites in a coat.
    console.log(NL + 'The calculator knows who is using it');
    await send('Page.navigate', { url: BASE + '/client/arabella/quote' });
    await sleep(2500);
    check('no "before we begin" in front of it', await ev(
      "(function(){var g=document.getElementById('gate');"
      + "return !g || g.hidden || g.offsetParent === null;})()"));
    check('the calculator itself is on screen', await ev(
      "(function(){var c=document.getElementById('calc');"
      + "return !!c && !c.hidden;})()"));
    check('and it is pricing for the person who signed in', await ev(
      "(document.getElementById('q_whoEmail')||{}).textContent") === 'rosa@example.com');

    // ── IT HAS TO FIT THE WINDOW ──
    //
    // The module keeps two columns until the VIEWPORT is 1000px, and each
    // column cannot go below about 420px of fields. With the rail at 286
    // and the room's padding that wants ~1240px of window, so on a 1200px
    // laptop the calculate button and the add-ons panel were cut off the
    // right-hand edge and the whole page scrolled sideways. Measured at the
    // widths the office actually uses rather than asserted in CSS.
    for (const width of [1024, 1100, 1200, 1366, 1920]) {
      await send('Emulation.setDeviceMetricsOverride',
        { width: width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: BASE + '/client/arabella/quote' });
      await sleep(1800);
      const over = await ev(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      check('the calculator fits a ' + width + 'px window', Number(over) <= 0, over);
    }
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.navigate', { url: BASE + '/client/arabella/quote' });
    await sleep(1500);

    // ── WHAT A PAGE INSIDE THE PORTAL ASKS FOR ──
    // Each room fetches off its own address, so the same file serves at
    // both mounts. If that broke, the room would draw empty and say
    // nothing about why.
    await send('Page.navigate', { url: BASE + '/client/arabella/liners' });
    await sleep(2200);
    check('the liner book really loaded its shelf, not an empty page',
      await ev("!!document.querySelector('#rail .coll, .rail, #field')"));

    // ── THE OLD ADDRESSES ──
    console.log(NL + 'One link to give out, not four');
    for (const [old_, lands] of [
      ['/liners', '/client/arabella/liners'],
      ['/catalogue', '/client/arabella/catalogue'],
      ['/quote/arabella', '/client/arabella/quote'],
      ['/quote/kpc', '/client/kpc/quote'],
    ]) {
      const r = await fetch(BASE + old_, { redirect: 'manual' });
      check(old_ + ' now points into the portal',
        r.status === 302 && r.headers.get('location') === lands,
        r.status + ' -> ' + r.headers.get('location'));
    }
    // A redirect and not a dead end: the liner book link is already in
    // somebody's chat and was read out over a telephone.
    check('and none of them is a dead end',
      (await fetch(BASE + '/liners', { redirect: 'manual' })).status !== 404);
    // The page a client gives their OWN customers is not behind this door.
    check('order tracking is still open to anybody',
      (await fetch(BASE + '/track', { redirect: 'manual' })).status === 200);

    await send('Page.navigate', { url: BASE + '/client/arabella' });
    await sleep(1500);

    console.log(NL + 'Coming back');
    await send('Page.navigate', { url: BASE + '/client/arabella' });
    await sleep(1200);
    check('the session is still good on a reload', await ev("!!document.querySelector('.doors')"));
    await ev("signOut()");
    await sleep(1200);
    check('signing out puts the card back', await ev("!!document.querySelector('.card')"));

    // ── READING BACK WHAT YOU TYPED ──
    //
    // A password typed on a phone, in a hall, with one thumb is a password
    // typed twice. The eye is wired in script for every password field on
    // the card, so this checks the wiring rather than one form's markup -
    // and checks it goes back to dots when the card changes panel, because
    // a password left readable on a shared screen is the reason the dots
    // are there.
    console.log(NL + 'Showing the password');
    check('the sign-in password has an eye on it',
      await ev("!!document.querySelector('#in-pass') && "
        + "!!document.querySelector('#in-pass').closest('.pw-wrap') && "
        + "!!document.querySelector('#in-pass').closest('.pw-wrap').querySelector('.pw-eye')"));
    await ev("document.getElementById('in-pass').value = 'liner-book-2026';");
    check('it starts as dots',
      (await ev("document.getElementById('in-pass').type")) === 'password');
    await ev("document.querySelector('#in-pass').closest('.pw-wrap').querySelector('.pw-eye').click()");
    await sleep(300);
    check('one press shows the word',
      (await ev("document.getElementById('in-pass').type")) === 'text');
    check('and the eye says it can be hidden again',
      (await ev("document.querySelector('#in-pass').closest('.pw-wrap')"
        + ".querySelector('.pw-eye').getAttribute('aria-label')")) === 'Hide password');
    check('the word itself is still what was typed',
      (await ev("document.getElementById('in-pass').value")) === 'liner-book-2026');
    await ev("show('p-up')"); await sleep(250);
    await ev("show('p-in')"); await sleep(250);
    check('changing panel puts the dots back',
      (await ev("document.getElementById('in-pass').type")) === 'password');
    // Every password field on the card, not only the one on the first panel.
    check('register and the new-password form have one too',
      (await ev("document.querySelectorAll('.pw-wrap .pw-eye').length")) >= 3,
      await ev("document.querySelectorAll('.pw-wrap .pw-eye').length"));

    console.log(NL + 'The other link');
    await send('Page.navigate', { url: BASE + '/client/kpc' });
    await sleep(1200);
    // AND IT DOES NOT SAY KPC EITHER. The office had it taken off: a
    // customer sent this link is a customer of Arabella Papers, and a
    // three-letter code beside the name is the office's own filing
    // showing through. The two links are told apart by their address.
    check('this one does not say KPC anywhere on it',
      !/KPC/.test(await ev('document.body.innerText')));
    check('and it is still the KPC link', await ev(
      "!!document.querySelector('a[href=\"/client/kpc/quote\"], form, .card')")
      && (await ev('location.pathname')) === '/client/kpc');
    await shot('5-kpc-sign-in');

    console.log(NL + 'Nothing shouted');
    check('no console errors anywhere in that', errors.length === 0, errors.slice(0, 3));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
    console.log('Screenshots: ' + SHOTS);
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
