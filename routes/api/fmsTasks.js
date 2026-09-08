// ══════════════════════════════════════════════════════
// FMS — the doer's side.
//
// Being named on a step is the permission. Everything here answers one of three
// questions: which FMSs am I on, which rows are waiting on me, and let me mark
// this one done.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { uploadToDrive } = require('../../utils/drive');
const { requireLogin } = require('../../middleware/auth');

// 4MB, the same cap the rest of the app uses — Vercel rejects a request body
// over 4.5MB before it reaches any handler.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
const sheets = require('../../utils/sheets');
const {
  extractSpreadsheetId, colToIdx,
  detectColumnDateFormat, isRowDelayed, istSheetSerialNow,
} = require('../../utils/sheetCells');
const fmsColumns = require('../../utils/fms/columns');
const fmsRepo = require('../../utils/fms/repo');

function canSeeAll(user) {
  const role = (user && user.role) || '';
  return role === 'SuperAdmin' || role === 'Head' || (user && user.domain === 'Head');
}

const one = async (sql, params) => {
  const [rows] = await db.query(sql, params);
  return rows[0] || null;
};
const many = async (sql, params) => {
  const [rows] = await db.query(sql, params);
  return rows;
};

// GET /api/fms-tasks — the FMSs this user has a step on.
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const all = canSeeAll(user);
    const rows = all
      ? await many(
        `SELECT s.id, s.fms_name, s.sheet_name, s.total_steps,
                (SELECT COUNT(*) FROM fms_steps st WHERE st.fms_id = s.id) AS step_count
           FROM fms_sheets s ORDER BY s.fms_name ASC, s.id DESC`)
      : await many(
        `SELECT DISTINCT s.id, s.fms_name, s.sheet_name, s.total_steps,
                (SELECT COUNT(*) FROM fms_steps st WHERE st.fms_id = s.id) AS step_count
           FROM fms_sheets s
           JOIN fms_steps st ON st.fms_id = s.id
           JOIN fms_step_doers d ON d.step_id = st.id
          WHERE d.user_id = ?
          ORDER BY s.fms_name ASC, s.id DESC`, [user.id]);
    res.json({ success: true, data: rows, canConfigure: all });
  } catch (err) {
    console.error('FMS tasks list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/fms-tasks/:id — the steps of one FMS, each with how many rows are
 * pending, done and late.
 *
 * Every step is counted, not only the viewer's: the point of a step train is
 * seeing where the work is stuck, and a doer who can only see their own square
 * cannot tell whether the row ahead has even started.
 */
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const sheet = await one('SELECT * FROM fms_sheets WHERE id = ?', [req.params.id]);
    if (!sheet) return res.status(404).json({ success: false, error: 'FMS not found.' });

    const steps = await many(
      `SELECT ${fmsRepo.STEP_COLUMNS} FROM fms_steps WHERE fms_id = ? ORDER BY step_order ASC`,
      [req.params.id]);
    await fmsRepo.decorateSteps(steps, {
      withExtraRows: true, viewerId: user.id, isAdmin: canSeeAll(user),
    });

    const grid = await fmsRepo.readSheetGrid(sheet, steps);
    for (const step of steps) {
      const stats = grid ? fmsRepo.stepStats(grid.dataRows, step) : null;
      step.stats = stats
        ? { pending: stats.pending, done: stats.done, delayed: stats.delayed, total: stats.total }
        : { pending: 0, done: 0, delayed: 0, total: 0 };
      // Nobody downstream needs the resolved indexes, and they read like a bug
      // when they turn up in a response.
      delete step._cols;
      delete step.header_map;
    }

    res.json({ success: true, data: { sheet, steps } });
  } catch (err) {
    console.error('FMS steps failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/fms-tasks/:fmsId/steps/:stepId/rows — the jobs waiting on this step.
 *
 * A row is workable when its plan date is filled (the sheet has reached this
 * step) and its actual is not (nobody has finished it). ?done=1 shows the
 * finished ones instead, which is how somebody checks their own work.
 */
router.get('/:fmsId/steps/:stepId/rows', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const sheet = await one('SELECT * FROM fms_sheets WHERE id = ?', [req.params.fmsId]);
    const step = await one('SELECT * FROM fms_steps WHERE id = ? AND fms_id = ?',
      [req.params.stepId, req.params.fmsId]);
    if (!sheet || !step) return res.status(404).json({ success: false, error: 'Step not found.' });

    await fmsRepo.decorateSteps([step], {
      withExtraRows: true, viewerId: user.id, isAdmin: canSeeAll(user),
    });

    const grid = await fmsRepo.readSheetGrid(sheet, [step]);
    if (!grid) return res.json({ success: true, data: { rows: [], headers: [], step } });

    const planIdx = step._cols.plan;
    const actualIdx = step._cols.actual;
    const planFormat = detectColumnDateFormat(grid.dataRows.map(r => r[planIdx]));
    const wantDone = String(req.query.done || '') === '1';

    // Which columns to put in front of the doer. Blank means everything before
    // the first step — the job's identity, which is what tells one row from
    // another. Guessing a narrower set would hide the context they work from.
    const show = (step.show_cols_parsed && step.show_cols_parsed.length)
      ? step.show_cols_parsed
      : grid.headers.map((h, i) => (h && i < planIdx ? i : -1)).filter(i => i >= 0);

    const rows = [];
    grid.dataRows.forEach((row, i) => {
      const planVal = String((row[planIdx] || '')).trim();
      if (!planVal) return;                                    // not reached this step yet
      const actualVal = actualIdx >= 0 ? String((row[actualIdx] || '')).trim() : '';
      if (wantDone !== Boolean(actualVal)) return;
      rows.push({
        // 1-based, and past the header — this is the number the write path uses.
        rowNumber: grid.headerRowIdx + 2 + i,
        plan: planVal,
        actual: actualVal,
        delayed: isRowDelayed(planVal, actualVal, planFormat),
        cells: show.map(idx => ({ header: grid.headers[idx] || '', value: row[idx] || '' })),
      });
    });

    delete step._cols;
    delete step.header_map;
    res.json({ success: true, data: { rows, step, showHeaders: show.map(i => grid.headers[i] || '') } });
  } catch (err) {
    console.error('FMS rows failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/fms-tasks/upload — a file field's value.
 *
 * A sheet cell holds a link, not a file, so the upload happens before the row
 * is written and what goes in the cell is the Drive link. Kept in memory: the
 * deployment has no writable disk.
 */
router.post('/upload', requireLogin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file.' });
    const url = await uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ success: true, url });
  } catch (err) {
    console.error('FMS upload failed:', err);
    res.status(500).json({ success: false, error: 'Could not upload that file.' });
  }
});

/**
 * POST /api/fms-tasks/:fmsId/steps/:stepId/done — mark one row done.
 *
 * Writing is where a stale column does real damage: it stamps somebody else's
 * step. So the target is resolved from the header row here too, exactly as on
 * the read path, and never from a letter the browser sent.
 */
router.post('/:fmsId/steps/:stepId/done', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const { rowNumber, delayReason, extraInputs } = req.body;
    if (!rowNumber) return res.status(400).json({ success: false, error: 'Which row?' });

    const sheet = await one('SELECT * FROM fms_sheets WHERE id = ?', [req.params.fmsId]);
    const step = await one('SELECT * FROM fms_steps WHERE id = ? AND fms_id = ?',
      [req.params.stepId, req.params.fmsId]);
    if (!sheet || !step) return res.status(404).json({ success: false, error: 'Step not found.' });

    // Being named on the step is the permission to complete it.
    if (!canSeeAll(user)) {
      const mine = await one(
        'SELECT 1 AS ok FROM fms_step_doers WHERE step_id = ? AND user_id = ? LIMIT 1',
        [step.id, user.id]);
      if (!mine) return res.status(403).json({ success: false, error: 'This step is not assigned to you.' });
    }

    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';
    const headerRowIdx = (sheet.header_row || 1) - 1;

    const extraRows = await many(
      'SELECT id, col_letter, header_name, header_occ FROM fms_extra_rows WHERE step_id = ? ORDER BY id ASC',
      [step.id]);
    const headerOnly = await sheets.readValues(
      spreadsheetId, `'${tabName}'!${headerRowIdx + 1}:${headerRowIdx + 1}`, { fresh: true });
    const cols = fmsColumns.resolveStep(step, extraRows, headerOnly[0] || []);

    // Two ways a step gets completed, and the sheet decides which.
    //
    // Where the sheet derives the actual date itself — =if(J8,J8,if(L8,$A$1,""))
    // on these tabs, which freezes a timestamp the moment the Status box is
    // ticked — writing our own date would replace that formula and leave the
    // checkbox and the date disagreeing from then on. So the app ticks the box
    // and lets the sheet fill the date, exactly as a person would.
    const completeCol = fmsColumns.letterAt(cols.complete);
    const actualCol = fmsColumns.letterAt(cols.actual);
    if (!completeCol && !actualCol) {
      return res.status(400).json({
        success: false,
        error: 'This step has neither an Actual column nor a Status checkbox configured.',
      });
    }

    const data = completeCol
      ? [{ range: `'${tabName}'!${completeCol}${rowNumber}`, values: [[true]] }]
      : [{ range: `'${tabName}'!${actualCol}${rowNumber}`, values: [[istSheetSerialNow()]] }];

    const delayCol = fmsColumns.letterAt(cols.delay);
    if (delayReason && delayCol) {
      data.push({ range: `'${tabName}'!${delayCol}${rowNumber}`, values: [[delayReason]] });
    }

    if (Array.isArray(extraInputs) && extraInputs.length) {
      // Match on the row id, not the letter. The browser holds the mapping it
      // was handed when the page loaded, and the sheet may have moved since.
      const byId = new Map(extraRows.map(r => [String(r.id), r]));
      for (const ei of extraInputs) {
        if (ei.value === undefined || ei.value === '') continue;
        const row = ei.rowId != null ? byId.get(String(ei.rowId)) : null;
        const letter = row ? fmsColumns.letterAt(cols.extras[row.id]) : '';
        if (letter) data.push({ range: `'${tabName}'!${letter}${rowNumber}`, values: [[ei.value]] });
      }
    }

    const api = await sheets.getWriteClient();
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
    sheets.invalidateSheet(spreadsheetId);   // the row just changed

    res.json({
      success: true,
      // Which mechanism was used, so the screen can say "ticked Status" rather
      // than implying a date was written.
      completedBy: completeCol ? 'checkbox' : 'timestamp',
      column: completeCol || actualCol,
    });
  } catch (err) {
    const code = err.code || (err.response && err.response.status);
    if (code === 403) {
      return res.status(400).json({
        success: false,
        error: `This server writes as ${sheets.serviceAccountEmail() || 'its service account'}, which only has read access to this sheet. Share it as Editor.`,
      });
    }
    console.error('FMS mark-done failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
