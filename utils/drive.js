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

module.exports = { uploadToDrive };
