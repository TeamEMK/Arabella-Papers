// ══════════════════════════════════════════════════════
// A BOARD, AS A GOOGLE SHEET
//
// The Excel button hands back a file that lands in somebody's Downloads and
// is mailed on. This makes the same table a sheet instead - one link, open in
// a browser, nothing to attach - which is how most of this office already
// passes work around.
//
// A NEW sheet every time, deliberately. Overwriting one would quietly rewrite
// a link somebody sent last week, and the person who opens it tomorrow has no
// way of telling that the numbers changed under them.
//
// It is made inside a folder of the office's own Drive, not the service
// account's. Google gives a service account no Drive storage at all - its
// quota reads limit: 0 - so a file it tries to own is refused with "The caller
// does not have permission", which says nothing about what is actually wrong.
// Made in a folder somebody else owns, it is that account's storage, and it
// works. That is what DRIVE_SHEETS_FOLDER_ID is for.
//
// Anybody with the link can read it. A decision the office took knowingly:
// these carry dealer and client names, and a link that leaves the building is
// readable by whoever has it.
// ══════════════════════════════════════════════════════
const { google } = require('googleapis');
const { loadCredentials } = require('./sheets');

// Creating the file and writing to it are Sheets; sharing it is Drive. Both
// scopes on one client, so there is one sign-in rather than two.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

async function auth() {
  const a = new google.auth.GoogleAuth({ credentials: loadCredentials(), scopes: SCOPES });
  return a.getClient();
}

// What the Sheets API will take in one write. A board is a few thousand rows,
// so this is a guard rather than a limit anybody meets.
const MAX_CELLS = 400000;

/**
 * Where the sheets go: a folder in the office's Drive, shared with the service
 * account as an Editor.
 *
 * Falls back to DRIVE_FOLDER_ID, the folder design uploads already go to - one
 * less thing to set up, and if those uploads work then that folder is already
 * shared the right way.
 */
function folderId() {
  return (process.env.DRIVE_SHEETS_FOLDER_ID || process.env.DRIVE_FOLDER_ID || '').trim();
}

/** Google's own limit on a tab name, minus the room the date takes. */
function tabName(title) {
  const clean = String(title || 'Export').replace(/[\[\]*?:\\\/]+/g, ' ').trim();
  return (clean || 'Export').slice(0, 90);
}

/**
 * Build the sheet and hand back its link.
 *
 * @param {string} title    what the file is called
 * @param {string[]} columns the header row
 * @param {Array[]} rows    the body, one array per row
 * @param {string} madeBy   who pressed the button, written into the file name
 * @returns {{url: string, id: string, rows: number}}
 */
async function createSheet(title, columns, rows, madeBy) {
  const cells = (rows.length + 1) * columns.length;
  if (cells > MAX_CELLS) {
    throw new Error(`Too much for one sheet (${cells.toLocaleString()} cells).`);
  }

  const parent = folderId();
  if (!parent) {
    // Spelled out, because whoever sees this cannot read the code and the 403
    // underneath explains nothing.
    throw new Error(
      'No Drive folder is set up for sheets. Make a folder in Google Drive, share it '
      + 'with the service account as an Editor, and set DRIVE_SHEETS_FOLDER_ID to the '
      + 'folder id out of its URL.');
  }

  const client = await auth();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const drive = google.drive({ version: 'v3', auth: client });

  // Dated in IST, because the question somebody asks of these afterwards is
  // "which day is this one" and the server runs on UTC.
  const stamp = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const name = `${tabName(title)} - ${stamp}`;

  // Made through Drive rather than sheets.spreadsheets.create, which takes no
  // parent and so would put the file in the service account's own Drive, where
  // it has no room. Everything after this is Sheets as usual.
  const file = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [parent],
      // Who asked for it, on the file itself: these pile up in one folder and
      // the name alone will not say where one came from.
      description: madeBy ? `Arabella Papers FMS - ${title}, made by ${madeBy}` : undefined,
    },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  });
  const id = file.data.id;

  // The tab Drive just made, by its real id - 0 is the usual answer and not a
  // promised one.
  const opened = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: 'spreadsheetUrl,sheets.properties(sheetId,title)',
  });
  const tab = opened.data.sheets[0].properties;

  // en_GB, not en_IN: Sheets rejects en_IN outright, and GB is the one that
  // reads 03/10 as the third of October, which is how every date in this app
  // is written. Set here because a file made through Drive takes the defaults.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [{
        updateSpreadsheetProperties: {
          properties: { locale: 'en_GB', timeZone: 'Asia/Kolkata' },
          fields: 'locale,timeZone',
        },
      }],
    },
  });

  // Everything as text the way the browser sent it. Letting Sheets guess turns
  // an order number into a date and 03/10 into the third of October in a
  // column that meant the third of the tenth.
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `'${tab.title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        columns.map(c => String(c)),
        ...rows.map(r => (Array.isArray(r) ? r : [])
          .slice(0, columns.length)
          .map(v => (v === null || v === undefined ? '' : String(v)))),
      ],
    },
  });

  // The header reads as a header, and the columns are wide enough to read
  // without dragging each one open - the same two things the .xlsx does.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.13, green: 0.15, blue: 0.16 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                verticalAlignment: 'MIDDLE',
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: tab.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: tab.sheetId,
                startRowIndex: 0,
                endRowIndex: rows.length + 1,
                startColumnIndex: 0,
                endColumnIndex: columns.length,
              },
            },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: tab.sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: columns.length,
            },
          },
        },
      ],
    },
  });

  // Readable by link, not writable. Somebody opening a report to look through
  // it has no business editing it, and a sheet that can be edited by anyone
  // who has the link is a sheet whose numbers cannot be trusted later.
  await drive.permissions.create({
    fileId: id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });

  return {
    url: opened.data.spreadsheetUrl || file.data.webViewLink
      || `https://docs.google.com/spreadsheets/d/${id}/edit`,
    id,
    rows: rows.length,
  };
}

module.exports = { createSheet };
