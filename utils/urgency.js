/**
 * One rule for "how long has this urgent order got left".
 *
 * An order is urgent when its Type of Order is RUSH - the punch asks it as a
 * plain yes or no and the approval box asks it in those words, and both write
 * the one column. On a yes the punch also takes the day the CLIENT has been
 * promised it, and that date is what every board counts down from here.
 *
 * Why one file: the production board, the dashboard, PMS Orders and the
 * morning stage report all say how many days are left. Four copies of the
 * arithmetic would eventually disagree, and the first anybody would hear of
 * it is an order that reads "due tomorrow" on a screen and "overdue" in a
 * mail sent from the same minute.
 *
 * DAYS ARE COUNTED IN THE OFFICE'S DAY, NOT IN HOURS. "Due tomorrow" has to
 * stay true all day today, so both dates are reduced to a calendar day in
 * Asia/Kolkata first and subtracted as days. Counting in milliseconds would
 * make an order due tomorrow morning read as due today after lunch.
 *
 * Loaded by Node as a module and by the browser as a plain script. Everything
 * is inside the wrapper: nothing is declared in the shared browser scope,
 * where a name as ordinary as `api` has already killed one page before.
 */
(function () {

var IST = { timeZone: 'Asia/Kolkata' };

/**
 * The calendar day of a date in the office's zone, as YYYY-MM-DD, or '' when
 * there is no date.
 *
 * THE EMPTY CASE IS CHECKED FIRST AND THAT IS NOT TIDINESS. `new Date(null)`
 * is the first of January 1970, not an invalid date, so a column nobody has
 * filled in comes out of here as a real day - and every normal order on the
 * dashboard was being sent "1970-01-01", which the countdown would have
 * read as twenty thousand days overdue.
 */
function day(value) {
  if (value === null || value === undefined || value === '') return '';
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', IST);
}

/** Today in the office's zone. */
function today() {
  return new Date().toLocaleDateString('en-CA', IST);
}

/** Whole days from one YYYY-MM-DD to another. Negative means it has passed. */
function daysBetween(fromDay, toDay) {
  var a = Date.parse(fromDay + 'T00:00:00Z');
  var b = Date.parse(toDay + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * What an order's promised date means right now, or null if there is none.
 *
 * MySQL hands a DATE back as a Date in Node and as a string over JSON, and
 * the browser is given the string, so both are accepted. Anything that is not
 * a date at all is treated as no date rather than as zero days left: a board
 * that says "overdue" because a column was blank would have everybody
 * ignoring the colour within a week.
 */
function describe(due, asOfDay) {
  if (!due) return null;
  var dueDay = typeof due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(due)
    ? due.slice(0, 10)
    : day(due);
  if (!dueDay) return null;

  var now = asOfDay || today();
  var left = daysBetween(now, dueDay);
  if (left === null) return null;

  return {
    iso: dueDay,
    pretty: dueDay.slice(8, 10) + ' ' + MONTHS[Number(dueDay.slice(5, 7)) - 1],
    daysLeft: left,
    overdue: left < 0,
    dueToday: left === 0,
    // Tomorrow is still "tomorrow", not "1 day": the office speaks in days
    // only once there are a few of them.
    label: left < -1 ? (-left) + ' days overdue'
      : left === -1 ? 'Due yesterday'
      : left === 0 ? 'Due today'
      : left === 1 ? 'Due tomorrow'
      : 'Due in ' + left + ' days',
  };
}

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whether a Type of Order means urgent, however it was typed. */
function isRush(orderType) {
  return /rush/i.test(String(orderType || ''));
}

/**
 * The one line a board shows: "RUSH · Due in 3 days", or just "RUSH" when
 * the order was marked urgent before the punch started asking for a date.
 * Returns '' for a normal order, so a caller can print it unconditionally.
 */
function summary(orderType, due) {
  if (!isRush(orderType)) return '';
  var d = describe(due);
  return d ? 'RUSH · ' + d.label : 'RUSH';
}

var api = { describe: describe, isRush: isRush, summary: summary, day: day, today: today };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ArabellaUrgency = api;
}());
