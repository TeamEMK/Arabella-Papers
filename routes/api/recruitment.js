const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');
const recruitEmail = require('../../utils/recruitEmail');
const { FILE_FIELDS, formUrl, mailForm, logMessage } = require('../../utils/joiningForm');

// ══════════════════════════════════════════════════════
// RECRUITMENT (/api/recruitment/*)
//
// The hiring pipeline: who is being interviewed, what came of it, and every
// letter sent to them along the way. /api/hr next door is the other half —
// people already on the payroll. Somebody who joins moves from this table to
// that one.
//
// A letter that fails is recorded and the request still succeeds. Losing a
// candidate record because an SMTP server was briefly unhappy would be the
// wrong trade, and a silent failure would be worse than either — which is what
// recruit_messages is for.
// ══════════════════════════════════════════════════════

// Candidate records carry mobiles, addresses and identity documents, so the
// section is not on offer to anybody who has no business opening it: the HR
// role, a SuperAdmin, or somebody handed it on the Access Control page.
function canSeeRecruitment(user) {
  return canSee(user, 'recruitment');
}

async function guard(req, res) {
  if (await canSeeRecruitment(req.session.user)) return true;
  res.status(403).json({ success: false, error: 'Unauthorized' });
  return false;
}

const STATUSES = ['Scheduled', 'Rescheduled', 'Selected', 'Rejected', 'Offer Sent'];

// Which letter belongs to which status. A status with no entry sends nothing —
// "Offer Sent" is here as a pipeline stage, and the offer letter itself is not
// part of this section yet.
const LETTER_FOR_STATUS = { Rescheduled: 'rescheduled', Selected: 'selected', Rejected: 'rejected' };

const clean = (v, max = 255) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
// Deliberately forgiving: this only stops obvious typos. A real address that
// trips a stricter pattern would block a hire for no good reason.
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

async function sendAndLog(candidate, kind, action) {
  const result = await recruitEmail.sendToCandidate(kind, candidate)
    .catch(err => ({ ok: false, reason: err.message }));
  await logMessage(candidate, action, result);
  return result;
}

// What a page should say once the letters have gone. Reported honestly:
// "2 sent" when both went, and which one failed when one did.
function mailReport(results) {
  const failed = results.filter(r => r && !r.ok);
  return {
    sent: results.filter(r => r && r.ok).length,
    failed: failed.length,
    reason: failed.length ? failed[0].reason : null,
  };
}

// ── Stats ─────────────────────────────────────────────
router.get('/stats', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const [rows] = await db.query(
      'SELECT status, COUNT(*) AS n FROM recruit_candidates WHERE is_deleted = 0 GROUP BY status');
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of rows) byStatus[r.status] = Number(r.n) || 0;

    const [[upcoming]] = await db.query(
      `SELECT COUNT(*) AS n FROM recruit_candidates
        WHERE is_deleted = 0 AND status IN ('Scheduled','Rescheduled')
          AND COALESCE(reschedule_date, interview_date) >= CURDATE()`);
    const [[failed]] = await db.query(
      "SELECT COUNT(*) AS n FROM recruit_messages WHERE status = 'Failed'");
    // Forms sent and never filled in. The number worth acting on, because each
    // one is somebody to chase before their first day.
    const [[waiting]] = await db.query(
      `SELECT COUNT(*) AS n FROM recruit_candidates c
         LEFT JOIN recruit_joining j ON j.candidate_id = c.id
        WHERE c.is_deleted = 0 AND c.joining_form_sent_at IS NOT NULL AND j.id IS NULL`);

    res.json({
      success: true,
      data: {
        total: rows.reduce((a, r) => a + (Number(r.n) || 0), 0),
        byStatus,
        upcoming: Number(upcoming.n) || 0,
        failedEmails: Number(failed.n) || 0,
        formsWaiting: Number(waiting.n) || 0,
      },
    });
  } catch (err) {
    console.error('Recruitment stats failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── List ──────────────────────────────────────────────
// The dates are formatted in SQL rather than handed over as Date objects: JSON
// turns those into UTC, and an interview at midnight IST comes out as the day
// before.
router.get('/candidates', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const q = clean(req.query.q, 120);
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';

    const where = ['c.is_deleted = 0'];
    const args = [];
    if (q) {
      where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.profile_position LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) { where.push('c.status = ?'); args.push(status); }

    const [rows] = await db.query(
      `SELECT c.id, c.name, c.email, c.phone, c.profile_position, c.interviewer_email,
              c.interview_time, c.reschedule_time, c.reschedule_reason, c.status,
              c.salary, c.notes, u.username AS created_by_name,
              DATE_FORMAT(c.interview_date,  '%Y-%m-%d') AS interview_date,
              DATE_FORMAT(c.reschedule_date, '%Y-%m-%d') AS reschedule_date,
              DATE_FORMAT(c.joining_date,    '%Y-%m-%d') AS joining_date,
              DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i') AS created_at,
              -- Where the onboarding form has got to, so the row can say so
              -- without a request per candidate.
              DATE_FORMAT(c.joining_form_sent_at, '%Y-%m-%d %H:%i') AS joining_form_sent_at,
              DATE_FORMAT(j.submitted_at, '%Y-%m-%d %H:%i') AS joining_submitted_at
         FROM recruit_candidates c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN recruit_joining j ON j.candidate_id = c.id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(c.reschedule_date, c.interview_date) DESC, c.id DESC
        LIMIT 500`, args);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Recruitment list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Create ────────────────────────────────────────────
router.post('/candidates', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const b = req.body || {};
    const name = clean(b.name);
    const email = clean(b.email);
    if (!name) return res.status(400).json({ success: false, error: 'Name is required.' });
    if (!looksLikeEmail(email)) {
      return res.status(400).json({ success: false, error: 'A valid email address is required — the invitation is sent there.' });
    }

    const candidate = {
      name,
      email,
      phone: clean(b.phone, 50),
      profile_position: clean(b.profile_position),
      interviewer_email: clean(b.interviewer_email),
      interview_date: dateOrNull(b.interview_date),
      interview_time: clean(b.interview_time, 20),
      salary: clean(b.salary, 100),
      notes: clean(b.notes, 5000),
    };

    // A second Save while the first is still sending arrives here as its own
    // request, and used to become a second candidate and a second set of
    // letters. The same person, for the same interview, seconds apart is never
    // two bookings — it is one impatient click. Re-adding somebody weeks later
    // for another role still works, which is why this is time-boxed rather
    // than a unique index on the address.
    const [[again]] = await db.query(
      `SELECT id FROM recruit_candidates
        WHERE email = ? AND interview_date <=> ?
          AND created_at > (NOW() - INTERVAL 3 MINUTE)
        ORDER BY id DESC LIMIT 1`,
      [candidate.email, candidate.interview_date]);
    if (again) return res.json({ success: true, data: { id: again.id, duplicate: true } });

    const [result] = await db.query(
      `INSERT INTO recruit_candidates
         (name, email, phone, profile_position, interviewer_email,
          interview_date, interview_time, salary, notes, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?, 'Scheduled', ?)`,
      [candidate.name, candidate.email, candidate.phone, candidate.profile_position,
       candidate.interviewer_email, candidate.interview_date, candidate.interview_time,
       candidate.salary, candidate.notes, req.session.user.id]);
    candidate.id = result.insertId;

    // The invitation goes only when there is a time to invite them to: a
    // record created to be filled in later should not email somebody an empty
    // date.
    const invite = b.sendEmail !== false && !!candidate.interview_date;
    // The interviewer is told separately. Their letter is not the candidate's
    // — it carries the phone number, which the candidate should not be sent
    // back — and it is worth sending even when the candidate's fails.
    const tellInterviewer = invite && looksLikeEmail(candidate.interviewer_email);

    // The letters are sent before the reply, not after it.
    //
    // The portal this came from replied first and sent afterwards, because
    // SMTP takes a few seconds and the dialog looked frozen. That works on a
    // long-lived server; here the app runs as a Vercel function, which is
    // frozen the moment the response is flushed, and a letter still in flight
    // at that point is simply never sent. So the wait is on the dialog, which
    // says "Sending…" and refuses a second click, and the reply can report
    // truthfully what actually happened rather than what was started.
    const letters = [];
    if (invite) {
      letters.push(await sendAndLog(candidate, 'interview', 'Interview invitation'));
      if (tellInterviewer) {
        const toInterviewer = await recruitEmail.sendToInterviewer(candidate)
          .catch(err => ({ ok: false, reason: err.message }));
        await logMessage(
          { ...candidate, name: 'Interviewer', email: candidate.interviewer_email },
          'Interviewer notified', toInterviewer);
        letters.push(toInterviewer);
      }
    }

    res.json({ success: true, data: { id: candidate.id, mail: mailReport(letters) } });
  } catch (err) {
    console.error('Recruitment create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Update ────────────────────────────────────────────
// Editing never emails anybody. Correcting a spelling should not re-invite
// somebody to an interview they already know about.
router.put('/candidates/:id', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const id = parseInt(req.params.id, 10);
    const [[existing]] = await db.query(
      'SELECT * FROM recruit_candidates WHERE id = ? AND is_deleted = 0', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Candidate not found.' });

    const b = req.body || {};
    const name = clean(b.name) || existing.name;
    const email = clean(b.email) || existing.email;
    if (!looksLikeEmail(email)) {
      return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }

    await db.query(
      `UPDATE recruit_candidates
          SET name = ?, email = ?, phone = ?, profile_position = ?, interviewer_email = ?,
              interview_date = ?, interview_time = ?, salary = ?, notes = ?, joining_date = ?
        WHERE id = ?`,
      [name, email, clean(b.phone, 50), clean(b.profile_position), clean(b.interviewer_email),
       dateOrNull(b.interview_date), clean(b.interview_time, 20), clean(b.salary, 100),
       clean(b.notes, 5000), dateOrNull(b.joining_date), id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Recruitment update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Status ────────────────────────────────────────────
// The one action that writes to a candidate, so it is its own endpoint rather
// than a field on the edit form: changing somebody's status is a decision, and
// a stray keystroke should not tell a candidate they were rejected.
router.put('/candidates/:id/status', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const id = parseInt(req.params.id, 10);
    const status = clean(req.body && req.body.status, 20);
    if (!STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Unknown status.' });

    const [[c]] = await db.query('SELECT * FROM recruit_candidates WHERE id = ? AND is_deleted = 0', [id]);
    if (!c) return res.status(404).json({ success: false, error: 'Candidate not found.' });

    const b = req.body || {};
    const fields = { status };
    if (status === 'Rescheduled') {
      fields.reschedule_date = dateOrNull(b.reschedule_date);
      fields.reschedule_time = clean(b.reschedule_time, 20);
      fields.reschedule_reason = clean(b.reschedule_reason, 2000);
      if (!fields.reschedule_date) {
        return res.status(400).json({ success: false, error: 'A new interview date is required to reschedule.' });
      }
    }
    if (status === 'Selected') fields.joining_date = dateOrNull(b.joining_date);

    const cols = Object.keys(fields);
    await db.query(
      `UPDATE recruit_candidates SET ${cols.map(k => '`' + k + '` = ?').join(', ')} WHERE id = ?`,
      [...cols.map(k => fields[k]), id]);

    const updated = { ...c, ...fields };
    const action = `Status → ${status}`;

    // The same double click, one screen along. Here the row may legitimately
    // be saved again — a reschedule that moves twice — so what is guarded is
    // the letter rather than the update: an identical one sent moments ago is
    // a repeat, not a second decision.
    const [[justSent]] = await db.query(
      `SELECT id FROM recruit_messages
        WHERE candidate_id = ? AND action = ? AND status = 'Sent'
          AND created_at > (NOW() - INTERVAL 2 MINUTE) LIMIT 1`,
      [id, action]);

    const kind = LETTER_FOR_STATUS[status];
    const letters = [];
    if (kind && b.sendEmail !== false && !justSent) {
      letters.push(await sendAndLog(updated, kind, action));
    }

    // Being selected is the moment the onboarding form is due, so it follows
    // the congratulations rather than waiting for somebody to remember. Sent
    // once: if it has gone before, or they have already filled it in, the
    // button on the candidate's row sends it again deliberately.
    let formSent = null;
    if (status === 'Selected' && b.sendEmail !== false && !c.joining_form_sent_at) {
      const [[done]] = await db.query('SELECT id FROM recruit_joining WHERE candidate_id = ?', [id]);
      if (!done) formSent = await mailForm({ ...c, ...fields, id });
    }

    res.json({
      success: true,
      data: {
        status,
        duplicate: !!justSent,
        mail: mailReport(letters),
        formSent: formSent ? !!formSent.ok : null,
      },
    });
  } catch (err) {
    console.error('Recruitment status change failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Delete ────────────────────────────────────────────
// Hidden, not erased — the same as a staff record next door. Somebody
// interviewed last spring is exactly the person asked about again in autumn,
// and their sent-mail history stays either way.
router.delete('/candidates/:id', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    await db.query('UPDATE recruit_candidates SET is_deleted = 1 WHERE id = ?', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Recruitment delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Sent mail ─────────────────────────────────────────
router.get('/messages', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const onlyFailed = req.query.failed === '1';
    const [rows] = await db.query(
      `SELECT id, candidate_id, candidate_name, email, action, subject, status, error_detail,
              retry_count, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
         FROM recruit_messages
        ${onlyFailed ? "WHERE status = 'Failed'" : ''}
        ORDER BY id DESC LIMIT 300`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Recruitment message log failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-send a letter that failed. The candidate is read fresh rather than the
// logged copy replayed, so a retry after fixing a typo'd address goes to the
// corrected one.
router.post('/messages/:id/retry', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const [[log]] = await db.query('SELECT * FROM recruit_messages WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (!log) return res.status(404).json({ success: false, error: 'Log entry not found.' });
    const [[c]] = await db.query('SELECT * FROM recruit_candidates WHERE id = ?', [log.candidate_id]);
    if (!c) return res.status(400).json({ success: false, error: 'That candidate no longer exists.' });

    // The onboarding form is its own letter with its own link, so it is sent
    // by its own path rather than rebuilt from the log line.
    let result;
    if (/onboarding/i.test(log.action)) {
      result = await mailForm(c);
    } else {
      const kind = /reschedul/i.test(log.action) ? 'rescheduled'
        : /select/i.test(log.action) ? 'selected'
        : /reject/i.test(log.action) ? 'rejected'
        : 'interview';
      result = await recruitEmail.sendToCandidate(kind, c).catch(err => ({ ok: false, reason: err.message }));
    }

    await db.query(
      `UPDATE recruit_messages
          SET status = ?, error_detail = ?, retry_count = retry_count + 1, last_retry_at = NOW()
        WHERE id = ?`,
      [result.ok ? 'Sent' : 'Failed', result.ok ? null : clean(result.reason, 1000), log.id]);
    res.json({ success: !!result.ok, error: result.ok ? null : (result.reason || 'Still failing.') });
  } catch (err) {
    console.error('Recruitment retry failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/messages/:id', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    await db.query('DELETE FROM recruit_messages WHERE id = ?', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Recruitment log delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// THE ONBOARDING FORM, ADMIN SIDE
// The candidate's own half — opening and submitting the form — is in
// routes/api/joining.js, and is deliberately outside the login.
// ══════════════════════════════════════════════════════

// Send it, or send it again. Kept apart from the status change so a form can
// be re-sent to somebody who lost the email without touching their status.
router.post('/candidates/:id/joining-form', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const [[c]] = await db.query(
      'SELECT * FROM recruit_candidates WHERE id = ? AND is_deleted = 0', [parseInt(req.params.id, 10)]);
    if (!c) return res.status(404).json({ success: false, error: 'Candidate not found.' });
    if (!looksLikeEmail(c.email)) {
      return res.status(400).json({ success: false, error: 'That candidate has no valid email address.' });
    }
    const result = await mailForm(c);
    res.json({ success: !!result.ok, error: result.ok ? null : (result.reason || 'The letter failed — see Sent mail.') });
  } catch (err) {
    console.error('Onboarding form send failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/candidates/:id/joining-details', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    const id = parseInt(req.params.id, 10);
    const [[c]] = await db.query(
      `SELECT id, name, email, joining_form_token,
              DATE_FORMAT(joining_form_sent_at, '%Y-%m-%d %H:%i') AS joining_form_sent_at
         FROM recruit_candidates WHERE id = ? AND is_deleted = 0`, [id]);
    if (!c) return res.status(404).json({ success: false, error: 'Candidate not found.' });

    const [[row]] = await db.query(
      `SELECT *, DATE_FORMAT(dob, '%Y-%m-%d') AS dob,
              DATE_FORMAT(submitted_at, '%Y-%m-%d %H:%i') AS submitted_at
         FROM recruit_joining WHERE candidate_id = ?`, [id]);

    // Which documents actually exist, so the panel shows five buttons or two
    // rather than five with three of them dead. Deliberately without `bytes`:
    // nothing is read out of the database until somebody opens a document.
    const [docs] = await db.query(
      'SELECT field, file_name, mime_type, size_bytes FROM recruit_files WHERE candidate_id = ?', [id]);

    res.json({
      success: true,
      data: {
        id,
        candidate: { id: c.id, name: c.name, email: c.email },
        sent_at: c.joining_form_sent_at,
        link: c.joining_form_token ? formUrl(c.joining_form_token) : null,
        details: row || null,
        files: FILE_FIELDS
          .filter(f => docs.some(doc => doc.field === f))
          .map(f => {
            const doc = docs.find(x => x.field === f);
            return { field: f, name: doc.file_name, size: doc.size_bytes };
          }),
      },
    });
  } catch (err) {
    console.error('Joining details failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// The documents themselves.
//
// Sent through this route rather than linked to, because that is the only way
// the login still applies to them. There is no file on a disk anywhere and no
// URL to guess at: the bytes come out of the database, and only for somebody
// who has this section.
router.get('/joining-file/:id/:field', requireLogin, async (req, res) => {
  try {
    if (!(await guard(req, res))) return;
    // The field name ends up in a query, so it is checked against the list
    // rather than trusted.
    const field = String(req.params.field);
    if (!FILE_FIELDS.includes(field)) return res.status(400).send('Unknown document.');

    const [[doc]] = await db.query(
      'SELECT file_name, mime_type, bytes FROM recruit_files WHERE candidate_id = ? AND field = ?',
      [parseInt(req.params.id, 10), field]);
    if (!doc) return res.status(404).send('Not uploaded.');

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    // Stated rather than left to chunked encoding: a PDF viewer opening this
    // in a tab wants to know how much there is before it starts drawing.
    res.setHeader('Content-Length', doc.bytes.length);
    // Shown in the browser rather than downloaded: whoever opens this is
    // checking an Aadhaar against a form, not collecting files. The name still
    // travels, so a Save As gets something better than a number.
    res.setHeader('Content-Disposition',
      `inline; filename="${String(doc.file_name || field).replace(/[^\w. -]+/g, '_')}"`);
    // Never let a proxy or the browser keep a copy of somebody's ID card.
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(doc.bytes);
  } catch (err) {
    console.error('Joining file read failed:', err);
    res.status(500).send('That document could not be opened.');
  }
});

module.exports = router;
