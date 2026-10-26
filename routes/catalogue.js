const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ══════════════════════════════════════════════════════
// DESIGN CATALOGUE — the public half
//
// The link the client gives their customers. No login, and nothing here
// reaches anything but the catalogue table: no orders, no clients, no names.
// Whatever the admin page puts up shows here on the next page load, and
// whatever it hides stops showing.
//
// Deliberately separate from routes/api/catalogue.js. The admin half is all
// behind requireLogin and a role check; keeping the two in one file is how
// an unguarded route eventually appears next to a guarded one and reads as
// though it were covered too.
// ══════════════════════════════════════════════════════

// GET /catalogue — the page.
router.get('/', (req, res) => {
  res.render('catalogue');
});

// GET /catalogue/api/items — only what is meant to be seen.
//
// is_active is filtered in SQL, not in the page. A hidden design must not
// travel to the browser at all: "not displayed" is not hidden when the reply
// is one right-click away.
router.get('/api/items', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, category, name, code
         FROM catalogue_items
        WHERE is_active = 1
        ORDER BY category, sort_order, id DESC`);
    res.json({
      success: true,
      categories: [...new Set(rows.map(r => r.category))],
      data: rows,
    });
  } catch (err) {
    console.error('Public catalogue failed:', err);
    res.status(500).json({ success: false, error: 'Could not load the catalogue just now.' });
  }
});

// GET /catalogue/image/:id — the picture itself.
router.get('/image/:id', async (req, res) => {
  try {
    const [[item]] = await db.query(
      'SELECT mime_type, bytes FROM catalogue_items WHERE id = ? AND is_active = 1',
      [parseInt(req.params.id, 10)]);
    // A hidden item answers exactly as a missing one does. Anything else and
    // the gap between the two says which ids are real.
    if (!item || !item.bytes) return res.status(404).send('Not found.');

    res.setHeader('Content-Type', item.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', item.bytes.length);
    // A catalogue picture changes about never, and this page is meant to be
    // opened by a lot of people who are not paying for the bandwidth.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(item.bytes);
  } catch (err) {
    console.error('Catalogue image failed:', err);
    res.status(500).send('Could not load that image.');
  }
});

module.exports = router;
