const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { matches, words, looksLikeCode, codeMatches } = require('../utils/linerTags');

// ══════════════════════════════════════════════════════
// ENVELOPE LINEARS — the public half
//
// The link the office sends a customer. No login, and nothing in this file
// touches anything but the two liner tables: no orders, no clients, no
// names. Whatever the tab marks active shows here on the next page load,
// and whatever it hides stops showing.
//
// Deliberately a separate file from routes/api/envelopeLinears.js, which is
// behind requireLogin from end to end. Keeping a guarded route and an open
// one in the same file is how an open one eventually gets written next to
// the guarded ones and reads as though it were covered too.
//
// WHAT IS EXPOSED. Every active design, at full size, to anybody holding the
// address - exactly as the design catalogue already works. There is no
// separate "show this one publicly" switch, and it would be a lie to imply
// there is: active means public.
// ══════════════════════════════════════════════════════

// GET /linears — the page.
router.get('/', (req, res) => {
  res.render('linears');
});

/**
 * GET /linears/api/board — the sections and their categories.
 *
 * is_active is filtered in SQL rather than in the page. A category that has
 * been taken down must not travel to the browser at all: "not displayed" is
 * not hidden when the reply is one right-click away.
 */
router.get('/api/board', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.section, c.category,
              c.cover IS NOT NULL AS has_cover,
              COUNT(i.id) AS items
         FROM envelope_linears c
         LEFT JOIN envelope_linear_items i
                ON i.category_id = c.id AND i.is_active = 1
        WHERE c.is_active = 1
        GROUP BY c.id
        HAVING items > 0
        ORDER BY c.section_order, c.sort_order, c.id`);

    // An empty category is left out entirely rather than shown as an empty
    // room: a customer has no idea it is a work in progress, only that the
    // company sent them a link to nothing.
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
      designs: rows.reduce((n, r) => n + (Number(r.items) || 0), 0),
    });
  } catch (err) {
    console.error('Public linears board failed:', err);
    res.status(500).json({ success: false, error: 'Could not load the liners just now.' });
  }
});

/** GET /linears/api/category/:id — the designs inside one category. */
router.get('/api/category/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such category.' });
    }
    const [[cat]] = await db.query(
      'SELECT id, section, category FROM envelope_linears WHERE id = ? AND is_active = 1', [id]);
    if (!cat) return res.status(404).json({ success: false, error: 'No such category.' });

    const [rows] = await db.query(
      `SELECT id, code, source_page, thumb IS NOT NULL AS has_thumb,
              bytes IS NOT NULL AS has_image
         FROM envelope_linear_items
        WHERE category_id = ? AND is_active = 1
        ORDER BY sort_order, id`, [id]);

    res.json({
      success: true,
      section: cat.section,
      category: cat.category,
      // Only what a customer needs to point at one. The tags are how the
      // search works and are nobody else's business; the file the design was
      // cut out of is even less so.
      items: rows.map(r => ({
        id: r.id,
        code: r.code || ('Design ' + (r.source_page || '')),
        hasThumb: !!r.has_thumb,
        hasImage: !!r.has_image,
      })),
    });
  } catch (err) {
    console.error('Public linears category failed:', err);
    res.status(500).json({ success: false, error: 'Could not load that just now.' });
  }
});

/** GET /linears/api/search?q=blue+flower — the same question, from outside. */
router.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 2) return res.json({ success: true, q, found: 0, items: [] });

    const [rows] = await db.query(
      `SELECT i.id, i.code, i.source_page, i.tags,
              i.thumb IS NOT NULL AS has_thumb,
              i.bytes IS NOT NULL AS has_image,
              c.id AS category_id, c.category
         FROM envelope_linear_items i
         JOIN envelope_linears c ON c.id = i.category_id
        WHERE i.is_active = 1 AND c.is_active = 1
        ORDER BY c.section_order, c.sort_order, i.sort_order`);

    // A NAME, OR A DESCRIPTION. Not both at once.
    //
    // "CT-TS-07" is somebody naming one design; "blue flower" is somebody
    // describing a kind. Telling them apart matters more than it looks:
    // broken into words, "CT-TS-07" is "ct", "ts" and "07", every one of
    // them too short to search on - and a phrase with nothing searchable
    // left in it matches EVERYTHING. A search for one design would have
    // answered with the whole book.
    //
    // "CT-FB" has no number and no words long enough to search on either,
    // and it is still obviously a name - half of one. So a phrase with
    // nothing searchable left in it falls back to the codes rather than
    // matching everything: typing half a code lists that category, which is
    // what somebody doing it meant.
    const byName = looksLikeCode(q);
    const usable = words(q);
    const hits = (byName || !usable.length)
      ? rows.filter(r => codeMatches(q, r.code))
      : rows.filter(r => matches(q, String(r.tags || '').split(' ')));
    res.json({
      success: true,
      q,
      found: hits.length,
      items: hits.slice(0, 60).map(r => ({
        id: r.id,
        code: r.code || ('Design ' + (r.source_page || '')),
        categoryId: r.category_id,
        category: r.category,
        hasThumb: !!r.has_thumb,
        hasImage: !!r.has_image,
      })),
    });
  } catch (err) {
    console.error('Public linears search failed:', err);
    res.status(500).json({ success: false, error: 'Could not search just now.' });
  }
});

/**
 * The pictures.
 *
 * Each in its own route rather than one with a query string, so a browser, a
 * proxy and our own Cache-Control all treat them as the different files they
 * are. The table and column are named in code and never taken from the
 * request: a path segment that reaches a FROM clause is a way into every
 * other table in the database.
 */
function serve(table, column, cacheSeconds) {
  return async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(404).send('Not found.');
      const [[row]] = await db.query(
        `SELECT ${column} AS pic FROM ${table} WHERE id = ? AND is_active = 1`, [id]);
      // A hidden one answers exactly as a missing one does. Anything else and
      // the gap between the two says which ids are real.
      if (!row || !row.pic) return res.status(404).send('Not found.');
      res.type('image/jpeg');
      res.setHeader('Content-Length', row.pic.length);
      // s-maxage as well as max-age: without it Vercel's edge keeps nothing,
      // so every thumbnail on every visit wakes a function and asks the
      // database for bytes that never change. A design's picture cannot
      // change under its id - a replacement is a new row, and taking one
      // down 404s it.
      res.setHeader('Cache-Control',
        'public, max-age=86400, s-maxage=' + cacheSeconds + ', immutable');
      res.send(row.pic);
    } catch (err) {
      console.error('Public linears picture failed:', err);
      res.status(500).send('Could not load that image.');
    }
  };
}

router.get('/cover/:id', serve('envelope_linears', 'cover', 2592000));

/**
 * The grid-sized copy.
 *
 * Not through serve() above, because this one has to ask about the CATEGORY
 * as well. Taking a category down has to take its designs with it: a
 * thumbnail that still answers after the category it lives in was hidden is
 * the design still being published, just without a page pointing at it.
 */
router.get('/thumb/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).send('Not found.');
    const [[row]] = await db.query(
      `SELECT i.thumb AS pic
         FROM envelope_linear_items i
         JOIN envelope_linears c ON c.id = i.category_id
        WHERE i.id = ? AND i.is_active = 1 AND c.is_active = 1`, [id]);
    if (!row || !row.pic) return res.status(404).send('Not found.');
    res.type('image/jpeg');
    res.setHeader('Content-Length', row.pic.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable');
    res.send(row.pic);
  } catch (err) {
    console.error('Public linears thumb failed:', err);
    res.status(500).send('Could not load that image.');
  }
});

/** The full design, which keeps whatever type it was stored as. */
router.get('/image/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).send('Not found.');
    const [[row]] = await db.query(
      `SELECT i.mime_type, i.bytes
         FROM envelope_linear_items i
         JOIN envelope_linears c ON c.id = i.category_id
        WHERE i.id = ? AND i.is_active = 1 AND c.is_active = 1`, [id]);
    if (!row || !row.bytes) return res.status(404).send('Not found.');
    res.type(row.mime_type || 'image/jpeg');
    res.setHeader('Content-Length', row.bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    res.send(row.bytes);
  } catch (err) {
    console.error('Public linears image failed:', err);
    res.status(500).send('Could not load that image.');
  }
});

module.exports = router;
