const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin, requireRole } = require('../../middleware/auth');

// ══════════════════════════════════════════════════════
// ENVELOPE LINEARS
//
// Five sections, twenty-one categories, and about three hundred designs
// inside them. The office's PDFs are one design per page, so what is stored
// is the pages pulled apart - somebody looking for a liner wants to see
// liners, not to page through a document hunting for one.
//
// Built like the design catalogue to look at and deliberately not like it
// underneath. catalogue_items renders every page of every volume into MySQL
// and is 54MB of a 60MB dump, which is why a nightly backup went from 8MB to
// 127MB. Here the design is in Drive and the database keeps a thumbnail:
// 3MB for all three hundred, against the 69MB the designs themselves weigh.
//
// TWO REQUESTS, NOT ONE. The board is the shelf - sections and their
// categories - and the designs in a category are fetched when somebody opens
// it. Three hundred thumbnails on the first paint would be most of a
// megabyte before anybody had decided what they were looking for.
// ══════════════════════════════════════════════════════

const canManage = requireRole('SuperAdmin', 'Head');

/**
 * GET /api/envelope-linears/board
 *
 * The shelf: every section, its categories, and how many designs each one
 * holds. No pictures - the covers are fetched one at a time from /cover/:id
 * and then cached by the browser.
 */
router.get('/board', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.section, c.category, c.section_order, c.sort_order,
              c.cover IS NOT NULL AS has_cover,
              COUNT(i.id) AS items
         FROM envelope_linears c
         LEFT JOIN envelope_linear_items i
                ON i.category_id = c.id AND i.is_active = 1
        WHERE c.is_active = 1
        GROUP BY c.id
        ORDER BY c.section_order, c.sort_order, c.id`);

    // Grouped here rather than in the browser so the order is decided once,
    // by the query that knows about section_order.
    const sections = [];
    const bySection = new Map();
    for (const r of rows) {
      if (!bySection.has(r.section)) {
        const s = { section: r.section, items: [] };
        bySection.set(r.section, s);
        sections.push(s);
      }
      bySection.get(r.section).items.push({
        id: r.id, category: r.category,
        count: Number(r.items) || 0,
        hasCover: !!r.has_cover,
      });
    }
    res.json({
      success: true,
      sections,
      categories: rows.length,
      designs: rows.reduce((n, r) => n + (Number(r.items) || 0), 0),
    });
  } catch (err) {
    console.error('Envelope Linears board failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/envelope-linears/category/:id — the designs inside one category. */
router.get('/category/:id', requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such category.' });
    }
    const [[cat]] = await db.query(
      'SELECT id, section, category FROM envelope_linears WHERE id = ? AND is_active = 1', [id]);
    if (!cat) return res.status(404).json({ success: false, error: 'No such category.' });

    const [rows] = await db.query(
      `SELECT id, code, name, source_page, file_url, width, height,
              thumb IS NOT NULL AS has_thumb,
              bytes IS NOT NULL AS has_image
         FROM envelope_linear_items
        WHERE category_id = ? AND is_active = 1
        ORDER BY sort_order, id`, [id]);

    res.json({
      success: true,
      section: cat.section,
      category: cat.category,
      items: rows.map(r => ({
        id: r.id, code: r.code, name: r.name, page: r.source_page,
        url: r.file_url, width: r.width, height: r.height,
        hasThumb: !!r.has_thumb,
        hasImage: !!r.has_image,
      })),
    });
  } catch (err) {
    console.error('Envelope Linears category failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * The pictures, one request each and cached hard.
 *
 * These change only when a volume is re-imported, which is rare, and a grid
 * of twenty tiles asking the server every time somebody opens a category is
 * the difference between a page that snaps and one that crawls. Private,
 * because everything here is behind a login.
 */
function servePicture(table, column) {
  return async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
      const [[row]] = await db.query(
        `SELECT ${column} AS pic FROM ${table} WHERE id = ? AND is_active = 1`, [id]);
      if (!row || !row.pic) return res.status(404).end();
      res.type('image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(row.pic);
    } catch (err) {
      console.error('Envelope Linears picture failed:', err);
      res.status(500).end();
    }
  };
}

// The table and column are named here, never taken from the request - a
// path segment that reaches a FROM clause is a way into every other table.
router.get('/cover/:id', requireLogin, servePicture('envelope_linears', 'cover'));
router.get('/thumb/:id', requireLogin, servePicture('envelope_linear_items', 'thumb'));

/**
 * GET /api/envelope-linears/image/:id - the full-size design.
 *
 * Its own handler rather than servePicture because this is the only one that
 * is not always a JPEG: a liner lifted straight out of a PDF keeps whatever
 * the PDF had it as, and sending a PNG labelled image/jpeg gives some
 * browsers a broken picture and no reason why.
 */
router.get('/image/:id', requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    const [[row]] = await db.query(
      `SELECT mime_type, bytes FROM envelope_linear_items
        WHERE id = ? AND is_active = 1`, [id]);
    if (!row || !row.bytes) return res.status(404).end();
    res.type(row.mime_type || 'image/jpeg');
    res.setHeader('Content-Length', row.bytes.length);
    // A design never changes under its id - a replacement is a new row - so
    // the browser can hold on to it. Private: these are behind a login.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.send(row.bytes);
  } catch (err) {
    console.error('Envelope Linears image failed:', err);
    res.status(500).end();
  }
});

/** GET /api/envelope-linears — the flat list, for whoever manages it. */
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.section, c.category, c.is_active, c.section_order, c.sort_order,
              COUNT(i.id) AS items,
              DATE_FORMAT(c.created_at, '%d %b %Y') AS created_at
         FROM envelope_linears c
         LEFT JOIN envelope_linear_items i ON i.category_id = c.id
        GROUP BY c.id
        ORDER BY c.section_order, c.sort_order, c.id`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Envelope Linears list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const clean = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);

/** PUT /api/envelope-linears/:id — rename a category, or take it down. */
router.put('/:id', requireLogin, canManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such category.' });
    }
    const b = req.body || {};
    const fields = {};
    if (b.section !== undefined) fields.section = clean(b.section, 80);
    if (b.category !== undefined) fields.category = clean(b.category, 120);
    if (b.isActive !== undefined) fields.is_active = b.isActive ? 1 : 0;
    if (b.sortOrder !== undefined) fields.sort_order = Number(b.sortOrder) || 0;

    if (fields.section === '') {
      return res.status(400).json({ success: false, error: 'A section needs a name.' });
    }
    if (fields.category === '') {
      return res.status(400).json({ success: false, error: 'A category needs a name.' });
    }
    const keys = Object.keys(fields);
    if (!keys.length) return res.json({ success: true, changed: 0 });

    const [out] = await db.query(
      'UPDATE envelope_linears SET ' + keys.map(k => `${k} = ?`).join(', ') + ' WHERE id = ?',
      [...keys.map(k => fields[k]), id]);
    res.json({ success: true, changed: out.affectedRows });
  } catch (err) {
    console.error('Envelope Linears update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /api/envelope-linears/item/:id — give a design a code, or hide it. */
router.put('/item/:id', requireLogin, canManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such design.' });
    }
    const b = req.body || {};
    const fields = {};
    if (b.code !== undefined) fields.code = clean(b.code, 60);
    if (b.name !== undefined) fields.name = clean(b.name, 255);
    if (b.isActive !== undefined) fields.is_active = b.isActive ? 1 : 0;
    if (b.sortOrder !== undefined) fields.sort_order = Number(b.sortOrder) || 0;

    const keys = Object.keys(fields);
    if (!keys.length) return res.json({ success: true, changed: 0 });

    const [out] = await db.query(
      'UPDATE envelope_linear_items SET ' + keys.map(k => `${k} = ?`).join(', ') + ' WHERE id = ?',
      [...keys.map(k => fields[k]), id]);
    res.json({ success: true, changed: out.affectedRows });
  } catch (err) {
    console.error('Envelope Linears item update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
