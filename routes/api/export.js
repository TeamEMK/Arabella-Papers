// ══════════════════════════════════════════════════════
// EXCEL DOWNLOAD
//
// One endpoint for every board. The page already knows what it is showing -
// the filters have been applied, the columns are on screen - so it hands over
// the rows it has and gets a workbook back. The alternative was a query per
// board on this side that would have to be kept in step with the filtering on
// that side, and the two would drift the first time a filter changed.
//
// Nothing here reads the database. What the browser could not see, it cannot
// send, so a designer's download carries a designer's orders.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { requireLogin } = require('../../middleware/auth');

// A board is a few thousand rows at the outside. The cap is here so a damaged
// or crafted request cannot ask the server to build a workbook out of memory
// it does not have.
const MAX_ROWS = 20000;
const MAX_COLS = 60;

/** Windows will not open a file with any of these in its name. */
function safeName(title) {
  const clean = String(title || 'export').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60);
  return (clean || 'export').replace(/\s+/g, '-');
}

router.post('/xlsx', requireLogin, async (req, res) => {
  try {
    const title = String(req.body.title || 'Export').slice(0, 80);
    const columns = Array.isArray(req.body.columns) ? req.body.columns.slice(0, MAX_COLS) : [];
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

    if (!columns.length) return res.status(400).json({ success: false, error: 'No columns given.' });
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ success: false, error: `Too many rows (${rows.length}).` });
    }

    const book = new ExcelJS.Workbook();
    book.creator = 'Arabella Papers FMS';
    book.created = new Date();
    const sheet = book.addWorksheet(safeName(title).slice(0, 31));

    sheet.addRow(columns.map(c => String(c)));
    const head = sheet.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF212529' } };
    head.alignment = { vertical: 'middle' };
    head.height = 20;

    for (const row of rows) {
      const cells = Array.isArray(row) ? row : [];
      sheet.addRow(cells.slice(0, columns.length).map(v => (v === null || v === undefined ? '' : v)));
    }

    // Wide enough to read without dragging every column open, and capped so one
    // long remark does not push the rest off the screen.
    columns.forEach((name, i) => {
      let width = String(name).length + 2;
      for (const row of rows) {
        const v = Array.isArray(row) ? row[i] : '';
        const len = String(v === null || v === undefined ? '' : v).length;
        if (len > width) width = len;
      }
      sheet.getColumn(i + 1).width = Math.min(Math.max(width + 2, 10), 45);
    });

    // The header stays put and the whole block filters, because a download of
    // 400 rows is opened to be sorted and looked through.
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: columns.length },
    };

    const stamp = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${safeName(title)}-${stamp}.xlsx"`);
    await book.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export failed:', err);
    // The headers may already be out by the time this throws, in which case
    // the browser gets a truncated file rather than this.
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    else res.end();
  }
});

module.exports = router;
