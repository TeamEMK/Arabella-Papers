// ══════════════════════════════════════════════════════
// S.C.O.T. SHEET
// A calling list. One row per dealer, one column per day of the year, and a
// number in the cell on every day that dealer ordered. The sheet's own
// Dashboard tab reads those numbers and works out when each dealer is due to
// order again - so all this side has to do is keep the grid true.
//
// The cell holds the NUMBER OF ORDERS punched that day, not their value. The
// invoice amount is only known weeks later at dispatch, and fewer than a third
// of orders ever carry one, so a sheet built on money would show most dealers
// as having ordered nothing and would call in the wrong people.
//
// Nothing here may break punching an order. Every entry point swallows its own
// errors: a sheet that is unreachable, unshared or renamed must cost the office
// a stale calling list, never the ability to take work in.
// ══════════════════════════════════════════════════════
const db = require('../config/db');
const sheets = require('./sheets');

// The sheet itself. An environment variable wins so a second office, or a test
// copy, does not need a code change - but the address is here so the feature
// works the moment it deploys.
const SHEET_ID = process.env.SCOT_SHEET_ID
  || '1TipQSaLAHHqrPiG_TVg23r8IGKTggtkyYv5eWIJ9MWE';
const TAB = process.env.SCOT_SHEET_TAB || 'SCOT Sheet';

// Rows 1-4 are the title, a blank, the band headings and the column names.
const FIRST_ROW = 5;
// Column A is =ROW()-4 and numbers itself. Everything this file writes starts
// at B, and the day grid starts at N.
const FIRST_GRID_COL = 14;

// Names that cannot be a row on a calling list.
//
// A blank one, because that would collect every unnamed order in the office
// under a single heading. And Local Order, which is the bucket walk-in work is
// punched against rather than a person - at 196 orders it was the longest line
// on the sheet, and there is nobody behind it to ring.
const NOT_A_CLIENT = new Set(['', 'local order']);

// How far back to fill. Nothing by default - the sheet's own calendar decides,
// which is the only answer that cannot drift.
//
// It was a fixed date once, and the two sides then disagreed: the sheet was
// filled from April while a punch rewrote the dealer's row from August, wiping
// four months off that one line and no other. Reading the first day of the
// grid means the fill and the sync are always asking for the same window.
const FROM_DAY = process.env.SCOT_FROM || null;

/** The first day the sheet has a column for. */
async function firstDay() {
  if (FROM_DAY) return FROM_DAY;
  const days = [...(await calendar()).keys()].sort();
  return days[0];
}

// ── small helpers ─────────────────────────────────────

/** 1 -> "A", 27 -> "AA". Sheets ranges are written in letters, not numbers. */
function colLetters(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The day, with the clock thrown away, as the office reckons it. */
function dayKey(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * A Sheets date serial back to a day. Sheets counts from 30 December 1899,
 * which is one of the two dates in the world that are famously off by one.
 */
function serialToDay(serial) {
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── the sheet's own calendar ──────────────────────────
// Read rather than calculated. The grid could start on a different day next
// year, and a column worked out from a hard-coded 6 April would then write
// every order into the wrong day without anything looking wrong.
let _calendar = null;

async function calendar() {
  if (_calendar) return _calendar;
  const api = await sheets.getReadClient();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!${colLetters(FIRST_GRID_COL)}4:ZZ4`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const row = (res.data.values || [])[0] || [];
  const byDay = new Map();
  row.forEach((v, i) => {
    if (typeof v === 'number' && v > 0) byDay.set(serialToDay(v), FIRST_GRID_COL + i);
  });
  if (!byDay.size) throw new Error(`'${TAB}' row 4 me koi date column nahi mila`);
  _calendar = byDay;
  return byDay;
}

function forgetCalendar() { _calendar = null; }

// ── which row belongs to which dealer ─────────────────

/**
 * Every dealer already on the sheet, and the first row going spare.
 *
 * Matched on the name lowered and trimmed: the sheet is typed in by hand and
 * "Fairy Tale Affairs Mp" turning up as "fairy tale affairs mp" must not open
 * a second row for the same person.
 */
async function rowIndex() {
  const rows = await sheets.readValues(SHEET_ID, `'${TAB}'!B${FIRST_ROW}:B404`, { fresh: true });
  const byName = new Map();
  let firstFree = FIRST_ROW;
  rows.forEach((r, i) => {
    const name = String((r && r[0]) || '').trim();
    if (!name) return;
    byName.set(name.toLowerCase(), FIRST_ROW + i);
    firstFree = Math.max(firstFree, FIRST_ROW + i + 1);
  });
  return { byName, firstFree };
}

// ── how often this dealer orders ──────────────────────

/**
 * The rhythm of a dealer's ordering, in the words the sheet's own Status
 * formula understands.
 *
 * It reads a number out of this text - "15 days" gives 15, "Weekly" gives
 * nothing and falls back to 7 - and calls a dealer overdue once that many days
 * have passed. So the wording matters more than it looks.
 *
 * Worked out from the whole history, not just the part that fits on the grid:
 * six weeks of orders is a thin basis for saying someone orders every 45 days.
 * Under two order days there is no gap to measure and this returns nothing,
 * which leaves the two columns blank rather than inventing a rhythm.
 */
function frequencyFrom(days) {
  const uniq = [...new Set(days)].sort();
  if (uniq.length < 2) return null;
  let total = 0;
  for (let i = 1; i < uniq.length; i++) {
    total += (Date.parse(uniq[i]) - Date.parse(uniq[i - 1])) / 86400000;
  }
  const avg = total / (uniq.length - 1);
  if (avg <= 10) return { label: 'Weekly', days: 7 };
  if (avg <= 20) return { label: '15 days', days: 15 };
  if (avg <= 37) return { label: 'Monthly', days: 30 };
  return { label: '45 days', days: 45 };
}

// ── what the database says about a dealer ─────────────

/**
 * Every day this dealer ordered, and how many orders on each.
 *
 * `from` limits what goes on the grid; the frequency is always measured over
 * everything. Deleted orders are left out of both - the office deletes an order
 * when it should never have existed, and counting it would keep calling a
 * dealer about work nobody is doing.
 */
async function dealerHistory(dealerName, from) {
  const [rows] = await db.query(
    `SELECT DATE(timestamp) AS day, COUNT(*) AS n
       FROM orders
      WHERE is_deleted = 0 AND LOWER(TRIM(dealer_name)) = LOWER(TRIM(?))
      GROUP BY DATE(timestamp) ORDER BY day`,
    [dealerName],
  );
  const all = rows.map(r => dayKey(r.day));
  const onGrid = rows
    .map(r => ({ day: dayKey(r.day), n: Number(r.n) }))
    .filter(r => !from || r.day >= from);
  return { all, onGrid };
}

// ── writing ───────────────────────────────────────────

/**
 * Make sure "Date for calling" is formatted as a date all the way down.
 *
 * The column holds a formula that returns a date, and a date in Sheets is a
 * number - 18 September 2026 is 46283. Without a date format on the cell that
 * is exactly what shows. The first dozen rows carried the format from the
 * sample data they used to hold, and every row written below them came out as
 * a five-digit number.
 *
 * Applied to the whole column rather than the rows in use, so a dealer added
 * later lands on a cell that is already right.
 */
async function ensureCallDateFormat() {
  const tab = await sheets.findTabByTitle(SHEET_ID, TAB);
  if (!tab) throw new Error(`'${TAB}' tab nahi mila`);
  const api = await sheets.getWriteClient();
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: tab.sheetId,
            startRowIndex: FIRST_ROW - 1,
            endRowIndex: 404,
            startColumnIndex: 11,   // L
            endColumnIndex: 12,
          },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'd-MMM-yyyy' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      }],
    },
  });
}

/**
 * The ranges that carry one dealer's details, written as separate blocks so
 * the columns in between are never touched.
 *
 * Contact No. (C), Products Name (D), Product (F), Email Id (G) and Average
 * Order Size (I) are the office's own columns. Nothing in this system can fill
 * them - the orders table has no phone number and no product, every dealer's
 * email on file is the office's proofsdone@ inbox, and the grid counts orders
 * rather than money - so whatever somebody types there has to survive every
 * later sync. Writing B to M in one block would wipe all five.
 */
function detailRanges(name, freq, row) {
  const dash = row - 3;              // SCOT row 5 is Dashboard row 2
  return [
    { range: `'${TAB}'!B${row}`, values: [[name]] },   // Client Name
    { range: `'${TAB}'!E${row}`, values: [[name]] },   // Company Name
    { range: `'${TAB}'!H${row}`, values: [[name]] },   // Company Name again
    {
      range: `'${TAB}'!J${row}:M${row}`,
      values: [[
        freq ? freq.label : '',      // J  Order Frequency
        freq ? freq.days : '',       // K  Usual Order Days
        // Formulas, not values. Written as values they would be right on the
        // day of the sync and quietly wrong every day after it.
        `=IFERROR(Dashboard!L${dash},"")`,   // L  Date for calling
        `=IFERROR(Dashboard!H${dash},"")`,   // M  Frequency Of Calling
      ]],
    },
  ];
}

/**
 * Put one dealer's orders on the sheet.
 *
 * The count comes from the database rather than from adding one to what is
 * already in the cell, so running this twice leaves the same number as running
 * it once, and a correction in the system reaches the sheet on its own.
 *
 * Returns what it did, or null when there was nothing to do.
 */
async function syncDealer(dealerName, { from } = {}) {
  const name = String(dealerName || '').trim();
  if (!name || NOT_A_CLIENT.has(name.toLowerCase())) return null;

  const cal = await calendar();
  const { all, onGrid } = await dealerHistory(name, from || await firstDay());
  const freq = frequencyFrom(all);

  const { byName, firstFree } = await rowIndex();
  const row = byName.get(name.toLowerCase()) || firstFree;
  const isNew = !byName.has(name.toLowerCase());

  // The whole grid row, not only the days with orders. Writing just the busy
  // days would leave a number behind on a day whose order was later deleted,
  // and the sheet would go on calling a dealer about work that no longer
  // exists. Written in full, the row always says what the database says.
  const cols = [...cal.values()].sort((a, b) => a - b);
  const first = cols[0], last = cols[cols.length - 1];
  const line = new Array(last - first + 1).fill('');
  for (const { day, n } of onGrid) {
    const col = cal.get(day);
    if (col) line[col - first] = n;           // a day outside the sheet's year
  }

  const data = [
    ...detailRanges(name, freq, row),
    {
      range: `'${TAB}'!${colLetters(first)}${row}:${colLetters(last)}${row}`,
      values: [line],
    },
  ];

  const api = await sheets.getWriteClient();
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  sheets.invalidateSheet(SHEET_ID);

  // Only for a row that did not exist before. The format covers the whole
  // column, so doing this on every punch would be one wasted call each time.
  if (isNew) await ensureCallDateFormat();

  return { name, row, isNew, days: onGrid.length, frequency: freq && freq.label };
}

/**
 * Whether this process is allowed to write to the sheet at all.
 *
 * There is one calling sheet and every copy of this app knows its address, so
 * a developer punching a test order on their own machine rewrote the office's
 * row from their own database - Local Order went from 196 orders to 83 that
 * way, and it took a full re-run to put right.
 *
 * The deployment writes; anything else has to say so. SCOT_SYNC=on is the way
 * to test the sync locally on purpose, and scripts/scot-backfill.js does not
 * come through here - running it is already saying so.
 */
function syncAllowed() {
  return !!process.env.VERCEL || process.env.SCOT_SYNC === 'on';
}

/**
 * Called when an order is punched. Never throws.
 *
 * Awaited by the route rather than left running: on Vercel the container stops
 * the moment the response goes out, and a promise nobody waited for is simply
 * dropped.
 */
async function recordPunchedOrder(dealerName) {
  if (!syncAllowed()) return null;
  try {
    return await syncDealer(dealerName);
  } catch (err) {
    console.error(`[scot] ${dealerName}: sheet update nahi hua -`, err.message);
    return null;
  }
}

module.exports = {
  SHEET_ID, TAB, FIRST_ROW, FIRST_GRID_COL, NOT_A_CLIENT, FROM_DAY,
  colLetters, dayKey, serialToDay, firstDay,
  calendar, forgetCalendar, rowIndex,
  frequencyFrom, dealerHistory, detailRanges, ensureCallDateFormat,
  syncDealer, recordPunchedOrder, syncAllowed,
};
