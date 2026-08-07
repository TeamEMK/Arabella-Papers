const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

const MIN_PASSWORD = 8;

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
