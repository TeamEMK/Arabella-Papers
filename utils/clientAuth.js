/**
 * The rules behind the client portal's sign-in, in one place.
 *
 * The portal is the only part of this system where a stranger can make
 * themselves an account, so each of these is here rather than scattered
 * through the route: what counts as an email, how long a code lives, how
 * many times it may be guessed, and how long somebody must wait before
 * asking for another. A number that decides whether a six-digit code can be
 * brute-forced should not be sitting in the middle of a request handler.
 */
const crypto = require('crypto');

// ── The code ──────────────────────────────────────────
// Six digits, because it is typed off a phone by somebody holding a mouse.
// Short enough to be guessed by a machine, which is what the three numbers
// under it are for.
const CODE_LENGTH = 6;
const CODE_LIFE_MS = 10 * 60 * 1000;   // long enough for mail to arrive
const MAX_TRIES = 5;                   // then the code is dead, not the account
const RESEND_AFTER_MS = 60 * 1000;     // one code a minute, per account

/**
 * A code nobody can predict.
 *
 * crypto.randomInt and not Math.random: the second is seeded from the clock
 * and two accounts opened in the same second can be handed the same code.
 */
function newCode() {
  const top = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, top)).padStart(CODE_LENGTH, '0');
}

// ── What may be typed in ──────────────────────────────
// Stricter than the quote page's, which is taking a lead and can afford to
// be generous. This one opens an account and sends a code to the address, so
// a typo that passes here is a person who cannot sign in.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const emailOf = (v) => String(v === null || v === undefined ? '' : v).trim().toLowerCase().slice(0, 255);
const looksLikeEmail = (v) => EMAIL.test(emailOf(v));

// Eight characters. Long enough to be worth hashing, short enough that
// somebody signs up rather than giving up - and the account holds no money
// and no order of theirs, only three catalogues.
const MIN_PASSWORD = 8;

/** What is wrong with this password, or '' if nothing is. */
function passwordFault(v) {
  const s = String(v === null || v === undefined ? '' : v);
  if (s.length < MIN_PASSWORD) return 'The password needs at least ' + MIN_PASSWORD + ' characters.';
  if (s.length > 200) return 'That password is too long.';
  return '';
}

const text = (v, n) => String(v === null || v === undefined ? '' : v).trim().slice(0, n);

/**
 * Whether a stored code may still be answered, and why not when it may not.
 *
 * Takes the row as it comes out of MySQL. Every "no" is a different sentence
 * on screen, because "that code has expired" and "that code is wrong" send
 * somebody to two different buttons.
 */
function codeState(row, purpose, now) {
  const when = now || Date.now();
  if (!row || !row.otp_hash) return 'none';
  if (purpose && row.otp_purpose !== purpose) return 'none';
  if (!row.otp_expires_at || new Date(row.otp_expires_at).getTime() < when) return 'expired';
  if (Number(row.otp_tries || 0) >= MAX_TRIES) return 'spent';
  return 'live';
}

/** How long is left before another code may be sent, in whole seconds. */
function resendWait(row, now) {
  const when = now || Date.now();
  if (!row || !row.otp_sent_at) return 0;
  const since = when - new Date(row.otp_sent_at).getTime();
  return since >= RESEND_AFTER_MS ? 0 : Math.ceil((RESEND_AFTER_MS - since) / 1000);
}

module.exports = {
  CODE_LENGTH, CODE_LIFE_MS, MAX_TRIES, RESEND_AFTER_MS, MIN_PASSWORD,
  newCode, looksLikeEmail, emailOf, passwordFault, text, codeState, resendWait,
};
