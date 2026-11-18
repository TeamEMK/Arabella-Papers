// ══════════════════════════════════════════════════════
// GUESSING PASSWORDS, AND WHY TWO DIFFERENT GUARDS
//
// A login form with nothing in front of it is a password guesser with a
// free hand: this office's own list of 30-odd staff emails is not a secret,
// and a script can try a thousand common passwords against each of them in
// a minute. Two separate limits, because they stop two different attacks:
//
//   PER ACCOUNT. Ten wrong answers in fifteen minutes and that email is
//   locked for fifteen minutes, even when the eleventh is the right
//   password. This is what stops a slow grind against one person - which is
//   the shape a real attack takes, because it is quiet.
//
//   PER ADDRESS. Thirty FAILED attempts from one caller in fifteen minutes
//   and that caller waits. Only failures count: the whole office signs in
//   from one office line every morning, and a limiter that counted their
//   successes would lock the office out of its own system by ten o'clock.
//
// Both FAIL OPEN. If the database cannot be read, the login proceeds
// un-throttled rather than refusing everybody: this table going missing
// must not be an outage for the whole company.
// ══════════════════════════════════════════════════════
const db = require('../config/db');

const MAX_PER_EMAIL = 10;
const EMAIL_WINDOW_MIN = 15;
const LOCK_MIN = 15;

const MAX_PER_IP = 30;
const IP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Who is calling, as far as it can honestly be known.
 *
 * NEVER THE RAW X-Forwarded-For. A caller can send that header themselves,
 * with a different value each time, and a limiter keyed on it is a limiter
 * with no key at all - every attempt looks like a new person.
 *
 * On Vercel the platform overwrites x-vercel-forwarded-for and x-real-ip
 * with the address it saw, and those are the ones to read. Anywhere else -
 * a laptop, a smoke test, a box behind nothing - the socket address is the
 * only thing that is true.
 */
function clientIp(req) {
  if (process.env.VERCEL) {
    const platform = String(req.headers['x-vercel-forwarded-for']
      || req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (platform) return platform;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Per address, in this instance's memory. On serverless each warm instance
// keeps its own count, so this slows a burst rather than stopping a patient
// one - the per-account lock is what actually stops that. A shared store
// would be better and there is none here to use.
const IP_HITS = new Map();

function ipBlocked(ip) {
  const now = Date.now();
  const seen = (IP_HITS.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  IP_HITS.set(ip, seen);
  return seen.length >= MAX_PER_IP;
}

/** Counted only when the answer was wrong - see the note at the top. */
function ipFailed(ip) {
  const now = Date.now();
  const seen = (IP_HITS.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  seen.push(now);
  IP_HITS.set(ip, seen);
  // Swept while we are here, so one long-running instance does not keep a
  // row for every address that ever typed a password wrong.
  if (IP_HITS.size > 5000) {
    for (const [k, v] of IP_HITS) {
      if (!v.length || now - v[v.length - 1] > IP_WINDOW_MS) IP_HITS.delete(k);
    }
  }
}

const key = (email) => String(email || '').trim().toLowerCase().slice(0, 150);

/** Is this email locked out right now? */
async function emailLocked(email) {
  const who = key(email);
  if (!who) return false;
  try {
    const [[row]] = await db.query(
      'SELECT locked_until FROM login_attempts WHERE email = ?', [who]);
    return !!(row && row.locked_until && new Date(row.locked_until) > new Date());
  } catch (err) {
    console.error('[login] lock check failed, letting it through:', err.message);
    return false;
  }
}

/**
 * One wrong answer, counted.
 *
 * COUNTED AND LOCKED IN ONE STATEMENT. Two attempts arriving together would
 * both read "9 so far" and both write 10, and the tenth and eleventh would
 * slip past a check done in JavaScript. MySQL decides it here instead: the
 * row is inserted or updated once, and the lock is set in the same breath
 * as the count that earns it.
 *
 * The window is rolled inside the statement too - a first failure more than
 * fifteen minutes old starts a fresh count rather than adding to an old one.
 */
async function noteFailure(email) {
  const who = key(email);
  if (!who) return;
  try {
    // THE ORDER OF THESE THREE LINES IS THE WHOLE TRICK.
    //
    // MySQL applies them left to right and each one sees what the earlier
    // ones wrote. So:
    //   tries        is counted first, while first_try_at still holds the
    //                OLD timestamp - that is what rolls the window.
    //   first_try_at is moved second, reading its own old value.
    //   locked_until is last, so `tries` is already the NEW count.
    //
    // Written the other way round it locked one attempt early: the lock
    // line re-derived the count from a column that had just been updated,
    // and nine wrong answers locked the account.
    await db.query(
      `INSERT INTO login_attempts (email, tries, first_try_at, locked_until)
       VALUES (?, 1, NOW(), NULL)
       ON DUPLICATE KEY UPDATE
         tries = IF(first_try_at < NOW() - INTERVAL ? MINUTE, 1, tries + 1),
         first_try_at = IF(first_try_at < NOW() - INTERVAL ? MINUTE, NOW(), first_try_at),
         locked_until = IF(tries >= ?, NOW() + INTERVAL ? MINUTE, locked_until)`,
      [who, EMAIL_WINDOW_MIN, EMAIL_WINDOW_MIN, MAX_PER_EMAIL, LOCK_MIN]);
  } catch (err) {
    console.error('[login] could not count a failure:', err.message);
  }
}

/** A right answer wipes the slate for that email. */
async function noteSuccess(email) {
  const who = key(email);
  if (!who) return;
  try {
    await db.query('DELETE FROM login_attempts WHERE email = ?', [who]);
  } catch (err) {
    console.error('[login] could not clear the count:', err.message);
  }
}

module.exports = {
  clientIp, ipBlocked, ipFailed, emailLocked, noteFailure, noteSuccess,
  MAX_PER_EMAIL, MAX_PER_IP, LOCK_MIN,
};
