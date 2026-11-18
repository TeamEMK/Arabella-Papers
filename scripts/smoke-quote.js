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

  const get = (url, cookie) => fetch(BASE + url, {
    headers: cookie ? Object.assign({ cookie }, H) : H, redirect: 'manual',
  });

  // THE CALCULATOR IS A ROOM IN THE CLIENT PORTAL NOW, not a public
  // address. The office gives out one link; /quote/<brand> sends whoever
  // holds an old one to the door. So these checks arrive the way a
  // customer does - signed in - and the redirect gets a check of its own.
  const { seat } = require(path.join(ROOT, 'scripts/lib/clientSeat.js'));
  const jar = { arabella: await seat(db, (u, o) => fetch(BASE + u, o), 'arabella'),
                kpc: await seat(db, (u, o) => fetch(BASE + u, o), 'kpc') };
  const room = (slug) => get('/client/' + slug + '/quote', jar[slug]);
  // A fresh IP per call where it matters, so the limiter does not quietly
  // answer the checks that are about something else.
  let ipSeed = 0;
  const send = async (slug, body, sameIp) => {
    const ip = sameIp || ('10.0.0.' + (++ipSeed % 250));
    const res = await fetch(BASE + '/client/' + slug + '/quote/api/send', {
      method: 'POST', redirect: 'manual',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, cookie: jar[slug] }, H),
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const ITEMS = [{ code: 'INVITE', qty: 100, layers: 2, printing: ['PR-FOIL'] }];
  // Each link's own copy, because they are no longer the same price list -
  // the Arabella customer build carries no base discount and the one KPC is
  // still on carries 50. Pricing a fixture with the wrong copy would make
  // every check here fail for a reason that is not the thing being checked.
  const ara = pricing.forArabella.price({ brand: 'ARA', additionalDiscount: 0, items: ITEMS });
  const kpc = pricing.forKpc.price({ brand: 'KPC', additionalDiscount: 0, items: ITEMS });
  const WHO = { name: 'Sarah Mitchell', email: 'sarah@example.com', store: 'Mitchell Paper' };

  console.log('The old addresses send you to the door');
  for (const [was, now] of [['/quote/arabella', '/client/arabella/quote'],
                            ['/quote/kpc', '/client/kpc/quote']]) {
    const moved = await get(was);
    check(was + ' points into the portal',
      moved.status === 302 && moved.headers.get('location') === now,
      moved.status + ' -> ' + moved.headers.get('location'));
  }
  const shut = await get('/client/arabella/quote');
  check('and the room itself turns a stranger away',
    shut.status === 302 && shut.headers.get('location') === '/client/arabella',
    shut.status + ' -> ' + shut.headers.get('location'));

  console.log('The pages, opened by a signed-in client');
  let r = await room('arabella');
  check('the Arabella link opens', r.status === 200, r.status);
  let html = await r.text();
  check('and is not a redirect to the login', !/name="password"/.test(html));
  check('it is signed Arabella Papers, not the internal code ARB',
    /ARABELLA PAPERS/.test(html) && !/ARABELLA \(ARB\)/.test(html));
  // No pill on this one: it would repeat the wordmark directly above it,
  // which says the same thing twice and reads as a page still loading.
  check('and carries no pill, because there is nothing to tell it apart from',
    !/class="q-brand"/.test(html));
  check('and asks who you are before anything else', /id="gate"/.test(html) && /g_email/.test(html));

  r = await room('kpc');
  html = await r.text();
  check('the KPC link opens', r.status === 200, r.status);
  // The office asked for this page to be signed Arabella Papers while the
  // link stays /quote/kpc - and then, once both pages looked identical, for
  // one word that tells them apart. So: signed Arabella Papers, priced from
  // the KPC list, and KPC said ONCE, in the pill under the wordmark.
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '')
    .replace(/<%[\s\S]*?%>/g, '');
  check('and is signed Arabella Papers, like the other one',
    /ARABELLA PAPERS/.test(html));
  check('KPC is said once, and only in the pill',
    (visible.match(/KPC/g) || []).length === 1
    && /<div class="q-brand">KPC<\/div>/.test(visible), (visible.match(/KPC/g) || []).length);
  check('while still being priced from the KPC list',
    /pricing-kpc\/js\//.test(html));

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

  console.log('\nEach link on its own price list');
  // The Arabella link runs the office's customer build, which carries
  // baseDiscount 0; the KPC link is still on the older shared one at 50. The
  // same basket is therefore twice the money on one link, on purpose - and
  // every quote has to be re-priced by the copy its own browser ran. One
  // shared engine would refuse every Arabella quote as tampered with.
  const all = require(path.join(ROOT, 'utils/pricing.js'));
  check('the Arabella link has its own copy', !!all.forArabella);
  check('and it is not the staff one', all.forArabella !== all.internal);
  check('nor the one KPC is on', all.forArabella !== all.forKpc);
  const araCust = all.forArabella.price({ brand: 'ARA', items: ITEMS });
  check('the customer build shows list price, no discount',
    araCust.baseDiscountPercent === 0 && araCust.balance === araCust.total, araCust.balance);
  check('which is twice what the office would quote',
    Math.abs(araCust.balance - all.internal.price({ brand: 'ARA', items: ITEMS }).balance * 2) < 0.01,
    { customer: araCust.balance, office: all.internal.price({ brand: 'ARA', items: ITEMS }).balance });
  check('and it carries one brand, not two', all.forArabella.BRANDS.length === 1, all.forArabella.BRANDS);

  // The whole point: a figure worked out by the page has to survive the
  // server, and it only does if the server used the same list.
  r = await send('arabella', Object.assign({}, WHO, {
    items: ITEMS, totals: { total: araCust.total, balance: araCust.balance },
  }));
  check('a quote off the customer build is accepted', r.json && r.json.success === true, r.json);
  [[row]] = await db.query('SELECT balance FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('and stored at the price the customer was shown',
    Math.abs(Number(row.balance) - araCust.balance) < 0.01, row.balance);
  // The old half-price figure is now the wrong answer on that link.
  r = await send('arabella', Object.assign({}, WHO, {
    items: ITEMS, totals: { total: araCust.total, balance: araCust.balance / 2 },
  }));
  check('and the office price is refused there', r.json && r.json.success === false, r.json);

  r = await room('arabella');
  html = await r.text();
  check('the page loads the Arabella build', /\/pricing-arabella\/js\//.test(html));
  check('and nothing of the other brand', !/\/pricing-kpc\//.test(html));
  r = await room('kpc');
  html = await r.text();
  check('and the KPC link has its own build too', /\/pricing-kpc\/js\//.test(html));
  check('with nothing of the Arabella one on it', !/\/pricing-arabella\//.test(html));

  // WHO IS ASKING IS THE ACCOUNT, NOT THE BODY.
  //
  // Out on the old public address these three fields were all the office
  // had, so the route refused a quote without them. Inside the portal the
  // person is signed in, and the server takes the name and the address off
  // the session - a box somebody can type anything into is a worse answer
  // than the seat they are sitting in. So the checks here are the other way
  // round: a body with nothing in it still works, and a body naming
  // somebody else does not get their name onto the quote.
  console.log('\nWho is asking');
  const bare = await send('arabella', { items: ITEMS });
  check('a quote with no name or email in the body still works',
    bare.json && bare.json.success === true, bare.json);
  let [[seated]] = await db.query(
    'SELECT customer_name, customer_email FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('and it is recorded against the account that asked',
    seated.customer_email === 'room-arabella@test.local', seated);

  const liar = await send('arabella', Object.assign({}, WHO, { items: ITEMS }));
  check('a body claiming somebody else is accepted', liar.json.success === true, liar.json);
  [[seated]] = await db.query(
    'SELECT customer_name, customer_email FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('but the quote still carries the account, not the name it claimed',
    seated.customer_email === 'room-arabella@test.local'
    && seated.customer_email !== WHO.email, seated);

  check('an empty basket is still refused',
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
  // Still built, though the button is gone: it is what gets attached to the
  // mail the customer receives. Taking the download away was a change to the
  // page, not to what the customer ends up holding.
  check('and a PDF', !!r.json.pdf && r.json.pdf.length > 1000, (r.json.pdf || '').length);
  const pdf = Buffer.from(r.json.pdf, 'base64');
  check('that really is a PDF', pdf.slice(0, 5).toString() === '%PDF-', pdf.slice(0, 8).toString());

  // The paper is what a customer forwards to whoever approves the spend,
  // so what it says matters as much as that it opened.
  const words = pdfText(pdf);
  check('it names the office by its trading name',
    /ARABELLA PAPERS/.test(words) && !/PVT|Private Limited/i.test(words), words.slice(0, 80));
  check('and the price list it was quoted from, in the customer\'s words',
    words.indexOf('ARABELLA PAPERS price list') >= 0, words.slice(0, 160));
  check('it carries who it is for - the account that asked',
    words.indexOf('room-arabella@test.local') >= 0, words.slice(0, 200));
  check('every line of the quote', (r.json.summary.match(/^d+./gm) || []).length
    === (words.match(/^d+.s/gm) || []).length);
  // The Arabella customer build quotes list price, so there is no discount
  // line to show - and the paper must not invent one. A PDF that prints a
  // discount the customer was never given is a document somebody argues with.
  check('it shows no discount, because this build gives none',
    words.indexOf('Less (') < 0, words.slice(0, 200));
  check('and the total and the balance are the same number',
    Math.abs(ara.total - ara.balance) < 0.01, { total: ara.total, balance: ara.balance });
  check('and the balance, which is the number anybody reads',
    words.indexOf(ara.balance.toFixed(2)) >= 0, ara.balance);
  check('and says it is an estimate, not an invoice', /not an invoice/i.test(words));

  console.log('\nThe email');
  const mail = SENT[SENT.length - 1];
  // Posted to the signed-in account, never to an address typed into the
   // body - that is what stops a quote being sent to anybody a stranger
   // names.
  check('it went to the account that asked',
    mail && mail.to === 'room-arabella@test.local', mail && mail.to);
  check('and never to an address from the body',
    SENT.every(m => m.to !== WHO.email), SENT.map(m => m.to));
  check('with the PDF attached', mail && (mail.attachments || []).length === 1);
  check('and the figures in the body',
    mail && mail.html.indexOf(ara.balance.toFixed(2)) >= 0, ara.balance);
  check('the office is not named as Private Limited',
    mail && !/Private Limited/i.test(mail.html + mail.text));

  console.log('\nWhat was kept');
  [[row]] = await db.query(
    'SELECT source, customer_name, customer_email, balance FROM pricing_quotes ORDER BY id DESC LIMIT 1');
  check('the quote is marked as coming from the public page', row.source === 'public', row.source);
  check('with who asked for it - the account, not the body',
    row.customer_email === 'room-arabella@test.local', row);
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
  // "And somebody else is not caught by it" used to be checked here by
  // sending a second burst under a different X-Forwarded-For. That header is
  // no longer the key - the caller writes it, so a limiter keyed on it was
  // no limiter at all - and over the wire this suite is one socket for all
  // of it, so there is no second caller to be. The key itself is checked in
  // scripts/smoke-security.js: the socket off the platform, and only what
  // the platform wrote on it.

  console.log('\nThe buttons the customer is offered');
  for (const slug of ['arabella', 'kpc']) {
    const page = await (await room(slug)).text();
    check(slug + ': the Download PDF button is gone', !/id="q_pdf"/.test(page));
    check(slug + ': Copy the quote is still there', /id="q_copy"/.test(page));
  }
  // The button list is built from what is actually on the page. Naming a
  // button that was removed puts a null in it, disabling a null throws, and
  // the customer is told "Something went wrong" about a quote that was never
  // attempted - which is exactly how a tidy-up turns into a bug report.
  const page = await (await room('kpc')).text();
  check('and the code does not reach for a button that is not there',
    /\.filter\(Boolean\)/.test(page) && !/getElementById\('q_pdf'\)\]/.test(page));

  console.log('\nThe paper it is printed on');
  const qview = require('fs').readFileSync(path.join(ROOT, 'views/quote.ejs'), 'utf8');
  // The two photographs are real flat-lays with leaves, ribbon and a wax
  // seal in them. Nothing anybody has to READ may sit on one: small grey
  // labels over a photograph are unreadable at exactly the moment somebody
  // is typing a quantity into them.
  // Not a count - a count needs updating every time one is added, and
  // the one somebody adds without the role is exactly the one that then
  // gets text put on it. Every decorative panel on this page must be an
  // EMPTY element marked as presentation.
  const decorative = ['q-band', 'q-bandfoot', 'gate-art'];
  for (const cls of decorative) {
    check(cls + ' is an empty panel marked as decoration',
      new RegExp('<div class="' + cls + '" role="presentation"></div>').test(qview));
  }
  // The form alone in the middle of an empty page looked like a form on
  // an empty page. It is one sheet now - the suite down one side, the
  // three questions down the other - and the picture steps aside on a
  // phone, where the page background is already that photograph.
  check('the gate is a composed sheet, not a box floating in cream',
    qview.includes('class="gate-art"') && qview.includes('.gate-art {'));
  check('and the picture gets out of the way on a phone',
    /@media \(max-width:760px\)[\s\S]{0,900}\.gate-art \{ display:none/.test(qview));
  check('they are bands above and below, not a field behind the form',
    qview.includes('.q-band {') && qview.includes('.q-bandfoot {'));
  // The module's own CALCULATE ESTIMATE is the loudest control on the page.
  // Our buttons take its colour, so the wrapper and the calculator do not
  // read as two different companies.
  check('our buttons use the module\'s own primary', qview.includes('--slate:#3e5576'));
  const modcss = require('fs').readFileSync(
    path.join(ROOT, 'public/pricing-arabella/css/pricing-calculator.css'), 'utf8');
  check('and that is still the colour the module uses', modcss.includes('--apc-plum: #3e5576'));
  check('the error state is a class, not a colour written into the script',
    qview.includes("classList.toggle('bad'") && !qview.includes('#b02a37'));
  for (const img of ['suite-band.jpg', 'suite-tall.jpg']) {
    const kb = require('fs').statSync(path.join(ROOT, 'public/ornament', img)).size / 1024;
    // This is a public page. A heavy background is a customer waiting.
    check(img + ' is light enough to send (' + kb.toFixed(0) + ' KB)', kb < 300, kb);
  }

  // THE BUG THE OFFICE FOUND ON LIVE. The `hidden` attribute is only
  // display:none from the browser's own stylesheet, and ANY author
  // `display` beats it. The moment .gate was given display:flex,
  // q_open()'s `gate.hidden = true` stopped hiding anything, and the gate
  // sat on screen above the calculator it had just opened. The other pages
  // never hit this because Bootstrap carries its own
  // [hidden]{display:none!important}; this page does not load Bootstrap.
  //
  // Checked for EVERY element the script hides, not just the one that
  // broke - the next person to style one of the others would otherwise
  // reintroduce exactly this.
  console.log('\nWhat the script hides actually goes');
  const hides = [...qview.matchAll(/getElementById\('([a-zA-Z_]+)'\)\.hidden = true/g)].map(m => m[1]);
  check('the script hides something by attribute', hides.length >= 2, hides);
  // The style block, with comments stripped so a mention inside one does
  // not read as a rule.
  const css = (qview.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1]
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const id of hides) {
    const rules = css.split('}').filter(r => r.includes('display')
      && new RegExp('(^|[,\\s])[.#]?' + id + '\\b', 'm').test(r.split('{')[0] || ''));
    const fights = rules.some(r => !/\[hidden\]/.test(r.split('{')[0] || ''));
    const answered = css.includes('#' + id + '[hidden]') || css.includes('.' + id + '[hidden]');
    check(fights
      ? id + ' has a display rule, and [hidden] takes it back'
      : id + ' has no display rule to fight',
      !fights || answered, { fights, answered });
  }

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
