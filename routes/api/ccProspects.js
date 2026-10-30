// ══════════════════════════════════════════════════════
// CARLSON CRAFT RETAILERS
//
// 7,041 shops that already sell a competitor's wedding stationery, read off
// their own find-a-retailer page. The board is by state because that is how
// the work divides: somebody takes a state, works its regions, and moves on.
//
// Read-only. Nothing has been done with any of these yet, so there is
// nothing to edit; when the office decides how it wants to work them, that
// is the moment to add the columns for it, not before.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');

async function allowed(req, res, next) {
  try {
    if (await canSee(req.session.user, 'ccProspects')) return next();
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  } catch (err) {
    console.error('CC prospect access check failed:', err.message);
    return res.status(500).json({ success: false, error: 'Could not check access.' });
  }
}

const text = (v, n) => {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return s ? s.slice(0, n) : '';
};

const HAS_EMAIL = "IFNULL(email, '') <> ''";
const HAS_PHONE = "IFNULL(phone, '') <> ''";
const ONLINE = "store_type LIKE '%nline%'";

/**
 * GET /api/cc-prospects/board — the fifty states, and the totals above them.
 *
 * Counted in the database rather than by reading 7,041 rows into the page
 * and adding them up there: the board is the first thing drawn and the list
 * underneath it is paged.
 */
router.get('/board', requireLogin, allowed, async (req, res) => {
  try {
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS retailers,
              COUNT(DISTINCT state) AS states,
              COUNT(DISTINCT region) AS regions,
              SUM(${HAS_EMAIL}) AS with_email,
              SUM(${HAS_PHONE}) AS with_phone,
              SUM(${ONLINE}) AS online_only
         FROM cc_prospects`);

    const [states] = await db.query(
      `SELECT state, MAX(state_code) AS state_code,
              COUNT(*) AS retailers,
              COUNT(DISTINCT region) AS regions,
              COUNT(DISTINCT city) AS cities,
              SUM(${HAS_EMAIL}) AS with_email,
              SUM(${HAS_PHONE}) AS with_phone,
              SUM(${ONLINE}) AS online_only
         FROM cc_prospects
        GROUP BY state
        ORDER BY retailers DESC`);

    res.json({ success: true, totals, states });
  } catch (err) {
    console.error('CC board failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the board.' });
  }
});

// GET /api/cc-prospects/regions?state= — the areas inside one state.
router.get('/regions', requireLogin, allowed, async (req, res) => {
  try {
    const state = text(req.query.state, 80);
    if (!state) return res.json({ success: false, error: 'Which state?' });
    const [rows] = await db.query(
      `SELECT region, COUNT(*) AS retailers,
              SUM(${HAS_EMAIL}) AS with_email, SUM(${HAS_PHONE}) AS with_phone
         FROM cc_prospects WHERE state = ?
        GROUP BY region ORDER BY retailers DESC`, [state]);
    res.json({ success: true, rows });
  } catch (err) {
    console.error('CC regions failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the regions.' });
  }
});

// GET /api/cc-prospects — the retailers themselves.
router.get('/', requireLogin, allowed, async (req, res) => {
  try {
    const where = [];
    const args = [];

    const state = text(req.query.state, 80);
    if (state) { where.push('state = ?'); args.push(state); }
    const region = text(req.query.region, 160);
    if (region) { where.push('region = ?'); args.push(region); }

    const q = text(req.query.q, 120);
    if (q) {
      where.push('(retailer LIKE ? OR city LIKE ? OR email LIKE ? OR phone LIKE ? OR zip LIKE ?)');
      const like = '%' + q + '%';
      args.push(like, like, like, like, like);
    }

    if (req.query.has === 'email') where.push(HAS_EMAIL);
    if (req.query.has === 'phone') where.push(HAS_PHONE);
    if (req.query.has === 'neither') where.push(`NOT ${HAS_EMAIL} AND NOT ${HAS_PHONE}`);
    if (req.query.type === 'online') where.push(ONLINE);
    if (req.query.type === 'store') where.push(`NOT ${ONLINE}`);

    const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));

    const [[count]] = await db.query('SELECT COUNT(*) AS n FROM cc_prospects' + sql, args);
    const [rows] = await db.query(
      `SELECT id, retailer, state, state_code, region, city, address, suite, zip,
              phone, email, website, store_type, notes
         FROM cc_prospects${sql}
        ORDER BY state ASC, city ASC, retailer ASC
        LIMIT ${limit}`, args);

    res.json({ success: true, total: count.n, shown: rows.length, rows });
  } catch (err) {
    console.error('Listing CC retailers failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the list.' });
  }
});

module.exports = router;
