const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { ipOf, locationOf, fixFrom } = require('../utils/whereFrom');
const vectorDuty = require('../utils/vectorDuty');

/**
 * The vector-file gate.
 *
 * A designer who still owes files does not get to log out until they are in.
 * Both ways out go through this, because the GET is a plain link and leaving
 * it open would make the whole thing a suggestion.
 *
 * It fails open. If the count cannot be read - the database is unwell, the
 * table is missing on a fresh deploy - the person is let out. A bug in here
 * must not be able to trap the whole office inside the app.
 */
async function vectorHold(req) {
  try {
    const user = req.session && req.session.user;
    if (!user) return null;
    const pending = await vectorDuty.pendingFor(user);
    return pending.count > 0 ? pending : null;
  } catch (err) {
    console.error('Vector logout check failed:', err.message);
    return null;
  }
}

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
  const held = await vectorHold(req);
  if (held) {
    // A plain form post - somebody with JavaScript off - wants a page, not a
    // page of JSON. The app shell puts the list in front of them.
    if (!req.xhr && req.accepts(['html', 'json']) === 'html') {
      return res.redirect('/?vectors=due');
    }
    return res.status(409).json({
      success: false,
      blocked: 'vector',
      count: held.count,
      orders: held.orders,
      error: held.count + ' order' + (held.count === 1 ? '' : 's')
        + ' still need their vector file. Upload them before signing out.',
    });
  }
  await recordLogout(req);
  req.session.destroy(() => res.redirect('/login'));
});

// GET /logout (fallback)
//
// Sent back to the app rather than answered with JSON: somebody who followed
// a link wants a page, and the app puts the list in front of them.
router.get('/logout', async (req, res) => {
  if (await vectorHold(req)) return res.redirect('/?vectors=due');
  await recordLogout(req);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
