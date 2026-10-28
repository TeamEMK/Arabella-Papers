// ══════════════════════════════════════════════════════
// PROSPECTS
//
// The dealers and stationers being worked on. Read, searched and edited
// here; brought in by scripts/import-prospects.js.
//
// Rough first pass, for the client to look at and say what is wrong with it.
// Everything the spreadsheet held is kept and shown, because at this stage
// nobody can say which column is dead - and a column dropped to tidy the
// screen is somebody's note about a customer gone for good.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');

async function allowed(req, res, next) {
  try {
    if (await canSee(req.session.user, 'prospects')) return next();
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  } catch (err) {
    console.error('Prospect access check failed:', err.message);
    return res.status(500).json({ success: false, error: 'Could not check access.' });
  }
}

const text = (v, n) => {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return s ? s.slice(0, n) : null;
};

// An address the office already knows bounces. 292 of them, which is worth
// seeing before somebody sends to it again.
const DEAD_MAIL = `(
  LOWER(IFNULL(mail_outcome, '')) LIKE '%not found%'
  OR LOWER(IFNULL(mail_outcome, '')) LIKE '%fail%'
  OR LOWER(IFNULL(status, '')) LIKE '%bounce%'
)`;

// GET /api/prospects — the list, searched and filtered.
router.get('/', requireLogin, allowed, async (req, res) => {
  try {
    const where = [];
    const args = [];

    const q = text(req.query.q, 120);
    if (q) {
      where.push(`(company_name LIKE ? OR contact_person LIKE ? OR email LIKE ?
                   OR city LIKE ? OR website LIKE ? OR phone LIKE ?)`);
      const like = '%' + q + '%';
      args.push(like, like, like, like, like, like);
    }
    for (const [param, column] of [['status', 'status'], ['state', 'state'],
                                   ['country', 'country'], ['pricing', 'pricing'],
                                   ['source', 'lead_source']]) {
      const v = text(req.query[param], 160);
      if (v) { where.push(column + ' = ?'); args.push(v); }
    }
    if (req.query.mail === 'dead') where.push(DEAD_MAIL);
    if (req.query.mail === 'ok') where.push('NOT ' + DEAD_MAIL + ' AND IFNULL(email, "") <> ""');
    if (req.query.needsName === '1') where.push('needs_name = 1');

    const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));

    const [[count]] = await db.query('SELECT COUNT(*) AS n FROM prospects' + sql, args);
    const [rows] = await db.query(
      `SELECT *, ${DEAD_MAIL} AS mail_dead FROM prospects${sql}
        ORDER BY company_name ASC LIMIT ${limit}`, args);

    res.json({ success: true, total: count.n, shown: rows.length, rows });
  } catch (err) {
    console.error('Listing prospects failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the list.' });
  }
});

// GET /api/prospects/filters — what is actually in the data, for the
// dropdowns. Read from the rows rather than written out here, so a status
// the office invents next month appears on its own.
router.get('/filters', requireLogin, allowed, async (req, res) => {
  try {
    const one = async (column) => {
      const [rows] = await db.query(
        `SELECT ${column} AS v, COUNT(*) AS n FROM prospects
          WHERE IFNULL(${column}, '') <> '' GROUP BY v ORDER BY n DESC`);
      return rows;
    };
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS all_rows,
              SUM(IFNULL(email, '') <> '') AS with_email,
              SUM(${DEAD_MAIL}) AS dead_mail,
              SUM(needs_name = 1) AS needs_name
         FROM prospects`);
    res.json({
      success: true,
      totals,
      status: await one('status'),
      state: await one('state'),
      country: await one('country'),
      pricing: await one('pricing'),
      lead_source: await one('lead_source'),
    });
  } catch (err) {
    console.error('Prospect filters failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the filters.' });
  }
});

// The fields somebody can change from the screen. Not a free-for-all over
// every column: the imported history - what was sent, what bounced - is a
// record of what happened and is not edited by hand.
const EDITABLE = {
  company_name: 255, contact_person: 200, address: 400, city: 120, state: 120,
  country: 120, zipcode: 40, phone: 80, cell: 80, second_phone: 80, fax: 80,
  email: 255, second_email: 255, website: 400, facebook: 400, instagram: 400,
  status: 120, pricing: 60, lead_source: 160, comments: 2000,
};

// PUT /api/prospects/:id
router.put('/:id', requireLogin, allowed, async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    const sets = [];
    const args = [];
    for (const [field, max] of Object.entries(EDITABLE)) {
      if (!(field in req.body)) continue;
      sets.push(field + ' = ?');
      args.push(text(req.body[field], max));
    }
    if (!sets.length) return res.json({ success: false, error: 'Nothing to change.' });

    // A name was the one thing missing on the rescued rows, so filling it in
    // is what clears the flag.
    if ('company_name' in req.body && text(req.body.company_name, 255)) {
      sets.push('needs_name = 0');
    }

    args.push(id);
    const [out] = await db.query('UPDATE prospects SET ' + sets.join(', ') + ' WHERE id = ?', args);
    if (!out.affectedRows) return res.json({ success: false, error: 'No such row.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Updating a prospect failed:', err);
    res.status(500).json({ success: false, error: 'Could not save.' });
  }
});

module.exports = router;
