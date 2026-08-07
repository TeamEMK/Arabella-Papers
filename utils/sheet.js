const ExcelJS = require('exceljs');
const { Readable } = require('stream');

// Header text is matched loosely so "Dealer Name", "dealer name" and
// "Dealer  Name " all land on the same field — people retype these by hand.
function normalizeHeader(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  // ExcelJS returns objects for formulas, hyperlinks and rich text rather than
  // the string the user sees in the cell.
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(t => t.text).join('');
    if (value.hyperlink !== undefined) return String(value.hyperlink);
    return '';
  }
  return String(value).trim();
}

function isXlsx(buffer) {
  // xlsx is a zip archive: "PK\x03\x04".
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isLegacyXls(buffer) {
  // BIFF compound-document signature D0 CF 11 E0 — Excel 97-2003 .xls.
  return buffer.length > 4 &&
    buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

async function loadWorksheet(buffer, filename) {
  const workbook = new ExcelJS.Workbook();

  if (isLegacyXls(buffer)) {
    throw new Error(
      'This is a legacy .xls file (Excel 97-2003). Open it in Excel and use ' +
      'File > Save As > Excel Workbook (.xlsx), then upload again.',
    );
  }

  if (isXlsx(buffer)) {
    await workbook.xlsx.load(buffer);
  } else {
    // Anything else is treated as delimited text. A stream is required because
    // exceljs's csv reader does not accept a buffer.
    await workbook.csv.read(Readable.from(buffer.toString('utf8')));
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('That file has no sheets in it.');
  return sheet;
}

/**
 * Reads the first worksheet into plain objects keyed by normalized header.
 * Returns { headers, rows } where each row also carries the spreadsheet line
 * number, so errors can point the user at a row they can actually find.
 */
async function readRows(buffer, filename) {
  const sheet = await loadWorksheet(buffer, filename);

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = normalizeHeader(cellText(cell.value));
  });

  if (!headers.filter(Boolean).length) {
    throw new Error('The first row must contain column headers.');
  }

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const record = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const text = cellText(cell.value);
      record[key] = text;
      if (text !== '') hasValue = true;
    });

    // Spreadsheets routinely carry trailing rows that look empty but still
    // exist; importing them would create blank records.
    if (hasValue) rows.push({ line: rowNumber, values: record });
  });

  return { headers: headers.filter(Boolean), rows };
}

function toCsv(rows) {
  return rows
    .map(cols => cols.map(c => {
      const s = String(c === null || c === undefined ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','))
    .join('\r\n');
}

module.exports = { readRows, normalizeHeader, toCsv };
