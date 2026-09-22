const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../../config/db');
const { FILE_FIELDS } = require('../../utils/joiningForm');
const { uploadPrivateToDrive, deleteFromDrive } = require('../../utils/drive');

// ══════════════════════════════════════════════════════
// THE ONBOARDING FORM (/api/joining/*) — no login
//
// Once a candidate is selected they are emailed a link to a form asking for
// what the office needs before their first day: how to reach them, who to call
// if something happens, where they live, and their documents.
//
// Whoever fills it in has no account here, so the link is the credential: a
// long random token, one per candidate, that opens their form and nothing
// else. It is checked on both requests — reading the form, and submitting it.
//
// This router is mounted outside requireLogin on purpose. The admin half —
// sending the form, reading the answers, opening the documents — is in
// routes/api/recruitment.js and stays behind the login.
// ══════════════════════════════════════════════════════

// Held in memory and sent on to Drive only once the whole submission has
// passed, so a rejected form leaves no half-uploaded documents behind.
//
// 4MB a file rather than the 12MB the source portal allowed: this app runs as
// a serverless function, and the platform refuses a request body much past
// four and a half megabytes before any of this code runs. The form shrinks
// photographs in the browser first, so what actually arrives is a few hundred
// kilobytes each — the headroom is for a scanned PDF, which cannot be shrunk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 5 },
}).fields(FILE_FIELDS.map(name => ({ name, maxCount: 1 })));

// Multer's own errors are caught here rather than left to the app-wide handler
// in server.js, which speaks about design files and would tell a new hire
// about a limit that is not the one they hit.
function receive(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'One of those files is too large — up to 4 MB each. A photo of the card is usually enough.' });
    }
    console.error('Joining upload failed:', err);
    return res.status(400).json({ success: false, error: 'Those files could not be read. Please try again.' });
  });
}

// A CV is a document; an ID card is usually a photograph of one. Anything else
// is refused rather than stored — these are opened by people, not a sandbox.
const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/heic', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const clean = (v, max = 255) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);
const digits = (v, max = 20) => String(v === null || v === undefined ? '' : v).replace(/\D/g, '').slice(0, max);
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);

async function byToken(token) {
  const t = String(token || '').trim();
  // Checked before it reaches the database: the token is the only thing
  // standing between a stranger and somebody's Aadhaar, so anything that is
  // not one of ours is refused on sight.
  if (!/^[a-f0-9]{16,64}$/i.test(t)) return null;
  const [[row]] = await db.query(
    'SELECT * FROM recruit_candidates WHERE joining_form_token = ? AND is_deleted = 0 LIMIT 1', [t]);
  return row || null;
}

// What the form needs to greet somebody by name and fill in what is already
// known. Nothing sensitive: their own name, role and contact details.
router.get('/:token', async (req, res) => {
  try {
    const c = await byToken(req.params.token);
    if (!c) return res.status(404).json({ success: false, error: 'This link is not valid. Ask us to send the form again.' });
    const [[done]] = await db.query('SELECT submitted_at FROM recruit_joining WHERE candidate_id = ?', [c.id]);
    res.json({
      success: true,
      data: {
        name: c.name,
        position: c.profile_position || '',
        email: c.email || '',
        phone: c.phone || '',
        submitted: !!done,
      },
    });
  } catch (err) {
    console.error('Joining form open failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong at our end. Please try again.' });
  }
});

router.post('/:token', receive, async (req, res) => {
  try {
    const c = await byToken(req.params.token);
    if (!c) return res.status(404).json({ success: false, error: 'This link is not valid. Ask us to send the form again.' });

    const b = req.body || {};
    const files = req.files || {};
    const [[existing]] = await db.query('SELECT * FROM recruit_joining WHERE candidate_id = ?', [c.id]);

    const d = {
      full_name: clean(b.full_name),
      emp_mobile: digits(b.emp_mobile),
      email: clean(b.email).toLowerCase(),
      dob: dateOrNull(b.dob),
      guardian1_name: clean(b.guardian1_name),
      guardian1_relation: clean(b.guardian1_relation, 100),
      guardian1_mobile: digits(b.guardian1_mobile),
      guardian2_name: clean(b.guardian2_name),
      guardian2_relation: clean(b.guardian2_relation, 100),
      guardian2_mobile: digits(b.guardian2_mobile),
      street: clean(b.street, 500),
      city: clean(b.city),
      state: clean(b.state),
      pincode: digits(b.pincode, 10),
      aadhaar_no: digits(b.aadhaar_no, 12),
      pan_no: clean(b.pan_no, 20).toUpperCase().replace(/\s/g, ''),
    };

    // Checked here as well as in the page. This is the record an employee file
    // is built from, and a submission bounced back while they are still on the
    // form is far cheaper than a wrong record found on their first day.
    const missing = [];
    if (!d.full_name) missing.push('Name');
    if (!looksLikeEmail(d.email)) missing.push('Email');
    if (d.emp_mobile.length !== 10) missing.push('Mobile number (10 digits)');
    if (!d.dob) missing.push('Date of birth');
    if (!d.guardian1_name) missing.push('First contact name');
    if (!d.guardian1_relation) missing.push('First contact relation');
    if (d.guardian1_mobile.length !== 10) missing.push('First contact mobile (10 digits)');
    if (!d.guardian2_name) missing.push('Second contact name');
    if (!d.guardian2_relation) missing.push('Second contact relation');
    if (d.guardian2_mobile.length !== 10) missing.push('Second contact mobile (10 digits)');
    if (!d.street) missing.push('Address');
    if (!d.city) missing.push('City');
    if (d.pincode.length !== 6) missing.push('Pincode (6 digits)');
    if (!files.resume_file && !existing?.resume_file) missing.push('CV');
    if (!files.aadhaar_file && !existing?.aadhaar_file) missing.push('Aadhaar (front side)');
    if (missing.length) {
      return res.status(400).json({ success: false, error: 'Still needed: ' + missing.join(', ') });
    }

    // Three different people, three different numbers — the whole point of an
    // emergency contact is that it rings somewhere else.
    const mobiles = [d.emp_mobile, d.guardian1_mobile, d.guardian2_mobile];
    if (new Set(mobiles).size !== mobiles.length) {
      return res.status(400).json({ success: false, error: 'Your number and both contact numbers must be different.' });
    }
    if (d.aadhaar_no && d.aadhaar_no.length !== 12) {
      return res.status(400).json({ success: false, error: 'An Aadhaar number is 12 digits.' });
    }
    if (d.pan_no && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(d.pan_no)) {
      return res.status(400).json({ success: false, error: 'That PAN does not look right — it reads like ABCDE1234F.' });
    }

    for (const field of FILE_FIELDS) {
      const f = files[field] && files[field][0];
      if (f && !ALLOWED.has(f.mimetype)) {
        return res.status(400).json({ success: false, error: `${f.originalname}: only a PDF, a Word file or a photo (JPG, PNG, HEIC).` });
      }
    }

    // Everything has passed, so the documents can go to Drive — into the
    // private HR folder, never shared, read back only through the download
    // route behind the login. The row keeps the file id, not a link.
    const saved = {};
    const replaced = [];
    for (const field of FILE_FIELDS) {
      const f = files[field] && files[field][0];
      if (!f) { saved[field] = (existing && existing[field]) || ''; continue; }
      saved[field] = await uploadPrivateToDrive(
        f.buffer, `${c.id}-${c.name}-${field}`.replace(/[^\w.-]+/g, '_'), f.mimetype);
      if (existing && existing[field] && existing[field] !== saved[field]) replaced.push(existing[field]);
    }

    // One row per candidate: filling the form in a second time replaces the
    // first answer rather than adding a second nobody knows which to believe.
    const cols = ['candidate_id', ...Object.keys(d), ...FILE_FIELDS];
    const values = [c.id, ...Object.values(d), ...FILE_FIELDS.map(f => saved[f])];
    const overwrite = cols.filter(k => k !== 'candidate_id').map(k => '`' + k + '` = VALUES(`' + k + '`)');
    await db.query(
      `INSERT INTO recruit_joining (${cols.map(k => '`' + k + '`').join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${overwrite.join(', ')}, submitted_at = NOW()`,
      values);

    // Once the row is safely written, and before the reply — not after it.
    // A document nothing points at any more is an Aadhaar scan left in a
    // folder nobody knows to look in, and on a serverless host anything left
    // running past the response is simply never run. deleteFromDrive swallows
    // its own failures, so a file already gone by hand cannot fail the
    // submission that was replacing it.
    for (const fileId of replaced) await deleteFromDrive(fileId);

    res.json({ success: true, data: { name: c.name } });
  } catch (err) {
    console.error('Joining form submit failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Something went wrong at our end. Please try again, or reply to the email that brought you here.' });
    }
  }
});

module.exports = router;
