const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin, requireRole, hasRole } = require('../../middleware/auth');
const { codeFor } = require('../../utils/linerCode');
const {
  tagsFor, matches, colourName, words, looksLikeCode, codeMatches,
} = require('../../utils/linerTags');

// ══════════════════════════════════════════════════════
// ENVELOPE LINEARS
//
// Five sections, twenty-one categories, and about three hundred designs
// inside them. The office's PDFs are one design per page, so what is stored
// is the pages pulled apart - somebody looking for a liner wants to see
// liners, not to page through a document hunting for one.
//
// The design itself is kept here, next to its thumbnail, the same way the
// design catalogue keeps its pictures - a Drive link opened a Drive page in
// a new tab, which is not what somebody flicking through liners is after.
// About 69MB for the three hundred, so envelope_linear_items is on the
// nightly backup's heavy list beside catalogue_items: the structure goes
// into every dump, the rows only into the weekly full one. Every byte of it
// can be made again from the PDFs in a few minutes.
//
// The grid only ever fetches thumbnails, which is why the page is quick; the
// full picture is fetched for the one design somebody actually opened.
//
// TWO REQUESTS, NOT ONE. The board is the shelf - sections and their
// categories - and the designs in a category are fetched when somebody opens
// it. Three hundred thumbnails on the first paint would be most of a
// megabyte before anybody had decided what they were looking for.
// ══════════════════════════════════════════════════════

// One list, used twice: as the gate on every route that changes something,
// and as the answer the board gives the screen about which buttons to draw.
const MANAGERS = ['SuperAdmin', 'Head'];
const canManage = requireRole(...MANAGERS);

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
      // Answered here rather than worked out in the browser from a role name:
      // the rule lives in canManage, and a screen that keeps its own copy of
      // it is a screen that will one day show a button the server refuses.
      canManage: hasRole(req.session.user, ...MANAGERS),
    });
  } catch (err) {
    console.error('Envelope Linears board failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/envelope-linears/search?q=blue+flower
 *
 * Designs from anywhere, by what they look like and what they are.
 *
 * Matched in Node rather than in SQL. A LIKE would find "blue" inside
 * "bluebell" and would know nothing about "flower" meaning floral, and the
 * rule for both lives in utils/linerTags.js - the same rule the tagging
 * script uses, so what is searched for is what was written down. Three
 * hundred rows of short text is nothing to read through; if this ever
 * becomes thirty thousand it wants a proper index, not a cleverer LIKE.
 */
router.get('/search', requireLogin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 2) return res.json({ success: true, q, items: [] });

    const [rows] = await db.query(
      `SELECT i.id, i.code, i.name, i.source_page, i.file_url, i.tags,
              i.thumb IS NOT NULL AS has_thumb,
              i.bytes IS NOT NULL AS has_image,
              c.id AS category_id, c.section, c.category
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
      // Capped, and lower than it first was. At 120 the browser was asked
      // for a hundred and twenty thumbnails in one breath and a third of
      // them had not arrived by the time somebody looked - which reads as
      // "the search is broken", not "the network is busy". Sixty is about a
      // screen and a half, and `found` above says how many there really
      // were so nobody is misled about it.
      items: hits.slice(0, 60).map(r => ({
        id: r.id, code: r.code, name: r.name, page: r.source_page,
        url: r.file_url, categoryId: r.category_id,
        section: r.section, category: r.category,
        hasThumb: !!r.has_thumb, hasImage: !!r.has_image,
      })),
    });
  } catch (err) {
    console.error('Envelope Linears search failed:', err);
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
      `SELECT id, section, category, code_next FROM envelope_linears
        WHERE id = ? AND is_active = 1`, [id]);
    if (!cat) return res.status(404).json({ success: false, error: 'No such category.' });

    const [rows] = await db.query(
      `SELECT id, code, name, source_page, file_url, width, height,
              thumb IS NOT NULL AS has_thumb,
              bytes IS NOT NULL AS has_image
         FROM envelope_linear_items
        WHERE category_id = ? AND is_active = 1
        ORDER BY sort_order, id`, [id]);

    // What the NEXT design put in here will be called, worked out the same
    // way the upload itself works it out - off the counter that only goes
    // up, not off how many are in the category. Sent so the screen can say
    // it BEFORE anybody uploads: a code somebody is about to live with is
    // worth seeing while there is still time to object to it.
    const used = rows.reduce((top, r) => {
      const m = /-(\d+)$/.exec(String(r.code || ''));
      return m ? Math.max(top, Number(m[1])) : top;
    }, 0);

    res.json({
      success: true,
      section: cat.section,
      category: cat.category,
      nextCode: codeFor(cat.section, cat.category,
        Math.max(Number(cat.code_next) || 0, used) + 1),
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

// The design routes are declared above the category ones because the more
// particular path reads better first, NOT because it is required: "/:id"
// matches a single segment, so "/item/7" was never in danger of landing on
// it. Checked, after I had claimed otherwise.
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


/**
 * A picture arriving from a browser, checked before it reaches the database.
 *
 * It comes as a data URL because one request carrying the picture and its
 * row together cannot half-succeed. The limit is the serverless one: Vercel
 * refuses a request body over 4.5MB outright, and the refusal does not reach
 * this code at all - so the screen shrinks the picture before sending and
 * this is the backstop, not the rule.
 */
const MAX_PICTURE = 4 * 1024 * 1024;
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function decodePicture(dataUrl, what) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return { error: 'The ' + what + ' did not arrive as a picture.' };
  const mime = m[1].toLowerCase();
  if (!PICTURE_TYPES.includes(mime)) {
    return { error: 'A ' + what + ' has to be a JPG, PNG or WebP.' };
  }
  let bytes;
  try { bytes = Buffer.from(m[2], 'base64'); } catch (e) { bytes = null; }
  if (!bytes || !bytes.length) return { error: 'The ' + what + ' was empty.' };
  if (bytes.length > MAX_PICTURE) {
    return { error: 'That ' + what + ' is ' + (bytes.length / 1048576).toFixed(1)
      + 'MB. Four is the most that can go through in one go.' };
  }
  return { mime, bytes };
}

/**
 * POST /api/envelope-linears — a new category, in a new section or an old one.
 *
 * The section is just a name on the row; there is no table of sections and
 * deliberately so. A section exists for exactly as long as a category says it
 * does, which means one can never be left behind empty for somebody to
 * wonder about later.
 */
router.post('/', requireLogin, canManage, async (req, res) => {
  try {
    const b = req.body || {};
    const section = clean(b.section, 80);
    const category = clean(b.category, 120);
    if (!section) return res.status(400).json({ success: false, error: 'A section needs a name.' });
    if (!category) return res.status(400).json({ success: false, error: 'A category needs a name.' });

    // Two categories of the same name in the same section would be two tiles
    // nobody could tell apart, and the designs would go into whichever one
    // was clicked. Case and spacing do not make them different.
    const [[clash]] = await db.query(
      `SELECT id FROM envelope_linears
        WHERE LOWER(TRIM(section)) = LOWER(TRIM(?))
          AND LOWER(TRIM(category)) = LOWER(TRIM(?)) LIMIT 1`, [section, category]);
    if (clash) {
      return res.status(400).json({ success: false, error: 'That category is already in that section.' });
    }

    // A new section goes after the ones already there; a new category goes
    // after the last one in its own section. Nothing has to be renumbered.
    const [[where]] = await db.query(
      `SELECT COALESCE(MAX(CASE WHEN LOWER(TRIM(section)) = LOWER(TRIM(?))
                                THEN section_order END), -1) AS same_section,
              COALESCE(MAX(section_order), -1) AS last_section,
              COALESCE(MAX(CASE WHEN LOWER(TRIM(section)) = LOWER(TRIM(?))
                                THEN sort_order END), -1) AS last_sort
         FROM envelope_linears`, [section, section]);
    const sectionOrder = where.same_section >= 0 ? where.same_section : where.last_section + 1;

    const [out] = await db.query(
      `INSERT INTO envelope_linears (section, category, section_order, sort_order, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [section, category, sectionOrder, Number(where.last_sort) + 1]);
    res.json({ success: true, id: out.insertId, section, category });
  } catch (err) {
    console.error('Envelope Linears create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// The design routes are declared above the category ones because the more
// particular path reads better first, NOT because it is required: "/:id"
// matches a single segment, so "/item/7" was never in danger of landing on
// it. Checked, after I had claimed otherwise.
/** DELETE /api/envelope-linears/item/:id — take one design out for good. */
router.delete('/item/:id', requireLogin, canManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such design.' });
    }
    const [[row]] = await db.query(
      'SELECT category_id FROM envelope_linear_items WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ success: false, error: 'No such design.' });

    await db.query('DELETE FROM envelope_linear_items WHERE id = ?', [id]);
    // The cover was a copy of some design's thumbnail. If it was this one's,
    // the tile would go on showing a design that is no longer in there - so
    // the category takes the next one's instead, or none at all.
    await db.query(
      `UPDATE envelope_linears SET cover = (
         SELECT thumb FROM envelope_linear_items
          WHERE category_id = ? AND is_active = 1
          ORDER BY sort_order, id LIMIT 1) WHERE id = ?`,
      [row.category_id, row.category_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Envelope Linears item delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/envelope-linears/:id — a category and everything in it.
 *
 * Really gone, not hidden: hiding is what the Hide switch is for, and a
 * manage screen with two kinds of gone is a screen nobody trusts. The count
 * goes back so the screen can say what it actually removed.
 */
router.delete('/:id', requireLogin, canManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such category.' });
    }
    const [[cat]] = await db.query(
      'SELECT category FROM envelope_linears WHERE id = ?', [id]);
    if (!cat) return res.status(404).json({ success: false, error: 'No such category.' });

    const [[n]] = await db.query(
      'SELECT COUNT(*) AS n FROM envelope_linear_items WHERE category_id = ?', [id]);
    await db.query('DELETE FROM envelope_linear_items WHERE category_id = ?', [id]);
    await db.query('DELETE FROM envelope_linears WHERE id = ?', [id]);
    res.json({ success: true, category: cat.category, designs: Number(n.n || 0) });
  } catch (err) {
    console.error('Envelope Linears delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/envelope-linears/:id/items — put one design into a category.
 *
 * One design per request on purpose. Twenty pictures in one body is 4MB that
 * either all arrives or all fails, and the one that fails takes the other
 * nineteen with it; one at a time means the screen can say "14 of 20" and
 * name the one that would not go.
 */
router.post('/:id/items', requireLogin, canManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such category.' });
    }
    const [[cat]] = await db.query(
      'SELECT id, section, category, code_next FROM envelope_linears WHERE id = ?', [id]);
    if (!cat) return res.status(404).json({ success: false, error: 'No such category.' });

    const b = req.body || {};
    const full = decodePicture(b.image, 'design');
    if (full.error) return res.status(400).json({ success: false, error: full.error });
    const thumb = decodePicture(b.thumb, 'thumbnail');
    if (thumb.error) return res.status(400).json({ success: false, error: thumb.error });

    const [[last]] = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS n FROM envelope_linear_items WHERE category_id = ?', [id]);

    // The name it will be quoted by: CT-FB-19 for the nineteenth liner in
    // Floral & Botanical.
    //
    // Counted off the category's OWN counter, not off what is in the table.
    // The highest code in the table was the obvious way and it is wrong:
    // delete the second of three and the highest drops back to one, so the
    // next design added is handed a second SS-SL-02 - and a code somebody
    // read down a telephone last month now means a different liner. My own
    // test caught that; the counter only ever goes up.
    //
    // The MAX is still consulted, for rows that were named before the counter
    // existed. Whatever was typed wins over both, because somebody naming one
    // by hand means it.
    const [[used]] = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(code, '-', -1) AS UNSIGNED)), 0) AS n
         FROM envelope_linear_items
        WHERE category_id = ? AND code REGEXP '-[0-9]+$'`, [id]);
    const nextNumber = Math.max(Number(cat.code_next) || 0, Number(used.n) || 0) + 1;
    const code = clean(b.code, 60) || codeFor(cat.section, cat.category, nextNumber);

    // The words it will be found by. The browser sends the colours it saw
    // on the canvas as plain numbers and they are named here, so there is
    // one definition of "teal" rather than one per end of the wire.
    const seen = Array.isArray(b.colours) ? b.colours.slice(0, 8) : [];
    const colours = [...new Set(seen
      .filter(c => Array.isArray(c) && c.length >= 3)
      .map(c => colourName(c[0], c[1], c[2])))];
    const tags = tagsFor({ section: cat.section, category: cat.category, colours })
      .join(' ').slice(0, 500);

    const [out] = await db.query(
      `INSERT INTO envelope_linear_items
         (category_id, code, name, source_file, mime_type, bytes, thumb,
          width, height, sort_order, tags, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, code, clean(b.name, 255), clean(b.sourceFile, 255),
       full.mime, full.bytes, thumb.bytes,
       Number(b.width) || 0, Number(b.height) || 0, Number(last.n) + 1, tags]);

    // Remembered before anything else can be added, so two designs arriving
    // close together cannot be handed the same number.
    await db.query(
      'UPDATE envelope_linears SET code_next = GREATEST(COALESCE(code_next, 0), ?) WHERE id = ?',
      [nextNumber, id]);

    // The tile shows its first design, so a category that had none now has a
    // cover. Only when it has none: replacing it on every upload would make
    // the shelf change under somebody for no reason they asked for.
    await db.query(
      `UPDATE envelope_linears SET cover = ? WHERE id = ? AND cover IS NULL`,
      [thumb.bytes, id]);

    res.json({ success: true, id: out.insertId, code });
  } catch (err) {
    console.error('Envelope Linears item create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;
