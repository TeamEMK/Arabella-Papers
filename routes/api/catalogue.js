const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { checkFile, sendHeaders } = require('../../utils/fileKind');
const { archiveThenDelete } = require('../../utils/archive');
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

// The office's own volumes, which is what the eight PDFs on the shelf are:
// Borders, three volumes of Fonts, Monograms, Motifs, Patterns, and the order
// form. "Forms" was a guess from a half-heard recording and meant the order
// form, not a category of design.
const CATEGORIES = ['Borders', 'Fonts', 'Monograms', 'Motifs', 'Patterns', 'Order Form'];

// Pictures only. This is a gallery - a PDF or a spreadsheet here would show
// as a broken image on a page the client's customers are looking at.
// The kinds a catalogue design may be, decided by reading the file's first
// bytes rather than by believing the browser - see utils/fileKind.js.
// SVG IS GONE from this list on purpose: it is a document that can carry
// <script>, and this picture is handed back out from our own address to
// whoever opens the customer catalogue. A photograph of paper is a raster.
const ALLOWED_KINDS = ['jpeg', 'png', 'webp', 'gif'];

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

// GET /api/catalogue/thumb/:id — the grid picture, for the office screen.
//
// The admin page used to point at /catalogue/thumb/:id, which belongs to the
// customer's router. That address was shut when the customer's links became
// one link, so every thumbnail on this screen became a broken picture. It
// has its own route now, behind the same login as the rest of the screen -
// the office's catalogue is not a public page.
router.get('/thumb/:id', requireLogin, canManage, async (req, res) => {
  try {
    const [[item]] = await db.query(
      'SELECT file_name, mime_type, IFNULL(thumb, bytes) AS bytes FROM catalogue_items WHERE id = ?',
      [parseInt(req.params.id, 10)]);
    if (!item || !item.bytes) return res.status(404).send('Not found.');
    sendHeaders(res, item.bytes, item.mime_type, item.file_name || ('design-' + req.params.id));
    // A design's picture never changes under its id - a new upload is a new
    // row - but this one is behind a login, so it is the browser's to keep
    // and nobody else's.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(item.bytes);
  } catch (err) {
    console.error('Catalogue thumb failed:', err);
    res.status(500).send('Could not load that image.');
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
    const kind = checkFile(req.file, ALLOWED_KINDS);
    if (!kind.ok) return res.status(400).json({ success: false, error: kind.error });

    const [r] = await db.query(
      `INSERT INTO catalogue_items
         (category, name, code, file_name, mime_type, bytes, sort_order, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [category, clean(req.body.name), clean(req.body.code, 60),
       clean(req.file.originalname), kind.mime, req.file.buffer,
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
    // The row is kept; the image bytes are not - see utils/archive.js. What
    // comes back is the name, the category and who removed it, which is what
    // anyone asking will want.
    const r = await archiveThenDelete('catalogue_items', 'id = ?',
      [parseInt(req.params.id, 10)], req, 'catalogue design deleted');
    res.json({ success: true, changed: r.removed });
  } catch (err) {
    console.error('Catalogue delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
