const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { fixFrom } = require('../../utils/whereFrom');

const MIN_PASSWORD = 8;

// POST /api/account/where — attach the browser's position to this login.
//
// Asked for from inside the app rather than on the login page, which is where
// it was first put and where it never once worked. Two things were against it
// there: the browser's prompt needs a decision, and somebody who logs in in
// fifteen seconds has submitted the form long before that decision is made -
// and if the prompt is missed or dismissed, nothing arrives at all. Every
// login row for a week came through with a city and no pin.
//
// Here the page is already open and stays open, so the answer has somewhere
// to land whenever it comes.
router.post('/where', requireLogin, async (req, res) => {
  try {
    const [lat, lng, acc] = fixFrom(req.body);
    if (lat === null) return res.json({ success: true, stored: false });

    // The row this person's current visit began with, and only if it is still
    // waiting for one. Bounded by time so a browser that answers late, or a
    // tab left open overnight, cannot write a position onto a login from days
    // ago; and left alone once filled, so the first answer stands rather than
    // being rewritten by every page they open.
    const [r] = await db.query(
      `UPDATE activity_log
          SET latitude = ?, longitude = ?, accuracy_m = ?
        WHERE email = ? AND action = 'Login'
          AND latitude IS NULL
          AND logged_at > (NOW() - INTERVAL 12 HOUR)
        ORDER BY id DESC
        LIMIT 1`,
      [lat, lng, acc, req.session.user.email],
    );
    res.json({ success: true, stored: r.affectedRows > 0 });
  } catch (err) {
    // Never worth failing a page over. The city from the IP is already on the
    // row and the person is already logged in.
    console.warn('Could not store position:', err.message);
    res.json({ success: true, stored: false });
  }
});

// POST /api/account/password — change your own password
router.post('/password', requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Enter your current and new password.' });
    }
    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ success: false, error: `New password must be at least ${MIN_PASSWORD} characters.` });
    }

    // Read the hash fresh rather than trusting the session, so a password
    // changed elsewhere since login still has to be entered correctly here.
    const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [req.session.user.id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Your account no longer exists.' });
    }

    if (!await bcrypt.compare(currentPassword, rows[0].password)) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
    }
    if (await bcrypt.compare(newPassword, rows[0].password)) {
      return res.status(400).json({ success: false, error: 'New password must be different from your current one.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, req.session.user.id]);

    const u = req.session.user;
    await db.query(
      'INSERT INTO activity_log (email, action, role, domain) VALUES (?,?,?,?)',
      [u.email, 'Password Change', u.role, u.domain],
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('Password change failed:', err);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

module.exports = router;
