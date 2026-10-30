/**
 * The two public price links, against a throwaway database.
 *
 * This is the only part of the pricing that a stranger can reach, so most of
 * what follows is about what it must refuse: a brand swapped in the request
 * body, figures edited on the way, somebody with no name or address, and a
 * script filling the table.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');
const { pdfText } = require('./lib/pdfText');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_quote_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

const SENT = [];
const mailerPath = require.resolve(path.join(ROOT, 'utils/mailer.js'));
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async (m) => { SENT.push(m); return { sent: true }; },
    verifyMail: async () => ({ ok: true }), isMailConfigured: () => true,
  },
};

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

(async () => {
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
  const pricing = require(path.join(ROOT, 'utils/pricing.js'));

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Forwarded-Proto': 'https' };

  const get = (url) => fetch(BASE + url, { headers: H, redirect: 'manual' });
  // A fresh IP per call where it matters, so the limiter does not quietly
  // answer the checks that are about something else.
  let ipSeed = 0;
  const send = async (slug, body, sameIp) => {
    const ip = sameIp || ('10.0.0.' + (++ipSeed % 250));
    const res = await fetch(BASE + '/quote/' + slug + '/api/send', {
      method: 'POST', redirect: 'manual',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, H),
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const ITEMS = [{ code: 'INVITE', qty: 100, layers: 2, printing: ['PR-FOIL'] }];
  const ara = pricing.price({ brand: 'ARA', additionalDiscount: 0, items: ITEMS });
  const kpc = pricing.price({ brand: 'KPC', additionalDiscount: 0, items: ITEMS });
  const WHO = { name: 'Sarah Mitchell', email: 'sarah@example.com', store: 'Mitchell Paper' };

  console.log('The pages, with nobody logged in');
  let r = await get('/quote/arabella');
  check('the Arabella link opens', r.status === 200, r.status);
  let html = await r.text();
  check('and is not a redirect to the login', !/name="password"/.test(html));
  check('it names its own price list', /ARABELLA \(ARB\)/.test(html));
  check('and asks who you are before anything else', /id="gate"/.test(html) && /g_email/.test(html));

  r = await get('/quote/kpc');
  html = await r.text();
  check('the KPC link opens on the KPC list', r.status === 200 && /KPC/.test(html), r.status);

  r = await get('/quote/somethingelse');
  check('an invented brand is not a page', r.status === 404, r.status);

  console.log('\nThe brand belongs to the link');
  // Otherwise the Arabella link prices on the KPC list for anybody who asks
  // it to, and the two links stop meaning anything.
  r = await send('arabella', Object.assign({}, WHO, {
    brand: 'KPC', items: ITEMS, totals: { total: kpc.total, balance: kpc.balance },
  }));
  check('posting the other brand does not switch the price list', r.json && r.json.success === false, r.json);
  r = await send('arabella', Object.assign({}, WHO, {
    brand: 'KPC', items: ITEMS, totals: { total: ara.total, balance: ara.balance },
  }));
  check('and the link’s own list is what prices it', r.json && r.json.success === true, r.json);
  let [[row]] = await db.query('SELECT brand FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('which is what gets stored', row.brand === 'ARA', row);

  r = await send('kpc', Object.assign({}, WHO, {
    items: ITEMS, totals: { total: kpc.total, balance: kpc.balance },
  }));
  check('the KPC link prices on the KPC list', r.json && r.json.success === true, r.json);
  [[row]] = await db.query('SELECT brand, total FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('and KPC is the cheaper of the two here',
    row.brand === 'KPC' && Number(row.total) === kpc.total && kpc.total < ara.total,
    { kpc: kpc.total, ara: ara.total });

  console.log('\nWho is asking');
  check('no name is refused',
    (await send('arabella', { email: WHO.email, items: ITEMS })).json.success === false);
  check('no email is refused',
    (await send('arabella', { name: WHO.name, items: ITEMS })).json.success === false);
  check('and something that is not an address is refused',
    (await send('arabella', { name: WHO.name, email: 'not-an-address', items: ITEMS })).json.success === false);
  check('an empty basket is refused',
    (await send('arabella', Object.assign({}, WHO, { items: [] }))).json.success === false);

  console.log('\nThe figures are still the server’s');
  r = await send('arabella', Object.assign({}, WHO, {
    items: ITEMS, totals: { total: 1, balance: 1 },
  }));
  check('an edited total is refused here too', r.json && r.json.success === false, r.json);

  console.log('\nWhat the customer walks away with');
  r = await send('arabella', Object.assign({}, WHO, {
    items: ITEMS, totals: { total: ara.total, balance: ara.balance },
  }));
  check('a quote comes back', r.json && r.json.success === true, r.json);
  check('with the summary to paste', /Cost Summary/.test(r.json.summary || ''));
  check('and a PDF', !!r.json.pdf && r.json.pdf.length > 1000, (r.json.pdf || '').length);
  const pdf = Buffer.from(r.json.pdf, 'base64');
  check('that really is a PDF', pdf.slice(0, 5).toString() === '%PDF-', pdf.slice(0, 8).toString());

  // The paper is what a customer forwards to whoever approves the spend,
  // so what it says matters as much as that it opened.
  const words = pdfText(pdf);
  check('it names the office by its trading name',
    /ARABELLA PAPERS/.test(words) && !/PVT|Private Limited/i.test(words), words.slice(0, 80));
  check('and the price list it was quoted from',
    words.indexOf('ARABELLA (ARB) price list') >= 0, words.slice(0, 160));
  check('it carries who it is for', words.indexOf(WHO.name) >= 0 && words.indexOf(WHO.email) >= 0);
  check('every line of the quote', (r.json.summary.match(/^d+./gm) || []).length
    === (words.match(/^d+.s/gm) || []).length);
  check('the discount it was given', words.indexOf('Less (50%)') >= 0, words.slice(0, 160));
  check('and the balance, which is the number anybody reads',
    words.indexOf(ara.balance.toFixed(2)) >= 0, ara.balance);
  check('and says it is an estimate, not an invoice', /not an invoice/i.test(words));

  console.log('\nThe email');
  const mail = SENT[SENT.length - 1];
  check('it went to the customer', mail && mail.to === WHO.email, mail && mail.to);
  check('and to nobody else',
    SENT.every(m => m.to === WHO.email), SENT.map(m => m.to));
  check('with the PDF attached', mail && (mail.attachments || []).length === 1);
  check('and the figures in the body',
    mail && mail.html.indexOf(ara.balance.toFixed(2)) >= 0, ara.balance);
  check('the office is not named as Private Limited',
    mail && !/Private Limited/i.test(mail.html + mail.text));

  console.log('\nWhat was kept');
  [[row]] = await db.query(
    'SELECT source, customer_name, customer_email, balance FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('the quote is marked as coming from the public page', row.source === 'public', row.source);
  check('with who asked for it', row.customer_name === WHO.name && row.customer_email === WHO.email, row);
  check('and the balance the server worked out',
    Math.abs(Number(row.balance) - ara.balance) < 0.01, row.balance);

  console.log('\nFilling the table from a script');
  let blocked = 0;
  for (let i = 0; i < 14; i++) {
    const x = await send('arabella', Object.assign({}, WHO, {
      items: ITEMS, totals: { total: ara.total, balance: ara.balance },
    }), '203.0.113.9');
    if (x.status === 429) blocked++;
  }
  check('gets cut off', blocked > 0, { blocked });
  check('and somebody else is not caught by it',
    (await send('kpc', Object.assign({}, WHO, {
      items: ITEMS, totals: { total: kpc.total, balance: kpc.balance },
    }), '198.51.100.7')).json.success === true);

  console.log('\nIt does not disturb the internal tab');
  const [[internal]] = await db.query(
    "SELECT COUNT(*) AS n FROM pricing_quotes WHERE source = 'internal'");
  check('nothing public was filed as internal', internal.n === 0, internal.n);

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
