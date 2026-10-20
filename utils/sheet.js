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
    // richText first, and each of these read back through cellText rather than
    // String(). A cell somebody typed an address into and let Excel turn into a
    // mailto link comes back as { text: { richText: [...] }, hyperlink: ... } -
    // nested, and String() on that object gives "[object Object]". One such
    // cell in the office's list of 206 read as exactly that and the row was
    // turned away for having an invalid email.
    if (Array.isArray(value.richText)) return value.richText.map(t => cellText(t.text)).join('');
    if (value.text !== undefined) return cellText(value.text);
    if (value.result !== undefined) return cellText(value.result);
    if (value.hyperlink !== undefined) return String(value.hyperlink).replace(/^mailto:/i, '');
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

async function loadWorkbook(buffer, filename) {
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

  if (!workbook.worksheets.length) throw new Error('That file has no sheets in it.');
  return workbook;
}

/**
 * Reads a workbook into plain objects keyed by normalized header.
 *
 * EVERY sheet, not just the first. The office's recruitment list turned out to
 * be eleven tabs, one per role, and reading worksheets[0] took the 206 rows on
 * the first tab and silently left 930 behind - while reporting a successful
 * import, which is the worst way to lose data: nobody goes looking.
 *
 * Each sheet brings its own header row, so a tab with its columns in a
 * different order still reads correctly. A sheet with no headers at all is
 * skipped rather than fatal - a workbook often carries a notes or summary tab,
 * and refusing the whole upload over one is no help to anybody.
 *
 * Returns { headers, rows, sheets }, where every row carries the tab it came
 * from and its line number within that tab, so an error can name a place
 * somebody can actually go and look at.
 */
async function readRows(buffer, filename) {
  const workbook = await loadWorkbook(buffer, filename);

  const headerUnion = [];
  const rows = [];
  const sheets = [];

  for (const sheet of workbook.worksheets) {
    // Excel keeps a hidden sheet's data, but hiding a tab is how somebody says
    // "not this one" - importing from it would be importing what they put away.
    if (sheet.state && sheet.state !== 'visible') continue;

    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = normalizeHeader(cellText(cell.value));
    });
    const named = headers.filter(Boolean);
    if (!named.length) continue;

    for (const h of named) if (!headerUnion.includes(h)) headerUnion.push(h);

    let count = 0;
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
      if (!hasValue) return;
      // The tab name is data in its own right: when the tabs are departments,
      // it is the only place the department is written down.
      rows.push({ line: rowNumber, sheet: sheet.name.trim(), values: record });
      count++;
    });

    sheets.push({ name: sheet.name.trim(), rows: count });
  }

  if (!headerUnion.length) {
    throw new Error('The first row of a sheet must contain column headers.');
  }

  return { headers: headerUnion, rows, sheets };
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
