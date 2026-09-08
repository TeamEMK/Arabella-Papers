// ══════════════════════════════════════════════════════
// FMS DATA ACCESS
// An FMS is a Google Sheet plus a description of which columns are the plan and
// actual dates of each step, and who works each one.
//
// The queries are batched on purpose. Walking sheets → steps → doers with a
// query at every level makes one screen issue sixty; these are three, whatever
// the size.
// ══════════════════════════════════════════════════════
const db = require('../../config/db');
const {
  colToIdx, idxToCol, detectColumnDateFormat, sheetDateToYMD, isRowDelayed, extractSpreadsheetId,
} = require('../sheetCells');
const sheets = require('../sheets');
const fmsColumns = require('./columns');

const SHEET_COLUMNS = 'id, fms_name, sheet_name, sheet_id, header_row, total_steps, created_by, created_at';
const STEP_COLUMNS = `id, fms_id, step_order, step_name, plan_col, actual_col, extra_input, extra_col,
                      show_cols, delay_reason_col, complete_col, header_map`;

const placeholders = (arr) => arr.map(() => '?').join(', ');

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    const list = map.get(k);
    if (list) list.push(row); else map.set(k, [row]);
  }
  return map;
}

async function stepsForSheets(sheetIds) {
  if (!sheetIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT ${STEP_COLUMNS} FROM fms_steps WHERE fms_id IN (${placeholders(sheetIds)})
      ORDER BY step_order ASC`, sheetIds);
  return groupBy(rows, 'fms_id');
}

// step_id → the people who work it
async function doersForSteps(stepIds) {
  if (!stepIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT fsd.step_id, fsd.user_id, u.username AS name, u.role
       FROM fms_step_doers fsd JOIN users u ON fsd.user_id = u.id
      WHERE fsd.step_id IN (${placeholders(stepIds)})`, stepIds);
  return groupBy(rows, 'step_id');
}

async function extraRowsForSteps(stepIds) {
  if (!stepIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT id, step_id, row_label, col_letter, field_type, dropdown_options, required,
            header_name, header_occ
       FROM fms_extra_rows WHERE step_id IN (${placeholders(stepIds)}) ORDER BY id ASC`, stepIds);
  return groupBy(rows, 'step_id');
}

const parseShowCols = (step) => {
  try { return JSON.parse(step.show_cols || '[]'); } catch (_) { return []; }
};

// Hangs doers (and optionally the extra input fields) on a list of steps, one
// query each rather than one per step.
async function decorateSteps(steps, { withExtraRows = false, viewerId = null, isAdmin = false } = {}) {
  const ids = steps.map(s => s.id);
  const [doers, extras] = await Promise.all([
    doersForSteps(ids),
    withExtraRows ? extraRowsForSteps(ids) : Promise.resolve(new Map()),
  ]);
  for (const step of steps) {
    const d = doers.get(step.id) || [];
    step.doers = d.map(x => ({ user_id: x.user_id, name: x.name, role: x.role }));
    step.doerIds = d.map(x => x.user_id);
    step.doerNames = d.map(x => x.name).join(', ');
    step.show_cols_parsed = parseShowCols(step);
    if (viewerId != null) step.isMyStep = isAdmin || step.doerIds.includes(viewerId);
    if (withExtraRows) step.extraRows = extras.get(step.id) || [];
  }
  return steps;
}

// Resolves every step's mapped columns against the sheet as it stands NOW and
// hangs the answer on the step as `_cols`. Everything downstream reads that
// rather than the stored letter, which is what makes an inserted column
// harmless instead of silently destructive.
function attachResolved(steps, headers) {
  for (const step of steps) {
    step._cols = fmsColumns.resolveStep(step, step.extraRows || [], headers);
  }
  return steps;
}

/**
 * Reads the part of the sheet that covers every column these steps use.
 *
 * The header row is fetched first, on its own — one small call — because
 * without it the range would have to be sized from the stored letters, which
 * are exactly the stale positions this mechanism exists to stop trusting.
 */
async function readSheetGrid(sheet, steps) {
  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';
  const headerRowIdx = (sheet.header_row || 1) - 1;

  const headerOnly = await sheets.readValues(
    spreadsheetId, `'${tabName}'!${headerRowIdx + 1}:${headerRowIdx + 1}`);
  attachResolved(steps, headerOnly[0] || []);

  const cols = steps.flatMap(s => [s._cols.plan, s._cols.actual, s._cols.complete]).filter(x => x >= 0);
  if (!cols.length) return null;
  const values = await sheets.readValues(spreadsheetId, `'${tabName}'!A:${idxToCol(Math.max(...cols))}`);
  const headers = values[headerRowIdx] || headerOnly[0] || [];
  // The wide read is the authoritative one; resolve again against it in case
  // the narrow read returned a truncated header row.
  attachResolved(steps, headers);
  return { spreadsheetId, tabName, headerRowIdx, headers, dataRows: values.slice(headerRowIdx + 1) };
}

/**
 * Counts pending / done / delayed rows for one step, optionally inside a
 * plan-date window. The column's date format is worked out once per step
 * rather than once per row.
 */
function stepStats(dataRows, step, { start = null, end = null } = {}) {
  const planIdx = step._cols ? step._cols.plan : colToIdx(step.plan_col);
  const actualIdx = step._cols ? step._cols.actual : colToIdx(step.actual_col);
  if (planIdx < 0 || actualIdx < 0) return null;

  const planFormat = detectColumnDateFormat(dataRows.map(r => r[planIdx]));
  let pending = 0, done = 0, delayed = 0;
  for (const row of dataRows) {
    const planVal = (row[planIdx] || '').trim();
    if (!planVal) continue;
    const actualVal = (row[actualIdx] || '').trim();
    if (start || end) {
      const planYMD = sheetDateToYMD(planVal, planFormat);
      if (planYMD && ((start && planYMD < start) || (end && planYMD > end))) continue;
    }
    if (actualVal) done++; else pending++;
    if (isRowDelayed(planVal, actualVal, planFormat)) delayed++;
  }
  return { pending, done, delayed, total: pending + done, planIdx, actualIdx, planFormat };
}

module.exports = {
  SHEET_COLUMNS, STEP_COLUMNS, attachResolved,
  stepsForSheets, doersForSteps, extraRowsForSteps, decorateSteps, parseShowCols,
  readSheetGrid, stepStats, groupBy, placeholders,
};
