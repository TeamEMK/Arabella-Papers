// ══════════════════════════════════════════════════════
// A STAFF PASSWORD, RESET BY THE PERSON WHO OWNS IT
//
// Until now there was no way back into an account except asking the
// SuperAdmin to type a new password in. That is a worse thing than it
// sounds: the new password travels over WhatsApp, it is chosen by somebody
// other than its owner, and it is known to two people from the moment it
// exists. Half the office's passwords have been set that way.
//
// So: a six-digit code to the address on the account, typed on the page it
// was asked for.
//
// A CODE, NOT A LINK. A link has to carry the secret in the address bar,
// where it lands in chat windows, in browser history and in whatever reads
// the clipboard. The code is typed on the page the person already has open.
//
// THE PAGE NEVER SAYS WHETHER THE ACCOUNT EXISTS. "If that address has an
// account, a code is on its way" is the answer either way - otherwise this
// form is a way to test which of thirty staff addresses are real, from
// outside, with no login.
//
// What stops the code being guessed: six digits is a million, but a million
// is nothing to a script, so the code dies after five wrong answers and
// after ten minutes, and one address may ask for a code once a minute.
// ══════════════════════════════════════════════════════
const crypto = require('crypto');

const CODE_LENGTH = 6;
const CODE_LIFE_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const RESEND_AFTER_MS = 60 * 1000;

// Eight characters, the same as everywhere else in this app. The rule lives
// in one place so a reset cannot quietly be the weakest way in.
const MIN_PASSWORD = 8;

/**
 * A code nobody can predict.
 *
 * crypto.randomInt and not Math.random: the second is seeded from the clock,
 * and two people asking in the same second can be handed the same code.
 */
function newCode() {
  const top = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, top)).padStart(CODE_LENGTH, '0');
}

const emailOf = (v) => String(v === null || v === undefined ? '' : v)
  .trim().toLowerCase().slice(0, 150);

/** What is wrong with this password, or '' if nothing is. */
function passwordFault(v) {
  const s = String(v === null || v === undefined ? '' : v);
  if (s.length < MIN_PASSWORD) {
    return 'The password needs at least ' + MIN_PASSWORD + ' characters.';
  }
  if (s.length > 200) return 'That password is too long.';
  return '';
}

/**
 * Whether a stored code may still be answered.
 *
 * 'live' | 'spent' (too many wrong answers) | 'none' (expired, used, or
 * never sent). The two are different sentences on screen because they send
 * the person to different places: one asks for a new code, the other says
 * stop guessing.
 */
function codeState(row, now) {
  if (!row || !row.code_hash) return 'none';
  if (Number(row.tries) >= MAX_TRIES) return 'spent';
  if (!row.expires_at || new Date(row.expires_at) <= (now || new Date())) return 'none';
  return 'live';
}

/** Seconds somebody must wait before another code is sent, or 0. */
function resendWait(row, now) {
  if (!row || !row.sent_at) return 0;
  const since = (now || new Date()) - new Date(row.sent_at);
  return since >= RESEND_AFTER_MS ? 0 : Math.ceil((RESEND_AFTER_MS - since) / 1000);
}

function mail(code, name) {
  const who = String(name || '').trim();
  const minutes = Math.round(CODE_LIFE_MS / 60000);
  return {
    subject: 'Your Arabella Papers password code: ' + code,
    text: [
      who ? 'Hello ' + who + ',' : 'Hello,',
      '',
      'Someone asked to set a new password for this account.',
      '',
      'Your code is ' + code,
      'It works for ' + minutes + ' minutes, on the page you asked from.',
      '',
      'If this was not you, nothing has changed and you can ignore this.',
      'Nobody can use the code without it.',
    ].join('\n'),
    html: '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#212529">'
      + '<p>' + (who ? 'Hello ' + esc(who) + ',' : 'Hello,') + '</p>'
      + '<p>Someone asked to set a new password for this account.</p>'
      + '<p style="font-size:30px;font-weight:700;letter-spacing:7px;margin:22px 0">'
      + esc(code) + '</p>'
      + '<p>It works for ' + minutes + ' minutes, on the page you asked from.</p>'
      + '<p style="color:#6c757d;font-size:13px">If this was not you, nothing has '
      + 'changed and you can ignore this. Nobody can use the code without it.</p>'
      + '</div>',
  };
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  newCode, emailOf, passwordFault, codeState, resendWait, mail,
  CODE_LIFE_MS, MAX_TRIES, RESEND_AFTER_MS, MIN_PASSWORD,
};
