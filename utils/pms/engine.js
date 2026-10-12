// ══════════════════════════════════════════════════════
// PMS — THE STEP ENGINE
//
// An order's steps open one after another. A step whose condition says no is
// skipped and the next one opens straight away, so most orders walk past most
// of production: die cutting is on 3% of orders and laser on 1%.
//
// Conditions are read when the step is about to open, not when the order is
// punched. At punch nobody yet knows whether the job needs a die — that is
// decided at the approval, by which time these fields are filled. Deciding
// early would freeze a guess into every order.
// ══════════════════════════════════════════════════════

const db = require('../../config/db');
const clock = require('./clock');

// ── CONDITIONS ──
// A step's condition_key names one of these. The order row goes in, and out
// comes true (run it), false (skip it) or null (nobody has said yet).
//
// null is not false. A field still blank means the decision has not been
// made, and the step opens so somebody makes it — skipping on a blank would
// quietly drop a stage off the job and nobody would see it go.
//
// The "no" words are taken from what is actually in the column, which is not
// tidy: dye_status alone holds 'No Dye', 'NO DIE' and 'No'. Matching a list
// of noes rather than a list of yeses means a new spelling of yes still runs
// the step, where a new spelling of no only costs an extra tick.
const NO_WORDS = ['no', 'none', 'not required', 'na', 'n/a', '-'];

function saysNo(value, extra) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (NO_WORDS.includes(v)) return true;
  if (extra && extra.some(w => v === w || v.startsWith(w))) return true;
  return false;
}

// A plain yes/no column: it runs unless the column says no.
function unlessNo(field, extra) {
  return (order) => {
    const no = saysNo(order[field], extra);
    return no === null ? null : !no;
  };
}

const CONDITIONS = {
  // Changes the client asked for after the proof went out. The count is the
  // record of whether there were any.
  revision: (o) => {
    const n = Number(o.no_of_design_revision);
    return Number.isFinite(n) ? n > 0 : null;
  },
  // Addressing: the couple's guest list, printed onto the envelopes.
  guest_name: (o) => {
    const v = o.guest_name;
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    return !NO_WORDS.includes(s.toLowerCase());
  },
  die: unlessNo('dye_status', ['no dye', 'no die']),
  block: unlessNo('block_status', ['no block']),
  edges: unlessNo('edges', ['no edges']),
  laser: unlessNo('laser_cutting', ['no laser']),
  output: unlessNo('output', ['no output']),
};

// Every column a condition reads. Kept beside them so the query that loads an
// order for the engine cannot drift from what the conditions ask for.
const ORDER_FIELDS = [
  'order_id', 'timestamp', 'actual_2', 'order_type', 'dispatch_days',
  'no_of_design_revision', 'guest_name', 'dye_status', 'block_status',
  'edges', 'laser_cutting', 'output',
];

// ── THE CATALOGUE AS IT FIRST ARRIVES ──
//
// The spine is the office's own "Order Taking" flow, the 14 steps already
// written in fms_sheets. The production stages in the middle are split out of
// what the orders table records, because that flow says "Printing /
// Production" where the floor really does cutting, die, block, printing,
// edges, laser and assembly as separate jobs on separate days.
//
// Nearly every TAT is null, and that is the point. The time each production
// stage really takes cannot be recovered: 92% of orders with five production
// stages filled have all five stamped within the same minute, because one
// form writes them all at the end. A number invented here would print a due
// date on the floor's board and then mark them late against it. They get
// filled in from the floor, through the admin screen.
//
// Where a real figure does exist it goes in `note`, not in tat_days, so
// whoever fills the screen can see what the last two years actually did
// without this file pretending it is a target.
const STEP_SEED = [
  ['Order Details & Files Collected', null, 'Sales', null, ''],
  ['Order Punched & Order ID Generated', null, 'Sales', null, ''],
  ['Designer Assigned', null, 'Production Manager', null, ''],
  ['Proofing Started', null, 'Designer', null, ''],
  ['Proof Sent to Customer', null, 'Designer', null, ''],
  ['Proof Review & Revisions', 'revision', 'Designer', null,
    'Today: 9 days median from proof to approval, 57 days at p90'],
  ['Final Proof Approval', null, 'Sales', null,
    'The biggest wait: 1 order in 10 sits here for two months'],
  ['Final Approval For Production', null, 'Production Manager', null,
    'RUSH / Normal and the dispatch days are set here'],
  ['Guest Name / Addressing', 'guest_name', 'Production', null, ''],
  ['Paper & Material Preparation', null, 'Production', null, ''],
  ['Paper Cutting', null, 'Production', null, ''],
  ['Die Cutting', 'die', 'Production', null, 'Runs on 3% of orders'],
  ['Block Printing', 'block', 'Production', null, 'Runs on 2% of orders'],
  ['Printing', null, 'Production', null,
    'Bell Press / Letterpress / Foil Emboss / Thermography / Digital / UV'],
  ['Edges', 'edges', 'Production', null, 'Runs on 20% of orders'],
  ['Laser Cutting', 'laser', 'Production', null, 'Runs on 1% of orders'],
  ['Output', 'output', 'Production', null, ''],
  ['Card Assembly', null, 'Production', null, ''],
  ['Quality Control', null, 'Quality Checker', null, ''],
  ['Packing', null, 'Dispatch', null, ''],
  ['Final Order Verification', null, 'Sales', null, ''],
  ['Shipping Label & Documentation', null, 'Dispatch', null, ''],
  ['Order Dispatched', null, 'Dispatch', null, 'Courier is DHL on every order in the data'],
  ['Tracking Details Sent to Customer', null, 'Dispatch', null, ''],
];

/**
 * Put the catalogue in, once, on an empty table.
 *
 * Only when empty. Re-seeding a table the office has since edited would push
 * their TATs back to null on the next boot, which is the one thing this table
 * must never do.
 */
async function seedSteps() {
  const [[row]] = await db.query('SELECT COUNT(*) AS c FROM pms_steps');
  if (row.c) return 0;

  const values = STEP_SEED.map(([name, cond, role, tat, note], i) =>
    [i + 1, name, cond, role, tat, note, 'setup']);
  const [res] = await db.query(
    `INSERT INTO pms_steps
       (step_order, name, condition_key, doer_role, tat_days, note, updated_by)
     VALUES ?`, [values]);
  return res.affectedRows || 0;
}

/** The live catalogue, in order. */
async function catalogue() {
  const [rows] = await db.query(
    `SELECT id, step_order, name, condition_key, doer_role, tat_days, note
       FROM pms_steps WHERE is_active = 1 ORDER BY step_order, id`);
  return rows;
}

async function loadOrder(orderId) {
  const [rows] = await db.query(
    `SELECT ${ORDER_FIELDS.join(', ')} FROM orders
      WHERE order_id = ? AND is_deleted = 0 LIMIT 1`, [orderId]);
  return rows[0] || null;
}

/**
 * Does this step apply to this order?
 *
 * An unknown condition key counts as "runs". A step pointing at a condition
 * this file does not have is a mistake in the catalogue, and the honest
 * answer to a mistake is to show the step rather than silently drop it.
 */
function applies(step, order) {
  if (!step.condition_key) return true;
  const fn = CONDITIONS[step.condition_key];
  if (!fn) return true;
  const out = fn(order);
  return out === null ? true : out;
}

/**
 * Give an order its steps. Safe to call twice — the unique key means a repeat
 * adds nothing, so a retry cannot hand the floor the same step again.
 */
async function createSteps(orderId) {
  const steps = await catalogue();
  if (!steps.length) return 0;

  const values = steps.map(s => [orderId, s.id, s.step_order, s.name]);
  const [res] = await db.query(
    `INSERT IGNORE INTO pms_order_steps (order_id, step_id, step_order, step_name)
     VALUES ?`, [values]);
  await advance(orderId);
  return res.affectedRows || 0;
}

/**
 * Walk forward from wherever the order is: skip the steps that do not apply,
 * open the first one that does.
 *
 * Everything the board shows comes from here, so it is written to be safe to
 * run at any time — on a punch, on a Done, or on its own to repair an order
 * whose steps were created before the catalogue changed.
 */
async function advance(orderId) {
  const order = await loadOrder(orderId);
  if (!order) return null;

  const [rows] = await db.query(
    `SELECT os.id, os.step_id, os.step_order, os.step_name, os.status,
            os.planned_at, os.actual_at,
            s.condition_key, s.tat_days
       FROM pms_order_steps os
       JOIN pms_steps s ON s.id = os.step_id
      WHERE os.order_id = ?
      ORDER BY os.step_order, os.id`, [orderId]);

  // Where the next step's clock starts: the last finished step, or the order
  // itself for the first one. actual_2 is the client approval and timestamp
  // the punch — the same fallback the rest of the boards use.
  let previous = null;
  for (const r of rows) if (r.status === 'done' && r.actual_at) previous = r.actual_at;
  if (!previous) previous = clock.fromDate(order.timestamp);

  for (const r of rows) {
    if (r.status === 'done' || r.status === 'skipped') continue;

    if (!applies({ condition_key: r.condition_key }, order)) {
      if (r.status !== 'skipped') {
        await db.query(
          `UPDATE pms_order_steps SET status = 'skipped' WHERE id = ?`, [r.id]);
      }
      continue;
    }

    // The first step that applies. Open it if it is not open already, and
    // leave everything after it waiting.
    if (r.status === 'waiting') {
      const now = clock.nowIst();
      const planned = clock.plannedFrom(previous, r.tat_days);
      await db.query(
        `UPDATE pms_order_steps
            SET status = 'pending', opened_at = ?, planned_at = ?
          WHERE id = ?`, [now, planned, r.id]);
    }
    return r.step_order;
  }

  return null;   // nothing left: the order is through
}

/**
 * Mark a step done and open whatever comes next.
 *
 * `when` is for a step being recorded after the fact — the floor finishing a
 * job at six and reaching a screen at nine. Left out, it is now.
 */
async function markDone(orderId, stepId, user, { remark = '', delayReason = '', when = null } = {}) {
  const at = when ? clock.fromDate(when) || clock.nowIst() : clock.nowIst();
  const [res] = await db.query(
    `UPDATE pms_order_steps
        SET status = 'done', actual_at = ?, doer_email = ?, doer_name = ?,
            remark = ?, delay_reason = ?
      WHERE order_id = ? AND step_id = ? AND status <> 'done'`,
    [at, (user && user.email) || '', (user && user.name) || '',
      remark || null, delayReason || null, orderId, stepId]);

  if (!res.affectedRows) return { changed: false };
  const next = await advance(orderId);
  return { changed: true, at, nextStep: next };
}

/**
 * The day the step board starts counting. Orders punched before it are left
 * alone.
 *
 * There are 9,224 orders already in the table and most are long finished.
 * Giving them steps would open one on every single one of them and hand the
 * floor a board of nine thousand jobs that nobody is going to do, which is
 * the fastest way to make them stop looking at it. The office already works
 * this way elsewhere - the production board has its own August cutoff.
 *
 * Blank, or missing, means the board is off. That is the safe default: a new
 * deploy should not start writing steps until somebody has set the date.
 */
async function startDate() {
  try {
    const [rows] = await db.query(
      `SELECT value FROM app_settings WHERE name = 'pms_start_date' LIMIT 1`);
    const v = rows.length ? String(rows[0].value || '').trim() : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Give a freshly punched order its steps, if the board is on and the order is
 * on the right side of the cutoff.
 *
 * Only ever returns. It is called from the punch, and a step board that
 * cannot write its rows must not be the reason the office cannot take an
 * order - exactly how the calling-sheet write beside it behaves.
 */
async function startOrder(orderId, punchedAt) {
  try {
    const from = await startDate();
    if (!from) return { started: false, why: 'board off' };

    const day = clock.dayOf(punchedAt || clock.nowIst());
    if (day && day < from) return { started: false, why: 'before cutoff' };

    const made = await createSteps(orderId);
    return { started: true, created: made };
  } catch (err) {
    console.error('[pms] could not start ' + orderId + ':', err.message);
    return { started: false, why: err.message };
  }
}

module.exports = {
  CONDITIONS, ORDER_FIELDS, STEP_SEED,
  seedSteps, catalogue, loadOrder, applies,
  createSteps, advance, markDone, startDate, startOrder,
};
