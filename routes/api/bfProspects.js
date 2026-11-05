// ══════════════════════════════════════════════════════
// BELLA FIGURA DEALERS
//
// 395 shops and event planners that already sell a competitor's wedding
// stationery, read off their public find-us map. The third of these lists
// and the smallest: Prospects is the office's own 930, CC Prospects is
// 7,041 Carlson Craft retailers, and this is Bella Figura's.
//
// Its own table and its own screen rather than a "source" column on one of
// the others. They are different competitors gathered on different days and
// the office works them as separate rounds; sharing a table would make
// every count on either screen a question about which rows it meant.
//
// MOST FIELDS ARE BLANK, AND THAT IS THE DATA. The map shows only what each
// dealer chose to publish - 314 give a website, 136 an email, 47 a phone,
// and half have no street address because they work from home by
// appointment. So the useful filter here is not "has a phone" but "how do I
// reach this one at all", which is what the contact filter answers.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');

async function allowed(req, res, next) {
  try {
    if (await canSee(req.session.user, 'bfProspects')) return next();
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  } catch (err) {
    console.error('BF prospect access check failed:', err.message);
    return res.status(500).json({ success: false, error: 'Could not check access.' });
  }
}

const text = (v, n) => {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return s ? s.slice(0, n) : '';
};

// The only two the office named. Anything else is refused rather than
// stored, or the column becomes one nobody can filter on afterwards.
const STATUSES = ['active', 'inactive'];

const HAS_EMAIL = "IFNULL(email, '') <> ''";
const HAS_PHONE = "IFNULL(phone, '') <> ''";
const HAS_SOCIAL = "(IFNULL(instagram, '') <> '' OR IFNULL(facebook, '') <> '')";
const HAS_WEBSITE = "IFNULL(website, '') <> ''";
// Nowhere to write, nowhere to ring, nothing to look up. The ones worth
// knowing about: on the list and unreachable.
const UNREACHABLE = `NOT ${HAS_EMAIL} AND NOT ${HAS_PHONE} AND NOT ${HAS_WEBSITE} AND NOT ${HAS_SOCIAL}`;

/**
 * GET /api/bf-prospects/board — the states, and the totals above them.
 *
 * Counted in the database rather than by reading every row into the page
 * and adding them up there.
 */
router.get('/board', requireLogin, allowed, async (req, res) => {
  try {
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS dealers,
              COUNT(DISTINCT NULLIF(state, '')) AS states,
              COUNT(DISTINCT NULLIF(country, '')) AS countries,
              SUM(${HAS_EMAIL}) AS with_email,
              SUM(${HAS_PHONE}) AS with_phone,
              SUM(${HAS_WEBSITE}) AS with_website,
              SUM(${HAS_SOCIAL}) AS with_social,
              SUM(${UNREACHABLE}) AS unreachable,
              SUM(IFNULL(status,'') = '') AS no_status
         FROM bf_prospects`);

    const [states] = await db.query(
      `SELECT IFNULL(NULLIF(state, ''), '—') AS state,
              IFNULL(NULLIF(country, ''), '—') AS country,
              COUNT(*) AS dealers,
              SUM(${HAS_EMAIL}) AS with_email,
              SUM(${HAS_PHONE}) AS with_phone,
              COUNT(DISTINCT NULLIF(city, '')) AS towns
         FROM bf_prospects
        GROUP BY IFNULL(NULLIF(state, ''), '—'), IFNULL(NULLIF(country, ''), '—')
        ORDER BY dealers DESC, state ASC`);

    res.json({ success: true, totals, states });
  } catch (err) {
    console.error('BF board failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the board.' });
  }
});

/** GET /api/bf-prospects — the list, filtered. */
router.get('/', requireLogin, allowed, async (req, res) => {
  try {
    const where = [];
    const args = [];

    const state = text(req.query.state, 80);
    if (state) {
      if (state === '—') where.push("IFNULL(state, '') = ''");
      else { where.push('state = ?'); args.push(state); }
    }
    const country = text(req.query.country, 60);
    if (country) { where.push('country = ?'); args.push(country); }

    const q = text(req.query.q, 120);
    if (q) {
      where.push('(store_name LIKE ? OR city LIKE ? OR email LIKE ? OR phone LIKE ? OR zip LIKE ? OR website LIKE ?)');
      const like = '%' + q + '%';
      args.push(like, like, like, like, like, like);
    }

    if (req.query.has === 'email') where.push(HAS_EMAIL);
    if (req.query.has === 'phone') where.push(HAS_PHONE);
    if (req.query.has === 'website') where.push(HAS_WEBSITE);
    if (req.query.has === 'social') where.push(HAS_SOCIAL);
    if (req.query.has === 'none') where.push(UNREACHABLE);

    // "Clients by Appointment" and the like. It decides whether somebody can
    // be walked in on or has to be written to first.
    if (req.query.visit === 'appointment') where.push("IFNULL(visitor_policy,'') <> ''");
    if (req.query.visit === 'open') where.push("IFNULL(visitor_policy,'') = ''");

    const status = text(req.query.status, 20).toLowerCase();
    if (status === 'none') where.push("IFNULL(status, '') = ''");
    else if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }

    const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));

    const [[count]] = await db.query('SELECT COUNT(*) AS n FROM bf_prospects' + sql, args);
    const [rows] = await db.query(
      `SELECT id, store_name, address, city, state, zip, country, phone, email,
              website, instagram, facebook, visitor_policy,
              status, remark, status_updated_by, status_updated_at
         FROM bf_prospects${sql}
        ORDER BY state ASC, city ASC, store_name ASC
        LIMIT ${limit}`, args);

    res.json({ success: true, total: count.n, shown: rows.length, rows });
  } catch (err) {
    console.error('Listing BF dealers failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the list.' });
  }
});

/**
 * PUT /api/bf-prospects/:id — the status and the remark on one dealer.
 *
 * These two are all this route will write. The rest of the row came off
 * Bella Figura's map and is traceable back to it by source_row; letting the
 * screen edit a dealer's own name or address would quietly break that.
 */
router.put('/:id', requireLogin, allowed, express.json(), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such row.' });
    }
    const out = await writeStatus([id], req.body, req.session.user);
    if (out.error) return res.status(400).json({ success: false, error: out.error });
    if (!out.changed) return res.status(404).json({ success: false, error: 'No such row.' });
    res.json({ success: true, status: out.status, remark: out.remark });
  } catch (err) {
    console.error('Saving a BF dealer failed:', err);
    res.status(500).json({ success: false, error: 'Could not save it.' });
  }
});

// Far more than anybody selects by hand, and short of a request that would
// sit there rewriting the whole table.
const MAX_BULK = 2000;

/**
 * PUT /api/bf-prospects/bulk/status — the same status on a batch.
 *
 * The remark is left alone here on purpose: one note is about one dealer,
 * and writing the same sentence onto two hundred rows would destroy
 * whatever was already on them.
 */
router.put('/bulk/status', requireLogin, allowed, express.json(), async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Nothing was selected.' });
    if (ids.length > MAX_BULK) {
      return res.status(400).json({
        success: false,
        error: `That is ${ids.length} rows — ${MAX_BULK} at a time is the limit.`,
      });
    }
    const out = await writeStatus(ids, { status: req.body.status }, req.session.user, true);
    if (out.error) return res.status(400).json({ success: false, error: out.error });
    res.json({ success: true, changed: out.changed, status: out.status });
  } catch (err) {
    console.error('BF bulk status failed:', err);
    res.status(500).json({ success: false, error: 'Could not save them.' });
  }
});

/**
 * The one writer, used by both routes above.
 *
 * `statusOnly` is the bulk case, where the remark must not be touched.
 * An empty status is allowed and means "clear it" - putting a row back into
 * the not-looked-at pile has to be possible, or a mis-click is permanent.
 */
async function writeStatus(ids, body, user, statusOnly) {
  const raw = String((body && body.status) || '').trim().toLowerCase();
  if (raw && !STATUSES.includes(raw)) {
    return { error: 'The status has to be Active or Inactive, or empty.' };
  }
  const status = raw || null;
  const who = (user && user.email) || '';

  if (statusOnly) {
    const [r] = await db.query(
      `UPDATE bf_prospects SET status = ?, status_updated_by = ?, status_updated_at = NOW()
        WHERE id IN (?)`, [status, who, ids]);
    return { changed: r.affectedRows, status };
  }

  const remark = String((body && body.remark) || '').trim().slice(0, 2000);
  const [r] = await db.query(
    `UPDATE bf_prospects
        SET status = ?, remark = ?, status_updated_by = ?, status_updated_at = NOW()
      WHERE id IN (?)`, [status, remark || null, who, ids]);
  return { changed: r.affectedRows, status, remark };
}

module.exports = router;
