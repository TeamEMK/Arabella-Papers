const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

// What paper is available is asked by everyone who takes an order, so reading
// it is open to anyone signed in. Changing it is too - whoever notices a paper
// has run out is the person who should be able to say so.
const FIELDS = ['category', 'code', 'name', 'status', 'thickness', 'note'];

function clean(body) {
  const row = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    const v = typeof body[f] === 'string' ? body[f].trim() : body[f];
    row[f] = v === '' ? null : v;
  }
  return row;
}

// GET /api/stock
router.get('/', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM stock_items WHERE is_deleted = 0
        ORDER BY category ASC, code ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Stock list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/stock — add an item.
router.post('/', requireLogin, async (req, res) => {
  try {
    const row = clean(req.body);
    if (!row.category) return res.status(400).json({ success: false, error: 'Category is required.' });
    if (!row.code && !row.name) {
      return res.status(400).json({ success: false, error: 'Give it a code or a name.' });
    }
    const cols = Object.keys(row);
    await db.query(
      `INSERT INTO stock_items (${cols.map(c => '`' + c + '`').join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => row[c])
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Stock create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/stock/:id — edit one. Sent from the row itself, so it is usually a
// single field: whatever is not in the body is left alone.
router.put('/:id', requireLogin, async (req, res) => {
  try {
    const row = clean(req.body);
    const cols = Object.keys(row);
    if (!cols.length) return res.json({ success: true });
    await db.query(
      `UPDATE stock_items SET ${cols.map(c => '`' + c + '` = ?').join(', ')} WHERE id = ?`,
      [...cols.map(c => row[c]), req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Stock update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/stock/:id — hidden, not erased.
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    await db.query('UPDATE stock_items SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Stock delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
