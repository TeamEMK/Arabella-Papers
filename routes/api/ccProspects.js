// ══════════════════════════════════════════════════════
// CARLSON CRAFT RETAILERS
//
// 7,041 shops that already sell a competitor's wedding stationery, read off
// their own find-a-retailer page. The board is by state because that is how
// the work divides: somebody takes a state, works its regions, and moves on.
//
// It was read-only to begin with, because nothing had been done with any of
// them. The office now works the list, so each row carries a status - active
// or inactive - and a remark. Neither is seeded: a shop nobody has looked at
// has no status, and blank says that honestly where "Active" would have been
// the app inventing an opinion on seven thousand businesses.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');
const address = require('../../utils/prospectAddress');
const toProspect = require('../../utils/toProspect');

async function allowed(req, res, next) {
  try {
    if (await canSee(req.session.user, 'bellaPapers')) return next();
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

// The only two the office named. Anything else is refused rather than
// stored, because a column with three spellings of "active" in it is a column
// nobody can filter on afterwards.
const STATUSES = ['active', 'inactive'];

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

    // 'none' is its own answer, and the useful one: it is the pile nobody has
    // been through yet.
    const status = text(req.query.status, 20).toLowerCase();
    if (status === 'none') where.push("IFNULL(status, '') = ''");
    else if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }

    const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));

    const [[count]] = await db.query('SELECT COUNT(*) AS n FROM cc_prospects' + sql, args);
    const [rows] = await db.query(
      `SELECT id, retailer, state, state_code, region, city, address, suite, zip,
              phone, email, website, store_type, notes,
              status, remark, status_updated_by, status_updated_at,
              address_edited_by, address_edited_at, prospect_id
         FROM cc_prospects${sql}
        ORDER BY state ASC, city ASC, retailer ASC
        LIMIT ${limit}`, args);

    res.json({ success: true, total: count.n, shown: rows.length, rows });
  } catch (err) {
    console.error('Listing CC retailers failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the list.' });
  }
});

/**
 * PUT /api/cc-prospects/:id — the status, the remark, and the address.
 *
 * The address was read off somebody else's find-a-retailer page and some of
 * it is wrong, so the five address fields may be corrected here - see
 * utils/prospectAddress.js. Everything else still comes from the workbook
 * and is left alone: the retailer's own name, the region, the source row.
 */
router.put('/:id', requireLogin, allowed, express.json(), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'No such row.' });
    }
    const where = address.fromBody(req.body);
    if (where.error) return res.status(400).json({ success: false, error: where.error });
    if (Object.keys(where.set).length) {
      const saved = await writeAddress(id, where.set, req.session.user);
      if (saved.error) return res.status(400).json({ success: false, error: saved.error });
    }

    const out = await writeStatus([id], req.body, req.session.user);
    if (out.error) return res.status(400).json({ success: false, error: out.error });
    if (!out.changed) return res.status(404).json({ success: false, error: 'No such row.' });
    res.json({ success: true, status: out.status, remark: out.remark,
               openedProspects: out.opened || 0 });
  } catch (err) {
    console.error('Saving a CC retailer failed:', err);
    res.status(500).json({ success: false, error: 'Could not save it.' });
  }
});

// How many may be set in one go. Far more than anybody selects by hand, and
// short of a request that would sit there rewriting the whole table.
const MAX_BULK = 2000;

/**
 * PUT /api/cc-prospects/bulk — the same status on a batch.
 *
 * The office asked for this because the list is 7,041 long and marking them
 * one at a time is not work anybody would finish. The remark is left alone
 * here on purpose: one note is about one shop, and writing the same sentence
 * onto two hundred rows would destroy whatever was already on them.
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
    res.json({ success: true, changed: out.changed, status: out.status,
               openedProspects: out.opened || 0 });
  } catch (err) {
    console.error('Bulk status failed:', err);
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

  // ACTIVE MEANS SOMEBODY IS GOING TO WORK THIS ONE, and working a shop
  // means samples, outreach and bounced mail - which live on the Prospects
  // list and have nowhere to go on this table. So Active opens it there.
  //
  // After the status is written, not before: if the update finds nothing,
  // nothing should have been opened. And it never throws out of here - a
  // status the office just set must not fail to save because the Prospects
  // list was unwell. Only Active does this; clearing a status afterwards
  // leaves the prospect alone, because by then somebody may have written on
  // it.
  const openProspects = async () => {
    if (status !== 'active') return 0;
    try {
      const [rows] = await db.query(
        'SELECT * FROM cc_prospects WHERE id IN (?)', [ids]);
      const made = await toProspect.open(db, 'cc', rows, user);
      return made.size;
    } catch (err) {
      console.error('Opening prospects from cc_prospects failed:', err.message);
      return 0;
    }
  };

  if (statusOnly) {
    const [r] = await db.query(
      `UPDATE cc_prospects SET status = ?, status_updated_by = ?, status_updated_at = NOW()
        WHERE id IN (?)`, [status, who, ids]);
    return { changed: r.affectedRows, status, opened: await openProspects() };
  }

  const remark = String((body && body.remark) || '').trim().slice(0, 2000);
  const [r] = await db.query(
    `UPDATE cc_prospects
        SET status = ?, remark = ?, status_updated_by = ?, status_updated_at = NOW()
      WHERE id IN (?)`, [status, remark || null, who, ids]);
  return { changed: r.affectedRows, status, remark, opened: await openProspects() };
}

/**
 * The corrected address, and the two-letter code that has to follow the state.
 *
 * THE CODE IS NOT TAKEN FROM THE SCREEN. state_code is what the badge on
 * every row prints and what the board groups by, and a row carrying "Texas"
 * with a code of "AL" would sit under the wrong state on a board built from
 * 7,041 rows. So the code is looked up from the other rows in that state -
 * the list already holds all fifty - and cleared when the state is one the
 * list has never seen, which is honest where a stale code would not be.
 */
async function writeAddress(id, set, user) {
  if (set.state !== undefined) {
    if (!set.state) {
      return { error: 'A shop has to be in a state.' };
    }
    const [[known]] = await db.query(
      `SELECT state_code FROM cc_prospects
        WHERE state = ? AND IFNULL(state_code,'') <> '' LIMIT 1`, [set.state]);
    set.state_code = known ? known.state_code : null;
  }
  const cols = Object.keys(set);
  await db.query(
    `UPDATE cc_prospects SET ${cols.map(c => `\`${c}\` = ?`).join(', ')},
            address_edited_by = ?, address_edited_at = NOW()
      WHERE id = ?`,
    [...cols.map(c => set[c]), (user && user.email) || '', id]);
  return {};
}

module.exports = router;
