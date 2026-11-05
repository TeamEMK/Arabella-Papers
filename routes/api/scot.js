// ══════════════════════════════════════════════════════
// S.C.O.T. — THE CALLING LIST, IN THE APP
//
// utils/scot.js writes the grid: one row per client, one column per day, the
// number of orders in the cell. The sheet's own Dashboard tab reads that grid
// and works out each client's ordering rhythm and when they are due again.
// That working-out stays in the sheet - it is the office's, they change it,
// and copying the formulas here would give two answers to one question.
//
// This reads the answer. Who is overdue for a call, longest wait first, on
// the dashboard people already have open, instead of in a tab they have to
// remember to go and look at.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { requireLogin } = require('../../middleware/auth');
const sheets = require('../../utils/sheets');
const scot = require('../../utils/scot');
const db = require('../../config/db');

// ── THE OFFICE'S OWN NOTE ON A CLIENT ──
//
// The sheet stays the sheet. It does the thinking - the rhythm, the expected
// date, how late somebody is - and nothing here writes back into it: our rows
// beside their formulas is one bad cell reference away from changing a number
// a meeting relies on.
//
// So a status and a remark live in our database and are joined on by name.
// The join key is a tidied name, because the sheet is typed into by hand and
// "Smith & Co" and "smith  &  co" are one client.
const STATUSES = ['active', 'inactive'];
const keyFor = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 190);

/** Every note, by key, for stitching onto the list. */
async function notesByKey() {
  try {
    const [rows] = await db.query(
      'SELECT client_key, status, remark, updated_by, updated_at FROM scot_notes');
    return new Map(rows.map(r => [r.client_key, r]));
  } catch (err) {
    // A note is an extra, not the list. Losing them must not lose the
    // calling list, which is the thing somebody opened the page for.
    console.error('[scot] notes unavailable:', err.message);
    return new Map();
  }
}

const TAB = 'Dashboard';
// 1216 rows allocated, 106 with a name in them. Reading the lot takes about
// three seconds, so the range is capped rather than asking for the sheet's
// full height.
const RANGE = `'${TAB}'!A1:L2000`;

// Three seconds is far too long to pay on every dashboard open, and the list
// moves when somebody punches an order - a few times a day. Ten minutes is
// well inside that.
//
// On Vercel the container is frozen between requests, so this mostly helps a
// busy stretch rather than all day; it costs nothing either way.
const CACHE_MS = Number(process.env.SCOT_LIST_CACHE_MS || 10 * 60 * 1000);
let _cache = null;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                 jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** The sheet writes its dates as 24-Jun-2026. */
function parseDay(v) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(v || '').trim());
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (mo === undefined) return null;
  return Date.UTC(Number(m[3]), mo, Number(m[1]));
}

/** Today in IST, as a UTC midnight, so the two can be subtracted. */
function todayIST() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

const num = (v) => {
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

async function readList() {
  if (_cache && Date.now() < _cache.expires) return _cache.data;

  const rows = await sheets.readValues(scot.SHEET_ID, RANGE, { fresh: true });
  const today = todayIST();

  const list = [];
  // Row 1 is the heading.
  for (const r of rows.slice(1)) {
    const name = String(r[1] || '').trim();
    if (!name) continue;

    const nextAt = parseDay(r[11]);
    // Days past the day they were expected. Negative means still to come, and
    // the sheet's own blank expected date leaves it null rather than 0, which
    // would read as "due today".
    const late = nextAt === null ? null : Math.round((today - nextAt) / 86400000);

    list.push({
      client: name,
      // Free text in the sheet: Weekly, Monthly, 15 days, 45 days, or blank
      // where there is not enough history to say.
      frequency: String(r[3] || '').trim(),
      lastOrder: String(r[5] || '').trim(),
      daysSince: num(r[7]),
      totalOrders: num(r[8]),
      expectedNext: String(r[11] || '').trim(),
      late,
      // Three of the sheet's columns are named Value but hold counts - the
      // grid records how MANY orders were punched, never what they were
      // worth, because the amount is only known weeks later at dispatch. They
      // are left out rather than shown under a name that would be read as
      // money.
    });
  }

  // Longest wait first; anyone with no expected date goes last rather than
  // being treated as on time.
  list.sort((a, b) => (b.late === null ? -Infinity : b.late) - (a.late === null ? -Infinity : a.late));

  const data = {
    list,
    due: list.filter(c => c.late !== null && c.late >= 0).length,
    soon: list.filter(c => c.late !== null && c.late < 0 && c.late >= -7).length,
    total: list.length,
    readAt: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${scot.SHEET_ID}/edit`,
  };
  _cache = { data, expires: Date.now() + CACHE_MS };
  return data;
}

/**
 * GET /api/scot/calling-list
 *
 * ?fresh=1 skips the cache, for the Refresh button.
 */
router.get('/calling-list', requireLogin, async (req, res) => {
  try {
    if (req.query.fresh === '1') _cache = null;
    const data = await readList();
    // Stitched on here rather than inside readList, which is cached for ten
    // minutes: a note saved a second ago has to show on the next draw, and
    // the sheet read is the slow part, not this.
    const notes = await notesByKey();
    const list = data.list.map((c) => {
      const n = notes.get(keyFor(c.client));
      return Object.assign({}, c, {
        status: (n && n.status) || '',
        remark: (n && n.remark) || '',
        noteBy: (n && n.updated_by) || '',
      });
    });
    res.json({ success: true, ...data, list });
  } catch (err) {
    console.error('SCOT calling list failed:', err);
    // Google's own message is the useful one - "Unable to parse range",
    // "caller does not have permission", "Requested entity was not found" -
    // so it goes through rather than being flattened to "server error".
    const detail = (err.errors && err.errors[0] && err.errors[0].message) || err.message;
    res.status(500).json({ success: false, error: detail || 'Could not read the SCOT sheet.' });
  }
});

/**
 * PUT /api/scot/note — the status and the remark on one client.
 *
 * Keyed by the client's name, because that is all the sheet gives us to
 * identify a row by. A client renamed in the sheet therefore starts with a
 * blank note rather than picking up somebody else's - the old one is kept,
 * under the old name, instead of being silently reattached.
 */
router.put('/note', requireLogin, express.json(), async (req, res) => {
  try {
    const name = String((req.body && req.body.client) || '').trim().slice(0, 255);
    if (!name) return res.status(400).json({ success: false, error: 'Which client?' });

    const raw = String((req.body && req.body.status) || '').trim().toLowerCase();
    if (raw && !STATUSES.includes(raw)) {
      return res.status(400).json({ success: false, error: 'The status has to be Active or Inactive, or empty.' });
    }
    const status = raw || null;
    const remark = String((req.body && req.body.remark) || '').trim().slice(0, 2000) || null;

    // Nothing to say about somebody is not a row worth keeping, and leaving
    // one behind makes the table a list of everybody anyone ever opened.
    if (!status && !remark) {
      await db.query('DELETE FROM scot_notes WHERE client_key = ?', [keyFor(name)]);
      return res.json({ success: true, status: '', remark: '' });
    }

    await db.query(
      `INSERT INTO scot_notes (client_key, client_name, status, remark, updated_by)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE client_name = VALUES(client_name), status = VALUES(status),
                               remark = VALUES(remark), updated_by = VALUES(updated_by)`,
      [keyFor(name), name, status, remark, (req.session.user && req.session.user.email) || '']);

    res.json({ success: true, status: status || '', remark: remark || '' });
  } catch (err) {
    console.error('Saving a SCOT note failed:', err);
    res.status(500).json({ success: false, error: 'Could not save it.' });
  }
});

module.exports = router;
module.exports.keyFor = keyFor;
