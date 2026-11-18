const { google } = require('googleapis');
const { Readable } = require('stream');
const { loadCredentials } = require('./googleCreds');

function getAuth() {
  // The same loader Sheets uses. This used to read one pair of variables
  // directly, and production does not have that pair - it holds the whole
  // service-account JSON in GOOGLE_CREDENTIALS. Two ways of finding one
  // service account is one way too many, and this was the half that was
  // looking in the wrong place.
  return new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

/**
 * Where the print-ready artwork goes.
 *
 * Its own folder, not the one the proofs land in: nine thousand JPEGs and a
 * few hundred pieces of artwork in one place is not somewhere anybody can
 * find anything. Falls back to the old folder so a deployment without the
 * new setting still works rather than failing at the first upload.
 */
const vectorFolder = () => process.env.VECTOR_DRIVE_FOLDER_ID || process.env.DRIVE_FOLDER_ID;

/**
 * Where everything that is not a vector file goes - proofs, approvals, the
 * design uploads. It is the folder `uploadToDrive` has always used, named
 * here so a direct upload lands in the same place as the ones that went
 * through the server, and a file does not move house because the route it
 * took changed.
 */
const designFolder = () => process.env.DRIVE_FOLDER_ID;

// ── NOTHING NEW IS SHARED WITH THE WORLD ──
//
// Every file this app uploaded used to be made "anyone with the link can
// read" the moment it landed. A Drive id is not guessable, but a link
// travels: into a sheet cell, a mail, a WhatsApp message, a browser history
// on a shared machine. Wherever it got to, the file went with it, with no
// login in front of it.
//
// So the permission is not created any more, and the link handed back is
// this app's own - routes/api/files.js, which checks the session and then
// streams the bytes through the service account. The office opens the same
// button; a stranger holding the link gets the login page.
//
// Files uploaded before this change are untouched: still public, still
// pointing at Drive. Thousands of those links are in sheets and mails
// already, and breaking them is a worse day than leaving them.

/** The folders this app owns. Nothing outside them is served. */
const ourFolders = () => [vectorFolder(), designFolder()]
  .filter(Boolean)
  .filter((v, i, all) => all.indexOf(v) === i);

const APP_URL = () =>
  (process.env.APP_URL || 'https://mis.arabellapapers.com').replace(/\/+$/, '');

/**
 * Where to send somebody to see this file.
 *
 * Absolute, because this link is written into Google Sheet cells and into
 * mail as often as it is clicked inside the app.
 */
const linkFor = (file) => APP_URL() + '/api/files/' + file.id;

/**
 * Upload a file buffer to Google Drive
 * @param {Buffer} buffer - File buffer
 * @param {string} fileName - Original file name
 * @param {string} mimeType - File mime type
 * @returns {string} - Shareable Google Drive URL
 */
async function uploadToDrive(buffer, fileName, mimeType) {
  const drive = getDriveClient();
  const folderId = process.env.DRIVE_FOLDER_ID;

  const response = await drive.files.create({
    requestBody: {
      name: `${Date.now()}_${fileName}`,
      parents: folderId ? [folderId] : [],
    },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  return linkFor(response.data);
}

// ══════════════════════════════════════════════════════
// STRAIGHT FROM THE BROWSER, FOR THE BIG ONES
//
// Everything above goes through this server, and this server is on Vercel,
// which refuses any request body over 4.5MB before a line of our code runs.
// Print-ready Illustrator artwork is routinely ten times that, so the vector
// file - the one thing the office is now required to attach - was the one
// thing that could not be sent.
//
// So it is not sent here. We ask Google for a resumable upload session, hand
// the browser the session address, and the file goes from the designer's
// machine to Drive without passing through us. Nothing we run has to hold
// fifty megabytes, and there is no size limit left to hit.
//
// THE SESSION ADDRESS IS THE CREDENTIAL. It carries its own authorisation for
// that one upload and nothing else - no token of ours reaches the browser,
// and the address is useless for reading or writing anything already in the
// folder. It is still short-lived and specific, so it is handed out per file,
// per order, to somebody already logged in.
//
// THE ORIGIN IS SENT WHEN THE SESSION IS OPENED, because Google's own
// instructions for uploading from a browser say to. Measured against the real
// folder: the session address answers the browser's preflight with
// Allow-Origin: our site and Allow-Methods: PUT, and the upload itself comes
// back 200 with the same header - and it did so whether or not the Origin was
// passed on the opening request. So this is the documented way round rather
// than the load-bearing one. It is kept because Google is free to start
// enforcing what it documents, and a header costs nothing.
// ══════════════════════════════════════════════════════

const RESUMABLE = 'https://www.googleapis.com/upload/drive/v3/files'
  + '?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink,size,parents';

/**
 * Open an upload the browser will finish.
 *
 * @param {object} o {fileName, mimeType, size, origin}
 * @returns {Promise<{sessionUrl: string, driveName: string}>}
 */
async function startResumableUpload({ fileName, mimeType, size, origin, folderId: wantFolder }) {
  const auth = getAuth();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Google would not issue an access token.');

  // The caller names the folder; a vector file and a proof do not live in
  // the same one. Undefined rather than empty means "not said", so an
  // explicit choice is never mistaken for the default.
  const folderId = wantFolder === undefined ? vectorFolder() : wantFolder;
  // The name is ours, not theirs, and it is how the finished file is
  // recognised when the browser comes back to say it is done - see
  // claimUpload. A name we invented and nobody else knows cannot be guessed
  // at, so a made-up file id is caught.
  const driveName = `${Date.now()}_${fileName}`;

  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'application/octet-stream',
  };
  if (size) headers['X-Upload-Content-Length'] = String(size);
  // The page that will do the uploading, as Google's browser-upload
  // instructions ask for. See the note above on what was measured.
  if (origin) headers.Origin = origin;

  const res = await fetch(RESUMABLE, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: driveName, parents: folderId ? [folderId] : [] }),
  });

  if (!res.ok) {
    const why = await res.text().catch(() => '');
    throw new Error('Google refused the upload session (' + res.status + '): ' + why.slice(0, 300));
  }
  const sessionUrl = res.headers.get('location');
  if (!sessionUrl) throw new Error('Google gave no upload address back.');

  return { sessionUrl, driveName };
}

/**
 * Take delivery of a file the browser uploaded.
 *
 * The browser tells us an id. An id is a claim, not a fact, so the file is
 * read back and checked: it has to be the name we issued, and it has to be in
 * our folder. Either way round, somebody passing the id of a file they do not
 * own gets nothing - the name was never theirs to know.
 *
 * @returns {Promise<{url: string, name: string, size: number}>}
 */
async function claimUpload(fileId, expectedName, wantFolder) {
  const drive = getDriveClient();
  const folderId = wantFolder === undefined ? vectorFolder() : wantFolder;

  const { data } = await drive.files.get({
    fileId,
    fields: 'id, name, size, parents, webViewLink',
    supportsAllDrives: true,
  });

  if (data.name !== expectedName) {
    throw new Error('That file is not the one this upload was opened for.');
  }
  if (folderId && !(data.parents || []).includes(folderId)) {
    throw new Error('That file is not in this app\'s Drive folder.');
  }

  // Nothing is shared with the world here either - see the note above
  // linkFor. The bytes are in Drive, the link is ours, and who may read it
  // is a question this app answers rather than Google.
  return { url: linkFor(data), name: data.name, size: Number(data.size || 0) };
}

module.exports = {
  uploadToDrive, startResumableUpload, claimUpload,
  vectorFolder, designFolder, ourFolders, getDriveClient, linkFor,
};
