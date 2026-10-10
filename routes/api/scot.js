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
    res.json({ success: true, ...(await readList()) });
  } catch (err) {
    console.error('SCOT calling list failed:', err);
    // Google's own message is the useful one - "Unable to parse range",
    // "caller does not have permission", "Requested entity was not found" -
    // so it goes through rather than being flattened to "server error".
    const detail = (err.errors && err.errors[0] && err.errors[0].message) || err.message;
    res.status(500).json({ success: false, error: detail || 'Could not read the SCOT sheet.' });
  }
});

module.exports = router;
