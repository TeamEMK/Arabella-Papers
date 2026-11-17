// ══════════════════════════════════════════════════════
// THE CLIENT PORTAL
//
// Two links a customer is sent, each opening the same three things behind a
// sign-in of their own:
//
//   /client/arabella   liner book · design catalogue · Arabella calculator
//   /client/kpc        liner book · design catalogue · KPC calculator
//
// THE BRAND IS THE LINK, NOT A SETTING, for the same reason it is on the
// quote pages: somebody sent one price list must not be able to put
// themselves on the other, and a customer handed a link should not have to
// know there are two.
//
// ANYBODY MAY REGISTER - asked for in those words. What that costs is a
// table a stranger can write rows into, so the address is proved by a code
// before the account works, there is a limit on how fast codes can be asked
// for, and the account carries nothing but a name, a company and which of
// the two links it was opened on.
//
// AN ACCOUNT HERE IS NOT AN OFFICE ACCOUNT. It lives in client_users, it is
// kept on the session under its own key, and nothing in the staff app reads
// that key. A customer cannot become staff by any road through this file.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { sendMail } = require('../utils/mailer');
const { TRADING_NAME } = require('../utils/office');
const A = require('../utils/clientAuth');

// Both links are signed Arabella Papers, exactly as the quote pages are -
// see routes/quote.js. The KPC one is told apart by one word in a pill, and
// that word is the only place a customer sees KPC.
const BRANDS = {
  arabella: {
    slug: 'arabella', wordmark: 'ARABELLA PAPERS', pill: '',
    quote: '/quote/arabella',
    calculator: 'Price calculator',
  },
  kpc: {
    // NOTHING ON THIS PAGE SAYS KPC. The office asked for it off: a
    // customer sent this link is a customer of Arabella Papers, and a
    // three-letter code beside the name is the office's own filing
    // showing through. The two links are still two price lists - that is
    // the address, the account and the calculator's own build - and the
    // calculator page keeps the small pill it was given.
    slug: 'kpc', wordmark: 'ARABELLA PAPERS', pill: '',
    quote: '/quote/kpc',
    calculator: 'Price calculator',
  },
};

const brandOf = (req) => BRANDS[String(req.params.brand || '').toLowerCase()];

// ── How often a stranger may ask ──────────────────────
//
// Every write in this file is behind this. The portal is open to the
// internet with no login in front of it, so without a limit one script can
// fill client_users, or send a thousand codes to an address that never
// asked for one.
//
// By IP and by the ten minutes behind it, which is the same shape the quote
// page uses. It holds in memory: on Vercel each container keeps its own
// count, so the real ceiling is this times however many are warm - still
// three orders of magnitude below what a script wants.
const MAX_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60 * 1000;
const HITS = new Map();

function callerIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',');
  return (chain[0] || '').trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function overLimit(req) {
  const ip = callerIp(req);
  const now = Date.now();
  const seen = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  seen.push(now);
  HITS.set(ip, seen);
  if (HITS.size > 5000) {
    for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > WINDOW_MS) HITS.delete(k);
  }
  return seen.length > MAX_PER_WINDOW;
}

const json = express.json({ limit: '64kb' });
const busy = (res) => res.status(429).json({
  success: false,
  error: 'That is a lot of attempts in a short while. Please try again in a few minutes.',
});

// ── Reading and writing the one account ───────────────
const findUser = async (brand, email) => (await db.query(
  'SELECT * FROM client_users WHERE brand = ? AND email = ? LIMIT 1', [brand, email]))[0][0];

/**
 * Put a fresh code on an account and post it.
 *
 * The code is hashed on the way in. This table is the one a leak would
 * reach, and a column of live codes beside the addresses they belong to is
 * a column that signs people in.
 *
 * Returns the code as well, which only the tests ever look at - the route
 * never sends it back down the wire.
 */
async function sendCode(user, brand, purpose) {
  const code = A.newCode();
  const hash = await bcrypt.hash(code, 10);
  await db.query(
    `UPDATE client_users
        SET otp_hash = ?, otp_purpose = ?, otp_tries = 0,
            otp_sent_at = NOW(), otp_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE id = ?`,
    [hash, purpose, Math.round(A.CODE_LIFE_MS / 1000), user.id]);

  const what = purpose === 'reset' ? 'reset your password' : 'confirm your email address';
  const out = await sendMail({
    to: user.email,
    subject: code + ' is your ' + TRADING_NAME + ' code',
    text: 'Your code is ' + code + '. It is good for ten minutes.',
    html: `
      <div style="font-family:Georgia,serif;background:#15171a;color:#e8e4da;padding:34px 28px;">
        <div style="letter-spacing:.22em;font-size:13px;color:#d8ad55;text-transform:uppercase;">
          ${brand.wordmark}${brand.pill ? ' &middot; ' + brand.pill : ''}
        </div>
        <p style="margin:26px 0 8px;font-size:15px;">Use this code to ${what}.</p>
        <div style="font-size:34px;letter-spacing:.34em;color:#d8ad55;margin:18px 0 10px;">${code}</div>
        <p style="font-size:13px;color:#8a8578;margin:0;">
          It is good for ten minutes. If you did not ask for it, nothing has
          happened to your account and you can ignore this.
        </p>
      </div>`,
  });
  return { code, delivered: out && out.sent !== false };
}

/**
 * The same answer whether or not the address is known.
 *
 * Asked for a code and asked to sign in both reply like this. An answer that
 * said "no such account" would turn this page into a way of finding out who
 * the office works with, one address at a time.
 */
const VAGUE = 'If that address has an account, a code is on its way to it.';

function seat(req, user, brand) {
  req.session.client = {
    id: user.id, brand: brand.slug, email: user.email,
    name: user.name || '', company: user.company || '',
  };
}

// ══ THE THREE ROOMS, INSIDE THE SAME LINK ═════════════
//
// The doors used to open /liners, /catalogue and /quote/<brand> in a new
// tab - three more addresses for a customer to be given, lose and ask about,
// and none of them knowing who had signed in. They are served here instead,
// under the link the customer already has:
//
//   /client/<brand>/liners      /client/<brand>/catalogue
//   /client/<brand>/quote
//
// THE SAME ROUTERS, NOT COPIES. routes/linears.js, routes/catalogue.js and
// routes/quote.js are mounted again at these paths. Two copies of a page
// are two pages, and the second one is always the one nobody remembers to
// fix.
//
// Each page asks its own address for everything it fetches - see the BASE
// line at the top of each view - so the same file serves correctly at both
// mounts without knowing which one it is at.
const linearsRoutes = require('./linears');
const catalogueRoutes = require('./catalogue');
const quoteRoutes = require('./quote');

/**
 * Nobody reaches the rooms without a seat in the portal they belong to.
 *
 * A page answers with a redirect rather than a 401: these are opened by a
 * person clicking a tile, not by a script, and somebody whose session has
 * quietly expired should land on the sign-in they recognise with the door
 * they wanted remembered.
 */
function requireClient(req, res, next) {
  const brand = brandOf(req);
  if (!brand) return next();
  const client = req.session && req.session.client;
  if (client && client.brand === brand.slug) {
    // The way back out, drawn by each page when it is being served here.
    res.locals.portalHome = '/client/' + brand.slug;
    res.locals.portalBrand = brand.wordmark;
    // Who is sitting here, for the rooms that would otherwise ask. The
    // calculator's three questions are the account's own fields, and the
    // session is a better answer than a box they could type anything into.
    res.locals.portalWho = {
      name: client.name || '', email: client.email, company: client.company || '',
    };
    // NOT KEPT BY THE BROWSER. Two reasons, and the second is the one that
    // was reported: a page behind a session should not sit in the cache
    // for whoever opens that laptop next, and a room that was cached
    // BEFORE somebody signed in comes back showing the gate it had then -
    // which looks exactly like a change that never shipped.
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    return next();
  }
  res.redirect('/client/' + brand.slug);
}

router.use('/:brand/liners', requireClient, linearsRoutes);
router.use('/:brand/catalogue', requireClient, catalogueRoutes);

// The calculator's own router is written around /:brand, so the request is
// pointed back at the path it expects. Rewritten rather than re-routed: the
// brand in the address IS the price list, and a second way of choosing it
// is a second way of getting it wrong.
router.get('/:brand/quote', requireClient, (req, res, next) => {
  req.url = '/' + brandOf(req).slug;
  quoteRoutes(req, res, next);
});
router.post('/:brand/quote/api/send', requireClient, express.json({ limit: '256kb' }),
  (req, res, next) => {
    // THE NAME ON THE QUOTE IS THE ACCOUNT'S, NOT THE PAGE'S. Out on the
    // public address those three fields were all the office had; in here
    // the person is signed in, and a box they could type anything into is
    // a worse answer than the session they are sitting in.
    const seated = req.session.client;
    req.body = Object.assign({}, req.body, {
      name: seated.name || seated.email,
      email: seated.email,
      store: seated.company || '',
    });
    req.url = '/' + brandOf(req).slug + '/api/send';
    quoteRoutes(req, res, next);
  });

// ══ THE PAGE ══════════════════════════════════════════

// /client on its own is half a link - somebody typing it from memory, or a
// chat app that cut the last word off. It opens the Arabella door rather
// than a 404, because the person holding half the address is a customer,
// not a mistake.
//
// A brand that is not one of the two is still a 404 on purpose: the brand
// IS the price list, and quietly serving the other one would be worse than
// saying there is no such page.
router.get('/', (req, res) => res.redirect(302, '/client/arabella'));
router.get('/:brand', (req, res, next) => {
  const brand = brandOf(req);
  if (!brand) return next();
  const client = req.session.client;
  // A session opened on the other link does not open this one. Same person,
  // possibly - but the two links are two price lists, and an account belongs
  // to the one it was opened on.
  const signedIn = !!(client && client.brand === brand.slug);
  res.render('client', {
    brand: brand.slug,
    wordmark: brand.wordmark,
    pill: brand.pill,
    quoteHref: brand.quote,
    signedIn,
    who: signedIn ? { name: client.name, email: client.email } : null,
  });
});

// ══ REGISTER ══════════════════════════════════════════
//
// An address that already has a VERIFIED account is not told so here; it is
// sent the vague line above and nothing is written. An address with an
// account that was never verified is simply started again - otherwise a
// mistyped address, or somebody closing the tab before the code arrived,
// would lock that address out for ever.
router.post('/:brand/api/register', json, async (req, res) => {
  const brand = brandOf(req);
  if (!brand) return res.status(404).json({ success: false, error: 'No such link.' });
  if (overLimit(req)) return busy(res);

  try {
    const email = A.emailOf(req.body && req.body.email);
    const name = A.text(req.body && req.body.name, 150);
    const company = A.text(req.body && req.body.company, 200);
    const password = String((req.body && req.body.password) || '');

    if (!name) return res.status(400).json({ success: false, error: 'Please give your name.' });
    if (!A.looksLikeEmail(email)) {
      return res.status(400).json({ success: false, error: 'That email address does not look right.' });
    }
    const fault = A.passwordFault(password);
    if (fault) return res.status(400).json({ success: false, error: fault });

    const existing = await findUser(brand.slug, email);
    if (existing && existing.verified_at) {
      // Already an account. Nothing is changed and nothing is said - they
      // are sent to the sign-in, where a forgotten password has its own door.
      return res.json({ success: true, step: 'verify', message: VAGUE, known: true });
    }

    const hash = await bcrypt.hash(password, 10);
    let user = existing;
    if (user) {
      await db.query(
        'UPDATE client_users SET name = ?, company = ?, password_hash = ? WHERE id = ?',
        [name, company, hash, user.id]);
    } else {
      const [ins] = await db.query(
        `INSERT INTO client_users (brand, email, name, company, password_hash)
         VALUES (?,?,?,?,?)`, [brand.slug, email, name, company, hash]);
      user = { id: ins.insertId, email };
    }

    const wait = A.resendWait(existing);
    if (wait) return res.json({ success: true, step: 'verify', wait });
    const out = await sendCode(user, brand, 'verify');
    res.json({ success: true, step: 'verify', delivered: out.delivered });
  } catch (err) {
    console.error('[client] register failed:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ══ THE CODE ══════════════════════════════════════════
router.post('/:brand/api/verify', json, async (req, res) => {
  const brand = brandOf(req);
  if (!brand) return res.status(404).json({ success: false, error: 'No such link.' });
  if (overLimit(req)) return busy(res);

  try {
    const email = A.emailOf(req.body && req.body.email);
    const code = A.text(req.body && req.body.code, 12);
    const user = await findUser(brand.slug, email);
    const state = A.codeState(user, 'verify');

    if (state === 'none') {
      return res.status(400).json({ success: false, error: 'Ask for a new code and try again.' });
    }
    if (state === 'expired') {
      return res.status(400).json({ success: false, error: 'That code has expired. Ask for a new one.' });
    }
    if (state === 'spent') {
      return res.status(400).json({ success: false, error: 'That code has been tried too many times. Ask for a new one.' });
    }

    // Counted BEFORE the comparison, so a crash or a dropped connection
    // mid-check cannot be used to try again for free.
    await db.query('UPDATE client_users SET otp_tries = otp_tries + 1 WHERE id = ?', [user.id]);
    if (!await bcrypt.compare(code, user.otp_hash)) {
      const left = A.MAX_TRIES - (Number(user.otp_tries || 0) + 1);
      return res.status(400).json({
        success: false,
        error: left > 0 ? 'That code is not right. ' + left + ' ' + (left === 1 ? 'try' : 'tries') + ' left.'
          : 'That code is not right, and that was the last try. Ask for a new one.',
      });
    }

    await db.query(
      `UPDATE client_users
          SET verified_at = COALESCE(verified_at, NOW()), otp_hash = NULL,
              otp_purpose = NULL, otp_expires_at = NULL, otp_tries = 0,
              last_login_at = NOW()
        WHERE id = ?`, [user.id]);
    seat(req, user, brand);
    req.session.save(() => res.json({ success: true, signedIn: true }));
  } catch (err) {
    console.error('[client] verify failed:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ══ ANOTHER CODE ══════════════════════════════════════
router.post('/:brand/api/resend', json, async (req, res) => {
  const brand = brandOf(req);
  if (!brand) return res.status(404).json({ success: false, error: 'No such link.' });
  if (overLimit(req)) return busy(res);

  try {
    const email = A.emailOf(req.body && req.body.email);
    const purpose = (req.body && req.body.purpose) === 'reset' ? 'reset' : 'verify';
    const user = await findUser(brand.slug, email);
    // No account, or one already verified asking to verify again: the same
    // vague answer, and nothing sent.
    if (!user || (purpose === 'verify' && user.verified_at)) {
      return res.json({ success: true, message: VAGUE });
    }
    const wait = A.resendWait(user);
    if (wait) {
      return res.status(429).json({
        success: false, wait,
        error: 'A code has just gone out. Another can be sent in ' + wait + ' seconds.',
      });
    }
    const out = await sendCode(user, brand, purpose);
    res.json({ success: true, delivered: out.delivered });
  } catch (err) {
    console.error('[client] resend failed:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ══ SIGN IN ═══════════════════════════════════════════
router.post('/:brand/api/login', json, async (req, res) => {
  const brand = brandOf(req);
  if (!brand) return res.status(404).json({ success: false, error: 'No such link.' });
  if (overLimit(req)) return busy(res);

  try {
    const email = A.emailOf(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const user = await findUser(brand.slug, email);

    // The same words whether the address is unknown or the password is
    // wrong. Two different answers here is a way of listing who has an
    // account, tried one address at a time.
    const no = () => res.status(401).json({
      success: false, error: 'That email and password do not match an account.',
    });
    if (!user) return no();
    if (!await bcrypt.compare(password, user.password_hash)) return no();

    // Right password, address never proved. Send a code rather than a
    // refusal: this is somebody who signed up and never finished.
    if (!user.verified_at) {
      const wait = A.resendWait(user);
      if (!wait) await sendCode(user, brand, 'verify');
      return res.json({ success: true, step: 'verify', wait: wait || 0 });
    }

    await db.query('UPDATE client_users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    seat(req, user, brand);
    req.session.save(() => res.json({ success: true, signedIn: true }));
  } catch (err) {
    console.error('[client] login failed:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ══ FORGOTTEN PASSWORD ════════════════════════════════
//
// A code to the address, not a link. A link in an email has to carry a
// secret in the address bar, where it is copied into chat windows and left
// in browser history; the code is typed on the page it was asked for.
router.post('/:brand/api/forgot', json, async (req, res) => {
  const brand = brandOf(req);
  if (!brand) return res.status(404).json({ success: false, error: 'No such link.' });
  if (overLimit(req)) return busy(res);

  try {
    const email = A.emailOf(req.body && req.body.email);
    const user = await findUser(brand.slug, email);
    if (!user) return res.json({ success: true, message: VAGUE });
    const wait = A.resendWait(user);
    if (!wait) await sendCode(user, brand, 'reset');
    res.json({ success: true, message: VAGUE, wait: wait || 0 });
  } catch (err) {
    console.error('[client] forgot failed:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

router.post('/:brand/api/reset', json, async (req, res) => {
  const brand = brandOf(req);
  if (!brand) return res.status(404).json({ success: false, error: 'No such link.' });
  if (overLimit(req)) return busy(res);

  try {
    const email = A.emailOf(req.body && req.body.email);
    const code = A.text(req.body && req.body.code, 12);
    const password = String((req.body && req.body.password) || '');
    const fault = A.passwordFault(password);
    if (fault) return res.status(400).json({ success: false, error: fault });

    const user = await findUser(brand.slug, email);
    const state = A.codeState(user, 'reset');
    if (state !== 'live') {
      return res.status(400).json({
        success: false,
        error: state === 'spent' ? 'That code has been tried too many times. Ask for a new one.'
          : 'That code has expired or was never sent. Ask for a new one.',
      });
    }
    await db.query('UPDATE client_users SET otp_tries = otp_tries + 1 WHERE id = ?', [user.id]);
    if (!await bcrypt.compare(code, user.otp_hash)) {
      return res.status(400).json({ success: false, error: 'That code is not right.' });
    }

    // A reset proves the address as surely as the sign-up code does, so an
    // account that never finished verifying is verified by this.
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `UPDATE client_users
          SET password_hash = ?, verified_at = COALESCE(verified_at, NOW()),
              otp_hash = NULL, otp_purpose = NULL, otp_expires_at = NULL,
              otp_tries = 0, last_login_at = NOW()
        WHERE id = ?`, [hash, user.id]);
    seat(req, user, brand);
    req.session.save(() => res.json({ success: true, signedIn: true }));
  } catch (err) {
    console.error('[client] reset failed:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ══ SIGN OUT ══════════════════════════════════════════
//
// Only the client's seat is cleared, never the whole session: somebody from
// the office looking at the portal in another tab is signed in as staff on
// the same session, and destroying it would sign them out of their work.
router.post('/:brand/api/logout', (req, res) => {
  if (req.session) delete req.session.client;
  if (req.session && req.session.save) return req.session.save(() => res.json({ success: true }));
  res.json({ success: true });
});

module.exports = router;
module.exports.BRANDS = BRANDS;
