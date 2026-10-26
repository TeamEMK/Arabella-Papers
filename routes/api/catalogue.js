const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { requireLogin, requireRole } = require('../../middleware/auth');

// ══════════════════════════════════════════════════════
// DESIGN CATALOGUE — the admin half
//
// Putting designs up and taking them down. The public half is in
// routes/catalogue.js and shares nothing but the table, which is the point:
// everything here is behind a login, and nothing there has one.
// ══════════════════════════════════════════════════════

// Vercel refuses a body over 4.5MB before it reaches this handler, so the cap
// is set under that - a refusal with a reason beats a request that vanishes.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const CATEGORIES = ['Forms', 'Motifs', 'Patterns'];

// Pictures only. This is a gallery - a PDF or a spreadsheet here would show
// as a broken image on a page the client's customers are looking at.
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];

const canManage = requireRole('SuperAdmin', 'Head');

const clean = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);

// GET /api/catalogue — everything, live and hidden, for the admin list.
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, category, name, code, file_name, mime_type,
              is_active, sort_order,
              DATE_FORMAT(created_at, '%d %b %Y') AS created_at,
              LENGTH(bytes) AS size
         FROM catalogue_items
        ORDER BY category, sort_order, id DESC`);
    res.json({ success: true, categories: CATEGORIES, data: rows });
  } catch (err) {
    console.error('Catalogue list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/catalogue — add one.
router.post('/', requireLogin, canManage, upload.single('image'), async (req, res) => {
  try {
    const category = CATEGORIES.find(c => c.toLowerCase() === clean(req.body.category).toLowerCase());
    if (!category) {
      return res.status(400).json({ success: false, error: 'Choose a category: ' + CATEGORIES.join(', ') });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Attach a picture.' });
    if (!ALLOWED.includes(req.file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: 'That is not a picture. Use a JPG, PNG, WEBP, GIF or SVG.',
      });
    }

    const [r] = await db.query(
      `INSERT INTO catalogue_items
         (category, name, code, file_name, mime_type, bytes, sort_order, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [category, clean(req.body.name), clean(req.body.code, 60),
       clean(req.file.originalname), req.file.mimetype, req.file.buffer,
       parseInt(req.body.sortOrder, 10) || 0, req.session.user.id],
    );
    res.json({ success: true, id: r.insertId });
  } catch (err) {
    console.error('Catalogue add failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/catalogue/:id — rename, recode, reorder, show or hide.
router.put('/:id', requireLogin, canManage, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const args = [];
    if (b.name !== undefined) { sets.push('name = ?'); args.push(clean(b.name)); }
    if (b.code !== undefined) { sets.push('code = ?'); args.push(clean(b.code, 60)); }
    if (b.sortOrder !== undefined) { sets.push('sort_order = ?'); args.push(parseInt(b.sortOrder, 10) || 0); }
    if (b.isActive !== undefined) { sets.push('is_active = ?'); args.push(b.isActive ? 1 : 0); }
    if (b.category !== undefined) {
      const category = CATEGORIES.find(c => c.toLowerCase() === clean(b.category).toLowerCase());
      if (!category) return res.status(400).json({ success: false, error: 'Unknown category.' });
      sets.push('category = ?'); args.push(category);
    }
    if (!sets.length) return res.json({ success: true, changed: 0 });

    args.push(parseInt(req.params.id, 10));
    const [r] = await db.query(`UPDATE catalogue_items SET ${sets.join(', ')} WHERE id = ?`, args);
    res.json({ success: true, changed: r.affectedRows });
  } catch (err) {
    console.error('Catalogue update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/catalogue/:id — for real. Hiding is the PUT above; this is for
// the picture that was never meant to go up.
router.delete('/:id', requireLogin, canManage, async (req, res) => {
  try {
    const [r] = await db.query('DELETE FROM catalogue_items WHERE id = ?', [parseInt(req.params.id, 10)]);
    res.json({ success: true, changed: r.affectedRows });
  } catch (err) {
    console.error('Catalogue delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
