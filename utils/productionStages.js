// ══════════════════════════════════════════════════════
// THE NINE PRODUCTION STAGES, AND WHAT COUNTS AS DONE
//
// One copy, loaded by Node and by the browser, for the reason the vector
// rule taught us: the Proofing-Done check was written once in a route and
// once in a page, and the two drifted until a stage was finished in one
// place and pending in the other. A morning mail that says an order is late
// while the board in front of somebody shows it green is worse than no mail.
//
// So the board's badges and the morning mail are the same list, the same
// words, and the same reading of them.
//
// READ THE COLUMN, DO NOT GUESS AT IT. Every one of these holds free text the
// office types, so "done" is a list of the words they actually use, not a
// boolean. Two of them need saying out loud:
//
//   GNA Approved is NOT finished. The guest list being signed off is a step
//   on the way; the stage is done when it has been printed, or when there is
//   no GNA on the job at all.
//
//   "No", "No Die", "No Block" mean the stage does not apply to this job.
//   That is finished, not pending - a job with no die cutting is not waiting
//   for die cutting.
// ══════════════════════════════════════════════════════

/**
 * The stages, in the order the floor works them.
 *
 * `browser` is the key the production board's rows carry; `column` is the
 * database column behind it. They differ because the board renames columns
 * on the way out, and the mail reads the table directly.
 */
var STAGES = [
  { label: 'GNA',      browser: 'Guest_Name',    column: 'guest_name',
    ok: ['no', 'no gna', 'printed', 'gna printed'] },
  { label: 'Paper',    browser: 'Paper_Cutting', column: 'paper_cutting',  ok: ['done'] },
  { label: 'Dye',      browser: 'Dye_Status',    column: 'dye_status',
    ok: ['no die', 'die cutting done', 'die sent'] },
  { label: 'Block',    browser: 'Block_Status',  column: 'block_status',
    ok: ['no block', 'block printed', 'block sent'] },
  { label: 'Print',    browser: 'Printing',      column: 'printing',       ok: ['done'] },
  { label: 'Edges',    browser: 'Edges',         column: 'edges',          ok: ['no', 'done'] },
  { label: 'Laser',    browser: 'Laser_Cutting', column: 'laser_cutting',  ok: ['no', 'done'] },
  { label: 'Output',   browser: 'Output',        column: 'output',         ok: ['no', 'done'] },
  { label: 'Assembly', browser: 'Card_Assembly', column: 'card_assembly',  ok: ['done'] },
];

function tidy(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

/** Is this stage finished, given whatever is written in its column? */
function isDone(stage, value) {
  return stage.ok.indexOf(tidy(value)) >= 0;
}

/**
 * The stages still outstanding on one order.
 *
 * @param {object} order a row, keyed either way
 * @param {'browser'|'column'} how which set of keys it carries
 * @returns {Array<{label: string, said: string}>} `said` is what the column
 *          actually holds, because "Pending" and blank are different problems
 */
function pending(order, how) {
  var key = how === 'column' ? 'column' : 'browser';
  var out = [];
  for (var i = 0; i < STAGES.length; i++) {
    var s = STAGES[i];
    var v = order ? order[s[key]] : '';
    if (!isDone(s, v)) out.push({ label: s.label, said: tidy(v) || 'not set' });
  }
  return out;
}

/** Everything done? Said separately because it reads better at a call site. */
function allDone(order, how) {
  return pending(order, how).length === 0;
}

var api = { STAGES: STAGES, isDone: isDone, pending: pending, allDone: allDone };

// Loaded by Node for the morning mail and by the browser for the board's
// badges, so the two cannot disagree about what "done" means.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ArabellaStages = api;
