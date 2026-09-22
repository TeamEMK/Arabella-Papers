const crypto = require('crypto');
const db = require('../config/db');
const recruitEmail = require('./recruitEmail');

// ══════════════════════════════════════════════════════
// THE ONBOARDING FORM — the link, and the letter that carries it
//
// Shared by both halves of the feature: routes/api/recruitment.js sends the
// form when somebody is selected, and routes/api/joining.js reads the token
// back when they open it. Keeping the token logic here is what stops those two
// files having to require each other.
// ══════════════════════════════════════════════════════

// The five documents asked for. One list, used by the form, the submission,
// the detail panel and the download route — four places that would otherwise
// each carry their own copy and drift apart.
const FILE_FIELDS = ['resume_file', 'aadhaar_file', 'aadhaar_file_2', 'pan_file', 'pan_file_2'];

const clean = (v, max = 255) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);

/**
 * The link a candidate is sent.
 *
 * Built from APP_URL so the address works from wherever they open their mail,
 * not only from inside the office. Point it at a host that actually serves
 * /join.html or the candidate gets a 404 instead of a form.
 */
function formUrl(token) {
  const base = (process.env.APP_URL || 'https://mis.arabellapapers.com').replace(/\/+$/, '');
  return `${base}/join.html?t=${token}`;
}

/**
 * One token per candidate, made the first time it is needed and kept after —
 * so a form emailed twice is the same form, not two of them, and the answers
 * already sent back still belong to it.
 */
async function ensureToken(candidate) {
  if (candidate.joining_form_token) return candidate.joining_form_token;
  const token = crypto.randomBytes(24).toString('hex');
  await db.query('UPDATE recruit_candidates SET joining_form_token = ? WHERE id = ?', [token, candidate.id]);
  candidate.joining_form_token = token;
  return token;
}

/**
 * Record what was sent, or why it was not.
 *
 * Never throws: a failure to write the log must not take down the action it
 * was describing. Exported because the status and interview letters are
 * logged the same way.
 */
async function logMessage(candidate, action, result) {
  try {
    await db.query(
      `INSERT INTO recruit_messages
         (candidate_id, candidate_name, email, action, subject, status, error_detail)
       VALUES (?,?,?,?,?,?,?)`,
      [candidate.id || null, clean(candidate.name), clean(candidate.email), clean(action),
       clean(result && result.subject, 500), result && result.ok ? 'Sent' : 'Failed',
       result && result.ok ? null : clean(result && result.reason, 1000)],
    );
  } catch (err) {
    console.error('Could not write recruit_messages:', err.message);
  }
}

/**
 * Send the onboarding form, and write it down beside the interview letters so
 * one screen answers "what has this candidate been sent".
 *
 * joining_form_sent_at is only stamped when the letter actually went. The
 * column is what the portal reads to say "sent 9 days ago and still nothing
 * back", and a date recorded against a letter that bounced would have the
 * office chasing somebody who was never written to.
 */
async function mailForm(candidate) {
  const token = await ensureToken(candidate);
  const result = await recruitEmail.sendOnboardingForm(candidate, formUrl(token))
    .catch(err => ({ ok: false, reason: err.message }));
  await logMessage(candidate, 'Onboarding form', result);
  if (result.ok) {
    await db.query('UPDATE recruit_candidates SET joining_form_sent_at = NOW() WHERE id = ?', [candidate.id]);
  }
  return result;
}

module.exports = { FILE_FIELDS, formUrl, ensureToken, logMessage, mailForm };
