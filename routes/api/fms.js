// ══════════════════════════════════════════════════════
// FMS — work that lives in a Google Sheet.
//
// Each row of the sheet is a job; each step of that job owns a block of columns
// (planned date, actual date, delay, a Status checkbox). An admin maps those
// columns once and says who works each step; the doer then gets a screen
// listing the rows waiting on them, and one click marks a row done.
//
// The sheet stays the record. Nothing about a job is copied into this database
// — only the mapping, and who does what. Two copies of the truth drift apart
// inside a week.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const sheets = require('../../utils/sheets');
const {
  extractSpreadsheetId, idxToCol,
  detectColumnDateFormat, sheetDateToYMD, isRowDelayed, istSheetSerialNow,
} = require('../../utils/sheetCells');
const introspect = require('../../utils/fms/introspect');
const fmsDetect = require('../../utils/fms/detect');
const fmsColumns = require('../../utils/fms/columns');
const fmsRepo = require('../../utils/fms/repo');

// Who may set an FMS up. Doing the work needs only a login — being named on a
// step is the permission.
function canConfigure(user) {
  const role = (user && user.role) || '';
  return role === 'SuperAdmin' || role === 'Head' || (user && user.domain === 'Head');
}

const requireAdmin = (req, res, next) => canConfigure(req.session.user)
  ? next()
  : res.status(403).json({ success: false, error: 'Only a SuperAdmin can configure an FMS.' });

const one = async (sql, params) => {
  const [rows] = await db.query(sql, params);
  return rows[0] || null;
};
const many = async (sql, params) => {
  const [rows] = await db.query(sql, params);
  return rows;
};

/**
 * Sheet failures are the common case here — the wrong tab name, or a file never
 * shared with the identity this server actually signs as. A bare "not found"
 * leaves somebody staring at an empty screen with nothing to act on, so say
 * which address to share with and what to check.
 */
function sheetError(res, err, where) {
  const account = sheets.serviceAccountEmail();
  const code = err.code || (err.response && err.response.status);
  const hint = code === 403
    ? `This server reads sheets as ${account || 'its service account'}. Share the sheet with that address — Editor, since it has to tick the Status boxes.`
    : code === 404
      ? 'Check the sheet link and that the tab name matches exactly, spaces included.'
      : '';
  console.error(`FMS ${where} failed:`, code || '', err.message);
  return res.status(code === 403 || code === 404 ? 400 : 500).json({
    success: false,
    error: err.message + (hint ? ' — ' + hint : ''),
    serviceAccount: account,
  });
}

// ══════════════════════════════════════════════════════
// ADMIN — setting an FMS up
// ══════════════════════════════════════════════════════

// GET /api/fms — every FMS, with its step count.
router.get('/', requireLogin, requireAdmin, async (req, res) => {
  try {
    const rows = await many(
      `SELECT s.${fmsRepo.SHEET_COLUMNS.split(', ').join(', s.')},
              (SELECT COUNT(*) FROM fms_steps st WHERE st.fms_id = s.id) AS step_count
         FROM fms_sheets s ORDER BY s.id DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('FMS list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fms/tabs?sheet=<url or id> — the tabs in a spreadsheet, so the
// admin picks one instead of typing its name and misspelling it.
// Registered before /:id, or Express reads "tabs" as an id.
router.get('/tabs', requireLogin, requireAdmin, async (req, res) => {
  try {
    const id = extractSpreadsheetId(req.query.sheet || '');
    if (!id) return res.status(400).json({ success: false, error: 'Give the sheet link.' });
    const tabs = await sheets.listTabs(id);
    res.json({ success: true, data: tabs.map(t => ({ title: t.title, gid: t.sheetId })) });
  } catch (err) {
    return sheetError(res, err, 'tabs');
  }
});

// POST /api/fms/detect-steps — read a sheet and propose a configuration.
// The heart of it: everything else is storage.
router.post('/detect-steps', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { sheetId, sheetName, headerRow } = req.body;
    if (!sheetId) return res.status(400).json({ success: false, error: 'Give the sheet link.' });

    const askedRow = Math.max(1, parseInt(headerRow, 10) || 1);
    let usedRow = askedRow;
    let meta = await introspect.readColumnMeta(sheetId, sheetName, usedRow);
    let detected = fmsDetect.detectSteps(meta.columns, { labelRows: meta.labelRows });

    // These sheets open with a banner block — a timestamp, the step names, who
    // owns each — and the real header row sits below it. Rather than showing an
    // empty screen and leaving somebody to guess the number, find the row
    // carrying the plan/actual pairs and say that is what was used.
    if (!detected.steps.length) {
      const firstRows = await sheets.readValues(
        extractSpreadsheetId(sheetId), `'${sheetName || 'Sheet1'}'!1:20`);
      const guess = fmsDetect.guessHeaderRow(firstRows);
      if (guess && guess !== usedRow) {
        usedRow = guess;
        meta = await introspect.readColumnMeta(sheetId, sheetName, usedRow);
        detected = fmsDetect.detectSteps(meta.columns, { labelRows: meta.labelRows });
      }
    }

    res.json({
      success: true,
      headers: meta.headers,
      steps: detected.steps,
      leadingColumns: detected.leadingColumns,
      // The row the columns were really read from, and whether that differs
      // from what was typed — the screen corrects its own field to match.
      headerRow: usedRow,
      headerRowAdjusted: usedRow !== askedRow,
      // Columns left out, with the reason. Nothing disappears silently.
      skipped: detected.skipped,
      // Columns that were mapped but come with a caveat — a formula the app
      // would overwrite, say. Shown, never acted on quietly.
      warnings: detected.steps.flatMap((st, i) => (st.warnings || []).map(w => ({ ...w, step: i + 1 }))),
      detectedSteps: detected.steps.length,
    });
  } catch (err) {
    return sheetError(res, err, 'detect-steps');
  }
});

// GET /api/fms/:id — one FMS with its steps, doers and extra fields.
router.get('/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const sheet = await one('SELECT * FROM fms_sheets WHERE id = ?', [req.params.id]);
    if (!sheet) return res.status(404).json({ success: false, error: 'FMS not found.' });
    const steps = await many(
      `SELECT ${fmsRepo.STEP_COLUMNS} FROM fms_steps WHERE fms_id = ? ORDER BY step_order ASC`,
      [req.params.id]);
    await fmsRepo.decorateSteps(steps, { withExtraRows: true });
    res.json({ success: true, data: { sheet, steps } });
  } catch (err) {
    console.error('FMS read failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Writes the steps of an FMS. Always a full replace: the screen hands over the
 * whole configuration, and reconciling it row by row would be more ways to be
 * wrong than rewriting four small tables.
 *
 * `headers` is the sheet's header row as it stands right now — every mapped
 * column is stored with its NAME as well as its letter, which is what lets an
 * inserted column be harmless later.
 */
async function writeSteps(fmsId, steps, headers) {
  const old = await many('SELECT id FROM fms_steps WHERE fms_id = ?', [fmsId]);
  const oldIds = old.map(s => s.id);
  if (oldIds.length) {
    const ph = oldIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM fms_extra_rows WHERE step_id IN (${ph})`, oldIds);
    await db.query(`DELETE FROM fms_step_doers WHERE step_id IN (${ph})`, oldIds);
    await db.query('DELETE FROM fms_steps WHERE fms_id = ?', [fmsId]);
  }

  let order = 0;
  for (const step of steps || []) {
    order++;
    const row = {
      fms_id: fmsId,
      step_order: order,
      step_name: String(step.stepName || `Step ${order}`).slice(0, 255),
      plan_col: (step.planCol || '').toUpperCase(),
      actual_col: (step.actualCol || '').toUpperCase(),
      complete_col: (step.completeCol || '').toUpperCase(),
      delay_reason_col: (step.delayReasonCol || '').toUpperCase(),
      extra_input: (step.extraRows && step.extraRows.length) ? 'yes' : 'no',
      extra_col: '',
      show_cols: JSON.stringify(Array.isArray(step.showCols) ? step.showCols : []),
    };
    row.header_map = JSON.stringify(fmsColumns.buildHeaderMap(row, step.extraRows || [], headers));
    const showMap = fmsColumns.buildShowMap(JSON.parse(row.show_cols), headers);
    if (showMap.length) {
      const m = JSON.parse(row.header_map);
      m.show = showMap;
      row.header_map = JSON.stringify(m);
    }

    const cols = Object.keys(row);
    const [ins] = await db.query(
      `INSERT INTO fms_steps (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => row[c]));
    const stepId = ins.insertId;

    const doerIds = [...new Set((step.doers || []).map(Number).filter(Boolean))];
    if (doerIds.length) {
      await db.query(
        `INSERT INTO fms_step_doers (step_id, user_id) VALUES ${doerIds.map(() => '(?, ?)').join(', ')}`,
        doerIds.flatMap(id => [stepId, id]));
    }

    for (const extra of step.extraRows || []) {
      const header = fmsColumns.buildRowHeader(extra, headers);
      await db.query(
        `INSERT INTO fms_extra_rows
           (step_id, row_label, col_letter, field_type, dropdown_options, required, header_name, header_occ)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [stepId, String(extra.label || extra.header || '').slice(0, 255),
         (extra.col_letter || '').toUpperCase(), extra.field_type || 'text',
         extra.dropdown_options || '', extra.required ? 1 : 0,
         header.header_name, header.header_occ]);
    }
  }
  await db.query('UPDATE fms_sheets SET total_steps = ? WHERE id = ?', [order, fmsId]);
}

// The header row as it stands now, for the name-mapping.
async function headerRowOf(sheetId, tabName, headerRow) {
  const rows = await sheets.readValues(
    extractSpreadsheetId(sheetId), `'${tabName || 'Sheet1'}'!${headerRow}:${headerRow}`, { fresh: true });
  return rows[0] || [];
}

// POST /api/fms — create.
router.post('/', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { fmsName, sheetId, sheetName, headerRow, steps } = req.body;
    if (!sheetId || !sheetName) {
      return res.status(400).json({ success: false, error: 'The sheet link and the tab are both needed.' });
    }
    const row = Math.max(1, parseInt(headerRow, 10) || 1);
    const headers = await headerRowOf(sheetId, sheetName, row);

    const [ins] = await db.query(
      `INSERT INTO fms_sheets (fms_name, sheet_name, sheet_id, header_row, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [String(fmsName || sheetName).slice(0, 255), sheetName,
       extractSpreadsheetId(sheetId), row, req.session.user.id]);

    await writeSteps(ins.insertId, steps, headers);
    res.json({ success: true, id: ins.insertId });
  } catch (err) {
    return sheetError(res, err, 'create');
  }
});

// PUT /api/fms/:id — update.
router.put('/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const sheet = await one('SELECT * FROM fms_sheets WHERE id = ?', [req.params.id]);
    if (!sheet) return res.status(404).json({ success: false, error: 'FMS not found.' });

    const { fmsName, sheetId, sheetName, headerRow, steps } = req.body;
    const row = Math.max(1, parseInt(headerRow, 10) || sheet.header_row || 1);
    const useSheet = sheetId ? extractSpreadsheetId(sheetId) : sheet.sheet_id;
    const useTab = sheetName || sheet.sheet_name;
    const headers = await headerRowOf(useSheet, useTab, row);

    await db.query(
      'UPDATE fms_sheets SET fms_name = ?, sheet_name = ?, sheet_id = ?, header_row = ? WHERE id = ?',
      [String(fmsName || useTab).slice(0, 255), useTab, useSheet, row, req.params.id]);

    if (Array.isArray(steps)) await writeSteps(Number(req.params.id), steps, headers);
    res.json({ success: true });
  } catch (err) {
    return sheetError(res, err, 'update');
  }
});

// DELETE /api/fms/:id — the mapping only. The sheet is untouched.
router.delete('/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const steps = await many('SELECT id FROM fms_steps WHERE fms_id = ?', [req.params.id]);
    const ids = steps.map(s => s.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(', ');
      await db.query(`DELETE FROM fms_extra_rows WHERE step_id IN (${ph})`, ids);
      await db.query(`DELETE FROM fms_step_doers WHERE step_id IN (${ph})`, ids);
    }
    await db.query('DELETE FROM fms_steps WHERE fms_id = ?', [req.params.id]);
    await db.query('DELETE FROM fms_sheets WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('FMS delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
