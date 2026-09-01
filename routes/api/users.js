const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../../config/db');
const { requireRole } = require('../../middleware/auth');

const MIN_PASSWORD = 8;
const ROLES = ['SuperAdmin', 'Designer', 'TillApprover', 'Production Manager', 'Accounts', 'HR'];
const DOMAINS = ['', 'Head'];

const onlySuperAdmin = requireRole('SuperAdmin');

function validate({ username, email, role, domain }) {
  if (!username || !username.trim()) return 'Name is required.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  if (!ROLES.includes(role)) return 'Choose a valid role.';
  if (!DOMAINS.includes(domain || '')) return 'Choose a valid domain.';
  return null;
}

async function countSuperAdmins(exceptId) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS n FROM users WHERE role = ? AND id <> ?',
    ['SuperAdmin', exceptId || 0],
  );
  return rows[0].n;
}

// GET /api/users — password hashes are never sent to the browser
router.get('/', onlySuperAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, emp_id, username, email, role, domain, created_at, last_login
       FROM users ORDER BY username`,
    );
    res.json({ success: true, users: rows, roles: ROLES, currentUserId: req.session.user.id });
  } catch (err) {
    console.error('User list failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// POST /api/users
router.post('/', onlySuperAdmin, async (req, res) => {
  try {
    const { empId, username, email, password, role, domain } = req.body;

    const invalid = validate({ username, email, role, domain });
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    if (!password || password.length < MIN_PASSWORD) {
      return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO users (emp_id, username, email, password, role, domain)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [empId || '', username.trim(), email.trim().toLowerCase(), hash, role, domain || ''],
    );
    res.json({ success: true });
  } catch (err) {
    // users.email is UNIQUE — report the collision rather than a generic 500.
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'That email already has an account.' });
    }
    console.error('User create failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// PUT /api/users/:id — password is optional; blank leaves it unchanged
router.put('/:id', onlySuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { empId, username, email, password, role, domain } = req.body;

    const invalid = validate({ username, email, role, domain });
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const [existing] = await db.query('SELECT role FROM users WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ success: false, error: 'User not found.' });

    // Demoting yourself, or the last SuperAdmin, would leave nobody able to
    // manage users — and nothing in the app could undo it.
    if (id === req.session.user.id && role !== 'SuperAdmin') {
      return res.status(400).json({ success: false, error: 'You cannot change your own role.' });
    }
    if (existing[0].role === 'SuperAdmin' && role !== 'SuperAdmin' && await countSuperAdmins(id) === 0) {
      return res.status(400).json({ success: false, error: 'This is the last SuperAdmin — promote someone else first.' });
    }

    if (password) {
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD} characters.` });
      }
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
    }

    await db.query(
      'UPDATE users SET emp_id = ?, username = ?, email = ?, role = ?, domain = ? WHERE id = ?',
      [empId || '', username.trim(), email.trim().toLowerCase(), role, domain || '', id],
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'That email already has an account.' });
    }
    console.error('User update failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', onlySuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (id === req.session.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account.' });
    }

    const [existing] = await db.query('SELECT role FROM users WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ success: false, error: 'User not found.' });

    if (existing[0].role === 'SuperAdmin' && await countSuperAdmins(id) === 0) {
      return res.status(400).json({ success: false, error: 'This is the last SuperAdmin — the app would be left unmanageable.' });
    }

    await db.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('User delete failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

module.exports = router;
