const { sendMail } = require('./mailer');

// ══════════════════════════════════════════════════════
// RECRUITMENT LETTERS
//
// What a candidate receives: the interview invitation, a new time when it
// moves, the outcome either way, and the onboarding form once they are in.
//
// These go to people outside the company — often the first thing they ever see
// of Arabella — so they say what is happening, when, and what to do next, and
// nothing else. The chrome is the same dark header and orange rule as the
// dispatch and assignment notices in notify.js, so a candidate's letter and a
// colleague's notice look like one company wrote them.
//
// The markup is deliberately old-fashioned — nested tables, inline styles, no
// flexbox, no <style> block. Outlook renders HTML through Word and drops most
// modern CSS; tables and inline attributes are the only things every mail
// client agrees on.
// ══════════════════════════════════════════════════════

const FONT = 'Segoe UI,Helvetica,Arial,sans-serif';

/**
 * The office, as every candidate is told it.
 *
 * Standing text, not something typed into the Notes box per candidate. It is
 * the same address every time, and retyping it is exactly how a line meant for
 * one person on one day — "ask for so-and-so at reception" — ends up in
 * somebody else's letter months later. A candidate's letter should name the
 * company and nobody inside it.
 *
 * Filling these in is the only change needed: the "Where to come" block then
 * appears in the interview and reschedule letters. Left empty, the letters
 * read exactly as they did before it existed.
 *
 *   address: the building, floor and locality, one line per line
 *   map:     a Google Maps share link, or blank for no map button
 */
const OFFICE = {
  address: 'Arabella Papers Pvt. Ltd.\nG1-592, RIICO Industrial Area, Sitapura\nJaipur 302022',
  map: 'https://maps.app.goo.gl/PK9DVNy3AmncHHYP6',
};

// Everything below builds HTML out of what somebody typed into a form. A stray
// < or & in a name or a note would otherwise swallow the rest of the letter.
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// "2026-10-02" → "02 October 2026". A candidate should not have to read a date
// backwards, and an ISO string in a letter looks like a machine wrote it.
function longDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

// "14:30" → "2:30 PM". Anything it cannot read comes back untouched rather
// than becoming "Invalid Date" in somebody's inbox.
function niceTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return String(t || '');
  let h = Number(m[1]);
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

const para = (html) =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:14.5px;line-height:1.65;color:#495057;">${html}</p>`;

// A map link is the main thing that gets pasted into the notes box, and a link
// nobody can tap is no use to somebody reading this on a phone on their way
// over. Run after escaping, so the only markup in the block is the anchor this
// adds. Trailing punctuation is pushed back out of the href — a link at the
// end of a sentence should not carry the full stop into the URL.
function linkify(escaped) {
  return escaped.replace(/\b(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (url) => {
    const tail = (url.match(/[.,;:!?)]+$/) || [''])[0];
    const bare = url.slice(0, url.length - tail.length);
    const href = /^www\./i.test(bare) ? 'https://' + bare : bare;
    return `<a href="${href}" target="_blank" style="color:#0d6efd;text-decoration:underline;">${bare}</a>${tail}`;
  });
}

// The note the office typed, shown to the candidate and to nobody else. It is
// the part of the letter actually about them — the address, which floor, the
// map link — so it is set apart from the template text a machine wrote.
function note(text) {
  const t = String(text === null || text === undefined ? '' : text).trim();
  if (!t) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
    <tr><td style="background:#f8f9fa;border-left:3px solid #ffa500;border-radius:0 6px 6px 0;padding:13px 16px;
      font-family:${FONT};font-size:14.5px;line-height:1.6;color:#495057;">${linkify(esc(t)).replace(/\r?\n/g, '<br>')}</td></tr></table>`;
}

/**
 * Where the interview is held — the same block in every letter that needs it.
 *
 * Set apart from the paragraphs, because it is the one thing in the letter
 * somebody will come back to on their phone on the way over, and a map link
 * they can tap beats an address they have to copy out.
 */
function whereToCome() {
  const lines = String(OFFICE.address || '').split('\n')
    .map(l => esc(l.trim())).filter(Boolean).join('<br>');
  if (!lines) return '';
  const map = OFFICE.map
    ? `<div style="margin-top:10px"><a href="${esc(OFFICE.map)}" target="_blank"
         style="font-family:${FONT};font-size:13.5px;font-weight:600;color:#0d6efd;text-decoration:underline">
         Open in Google Maps</a></div>`
    : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
    <tr><td style="background:#f8f9fa;border-left:3px solid #ffa500;border-radius:0 6px 6px 0;padding:14px 16px;">
      <div style="font-family:${FONT};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#6c757d;margin-bottom:7px;">Where to come</div>
      <div style="font-family:${FONT};font-size:14.5px;line-height:1.6;color:#212529;font-weight:600;">${lines}</div>
      ${map}
    </td></tr></table>`;
}

// [label, value] pairs, the values already escaped. An empty one drops out
// entirely, so a candidate with no position on file gets no blank "Position"
// line staring back at them.
function detail(rows) {
  const cells = rows
    .filter(([, v]) => String(v === null || v === undefined ? '' : v).trim() !== '')
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 16px 8px 0;color:#6c757d;font-size:13px;font-family:${FONT};white-space:nowrap;vertical-align:top;">${k}</td>
        <td style="padding:8px 0;color:#212529;font-size:14px;font-family:${FONT};font-weight:600;">${v}</td>
      </tr>`).join('');
  if (!cells) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
    style="border-collapse:collapse;border-top:1px solid #e9ecef;border-bottom:1px solid #e9ecef;margin:4px 0 18px;">${cells}</table>`;
}

// The grey line a mail client shows after the subject. Without it clients grab
// the first words of the body, which here would be "Dear <name>," on every
// single letter and tell the reader nothing.
const preheader = (text) =>
  `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
  `${esc(text)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`;

/**
 * The shared chrome. Only `body` changes from letter to letter.
 *
 * `footer` has no default on purpose. Half of these letters ask the candidate
 * to reply and the other half do not, and the standing "do not reply to this
 * message" the rest of the app's mail carries would make a nonsense of the
 * first half.
 */
function shell({ head, eyebrow, body, footer }) {
  return `${preheader(head)}
  <div style="background:#f4f5f7;padding:24px 12px;font-family:${FONT};">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8eb;">
      <div style="background:#212529;padding:22px 24px;">
        <div style="color:#ffa500;font-size:17px;font-weight:700;letter-spacing:.5px;">ARABELLA PAPERS</div>
        ${eyebrow ? `<div style="color:#adb5bd;font-size:11px;letter-spacing:1.2px;margin-top:5px;">${esc(eyebrow)}</div>` : ''}
      </div>
      <div style="padding:24px;">${body}</div>
      <div style="background:#f8f9fa;padding:14px 24px;border-top:1px solid #e9ecef;">
        <p style="margin:0;font-size:11px;color:#adb5bd;line-height:1.5;">${esc(footer)}</p>
      </div>
    </div>
  </div>`;
}

const FOOTER_CANDIDATE = 'Sent by the Arabella Papers HR team. You can reply to this email.';
const FOOTER_INTERNAL = 'Sent by Arabella Papers Recruitment.';

/**
 * A plain-text twin of every letter. Some clients never render HTML, and the
 * candidate reading the fallback still needs the date and the link.
 *
 * Blocks have to become line breaks before the tags go, or every paragraph
 * runs into the next — "Dear Asha,Thank you for your interest" — and the
 * detail table collapses into a ribbon of stray spaces.
 */
function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li)>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>\s*<td[^>]*>/gi, ': ')   // label cell, value cell → "Label: value"
    .replace(/<\/table>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    // Undo the escaping the HTML needed, or a note with an & in it reaches the
    // candidate reading the fallback as "&amp;".
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── The letters ───────────────────────────────────────

// The company is telling the candidate what has been arranged, not asking them
// for a favour: the slot is booked and the interviewer has been told. So the
// interview has been scheduled, here is when, tell us if you cannot make it.
function buildInterviewEmail(c) {
  const when = [longDate(c.interview_date), niceTime(c.interview_time)].filter(Boolean).join(', ');
  const body = para(`Dear ${esc(c.name)},`)
    + para(`Thank you for your interest in Arabella Papers. Your interview${c.profile_position ? ` for the role of <b>${esc(c.profile_position)}</b>` : ''} has been scheduled. The details are below.`)
    + detail([['Date &amp; time', esc(when)], ['Position', esc(c.profile_position)]])
    + whereToCome()
    + note(c.notes)
    + para(OFFICE.address
      ? 'Please arrive a few minutes early.'
      : 'The interview is held at our office. Please arrive a few minutes early.')
    + para('If you cannot make this time, reply to this email and we will arrange another.')
    + para('We look forward to meeting you.');
  return {
    subject: `Interview scheduled${c.profile_position ? ` — ${c.profile_position}` : ''}`,
    html: shell({ head: `Interview scheduled${when ? ' — ' + when : ''}`, eyebrow: 'INTERVIEW SCHEDULED', body, footer: FOOTER_CANDIDATE }),
    text: stripTags(body),
  };
}

function buildRescheduleEmail(c) {
  const when = [longDate(c.reschedule_date || c.interview_date), niceTime(c.reschedule_time || c.interview_time)]
    .filter(Boolean).join(', ');
  const body = para(`Dear ${esc(c.name)},`)
    + para('Your interview has been moved. The new time is below; everything else is unchanged.')
    + detail([['New date &amp; time', esc(when)], ['Position', esc(c.profile_position)],
              ['Reason', esc(c.reschedule_reason)]])
    // Repeated here rather than left to the first letter: somebody reading
    // "your interview has moved" on the day should not have to go hunting up
    // the thread for the address.
    + whereToCome()
    + note(c.notes)
    + para('Apologies for the change, and thank you for your patience.');
  return {
    subject: 'Your interview has been rescheduled',
    html: shell({ head: `Interview moved${when ? ' to ' + when : ''}`, eyebrow: 'INTERVIEW RESCHEDULED', body, footer: FOOTER_CANDIDATE }),
    text: stripTags(body),
  };
}

function buildSelectedEmail(c) {
  const body = para(`Dear ${esc(c.name)},`)
    + para(`We are glad to tell you that you have been selected${c.profile_position ? ` for the role of <b>${esc(c.profile_position)}</b>` : ''} at Arabella Papers.`)
    + detail([['Position', esc(c.profile_position)], ['Expected joining', esc(longDate(c.joining_date))]])
    + para('We will follow up shortly with the next steps. If you have any questions in the meantime, simply reply to this email.')
    + para('Congratulations, and welcome.');
  return {
    subject: `Congratulations — you have been selected${c.profile_position ? ` for ${c.profile_position}` : ''}`,
    html: shell({ head: 'You have been selected', eyebrow: 'SELECTED', body, footer: FOOTER_CANDIDATE }),
    text: stripTags(body),
  };
}

// Short, and without false comfort. The one thing it must do is close the
// loop, because the worst outcome for a candidate is never being told.
function buildRejectedEmail(c) {
  const body = para(`Dear ${esc(c.name)},`)
    + para(`Thank you for taking the time to speak with us${c.profile_position ? ` about the ${esc(c.profile_position)} role` : ''}.`)
    + para('After careful consideration we have decided not to proceed on this occasion. This is not a reflection of your ability, and we would be glad to hear from you about future openings.')
    + para('We wish you the very best.');
  return {
    subject: 'Update on your application',
    html: shell({ head: 'Update on your application', eyebrow: 'APPLICATION UPDATE', body, footer: FOOTER_CANDIDATE }),
    text: stripTags(body),
  };
}

// The interviewer's own letter — not the candidate's. It carries the phone
// number and the email address, which is how whoever is taking the interview
// reaches them if something changes on the day.
//
// The notes box is deliberately absent. What gets typed there is written for
// the candidate — which floor, what to bring — so it belongs in their letter,
// and repeating it here only pads a page somebody is skimming for a number.
function buildInterviewerEmail(c) {
  const when = [longDate(c.reschedule_date || c.interview_date),
                niceTime(c.reschedule_time || c.interview_time)].filter(Boolean).join(', ');
  const body = para('Hello,')
    + para(`An interview has been scheduled with <b>${esc(c.name)}</b>${c.profile_position ? ` for the ${esc(c.profile_position)} role` : ''}.`)
    + detail([
        ['Candidate', esc(c.name)],
        ['Position', esc(c.profile_position)],
        ['Date &amp; time', esc(when)],
        ['Candidate phone', esc(c.phone)],
        ['Candidate email', esc(c.email)],
      ])
    + para('The candidate has been sent the date and time separately.');
  return {
    subject: `Interview scheduled — ${c.name}${c.profile_position ? ` (${c.profile_position})` : ''}`,
    html: shell({ head: `Interview with ${c.name}${when ? ' — ' + when : ''}`, eyebrow: 'INTERVIEW SCHEDULED', body, footer: FOOTER_INTERNAL }),
    text: stripTags(body),
  };
}

// Sent once a candidate is selected: the link to the form where they hand over
// what the office needs before they can start. The link is the whole point of
// the letter, so it is a button as well as a line of text — a plain URL in a
// mail app is easy to miss and easier to mistype.
//
// It lists what will be asked for, because somebody who knows they need their
// Aadhaar to hand fills the form in once instead of abandoning it halfway.
function buildOnboardingEmail(c, url) {
  const body = para(`Dear ${esc(c.name)},`)
    + para('Welcome aboard. Before your first day we need a few details from you — please fill in this short form:')
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 18px;">
        <tr><td bgcolor="#ffa500" style="border-radius:6px;">
          <a href="${esc(url)}" target="_blank" style="display:inline-block;padding:12px 26px;font-family:${FONT};
             font-size:14px;font-weight:700;color:#212529;text-decoration:none;border-radius:6px;">Open the form</a>
        </td></tr></table>`
    + para(`<span style="font-size:12.5px;color:#868e96;">If the button does not work, paste this into your browser:<br>
        <a href="${esc(url)}" style="color:#0d6efd;">${esc(url)}</a></span>`)
    + para('Keep these ready before you start:')
    + `<ul style="margin:0 0 16px 18px;padding:0;font-family:${FONT};font-size:14.5px;line-height:1.8;color:#495057;">
        <li>Your mobile number, email and date of birth</li>
        <li>Two family contacts — name, relation and mobile number</li>
        <li>Your home address</li>
        <li>Your CV — PDF or Word</li>
        <li>Aadhaar card — one PDF, or photos of the front and back</li>
        <li>PAN card, if you have one — same again</li>
      </ul>`
    + para('The link is yours alone, so please do not forward it. If anything is unclear, simply reply to this email.');
  return {
    subject: 'Your joining details form — Arabella Papers',
    html: shell({ head: 'A few details before your first day', eyebrow: 'ONBOARDING', body, footer: FOOTER_CANDIDATE }),
    text: stripTags(body),
  };
}

const BUILDERS = {
  interview: buildInterviewEmail,
  rescheduled: buildRescheduleEmail,
  selected: buildSelectedEmail,
  rejected: buildRejectedEmail,
};

/**
 * utils/mailer.js answers {sent, skipped, error}; the message log wants to
 * know which letter it was as well, so every send comes back the same shape
 * with the subject attached. A log row that cannot say what failed is not
 * much of a log.
 */
function report(result, subject) {
  if (result.sent) return { ok: true, subject };
  return { ok: false, subject, reason: result.error || result.skipped || 'not sent' };
}

/**
 * Build and send in one step, reporting what happened rather than throwing, so
 * the caller can record a failure against the candidate instead of losing the
 * whole request to it.
 *
 * @returns {Promise<{ok: boolean, reason?: string, subject: string}>}
 */
async function sendToCandidate(kind, candidate) {
  const build = BUILDERS[kind];
  if (!build) return { ok: false, reason: 'unknown letter: ' + kind, subject: '' };
  const { subject, html, text } = build(candidate);
  if (!candidate.email) return { ok: false, reason: 'candidate has no email address', subject };
  return report(await sendMail({ to: candidate.email, subject, html, text }), subject);
}

// Its own path rather than a `kind`, because the address it goes to is a
// different one.
async function sendToInterviewer(candidate) {
  const { subject, html, text } = buildInterviewerEmail(candidate);
  if (!candidate.interviewer_email) return { ok: false, reason: 'no interviewer email', subject };
  return report(await sendMail({ to: candidate.interviewer_email, subject, html, text }), subject);
}

// Its own path again: this one needs the form's address, and the four
// candidate letters need nothing but the candidate.
async function sendOnboardingForm(candidate, url) {
  const { subject, html, text } = buildOnboardingEmail(candidate, url);
  if (!candidate.email) return { ok: false, reason: 'candidate has no email address', subject };
  return report(await sendMail({ to: candidate.email, subject, html, text }), subject);
}

module.exports = {
  sendToCandidate, sendToInterviewer, sendOnboardingForm,
  // The builders are exported as well as the senders so a letter can be looked
  // at without one being posted to anybody.
  BUILDERS, buildInterviewEmail, buildInterviewerEmail, buildOnboardingEmail,
  longDate, niceTime,
};
