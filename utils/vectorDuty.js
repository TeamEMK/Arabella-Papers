// ══════════════════════════════════════════════════════
// VECTOR FILE DUTY
//
// Every order a designer is given needs its print-ready vector file attached.
// This is the part that keeps count of the ones that have not been, holds the
// logout until they are, and tells the owners each evening who is behind.
//
// Three decisions are baked in here, and each was made for a reason that is
// worth keeping in sight:
//
//   1. THE RULE HAS A START DATE. When this went in there were 7,828 orders
//      past proofing and not one vector file in the table, because the upload
//      did not exist until recently. Applied to all of history it would have
//      opened with 1,100 pending against one designer and 816 against
//      another - files that cannot be produced now for orders finished months
//      ago - and not one of them could ever have logged out again. The date
//      lives in app_settings beside pms_start_date, which was put there for
//      exactly this shape of problem.
//
//   2. AN ORDER WITH NO DESIGNER NAMED IS NOT ANYBODY'S. 3,524 orders carry
//      "Other" in the designer column and 1,111 carry nothing at all. There
//      is no person to hold responsible for those, so the rule leaves them
//      alone rather than inventing one.
//
//   3. AN ORDER PUNCHED THIS EVENING IS TOMORROW'S WORK. Something that
//      arrived at five to six is not a thing somebody failed to do that day.
//      The cutoff keeps it out of tonight's count - and out of tonight's
//      logout - and it appears in both the next day if the file is still
//      missing.
// ══════════════════════════════════════════════════════
const db = require('../config/db');

const SETTING = 'vector_rule_start_date';

// Orders punched from this hour onward belong to the next day's reckoning.
const EVENING_CUTOFF_HOUR = 18;

// The placeholders the order form leaves in the designer column when nobody
// in particular is on the job.
const NO_ONE = ['other', 'local order', 'n/a', 'na', '-'];

/**
 * The day the rule starts applying, as YYYY-MM-DD, or null when it is off.
 *
 * Blank or missing means off, and off is how it ships: until somebody sets a
 * date, nothing is counted and nobody is held. A deploy should not start
 * barring people from logging out on its own.
 */
async function startDate() {
  try {
    const [rows] = await db.query(
      `SELECT value FROM app_settings WHERE name = ? LIMIT 1`, [SETTING]);
    const v = rows.length ? String(rows[0].value || '').trim() : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Today in IST as YYYY-MM-DD. The office's day, not the server's. */
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** The hour of the day in IST, 0-23. */
function hourIST() {
  return Number(new Date().toLocaleString('en-GB',
    { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).slice(0, 2));
}

const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB',
  { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');

/**
 * The SQL that picks out an order still owing its vector file.
 *
 * `from` is the start date. `before` is the moment orders stop counting - the
 * evening cutoff - passed in rather than computed here so the nightly mail and
 * the logout gate can be shown to use the same one.
 */
const PENDING_SQL = `
  FROM orders o
 WHERE o.is_deleted = 0
   AND DATE(o.timestamp) >= ?
   AND o.timestamp < ?
   AND NOT EXISTS (SELECT 1 FROM order_vector_files v WHERE v.order_id = o.order_id)
   AND NOT (
     LOWER(IFNULL(o.design_approval_status_from_client, '')) LIKE '%cancel%'
     OR LOWER(IFNULL(o.design_status, '')) LIKE '%cancel%'
   )`;

/**
 * The instant orders stop counting: six o'clock this evening.
 *
 * Everything punched before it is in the reckoning, which means today's own
 * morning work and every unfinished thing from the days before - including
 * last night's late orders, which were spared yesterday and are nobody's
 * excuse today. Only what came in after six tonight is left alone, and only
 * until tomorrow.
 */
function cutoff() {
  return todayIST() + ' ' + String(EVENING_CUTOFF_HOUR).padStart(2, '0') + ':00:00';
}

/**
 * The orders this person still owes a vector file for.
 *
 * Matched on the name in the designer column against their login name, which
 * is the only link the orders carry - they reference a designer by text, not
 * by id. Both columns are read: India and overseas designers are both held to
 * this.
 *
 * @returns {Promise<{on: boolean, orders: Array, count: number}>}
 */
async function pendingFor(user) {
  const name = String((user && user.username) || '').trim();
  const from = await startDate();
  if (!from || !name) return { on: !!from, orders: [], count: 0 };

  const [rows] = await db.query(
    `SELECT o.order_id, o.client_name, o.timestamp,
            IFNULL(NULLIF(o.india_designer, ''), o.overseas_designer) AS designer
     ${PENDING_SQL}
       AND (LOWER(TRIM(IFNULL(o.india_designer, ''))) = LOWER(?)
         OR LOWER(TRIM(IFNULL(o.overseas_designer, ''))) = LOWER(?))
     ORDER BY o.timestamp ASC`,
    [from, cutoff(), name, name],
  );

  return {
    on: true,
    count: rows.length,
    orders: rows.map(r => ({
      orderId: r.order_id,
      client: r.client_name || '',
      punched: day(r.timestamp),
      designer: r.designer || '',
    })),
  };
}

/**
 * Everybody's pending count, for the evening report.
 *
 * Orders with nobody named are left out here as everywhere else - there is no
 * mailbox to put them against.
 */
async function pendingByDesigner() {
  const from = await startDate();
  if (!from) return { on: false, rows: [], total: 0 };

  // Read the orders and group them here rather than in SQL. A designer four
  // days behind is a different conversation from one who had a bad Tuesday,
  // and GROUP_CONCAT of the ids cannot tell those apart - it gives one list
  // and one oldest date, which reads as a single lump of lateness.
  const [rows] = await db.query(
    `SELECT o.order_id, o.timestamp,
            IFNULL(NULLIF(TRIM(o.india_designer), ''), TRIM(o.overseas_designer)) AS designer
     ${PENDING_SQL}
       AND TRIM(IFNULL(NULLIF(TRIM(o.india_designer), ''), IFNULL(TRIM(o.overseas_designer), ''))) <> ''
       AND LOWER(TRIM(IFNULL(NULLIF(TRIM(o.india_designer), ''), TRIM(o.overseas_designer))))
           NOT IN (${NO_ONE.map(() => '?').join(',')})
     ORDER BY o.timestamp ASC`,
    [from, cutoff(), ...NO_ONE],
  );

  const byName = new Map();
  for (const r of rows) {
    const name = String(r.designer || '').trim();
    if (!byName.has(name)) byName.set(name, { designer: name, count: 0, days: new Map() });
    const who = byName.get(name);
    who.count++;
    const d = day(r.timestamp);
    if (!who.days.has(d)) who.days.set(d, []);
    who.days.get(d).push(r.order_id);
  }

  const out = [...byName.values()]
    .map(w => {
      // Oldest first within a designer, which is the order the office would
      // work them in.
      const days = [...w.days.entries()].map(([date, ids]) => ({
        date,
        count: ids.length,
        // Capped per day: a designer forty behind makes a mail nobody reads.
        orders: ids.slice(0, 12),
        more: Math.max(0, ids.length - 12),
      }));
      return {
        designer: w.designer,
        count: w.count,
        oldest: days.length ? days[0].date : '',
        // How many separate days they are carrying - the number that says
        // whether this is a backlog or a bad afternoon.
        dayCount: days.length,
        days,
      };
    })
    .sort((a, b) => b.count - a.count);

  return { on: true, total: rows.length, rows: out };
}

module.exports = {
  SETTING, EVENING_CUTOFF_HOUR, NO_ONE,
  startDate, pendingFor, pendingByDesigner, cutoff, todayIST, hourIST,
};
