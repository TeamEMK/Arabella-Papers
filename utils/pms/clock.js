// ══════════════════════════════════════════════════════
// PMS — WORKING TIME
//
// Every date here is an IST wall clock, carried as 'YYYY-MM-DD HH:MM:SS' and
// stored that way. No Date objects cross into a query.
//
// That is deliberate. The pool runs at +05:30, so handing it a Date converts
// on the way in and again on the way out, and a value that has already been
// converted once gets shifted a second time. That exact double conversion put
// 1,825 orders in the wrong day column of the SCOT sheet. A string is stored
// as written and read back as written, so there is nothing to convert twice.
// ══════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;

// When the working day starts and ends. A step finished after close belongs to
// the next morning: counting its TAT from 7pm would make a one-day step due at
// 7pm the next day, which is not a deadline anyone on the floor recognises.
const DAY_START_H = 10;   // 10:00
const DAY_END_H = 18;     // 18:00
const SUNDAY = 0;

/** Right now, as an IST wall clock. */
function nowIst() {
  return fromDate(new Date());
}

/** A Date (or anything Date can parse) as an IST wall clock string. */
function fromDate(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA gives YYYY-MM-DD; hourCycle h23 avoids the "24:00" that en-CA
  // otherwise prints for midnight.
  const s = d.toLocaleString('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23',
  });
  return s.replace(', ', ' ');
}

/** 'YYYY-MM-DD HH:MM:SS' (or a Date, or a date-only string) into its parts. */
function parts(ist) {
  if (!ist) return null;
  const s = ist instanceof Date ? fromDate(ist) : String(ist).trim().replace('T', ' ');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    h: m[4] === undefined ? 0 : +m[4],
    mi: m[5] === undefined ? 0 : +m[5],
    s: m[6] === undefined ? 0 : +m[6],
  };
}

function format(p) {
  const two = n => String(n).padStart(2, '0');
  return p.y + '-' + two(p.mo) + '-' + two(p.d) + ' '
    + two(p.h) + ':' + two(p.mi) + ':' + two(p.s);
}

/** The date half only, 'YYYY-MM-DD'. */
function dayOf(ist) {
  const p = parts(ist);
  return p ? format(p).slice(0, 10) : null;
}

// Calendar arithmetic through UTC midnight, which has no DST and no offset to
// get wrong — the parts going in and coming out are both plain IST wall dates.
function shiftDays(p, n) {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d) + n * DAY_MS);
  return { ...p, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekday(p) {
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}

function isHoliday(p) {
  return weekday(p) === SUNDAY;
}

/** The next working day at 10:00, from a date that may itself be a Sunday. */
function nextWorkingMorning(p) {
  let out = { ...p, h: DAY_START_H, mi: 0, s: 0 };
  do { out = shiftDays(out, 1); } while (isHoliday(out));
  return out;
}

/**
 * Where a step's clock starts, given when the step before it finished.
 *
 *   finished after close  -> 10:00 the next working day
 *   finished before open  -> 10:00 the same day
 *   finished on a Sunday  -> 10:00 the next working day
 *   otherwise             -> the moment it finished
 */
function clockStart(ist) {
  const p = parts(ist);
  if (!p) return null;
  if (isHoliday(p)) return nextWorkingMorning(p);
  if (p.h >= DAY_END_H) return nextWorkingMorning(p);
  if (p.h < DAY_START_H) return { ...p, h: DAY_START_H, mi: 0, s: 0 };
  return p;
}

/**
 * Add a TAT in working days, skipping Sundays.
 *
 * A fractional TAT (0.5 of a day) moves the clock within the working day
 * instead of to the next one — half a day is four hours of an eight hour day,
 * not noon tomorrow. Anything that spills past close lands at the next
 * morning rather than at 9pm.
 */
function addWorkingDays(start, tatDays) {
  const tat = Number(tatDays);
  if (!Number.isFinite(tat) || tat < 0) return null;

  let p = { ...start };
  let whole = Math.floor(tat);
  const rest = tat - whole;

  while (whole > 0) {
    p = shiftDays(p, 1);
    if (!isHoliday(p)) whole -= 1;
  }

  if (rest > 0) {
    const hours = rest * (DAY_END_H - DAY_START_H);
    const mins = Math.round((p.h * 60 + p.mi) + hours * 60);
    if (mins >= DAY_END_H * 60) {
      // Past closing: carry what is left into the next working morning.
      const over = mins - DAY_END_H * 60;
      p = nextWorkingMorning(p);
      p.h = DAY_START_H + Math.floor(over / 60);
      p.mi = over % 60;
    } else {
      p.h = Math.floor(mins / 60);
      p.mi = mins % 60;
    }
    p.s = 0;
  }

  if (isHoliday(p)) p = nextWorkingMorning(p);
  return format(p);
}

/**
 * When a step is due: its clock start plus its TAT.
 *
 * Returns null when tatDays is null, and the caller stores that null. A step
 * whose TAT nobody has given yet has no due date — showing one would put an
 * invented deadline on the floor's board, and then mark the step late against
 * a number this system made up.
 */
function plannedFrom(previousActual, tatDays) {
  if (tatDays === null || tatDays === undefined || tatDays === '') return null;
  const start = clockStart(previousActual);
  if (!start) return null;
  return addWorkingDays(start, tatDays);
}

/**
 * Anything the driver hands back, as an IST wall clock string.
 *
 * Reads need this as much as writes do. The column holds the right characters
 * — MySQL stores what was written — but mysql2 turns a DATETIME into a Date,
 * and a Date prints in the server's own timezone. On Vercel that is UTC, so
 * 23:30 on the 12th comes back reading 18:00, and the naive String(v).slice()
 * that looks right on a laptop in Jaipur prints 'Mon Oct 12' in production.
 *
 * The instant is never wrong, only its wording. This puts the wording back.
 */
function istOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return fromDate(value);
  const p = parts(value);
  return p ? format(p) : null;
}

/** The named datetime fields of a row, every one of them through istOf. */
function withIst(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) if (f in out) out[f] = istOf(out[f]);
  return out;
}

/** Whole IST days past a due date; 0 when not late or not known. */
function daysLate(plannedAt, asOf) {
  if (!plannedAt) return 0;
  const a = dayOf(plannedAt);
  const b = dayOf(asOf || nowIst());
  if (!a || !b) return 0;
  const n = Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
  return n > 0 ? n : 0;
}

module.exports = {
  DAY_START_H, DAY_END_H,
  nowIst, fromDate, parts, format, dayOf, istOf, withIst,
  isHoliday, clockStart, addWorkingDays, plannedFrom, daysLate,
};
