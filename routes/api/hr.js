const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

// Staff records hold mobiles, emergency contacts and document status. Nobody
// gets at them without being told to: the HR role, or a SuperAdmin.
function canSeeHR(user) {
  const role = user && user.role ? String(user.role) : '';
  return role === 'SuperAdmin' || role.includes('HR');
}

// The columns a person fills in. Everything else on the row - id, is_deleted,
// the timestamps - the system looks after.
const FIELDS = [
  'company', 'name', 'emp_code', 'mobile', 'email', 'emergency_no',
  'designation', 'department', 'kra', 'reporting_manager', 'work_location',
  'offer_letter_date', 'date_of_joining', 'probation_end_date', 'confirmation_date',
  'appointment_nda_status', 'code_of_conduct', 'policy_handbook',
  'background_verification', 'working_status', 'last_date_of_employment',
  'record_log', 'performance_remarks', 'other_notes',
];

function clean(body) {
  const row = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    const v = typeof body[f] === 'string' ? body[f].trim() : body[f];
    row[f] = v === '' ? null : v;
  }
  return row;
}

// GET /api/hr — every employee on file.
router.get('/', requireLogin, async (req, res) => {
  try {
    if (!canSeeHR(req.session.user)) return res.status(403).json({ success: false, error: 'Unauthorized' });
    const [rows] = await db.query(
      'SELECT * FROM employees WHERE is_deleted = 0 ORDER BY name ASC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('HR list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/hr — add someone.
router.post('/', requireLogin, async (req, res) => {
  try {
    if (!canSeeHR(req.session.user)) return res.status(403).json({ success: false, error: 'Unauthorized' });
    const row = clean(req.body);
    if (!row.name) return res.status(400).json({ success: false, error: 'Name is required.' });
    if (!row.company) row.company = 'AMIPL';

    const cols = Object.keys(row);
    await db.query(
      `INSERT INTO employees (${cols.map(c => '`' + c + '`').join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => row[c])
    );
    res.json({ success: true });
  } catch (err) {
    console.error('HR create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/hr/:id — edit someone.
router.put('/:id', requireLogin, async (req, res) => {
  try {
    if (!canSeeHR(req.session.user)) return res.status(403).json({ success: false, error: 'Unauthorized' });
    const row = clean(req.body);
    if (row.name !== undefined && !row.name) {
      return res.status(400).json({ success: false, error: 'Name is required.' });
    }
    const cols = Object.keys(row);
    if (!cols.length) return res.json({ success: true });

    await db.query(
      `UPDATE employees SET ${cols.map(c => '`' + c + '` = ?').join(', ')} WHERE id = ?`,
      [...cols.map(c => row[c]), req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('HR update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/hr/:id — hidden, not erased. A staff record is the kind of thing
// somebody asks for again a year later.
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    if (!canSeeHR(req.session.user)) return res.status(403).json({ success: false, error: 'Unauthorized' });
    await db.query('UPDATE employees SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('HR delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
