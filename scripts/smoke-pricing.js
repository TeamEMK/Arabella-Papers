/**
 * The pricing calculator, driven against a throwaway database.
 *
 * The arithmetic is the client's and is not re-tested here beyond a couple
 * of worked examples - rewriting their price list in a test file would only
 * give two things to keep in step. What IS tested is everything this office
 * put around it: that the server prices a quote again instead of believing
 * the browser, that a tampered total is refused rather than stored, and that
 * the page is not open to whoever asks for the URL.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_pricing_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

const mailerPath = require.resolve(path.join(ROOT, 'utils/mailer.js'));
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendMail: async () => ({ sent: true }), verifyMail: async () => ({ ok: true }), isMailConfigured: () => true },
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

  console.log('The engine runs where the quote is stored');
  // The module shipped browser-only; without this the server could not check
  // a single figure and would be taking the browser's word for the money.
  const basket = {
    brand: 'ARA', additionalDiscount: 0,
    items: [{ code: 'INVITE', qty: 100, layers: 2, printing: ['PR-FOIL'] }],
  };
  const r = pricing.price(basket);
  check('it prices a basket under Node', r.total > 0 && r.lines.length === 1, r.total);
  check('the standing discount comes off',
    Math.abs(r.baseDiscountAmount - r.total / 2) < 0.01, r.baseDiscountAmount);
  check('and the balance is what is left',
    Math.abs(r.balance - (r.total - r.baseDiscountAmount)) < 0.01, r.balance);
  // Two layers is twice one, which is the rule most likely to be broken by
  // somebody "tidying" the rates file later.
  const one = pricing.price({ brand: 'ARA', additionalDiscount: 0,
    items: [{ code: 'INVITE', qty: 100, layers: 1, printing: [] }] });
  const two = pricing.price({ brand: 'ARA', additionalDiscount: 0,
    items: [{ code: 'INVITE', qty: 100, layers: 2, printing: [] }] });
  check('two layers costs twice one', Math.abs(two.total - one.total * 2) < 0.01,
    { one: one.total, two: two.total });
  // The two brands are not the same price list.
  const kpc = pricing.price({ brand: 'KPC', additionalDiscount: 0,
    items: [{ code: 'INVITE', qty: 100, layers: 1, printing: [] }] });
  check('the brands price differently', kpc.total !== one.total, { ARA: one.total, KPC: kpc.total });

  // The module grew these after the first integration, and each has a way of
  // going wrong quietly rather than loudly.
  console.log('\nThe rush fee');
  const rushed = pricing.price(Object.assign({}, basket, { rushFee: 10 }));
  check('it is added, not taken off', rushed.balance > r.balance,
    { plain: r.balance, rushed: rushed.balance });
  check('and is worked out on the discounted amount, not the total',
    Math.abs(rushed.rushFeeAmount
      - (rushed.total - rushed.baseDiscountAmount - rushed.additionalDiscountAmount) * 0.1) < 0.01,
    { rush: rushed.rushFeeAmount, total: rushed.total });
  // The server used to drop rushFee on its way to the engine, which did not
  // fail loudly - it just priced lower than the screen and refused the quote.
  check('the server carries it through to the engine',
    pricing.verify(Object.assign({}, basket, { rushFee: 10 }),
      { total: rushed.total, balance: rushed.balance }).ok === true,
    'a rush job would be refused as tampered with');

  console.log('\nInk on the back');
  const twoSided = pricing.price({ brand: 'ARA', additionalDiscount: 0,
    items: [{ code: 'INVITE', qty: 100, layers: 1, printing: ['PR-FOIL'], printingBack: ['PR-DIGITAL'] }] });
  const frontOnly = pricing.price({ brand: 'ARA', additionalDiscount: 0,
    items: [{ code: 'INVITE', qty: 100, layers: 1, printing: ['PR-FOIL'] }] });
  check('a back ink costs more than none', twoSided.total > frontOnly.total,
    { front: frontOnly.total, both: twoSided.total });
  check('and the line says which side', /Back:/.test(twoSided.lines[0]), twoSided.lines[0]);

  console.log('\nAdd-ons and edges');
  check('an edge treatment prices from the new list',
    pricing.price({ brand: 'ARA', additionalDiscount: 0, items: [{ code: 'EDGE-GILDED', qty: 100 }] }).total > 0);
  check('so does an add-on',
    pricing.price({ brand: 'ARA', additionalDiscount: 0, items: [{ code: 'ADD-TASSEL', qty: 100 }] }).total > 0);

  console.log('\nWhat it refuses to price');
  const refuses = (input) => { try { pricing.price(input); return false; } catch (e) { return true; } };
  check('an unknown brand', refuses({ brand: 'NOPE', items: basket.items }));
  check('an empty basket', refuses({ brand: 'ARA', items: [] }));
  check('a discount over 100', refuses({ brand: 'ARA', additionalDiscount: 140, items: basket.items }));
  check('a negative discount', refuses({ brand: 'ARA', additionalDiscount: -5, items: basket.items }));
  check('a basket with thousands of lines',
    refuses({ brand: 'ARA', items: new Array(5000).fill(basket.items[0]) }));

  console.log('\nThe browser is not asked what the price is');
  let v = pricing.verify(basket, { total: r.total, balance: r.balance });
  check('figures that match are accepted', v.ok === true, v);
  v = pricing.verify(basket, { total: r.total, balance: 1 });
  check('a balance somebody edited is refused', v.ok === false, v);
  v = pricing.verify(basket, { total: 1, balance: r.balance });
  check('so is an edited total', v.ok === false, v);
  v = pricing.verify(basket, {});
  check('and sending no figures at all is not a disagreement', v.ok === true, v);
  // Doubles are doubles on both sides; a last-place wobble must not refuse
  // somebody's quote.
  v = pricing.verify(basket, { total: r.total + 0.004, balance: r.balance });
  check('a rounding hair is not a disagreement', v.ok === true, v);

  console.log('\nThrough the app');
  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const HTTPS = { 'X-Forwarded-Proto': 'https' };
  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({}, HTTPS, opts.headers || {});
    opts.redirect = opts.redirect || 'manual';
    return fetch(BASE + url, opts);
  };

  let res = await go('/api/pricing/quotes');
  check('a stranger cannot read what was quoted', res.status === 401 || res.status === 302, res.status);
  res = await go('/api/pricing/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  check('nor save one', res.status === 401 || res.status === 302, res.status);

  const login = async () => {
    const out = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    return (out.headers.get('set-cookie') || '').split(';')[0];
  };
  const jar = await login();

  const post = (body) => go('/api/pricing/quote', {
    method: 'POST',
    headers: { cookie: jar, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let json = await (await post({
    orderId: 'K-160108', brand: 'ARA', store: 'Bella', customer: 'Priya',
    additionalDiscount: 0, items: basket.items,
    totals: { total: r.total, balance: r.balance },
  })).json();
  check('a quote saves', json.success === true && json.id > 0, json);
  check('and comes back with the summary to paste',
    /Cost Summary/.test(json.summary || ''), (json.summary || '').slice(0, 40));

  // A rush job, all the way through: the figure the screen showed has to
  // survive the server's own recalculation and land in the table.
  json = await (await post({
    orderId: 'K-160109', brand: 'ARA', additionalDiscount: 0, rushFee: 10,
    items: basket.items,
    totals: { total: rushed.total, balance: rushed.balance, rushFee: rushed.rushFeeAmount },
  })).json();
  check('a rush job saves rather than being refused', json.success === true, json);
  const [[rushRow]] = await db.query(
    'SELECT rush_fee_percent, rush_fee_amount, balance FROM pricing_quotes WHERE id = ?', [json.id]);
  check('and the rush fee is stored as its own figure',
    Number(rushRow.rush_fee_percent) === 10
    && Math.abs(Number(rushRow.rush_fee_amount) - rushed.rushFeeAmount) < 0.01, rushRow);
  check('with the balance that includes it',
    Math.abs(Number(rushRow.balance) - rushed.balance) < 0.01, rushRow.balance);

  // The whole reason the server re-prices.
  //
  // Counted before and after rather than against a fixed number: a check that
  // breaks when a quote is added above it teaches people to edit the number
  // until it passes.
  const [[before]] = await db.query('SELECT COUNT(*) AS n FROM pricing_quotes');
  json = await (await post({
    orderId: 'K-160108', brand: 'ARA', additionalDiscount: 0, items: basket.items,
    totals: { total: 1, balance: 1 },
  })).json();
  check('a quote with figures somebody edited is refused', json.success === false, json);

  const [[stored]] = await db.query('SELECT COUNT(*) AS n FROM pricing_quotes');
  check('and nothing was written', stored.n === before.n, { before: before.n, after: stored.n });

  // Even with no figures sent, what gets stored is the server's own sum.
  json = await (await post({
    brand: 'ARA', additionalDiscount: 0, items: basket.items,
  })).json();
  const [[saved]] = await db.query('SELECT total, balance FROM pricing_quotes WHERE id = ?', [json.id]);
  check('a quote sent with no totals is stored at the real price',
    Math.abs(Number(saved.total) - r.total) < 0.01, saved);

  console.log('\nReading them back');
  json = await (await go('/api/pricing/quotes?orderId=K-160108', { headers: { cookie: jar } })).json();
  check('a quote can be found by its order number', json.rows.length === 1, json.rows.length);
  check('order numbers are text, not numbers',
    json.rows[0].order_id === 'K-160108', json.rows[0].order_id);
  json = await (await go('/api/pricing/quotes?orderId=K-999999', { headers: { cookie: jar } })).json();
  check('and an order with none is empty, not everything', json.rows.length === 0, json.rows.length);
  json = await (await go('/api/pricing/quotes?q=Priya', { headers: { cookie: jar } })).json();
  check('the customer name finds it too', json.rows.length === 1, json.rows.length);

  json = await (await go('/api/pricing/quote/1', { headers: { cookie: jar } })).json();
  check('one quote reopens with what was asked for',
    json.success && json.input && json.input.items.length === 1, json.input);
  check('and records which price list priced it',
    !!json.quote.rates_version, json.quote.rates_version);

  console.log('\nTwo copies of the module');
  // The staff calculator moves with the office's newer builds; the two public
  // brand links are frozen until their own code arrives. Each page is priced
  // by the engine its own browser ran, so they cannot drift apart by accident.
  const fs = require('fs');
  const both = require(path.join(ROOT, 'utils/pricing.js'));
  check('the staff side and the public side are separate instances',
    both.internal !== both.forArabella);
  check('and the Arabella customer build is a third, again separate',
    both.forKpc !== both.internal && both.forKpc !== both.forArabella);
  // They are deliberately NOT the same price list any more: the customer
  // build shows list price and the staff one takes half off.
  check('the staff copy still discounts',
    both.internal.price(basket).baseDiscountPercent === 50,
    both.internal.price(basket).baseDiscountPercent);
  check('and the customer build does not',
    both.forArabella.price(basket).baseDiscountPercent === 0,
    both.forArabella.price(basket).baseDiscountPercent);

  const staffPage = fs.readFileSync(path.join(ROOT, 'views/views/pricing.ejs'), 'utf8');
  const publicPage = fs.readFileSync(path.join(ROOT, 'views/quote.ejs'), 'utf8');
  const publicRoute = fs.readFileSync(path.join(ROOT, 'routes/quote.js'), 'utf8');
  check('the staff page loads the staff copy', staffPage.indexOf('"/pricing/js/') >= 0);
  // The public page takes its folder from the link rather than naming one,
  // so a page cannot be drawn by one build and priced by another.
  check('the public page takes its build from the link',
    publicPage.indexOf('/<%= assets %>/js/') >= 0);
  check('and names no copy of its own', publicPage.indexOf('"/pricing') < 0);
  check('the route gives Arabella its own build',
    /assets: 'pricing-arabella', pricing: pricing\.forArabella/.test(publicRoute));
  check('and leaves KPC where it was',
    /assets: 'pricing-kpc', pricing: pricing\.forKpc/.test(publicRoute));
  check('and prices each quote with the link’s own copy',
    /brand\.pricing\.verify\(/.test(publicRoute));

  console.log('\nThe tab is not for everybody');
  const { defaultSectionIds } = require(path.join(ROOT, 'utils/nav.js'));
  // The price list and the standing discount are the tightest thing in here
  // after the Recruitment tab's document scans.
  check('a designer is not shown the price list',
    !defaultSectionIds('India Designer', '').includes('pricing'));
  check('nor the production floor',
    !defaultSectionIds('Production & Dispatch', '').includes('pricing'));
  check('nor accounts', !defaultSectionIds('Accounts', '').includes('pricing'));
  check('nor a head of department', !defaultSectionIds('Accounts', 'Head').includes('pricing'));
  check('only a SuperAdmin', defaultSectionIds('SuperAdmin', '').includes('pricing'));
  // Not locked, so one person can still be handed it deliberately.
  const { MANAGEABLE_IDS } = require(path.join(ROOT, 'utils/nav.js'));
  check('but it can still be granted to one person', MANAGEABLE_IDS.includes('pricing'));

  server.close();
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
