// ══════════════════════════════════════════════════════
// SPREADSHEET CELL HELPERS — pure functions, no network.
// Column letters ⇄ indexes, and the date reading that has to cope with a sheet
// where one column is DD/MM/YYYY and the next is MM/DD/YYYY.
// ══════════════════════════════════════════════════════

// Accepts a full Google Sheets URL or a bare id.
function extractSpreadsheetId(raw) {
  const s = (raw || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

// 'A' → 0, 'Z' → 25, 'AA' → 26. Returns -1 for an empty/absent column.
function colToIdx(col) {
  if (!col) return -1;
  const s = col.toUpperCase().trim();
  let idx = 0;
  for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.charCodeAt(i) - 64);
  return idx - 1;
}

function idxToCol(idx) {
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Parse a date out of a sheet cell — YYYY-MM-DD, DD/MM/YYYY or MM/DD/YYYY.
 *
 * `format` ('DMY' default, or 'MDY') decides which number is the day when both
 * are ≤ 12 and the value alone cannot say. Where one number is > 12 the value
 * settles it and the hint is ignored.
 *
 * `endOfDayIfNoTime` uses 23:59:59 when no time is present — a plan date is met
 * any time that day, so a bare date must not read as midnight.
 */
function parseSheetDate(val, endOfDayIfNoTime, format) {
  const s = (val || '').trim();
  if (!s) return null;
  const slashy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[ T](\d{1,2}:\d{2}(:\d{2})?))?/);
  const yyyymmdd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}:\d{2}(:\d{2})?))?/);

  const timePart = (time) => {
    if (!time) return endOfDayIfNoTime ? '23:59:59' : '00:00:00';
    const parts = time.split(':');
    let t = parts.map((p, i) => (i === 0 ? p.padStart(2, '0') : p)).join(':');
    if (t.length === 5) t += ':00';
    return t;
  };

  let d = null;
  if (slashy) {
    const [, a, b, yyyy, time] = slashy;
    const p1 = +a, p2 = +b;
    let dd, mm;
    if (p1 > 12 && p2 <= 12) { dd = p1; mm = p2; }        // unambiguous DD/MM
    else if (p2 > 12 && p1 <= 12) { dd = p2; mm = p1; }   // unambiguous MM/DD
    else if (format === 'MDY') { dd = p2; mm = p1; }      // ambiguous — column decides
    else { dd = p1; mm = p2; }                            // ambiguous — default DD/MM
    d = new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${timePart(time)}`);
  } else if (yyyymmdd) {
    const [, yyyy, mm, dd, time] = yyyymmdd;
    d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${timePart(time)}`);
  }
  return (d && !isNaN(d.getTime())) ? d : null;
}

// Reads a whole column to decide whether it is DD/MM or MM/DD. One value with a
// part over 12 settles it for the column's ambiguous values too.
function detectColumnDateFormat(values) {
  for (const v of (values || [])) {
    const m = (v || '').trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (!m) continue;
    const p1 = +m[1], p2 = +m[2];
    if (p1 > 12 && p2 <= 12) return 'DMY';
    if (p2 > 12 && p1 <= 12) return 'MDY';
  }
  return 'DMY'; // nothing decisive — the office writes dates day-first
}

// Sheet cell → 'YYYY-MM-DD' or null, for filtering by date.
function sheetDateToYMD(val, format) {
  const d = parseSheetDate(val, false, format);
  if (!d) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Late: the actual date passed the plan date, or the plan date has passed and
// nothing has been recorded yet.
function isRowDelayed(planVal, actualVal, planFormat) {
  const planDate = parseSheetDate(planVal, true, planFormat); // good for the whole day
  if (!planDate) return false;
  if (actualVal) {
    const actualDate = parseSheetDate(actualVal, false, 'DMY');
    if (!actualDate) return false;
    return actualDate > planDate;
  }
  return new Date() > planDate;
}

// Sheets counts date-times as days since 30 Dec 1899. Writing that number rather
// than a "DD/MM/YYYY HH:mm:ss" string keeps the cell a real date whatever the
// spreadsheet's locale is — under en_US a text timestamp with a day above 12 is
// stored as text, and every date formula downstream of it stops working.
function istSheetSerialNow() {
  const ist = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  return Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(),
    ist.getUTCHours(), ist.getUTCMinutes(), ist.getUTCSeconds()
  ) / 86400000 + 25569;
}

module.exports = {
  extractSpreadsheetId, colToIdx, idxToCol,
  parseSheetDate, detectColumnDateFormat, sheetDateToYMD, isRowDelayed,
  istSheetSerialNow,
};
