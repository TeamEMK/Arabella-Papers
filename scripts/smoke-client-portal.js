/**
 * THE CLIENT PORTAL: REGISTER, CODE, SIGN IN, FORGOTTEN PASSWORD.
 *
 *   node scripts/smoke-client-portal.js
 *
 * Two links, each opening the liner book, the design catalogue and that
 * brand's price calculator behind a sign-in a customer makes for themselves.
 * Anybody may register, which is what makes the rest of this worth testing:
 * it is the only door in the system a stranger can walk up to.
 *
 * What is actually being proved here:
 *
 *   AN ADDRESS HAS TO BE PROVED before the account works, and the code that
 *   proves it cannot be guessed, reused after it expires, or found in the
 *   table it is stored in.
 *
 *   THE PAGE DOES NOT SAY WHO HAS AN ACCOUNT. A wrong password and an
 *   unknown address answer in the same words, or the sign-in becomes a way
 *   of listing the office's customers one address at a time.
 *
 *   A CLIENT IS NOT STAFF. The account lives in its own table and sits on
 *   the session under its own key, and the office's own screens do not know
 *   that key exists.
 *
 *   THE TWO LINKS ARE TWO PRICE LISTS. An account opened on one does not
 *   open the other.
 *
 * Builds its own throwaway database. Never live.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_client_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.PORT = '0';

// The post is caught, not sent - and the code is read out of it, which is
// the only way this suite ever learns one. Exactly what a customer gets.
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
const lastCode = (to) => {
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i];
    if (!to || String(m.to).toLowerCase() === to.toLowerCase()) {
      const hit = /\b(\d{6})\b/.exec(String(m.text || ''));
      if (hit) return hit[1];
    }
  }
  return '';
};

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};
const NL = String.fromCharCode(10);

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

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  // A fresh caller every time, because the limit that protects this page
  // counts by address and this suite makes a lot of attempts.
  let callers = 0;
  const post = async (brand, what, body, jar) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '10.0.0.' + ((callers++ % 250) + 1),
    };
    if (jar) headers.cookie = jar;
    const r = await go('/client/' + brand + '/api/' + what,
      { method: 'POST', headers, body: JSON.stringify(body) });
    return {
      status: r.status,
      json: await r.json().catch(() => null),
      cookie: (r.headers.get('set-cookie') || '').split(';')[0],
    };
  };
  const rowOf = async (brand, email) => (await db.query(
    'SELECT * FROM client_users WHERE brand = ? AND email = ?', [brand, email]))[0][0];

  try {
    // ──────────────────────────────────────────────
    console.log(NL + 'Two links, and nothing else');
    const arb = await go('/client/arabella');
    const kpc = await go('/client/kpc');
    check('the Arabella link opens with no session at all', arb.status === 200, arb.status);
    check('and so does the KPC one', kpc.status === 200, kpc.status);
    const kpcHtml = await kpc.text();
    const arbHtml = await arb.text();
    check('both are signed Arabella Papers', /ARABELLA PAPERS/.test(kpcHtml) && /ARABELLA PAPERS/.test(arbHtml));
    // NEITHER PAGE SAYS KPC. Taken off at the office's request: a customer
    // sent this link is a customer of Arabella Papers, and a three-letter
    // code beside the name is the office's own filing showing through.
    check('neither page says KPC', !/KPC/.test(kpcHtml) && !/KPC/.test(arbHtml));
    // The two are still two price lists. What tells them apart is the
    // address, the account, and which build the calculator loads - none of
    // which a customer has to read.
    // Signed out there are no doors on the page yet, so what says which
    // link this is, is the brand the page was built for.
    check('and the two are still two links',
      /"kpc"/.test(kpcHtml) && /"arabella"/.test(arbHtml));
    check('a link that is not one of the two is not a page',
      (await go('/client/somebody')).status === 404);
    // Half a link - typed from memory, or cut short by a chat app. The
    // person holding it is a customer, not a mistake.
    const half = await go('/client');
    check('and /client on its own opens a door rather than a 404',
      half.status === 302 && half.headers.get('location') === '/client/arabella',
      half.status + ' -> ' + half.headers.get('location'));
    check('the sign-in offers registering and a forgotten password',
      /Register/.test(arbHtml) && /Forgotten your password/.test(arbHtml));
    check('and shows none of the three doors to somebody not signed in',
      !/Envelope Liner Book/.test(arbHtml));

    // ──────────────────────────────────────────────
    console.log(NL + 'Registering');
    const me = 'rosa@example.com';
    let r = await post('arabella', 'register', {
      name: 'Rosa Fields', company: 'Fields & Co', email: me, password: 'liner-book-2026',
    });
    check('the account is opened', r.json && r.json.success === true, r.json);
    check('and a code is posted to that address',
      posted.length === 1 && posted[0].to === me, posted.map(m => m.to));
    const row = await rowOf('arabella', me);
    check('the account is not usable yet', row && row.verified_at === null, row && row.verified_at);
    // THE CODE IS NOT IN THE TABLE. This is the row a leak would reach, and
    // a column of live codes beside the addresses they belong to is a
    // column that signs people in.
    const code = lastCode(me);
    check('the code is six digits', /^\d{6}$/.test(code), code);
    check('and the table holds a hash of it, not the code',
      row.otp_hash && row.otp_hash.indexOf(code) === -1 && row.otp_hash.startsWith('$2'),
      row.otp_hash);
    check('nor is the password in there',
      row.password_hash.indexOf('liner-book-2026') === -1 && row.password_hash.startsWith('$2'));

    console.log(NL + 'What register will not take');
    for (const [why, body] of [
      ['no name', { email: 'a@b.com', password: 'longenough1' }],
      ['an address that is not one', { name: 'X', email: 'not-an-email', password: 'longenough1' }],
      ['a password of four characters', { name: 'X', email: 'c@d.com', password: 'four' }],
    ]) {
      const bad = await post('arabella', 'register', body);
      check(why + ' is refused', bad.status === 400, bad.json);
    }
    check('and none of them opened an account',
      (await db.query('SELECT COUNT(*) n FROM client_users'))[0][0].n === 1);

    // ──────────────────────────────────────────────
    console.log(NL + 'The code has to be the right one');
    let w = await post('arabella', 'verify', { email: me, code: '000000' });
    check('a wrong code is refused', w.status === 400, w.json);
    check('and says how many tries are left', /tries left/.test(w.json.error), w.json.error);
    check('the account is still unverified', (await rowOf('arabella', me)).verified_at === null);

    // Five wrong answers and the code is dead - not the account, which can
    // simply ask for another.
    for (let i = 0; i < 4; i++) await post('arabella', 'verify', { email: me, code: '111111' });
    w = await post('arabella', 'verify', { email: me, code: code });
    check('after five tries even the RIGHT code is refused',
      w.status === 400 && /too many times/.test(w.json.error), w.json);

    // A minute has to have passed, and in this suite none has. The clock on
    // the row is wound back rather than the limit lifted - the check two
    // lines below is the limit itself, and it has to be the real one.
    await db.query(
      "UPDATE client_users SET otp_sent_at = DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
      + " WHERE brand = 'arabella' AND email = ?", [me]);
    r = await post('arabella', 'resend', { email: me });
    check('but another code can be asked for', r.json && r.json.success === true, r.json);
    const second = lastCode(me);
    check('and it is a different one', second !== code, { code, second });

    // One code a minute. Without this, the address is a free mail service.
    const soon = await post('arabella', 'resend', { email: me });
    check('two codes in a row are refused, with the wait in seconds',
      soon.status === 429 && soon.json.wait > 0, soon.json);

    // An expired code is no code at all.
    await db.query(
      'UPDATE client_users SET otp_expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE email = ?',
      [me]);
    w = await post('arabella', 'verify', { email: me, code: second });
    check('an expired code is refused', w.status === 400 && /expired/.test(w.json.error), w.json);

    await db.query(
      'UPDATE client_users SET otp_expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE), otp_tries = 0 WHERE email = ?',
      [me]);
    const seated = await post('arabella', 'verify', { email: me, code: second });
    check('the right code signs them in', seated.json && seated.json.signedIn === true, seated.json);
    check('and the account is verified from now on',
      !!(await rowOf('arabella', me)).verified_at);
    // Used once and gone: a code left on the row is a second password.
    const after = await rowOf('arabella', me);
    check('the code is wiped once it has been used', after.otp_hash === null, after.otp_hash);

    // ──────────────────────────────────────────────
    console.log(NL + 'Signed in, the three doors are there');
    const jar = seated.cookie;
    const home = await go('/client/arabella', { headers: { cookie: jar } });
    const homeHtml = await home.text();
    check('the liner book is one of them', /Envelope Liners/.test(homeHtml));
    check('the design catalogue is another', /Design Catalogue/.test(homeHtml));
    check('and the price calculator the third', /Price Calculator/.test(homeHtml));
    // The doors open inside this link now, not at four public addresses.
    check('the calculator is this brand\'s room, not the other one',
      /\/client\/arabella\/quote/.test(homeHtml) && !/\/client\/kpc\//.test(homeHtml));
    check('and all three open in the same tab',
      !/class="door"[^>]*target=/.test(homeHtml));
    check('and the sign-in is no longer on the page', !/Forgotten your password/.test(homeHtml));

    // A room is not kept by the browser: it would come back from the cache
    // for whoever opens that laptop next, and a copy cached before somebody
    // signed in comes back showing the sign-in it had then.
    const roomHead = await go('/client/arabella/quote', { headers: { cookie: jar } });
    check('a room tells the browser not to keep it',
      /no-store/.test(roomHead.headers.get('cache-control') || ''),
      roomHead.headers.get('cache-control'));

    // ── THE WHOLE POINT OF A SEPARATE TABLE ──
    console.log(NL + 'A customer is not staff');
    const asStaff = await go('/api/orders', { headers: { cookie: jar } });
    check('the office\'s own screens do not know this session',
      [302, 401, 403].includes(asStaff.status), asStaff.status);
    check('nor do its boards',
      [302, 401, 403].includes((await go('/api/dashboards/production', { headers: { cookie: jar } })).status));
    check('and the client is kept under a key of its own, never session.user',
      require('fs').readFileSync(path.join(ROOT, 'routes/clientPortal.js'), 'utf8')
        .includes('req.session.client')
      && !/session\.user\s*=/.test(require('fs').readFileSync(path.join(ROOT, 'routes/clientPortal.js'), 'utf8')));

    // ──────────────────────────────────────────────
    console.log(NL + 'The two links are two accounts');
    const onKpc = await post('kpc', 'login', { email: me, password: 'liner-book-2026' });
    check('the Arabella account does not sign in on the KPC link',
      onKpc.status === 401, onKpc.json);
    r = await post('kpc', 'register', {
      name: 'Rosa Fields', email: me, password: 'liner-book-2026',
    });
    check('the same address may register on the other link', r.json.success === true, r.json);
    check('which is a second account, not a moved one',
      (await db.query('SELECT COUNT(*) n FROM client_users WHERE email = ?', [me]))[0][0].n === 2);
    const pageAsArb = await go('/client/kpc', { headers: { cookie: jar } });
    check('and a session from one link does not open the other',
      !/Envelope Liner Book/.test(await pageAsArb.text()));

    // ──────────────────────────────────────────────
    console.log(NL + 'Signing in');
    const wrong = await post('arabella', 'login', { email: me, password: 'not-the-password' });
    const unknown = await post('arabella', 'login', { email: 'nobody@example.com', password: 'whatever12' });
    check('a wrong password is refused', wrong.status === 401, wrong.json);
    check('an address with no account is refused', unknown.status === 401, unknown.json);
    // THE SAME WORDS FOR BOTH. Two different answers here is a way of
    // listing who the office works with, one address at a time.
    check('and in the same words, so the page cannot be asked who has an account',
      wrong.json.error === unknown.json.error, [wrong.json.error, unknown.json.error]);
    check('nothing was posted to an address with no account',
      lastCode('nobody@example.com') === '');

    const good = await post('arabella', 'login', { email: me, password: 'liner-book-2026' });
    check('the right password signs them in', good.json.signedIn === true, good.json);
    check('and the row remembers when', !!(await rowOf('arabella', me)).last_login_at);

    // ──────────────────────────────────────────────
    console.log(NL + 'A forgotten password');
    // One code a minute, which this suite has already proved and which it
    // now has to step over: everything here happens inside a second. The
    // clock is wound back on the row rather than the wait being removed,
    // so what is tested below is the real route with the real limit on it.
    await db.query(
      "UPDATE client_users SET otp_sent_at = DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
      + " WHERE brand = 'arabella' AND email = ?", [me]);
    r = await post('arabella', 'forgot', { email: me });
    check('a code is sent', r.json.success === true, r.json);
    const resetCode = lastCode(me);
    check('and it is a new one', resetCode && resetCode !== second, { second, resetCode });

    // A code sent to prove an address must not set a password, and the
    // other way about. One code, one job.
    w = await post('arabella', 'verify', { email: me, code: resetCode });
    check('a reset code will not do as a sign-up code', w.status === 400, w.json);

    w = await post('arabella', 'reset', { email: me, code: '999999', password: 'brand-new-one' });
    check('a wrong code sets nothing', w.status === 400, w.json);
    w = await post('arabella', 'reset', { email: me, code: resetCode, password: 'short' });
    check('and nor does a password that is too short', w.status === 400, w.json);

    const done = await post('arabella', 'reset', { email: me, code: resetCode, password: 'brand-new-one' });
    check('the right code sets the password and signs them in',
      done.json.signedIn === true, done.json);
    check('the old password no longer works',
      (await post('arabella', 'login', { email: me, password: 'liner-book-2026' })).status === 401);
    check('and the new one does',
      (await post('arabella', 'login', { email: me, password: 'brand-new-one' })).json.signedIn === true);

    const unknownForgot = await post('arabella', 'forgot', { email: 'nobody@example.com' });
    check('asking for a code for an address with no account says the same vague thing',
      unknownForgot.json.success === true && /if that address/i.test(unknownForgot.json.message),
      unknownForgot.json);
    check('and posts nothing', lastCode('nobody@example.com') === '');

    // ──────────────────────────────────────────────
    console.log(NL + 'Registering an address that already has an account');
    const before = posted.length;
    r = await post('arabella', 'register', {
      name: 'Somebody Else', email: me, password: 'trying-it-on-123',
    });
    check('says nothing about it either way', r.json.success === true, r.json);
    check('sends no code', posted.length === before, posted.length - before);
    // The password on the real account must not be touched by somebody
    // registering over it - that would be a password reset with no proof.
    check('and leaves the real password alone',
      (await post('arabella', 'login', { email: me, password: 'brand-new-one' })).json.signedIn === true);
    check('certainly not signing the stranger in',
      (await post('arabella', 'login', { email: me, password: 'trying-it-on-123' })).status === 401);

    // ──────────────────────────────────────────────
    console.log(NL + 'Signing out');
    const out = await post('arabella', 'logout', {}, good.cookie);
    check('it answers', out.json.success === true, out.json);
    const back = await go('/client/arabella', { headers: { cookie: good.cookie } });
    check('and the doors are gone', !/Envelope Liner Book/.test(await back.text()));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    try { server.close(); } catch (e) {}
    try { await db.end(); } catch (e) {}
    try {
      await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
      await admin.end();
    } catch (e) {}
    console.log('Throwaway database dropped.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
