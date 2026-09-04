const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

// Arabella has no department or HOD hierarchy on its users, so there is nobody
// to route a request to. Every request is decided by a SuperAdmin.
function canDecide(user) {
  return !!user && user.role === 'SuperAdmin';
}

const LEAVE_TYPES = {
  full_day: 'Full Day Leave',
  half_day: 'Half Day Leave',
  work_from_home: 'Work From Home',
  extra_working: 'Extra Working',
};

const IST = { timeZone: 'Asia/Kolkata', hour12: true };
const stamp = d => (d ? new Date(d).toLocaleString('en-GB', IST) : '');
const day = d => (d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }) : '');

function shape(r) {
  let dates = [];
  try { dates = r.dates_json ? JSON.parse(r.dates_json) : []; } catch (e) { dates = []; }
  // Rows written before dates_json, if any, still have their range.
  if (!dates.length && r.from_date) dates = [{ date: String(r.from_date).slice(0, 10) }];

  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name || '',
    userEmail: r.user_email || '',
    userRole: r.user_role || '',
    type: r.leave_type,
    typeLabel: LEAVE_TYPES[r.leave_type] || r.leave_type,
    dates,
    days: dates.length,
    hours: dates.reduce((sum, d) => sum + (Number(d.hours) || 0), 0),
    from: day(r.from_date),
    to: day(r.to_date),
    reason: r.reason || '',
    status: r.status,
    approverName: r.approver_name || '',
    approverNote: r.approver_note || '',
    decidedAt: stamp(r.decided_at),
    appliedAt: stamp(r.created_at),
  };
}

const SELECT = `
  SELECT lr.*, u.username AS user_name, u.email AS user_email, u.role AS user_role,
         ap.username AS approver_name
    FROM leave_requests lr
    JOIN users u  ON u.id = lr.user_id
    LEFT JOIN users ap ON ap.id = lr.approver_id
`;

// GET /api/leaves?scope=mine|all&status=
// "all" is only worth anything to whoever decides them; for everyone else it
// returns their own, so the page cannot leak the rest by asking nicely.
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const all = req.query.scope === 'all' && canDecide(user);

    const where = ['1=1'];
    const params = [];
    if (!all) { where.push('lr.user_id = ?'); params.push(user.id); }
    if (req.query.status) { where.push('lr.status = ?'); params.push(req.query.status); }

    const [rows] = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY lr.created_at DESC LIMIT 500`,
      params
    );
    res.json({ success: true, data: rows.map(shape), canDecide: canDecide(user) });
  } catch (err) {
    console.error('Leave list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/leaves/pending-count — for the badge on the tab.
router.get('/pending-count', requireLogin, async (req, res) => {
  try {
    if (!canDecide(req.session.user)) return res.json({ success: true, count: 0 });
    const [[r]] = await db.query(
      "SELECT COUNT(*) AS c FROM leave_requests WHERE status = 'pending'"
    );
    res.json({ success: true, count: r.c });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leaves — apply.
router.post('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const { type, dates, reason } = req.body;

    if (!LEAVE_TYPES[type]) return res.status(400).json({ success: false, error: 'Choose a leave type.' });
    if (!Array.isArray(dates) || !dates.length) {
      return res.status(400).json({ success: false, error: 'Pick at least one date.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, error: 'A reason is required.' });
    }

    // Dates arrive from a calendar the user clicked, but they arrive over HTTP,
    // so they are checked here as well: right shape, no duplicates, in order.
    const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
    const seen = new Set();
    const clean = [];
    for (const entry of dates) {
      const date = typeof entry === 'string' ? entry : entry && entry.date;
      if (!isDate(date)) return res.status(400).json({ success: false, error: 'That is not a valid date.' });
      if (seen.has(date)) continue;
      seen.add(date);

      const item = { date };
      if (type === 'extra_working') {
        const hours = Number(entry && entry.hours);
        if (!hours || hours <= 0 || hours > 24) {
          return res.status(400).json({ success: false, error: `Hours are needed for ${date} (1-24).` });
        }
        item.hours = hours;
      }
      clean.push(item);
    }
    clean.sort((a, b) => a.date.localeCompare(b.date));

    await db.query(
      `INSERT INTO leave_requests (user_id, leave_type, dates_json, from_date, to_date, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, type, JSON.stringify(clean), clean[0].date, clean[clean.length - 1].date, String(reason).trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Leave create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/leaves/:id — approve or reject.
router.put('/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (!canDecide(user)) return res.status(403).json({ success: false, error: 'Only a SuperAdmin can decide leave.' });

    const { action, note } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Approve or reject.' });
    }

    const [[lr]] = await db.query('SELECT id, status FROM leave_requests WHERE id = ?', [req.params.id]);
    if (!lr) return res.status(404).json({ success: false, error: 'Request not found.' });
    if (lr.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Already ${lr.status}.` });
    }

    await db.query(
      `UPDATE leave_requests SET status = ?, approver_id = ?, approver_note = ?, decided_at = NOW()
       WHERE id = ?`,
      [action === 'approve' ? 'approved' : 'rejected', user.id, (note || '').trim() || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Leave decision failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/leaves/:id — withdraw. Your own, while it is still pending; a
// SuperAdmin can remove any.
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const [[lr]] = await db.query('SELECT id, user_id, status FROM leave_requests WHERE id = ?', [req.params.id]);
    if (!lr) return res.status(404).json({ success: false, error: 'Request not found.' });

    const mine = lr.user_id === user.id && lr.status === 'pending';
    if (!mine && !canDecide(user)) {
      return res.status(403).json({ success: false, error: 'You cannot withdraw this request.' });
    }

    await db.query('DELETE FROM leave_requests WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Leave delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
