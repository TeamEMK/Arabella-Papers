const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { ipOf, locationOf, fixFrom } = require('../utils/whereFrom');

// GET /login
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.render('login', { error: null });
});

// POST /login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) {
      return res.render('login', { error: 'Invalid credentials' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.render('login', { error: 'Invalid credentials' });
    }

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // Log activity
    await db.query(
      `INSERT INTO activity_log
         (email, action, role, domain, ip_address, location, latitude, longitude, accuracy_m)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.email, 'Login', user.role, user.domain, ipOf(req), locationOf(req),
       ...fixFrom(req.body)]
    );

    // Set session
    req.session.user = {
      id: user.id,
      empId: user.emp_id,
      username: user.username,
      email: user.email,
      role: user.role,
      domain: user.domain,
    };

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Server error. Please try again.' });
  }
});

// Both ways out write the same row.
//
// Only the POST used to, and the GET is a plain link anyone can follow - which
// is most of why the log holds 1,326 logins against 91 logouts. A log that
// records arrivals and drops most departures cannot answer how long somebody
// was on the system, which is the main thing anybody asks it.
async function recordLogout(req) {
  const user = req.session?.user;
  if (!user) return;
  await db.query(
    'INSERT INTO activity_log (email, action, role, domain, ip_address, location) VALUES (?,?,?,?,?,?)',
    [user.email, 'Logout', user.role, user.domain, ipOf(req), locationOf(req)]
  ).catch(() => {});
}

// POST /logout
router.post('/logout', async (req, res) => {
  await recordLogout(req);
  req.session.destroy(() => res.redirect('/login'));
});

// GET /logout (fallback)
router.get('/logout', async (req, res) => {
  await recordLogout(req);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
