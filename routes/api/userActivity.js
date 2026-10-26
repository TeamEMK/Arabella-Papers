const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { rootOrderId } = require('../../utils/remake');

// ══════════════════════════════════════════════════════
// ONE PERSON, EVERYTHING THEY DID
//
// The system keeps two logs and they have never met.
//
//   activity_log  - Login, Logout, Bulk Import. Keyed by EMAIL.
//   order_logs    - who changed which order. Keyed by DISPLAY NAME.
//
// Not one value matches across them: activity_log says
// "ankitsaini@arabellajaipur.com" where order_logs says "Ankit Saini". So
// "what did this person do on Thursday" was a question nobody could answer
// without opening two screens and knowing both of somebody's names. The users
// table is the only thing that knows they are the same person, and that is
// what this joins through.
//
// Reading only. Nothing here writes a log, which would be its own small joke.
// ══════════════════════════════════════════════════════

const MAX_ROWS = 500;

// Same gate as the Logs page. A log of who did what is exactly the thing not
// to hand out widely.
function allowed(user) {
  return (user.role || '') === 'SuperAdmin' || user.domain === 'Head';
}

// GET /api/user-activity/people — who there is to look at.
//
// Driven from the users table rather than from the logs, because the logs
// hold 14 addresses belonging to people who have left and whose rows would
// otherwise fill the list with names nobody recognises.
router.get('/people', requireLogin, async (req, res) => {
  try {
    if (!allowed(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const [rows] = await db.query(
      `SELECT id, username, email, role, domain FROM users ORDER BY username`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('User activity people failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/user-activity?userId=&from=&to=
router.get('/', requireLogin, async (req, res) => {
  try {
    if (!allowed(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const userId = Number(req.query.userId || 0);
    if (!userId) return res.status(400).json({ success: false, error: 'Choose somebody first.' });

    const [[person]] = await db.query(
      'SELECT id, username, email, role, domain FROM users WHERE id = ?', [userId]);
    if (!person) return res.status(404).json({ success: false, error: 'No such user.' });

    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();

    // Built once and used for both halves of the union, so a range cannot
    // filter the logins and leave the order changes alone.
    const range = (col) => {
      const parts = [];
      const args = [];
      if (from) { parts.push(`DATE(${col}) >= ?`); args.push(from); }
      if (to) { parts.push(`DATE(${col}) <= ?`); args.push(to); }
      return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
    };
    const act = range('a.logged_at');
    const ord = range('o.changed_at');

    const [rows] = await db.query(
      `SELECT * FROM (
         SELECT 'Account' AS kind, a.action AS action, '' AS order_id, '' AS field,
                '' AS old_value, '' AS new_value, a.role AS role, a.logged_at AS at
           FROM activity_log a
          WHERE a.email = ?${act.sql}
         UNION ALL
         SELECT 'Order' AS kind, o.action, o.order_id, IFNULL(o.field,''),
                IFNULL(o.old_value,''), IFNULL(o.new_value,''), '' AS role, o.changed_at
           FROM order_logs o
          WHERE o.changed_by = ?${ord.sql}
       ) t
       ORDER BY t.at DESC
       LIMIT ${MAX_ROWS}`,
      [person.email, ...act.args, person.username, ...ord.args],
    );

    // Counted over the whole range rather than the page, so the totals do not
    // quietly become "totals among the newest 500".
    const [[counts]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM activity_log a WHERE a.email = ? AND a.action = 'Login'${act.sql}) AS logins,
         (SELECT COUNT(*) FROM order_logs o WHERE o.changed_by = ?${ord.sql}) AS orderActions`,
      [person.email, ...act.args, person.username, ...ord.args],
    );

    // Inside the range, like the two counts beside them. Lifetime figures here
    // would read as the answer to the question the date boxes just asked, and
    // a card that quietly ignores the filter above it is how a page starts
    // disagreeing with itself. Clearing the dates gives the whole history.
    const [[seen]] = await db.query(
      `SELECT MIN(at) AS first_seen, MAX(at) AS last_seen FROM (
         SELECT a.logged_at AS at FROM activity_log a WHERE a.email = ?${act.sql}
         UNION ALL
         SELECT o.changed_at FROM order_logs o WHERE o.changed_by = ?${ord.sql}
       ) t`,
      [person.email, ...act.args, person.username, ...ord.args],
    );

    res.json({
      success: true,
      person,
      summary: {
        logins: counts.logins,
        orderActions: counts.orderActions,
        firstSeen: seen.first_seen,
        lastSeen: seen.last_seen,
        capped: rows.length >= MAX_ROWS,
      },
      data: rows.map(r => ({
        Kind: r.kind,
        Action: r.action,
        // The job's number as every other screen prints it, so a remake does
        // not read as a different order here than it does on the board.
        Order_ID: r.order_id ? rootOrderId(r.order_id) : '',
        Field: r.field || '',
        Old_Value: r.old_value || '',
        New_Value: r.new_value || '',
        Role: r.role || '',
        At: r.at,
      })),
    });
  } catch (err) {
    console.error('User activity failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
