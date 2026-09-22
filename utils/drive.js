const { google } = require('googleapis');
const { Readable } = require('stream');

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

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

  const stream = Readable.from(buffer);

  const fileMetadata = {
    name: `${Date.now()}_${fileName}`,
    parents: folderId ? [folderId] : [],
  };

  const media = {
    mimeType: mimeType,
    body: stream,
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  // Make file publicly viewable
  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });

  return response.data.webViewLink || `https://drive.google.com/file/d/${response.data.id}/view`;
}

/**
 * The same upload, without the "anyone with the link" permission.
 *
 * uploadToDrive above is for design files: those links are pasted into a
 * sheet and opened by dealers and designers who have no account here, so they
 * have to be public. A candidate's Aadhaar is the opposite case — it is read
 * by two people in the office and nobody else, so nothing is shared and the
 * file is fetched back through readFromDrive, behind the login.
 *
 * It returns the file id rather than a link, because a link to a private file
 * is no use to anybody: the id is what the download route needs.
 *
 * @returns {Promise<string>} the Drive file id
 */
async function uploadPrivateToDrive(buffer, fileName, mimeType) {
  const drive = getDriveClient();
  // Its own folder when one is set, so HR documents are not sitting in the
  // same folder as the design files somebody may have shared with a dealer.
  const folderId = process.env.DRIVE_HR_FOLDER_ID || process.env.DRIVE_FOLDER_ID;

  const response = await drive.files.create({
    requestBody: {
      name: `${Date.now()}_${fileName}`,
      parents: folderId ? [folderId] : [],
    },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id',
    supportsAllDrives: true,
  });

  return response.data.id;
}

/**
 * Read a private file back. The caller pipes the stream to the response, so
 * the file reaches the browser without ever being written to disk — which is
 * just as well, since on Vercel there is no disk to write it to.
 *
 * @returns {Promise<{name: string, mimeType: string, stream: NodeJS.ReadableStream}>}
 */
async function readFromDrive(fileId) {
  const drive = getDriveClient();
  const meta = await drive.files.get({
    fileId,
    fields: 'name, mimeType',
    supportsAllDrives: true,
  });
  const file = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  return { name: meta.data.name, mimeType: meta.data.mimeType, stream: file.data };
}

/**
 * Throw a file away. Used when a candidate fills the form in a second time and
 * replaces a document — the old one has no route left that can reach it, so
 * leaving it behind would only be an Aadhaar scan nobody knows is there.
 *
 * Never throws: a file that has already been deleted by hand must not fail the
 * submission that was replacing it.
 */
async function deleteFromDrive(fileId) {
  try {
    await getDriveClient().files.delete({ fileId, supportsAllDrives: true });
    return true;
  } catch (err) {
    console.warn(`[drive] could not delete ${fileId}: ${err.message}`);
    return false;
  }
}

module.exports = { uploadToDrive, uploadPrivateToDrive, readFromDrive, deleteFromDrive };
