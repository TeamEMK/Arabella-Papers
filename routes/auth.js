const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { ipOf, locationOf, fixFrom } = require('../utils/whereFrom');
const vectorDuty = require('../utils/vectorDuty');
const { safeNext } = require('../middleware/auth');
// Two limits in front of the one door a stranger can reach - see
// utils/loginGuard.js for why there are two and why both fail open.
const guard = require('../utils/loginGuard');
// A six-digit code to the address on the account - see utils/staffReset.js
// for why a code and not a link, and what stops it being guessed.
const R = require('../utils/staffReset');
const { callerIp } = require('../utils/callerIp');
const { sendMail } = require('../utils/mailer');

/**
 * The vector-file gate.
 *
 * A designer who still owes files does not get to log out until they are in.
 * Both ways out go through this, because the GET is a plain link and leaving
 * it open would make the whole thing a suggestion.
 *
 * It fails open. If the count cannot be read - the database is unwell, the
 * table is missing on a fresh deploy - the person is let out. A bug in here
 * must not be able to trap the whole office inside the app.
 */
async function vectorHold(req) {
  try {
    const user = req.session && req.session.user;
    if (!user) return null;
    const pending = await vectorDuty.pendingFor(user);
    return pending.count > 0 ? pending : null;
  } catch (err) {
    console.error('Vector logout check failed:', err.message);
    return null;
  }
}

// Carried through the sign-in and checked again on the way out, because
// between the two it has been through a browser and a form field. See
// safeNext in middleware/auth.js for what is allowed.
const landing = (req) => safeNext(req.query.next || req.body?.next) || '/';
// For putting back in the form after a bad password: the bare value, so an
// empty one stays empty rather than becoming a hidden field saying '/'.
const keepNext = (req) => safeNext(req.query.next || req.body?.next);

// GET /login
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect(landing(req));
  res.render('login', { error: null, next: safeNext(req.query.next) });
});

// POST /login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const ip = guard.clientIp(req);
  try {
    // ── BEFORE THE PASSWORD IS EVEN LOOKED AT ──
    //
    // Both answers are deliberately the same sentence as a wrong password.
    // "That account is locked" tells a guesser the address exists and that
    // they are hitting a real one, which is half of what they came for.
    if (guard.ipBlocked(ip) || await guard.emailLocked(email)) {
      return res.render('login', {
        error: 'Too many attempts. Please wait a few minutes and try again.',
        next: keepNext(req),
      });
    }

    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) {
      // An address nobody owns is counted too. Skipping it would make the
      // throttle itself the answer to "does this email exist?" - the known
      // ones get slower, the invented ones never do.
      await guard.noteFailure(email);
      guard.ipFailed(ip);
      return res.render('login', { error: 'Invalid credentials', next: keepNext(req) });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      await guard.noteFailure(email);
      guard.ipFailed(ip);
      return res.render('login', { error: 'Invalid credentials', next: keepNext(req) });
    }

    // A right answer wipes the count, so a morning of fat-fingered attempts
    // does not follow somebody around for the next quarter of an hour.
    await guard.noteSuccess(email);

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // Log activity
    await db.query(
      `INSERT INTO activity_log
         (email, action, role, domain, ip_address, location, latitude, longitude, accuracy_m)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.email, 'Login', user.role, user.domain, ipOf(req), locationOf(req),
       ...fixFrom(req.body)]
    );

    // Set session
    req.session.user = {
      id: user.id,
      empId: user.emp_id,
      username: user.username,
      email: user.email,
      role: user.role,
      domain: user.domain,
    };

    res.redirect(landing(req));
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Server error. Please try again.', next: keepNext(req) });
  }
});

// Both ways out write the same row.
//
// Only the POST used to, and the GET is a plain link anyone can follow - which
// is most of why the log holds 1,326 logins against 91 logouts. A log that
// records arrivals and drops most departures cannot answer how long somebody
// was on the system, which is the main thing anybody asks it.
async function recordLogout(req) {
  const user = req.session?.user;
  if (!user) return;
  // The logout form carries the position the browser gave this session, in
  // three hidden fields the shell fills if it ever got one. A GET logout -
  // somebody following the link - carries nothing, and the town from the IP
  // still stands.
  await db.query(
    `INSERT INTO activity_log (email, action, role, domain, ip_address, location,
                               latitude, longitude, accuracy_m)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [user.email, 'Logout', user.role, user.domain, ipOf(req), locationOf(req),
      ...fixFrom(req.body)]
  ).catch(() => {});
}

// POST /logout
router.post('/logout', async (req, res) => {
  const held = await vectorHold(req);
  if (held) {
    // A plain form post - somebody with JavaScript off - wants a page, not a
    // page of JSON. The app shell puts the list in front of them.
    if (!req.xhr && req.accepts(['html', 'json']) === 'html') {
      return res.redirect('/?vectors=due');
    }
    return res.status(409).json({
      success: false,
      blocked: 'vector',
      count: held.count,
      orders: held.orders,
      error: held.count + ' order' + (held.count === 1 ? '' : 's')
        + ' still need their vector file. Upload them before signing out.',
    });
  }
  await recordLogout(req);
  req.session.destroy(() => res.redirect('/login'));
});

// GET /logout (fallback)
//
// Sent back to the app rather than answered with JSON: somebody who followed
// a link wants a page, and the app puts the list in front of them.
router.get('/logout', async (req, res) => {
  if (await vectorHold(req)) return res.redirect('/?vectors=due');
  await recordLogout(req);
  req.session.destroy(() => res.redirect('/login'));
});

// ══════════════════════════════════════════════════════
// FORGOTTEN PASSWORDS
//
// Before this there was no way back into an account except asking the
// SuperAdmin to type a new password in, which means the new password
// travels over WhatsApp and is known to two people from the moment it
// exists.
//
// THE ANSWER IS THE SAME WHETHER OR NOT THE ACCOUNT EXISTS. Anything else
// and this form is a way to find out which of the office's addresses are
// real - from outside, with no login. The one exception is a password that
// is too short, which is about what was typed here and gives nothing away.
// ══════════════════════════════════════════════════════

// Per caller, against the address the platform saw - never a header they
// write. Twelve goes in ten minutes is more than anybody resetting one
// password needs, and far fewer than a script wants.
const RESET_HITS = new Map();
const RESET_MAX = 12;
const RESET_WINDOW_MS = 10 * 60 * 1000;

function resetFlooding(req) {
  const ip = callerIp(req);
  const now = Date.now();
  const seen = (RESET_HITS.get(ip) || []).filter(t => now - t < RESET_WINDOW_MS);
  seen.push(now);
  RESET_HITS.set(ip, seen);
  if (RESET_HITS.size > 5000) {
    for (const [k, v] of RESET_HITS) {
      if (!v.length || now - v[v.length - 1] > RESET_WINDOW_MS) RESET_HITS.delete(k);
    }
  }
  return seen.length > RESET_MAX;
}

const VAGUE = 'If that address has an account, a code is on its way to it.';
const BUSY = 'That is a lot of attempts in a short while. Please try again in a few minutes.';

const staffBy = async (email) => (await db.query(
  'SELECT id, username, email FROM users WHERE LOWER(email) = ? LIMIT 1', [email]))[0][0];

const resetRow = async (email) => (await db.query(
  'SELECT code_hash, expires_at, tries, sent_at FROM password_resets WHERE email = ?',
  [email]))[0][0];

// GET /forgot — the page itself.
router.get('/forgot', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.render('forgot', { sent: false });
});

// POST /forgot — send a code, or pretend to.
router.post('/forgot', express.json(), async (req, res) => {
  if (resetFlooding(req)) return res.status(429).json({ success: false, error: BUSY });
  try {
    const email = R.emailOf(req.body && req.body.email);
    const user = email ? await staffBy(email) : null;
    if (!user) return res.json({ success: true, message: VAGUE });

    // One code a minute per address, so somebody holding the form open
    // cannot fill an inbox - or wear the code list down by asking for a new
    // one every second.
    const wait = R.resendWait(await resetRow(email));
    if (wait) return res.json({ success: true, message: VAGUE, wait });

    const code = R.newCode();
    const hash = await bcrypt.hash(code, 10);
    await db.query(
      `INSERT INTO password_resets (email, code_hash, expires_at, tries, sent_at)
       VALUES (?, ?, NOW() + INTERVAL ? SECOND, 0, NOW())
       ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash),
                               expires_at = VALUES(expires_at),
                               tries = 0, sent_at = NOW()`,
      [email, hash, Math.round(R.CODE_LIFE_MS / 1000)]);

    const letter = R.mail(code, user.username);
    await sendMail({ to: user.email, ...letter });
    console.log('[reset] code sent to ' + user.email);
    res.json({ success: true, message: VAGUE });
  } catch (err) {
    console.error('[reset] could not send a code:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// POST /reset — the code and the new password together.
router.post('/reset', express.json(), async (req, res) => {
  if (resetFlooding(req)) return res.status(429).json({ success: false, error: BUSY });
  try {
    const email = R.emailOf(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim().slice(0, 12);
    const password = String((req.body && req.body.password) || '');

    // Checked before anything is looked up, because it is about what was
    // typed on this page and says nothing about any account.
    const fault = R.passwordFault(password);
    if (fault) return res.status(400).json({ success: false, error: fault });

    const row = email ? await resetRow(email) : null;
    const state = R.codeState(row);
    if (state !== 'live') {
      return res.status(400).json({
        success: false,
        error: state === 'spent'
          ? 'That code has been tried too many times. Ask for a new one.'
          : 'That code has expired or was never sent. Ask for a new one.',
      });
    }

    // Counted BEFORE it is compared, so a wrong answer costs a try even if
    // the comparison throws or the connection drops.
    await db.query('UPDATE password_resets SET tries = tries + 1 WHERE email = ?', [email]);
    if (!await bcrypt.compare(code, row.code_hash)) {
      return res.status(400).json({ success: false, error: 'That code is not right.' });
    }

    const user = await staffBy(email);
    if (!user) return res.status(400).json({ success: false, error: 'That code is not right.' });

    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
    // Used once. The row goes rather than being marked, so there is nothing
    // left to replay.
    await db.query('DELETE FROM password_resets WHERE email = ?', [email]);
    // Whoever was locked out by wrong guesses has just proved the address.
    await guard.noteSuccess(email);

    // EVERY OTHER SESSION OF THIS ACCOUNT ENDS HERE. A reset is what
    // somebody does when they think another person has their password, and
    // leaving that person's open tab signed in would make the reset
    // pointless. The session store holds the user id inside its JSON.
    try {
      await db.query(
        "DELETE FROM sessions WHERE data LIKE ?",
        ['%"email":"' + user.email + '"%']);
    } catch (err) {
      console.error('[reset] could not clear the old sessions:', err.message);
    }

    await db.query(
      'INSERT INTO activity_log (email, action, ip_address, location) VALUES (?,?,?,?)',
      [user.email, 'Password Reset', ipOf(req), locationOf(req)]);
    console.log('[reset] password set for ' + user.email);

    res.json({ success: true, message: 'Your password is set. Sign in with it.' });
  } catch (err) {
    console.error('[reset] could not set a password:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
