const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

// Dates are stored as IST wall-clock and read back through a +05:30
// connection. Vercel runs in UTC, so the zone has to be named here or every
// entry renders 5:30 earlier than it happened.
// Every date the boards show goes through here. 12-hour because that is how
// the office says the time - "18:42" is a moment nobody reads aloud.
const IST = { timeZone: 'Asia/Kolkata', hour12: true };

// The log only grows, so unlike the boards it is never handed over whole.
// Filtering happens in SQL and the answer is capped.
const MAX_ROWS = 500;

// GET /api/logs — who changed what, newest first.
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role || '';
    if (role !== 'SuperAdmin' && user.domain !== 'Head') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const where = [];
    const params = [];

    const orderId = String(req.query.orderId || '').trim();
    if (orderId) {
      where.push('order_id LIKE ?');
      params.push('%' + orderId + '%');
    }

    const changedBy = String(req.query.changedBy || '').trim();
    if (changedBy) {
      where.push('changed_by = ?');
      params.push(changedBy);
    }

    const action = String(req.query.action || '').trim();
    if (action) {
      where.push('action = ?');
      params.push(action);
    }

    // The date inputs send a plain day; compare against the day, not the
    // instant, or an entry made this afternoon falls outside "today to today".
    const from = String(req.query.from || '').trim();
    if (from) {
      where.push('DATE(changed_at) >= ?');
      params.push(from);
    }
    const to = String(req.query.to || '').trim();
    if (to) {
      where.push('DATE(changed_at) <= ?');
      params.push(to);
    }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await db.query(
      `SELECT order_id, action, field, old_value, new_value, changed_by, changed_at
         FROM order_logs
         ${clause}
        ORDER BY id DESC
        LIMIT ${MAX_ROWS}`,
      params
    );

    const [[total]] = await db.query(
      `SELECT COUNT(*) AS c FROM order_logs ${clause}`,
      params
    );

    // Who and what to offer in the filter boxes, from the whole log rather
    // than the page being shown - otherwise the options change as you filter.
    const [people] = await db.query(
      `SELECT DISTINCT changed_by FROM order_logs WHERE IFNULL(changed_by, '') <> '' ORDER BY changed_by`
    );
    const [actions] = await db.query(
      `SELECT DISTINCT action FROM order_logs ORDER BY action`
    );

    res.json({
      success: true,
      data: rows.map(r => ({
        Order_ID: r.order_id,
        Action: r.action,
        Field: r.field || '',
        Old_Value: r.old_value || '',
        New_Value: r.new_value || '',
        Changed_By: r.changed_by || '',
        When: r.changed_at ? new Date(r.changed_at).toLocaleString('en-GB', IST) : '',
      })),
      total: total.c,
      shown: rows.length,
      limit: MAX_ROWS,
      people: people.map(p => p.changed_by),
      actions: actions.map(a => a.action),
    });
  } catch (err) {
    console.error('Logs failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
