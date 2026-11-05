const crypto = require('crypto');
const db = require('../config/db');
// The whole module, not its pieces: the smoke suites replace drive.js in the
// require cache with a stub, and a destructured function captured at load
// time would still point at the real one - or, for a stub that does not
// bother to export it, at undefined.
const drive = require('./drive');
const designFolder = () => (drive.designFolder ? drive.designFolder() : process.env.DRIVE_FOLDER_ID);
const { DESIGN_FILES, MAX_VECTOR_BYTES } = require('./uploadTypes');

// ══════════════════════════════════════════════════════
// EVERY DESIGN FILE GOES STRAIGHT TO DRIVE NOW
//
// The vector box has done this since the day it was built: the browser asks
// us to open an upload, sends the bytes to Google itself, and comes back
// with an id we file against the order. Nothing large passes through this
// server, so the platform's 4.5MB body limit never applies.
//
// Every OTHER box - the design files on a new order, the upload on Update
// Order Status, the one on Edit Details, the final approval on Till Approval
// - still posted through us, and so still stopped at 4MB. Somebody holding a
// 69MB .ai was told to "send a flattened PDF", for a limit that had already
// been solved one box over.
//
// So this is that same three-step dance with the order taken out of it. A
// ticket is opened for a file, spent when the file arrives, and then named
// by the form that wanted it. The form sends the TOKEN, never the URL: a URL
// in a form field is a URL anybody can type, and we would file it.
//
// ONE PATH, NOT A SIZE BRANCH. A small file goes this way too. A route that
// only runs on big files is a route that is only tested on big files, and
// this box spent months looking like it worked.
// ══════════════════════════════════════════════════════

/** Same ceiling as the vector box: far past any artwork, well short of trouble. */
const MAX_DIRECT_BYTES = MAX_VECTOR_BYTES;

const ALLOWED = DESIGN_FILES.split(',');

const extensionOf = (name) => {
  const m = /\.[A-Za-z0-9]+$/.exec(String(name || '').trim());
  return m ? m[0].toLowerCase() : '';
};

/**
 * Open an upload the browser will finish.
 * @returns {Promise<{token: string, sessionUrl: string}>}
 */
async function openSession({ fileName, mimeType, size, origin, email }) {
  const name = String(fileName || '').trim().slice(0, 255);
  const type = String(mimeType || '').trim().slice(0, 150);
  const bytes = Number(size || 0);

  if (!name) throw Object.assign(new Error('No file was chosen.'), { status: 400 });
  // `accept` on the input is a hint to the file dialog and nothing more, so
  // the list is enforced here, where it cannot be clicked past.
  if (!ALLOWED.includes(extensionOf(name))) {
    throw Object.assign(
      new Error('The file has to be one of: ' + ALLOWED.join(', ') + '.'),
      { status: 400 });
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw Object.assign(new Error('That file appears to be empty.'), { status: 400 });
  }
  if (bytes > MAX_DIRECT_BYTES) {
    throw Object.assign(new Error(
      'That file is ' + (bytes / 1048576).toFixed(0) + ' MB. The limit is '
      + (MAX_DIRECT_BYTES / 1048576) + ' MB.'), { status: 400 });
  }

  const { sessionUrl, driveName } = await drive.startResumableUpload({
    fileName: name, mimeType: type, size: bytes, origin, folderId: designFolder(),
  });

  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO design_upload_tickets (token, drive_name, file_name, requested_by)
     VALUES (?,?,?,?)`,
    [token, driveName, name, email || ''],
  );
  return { token, sessionUrl };
}

/**
 * Take delivery of the finished file and hold it against the ticket, ready
 * for whichever form claims it.
 * @returns {Promise<{url: string, name: string}>}
 */
async function claim({ token, fileId, email }) {
  const tok = String(token || '').trim();
  const id = String(fileId || '').trim();
  if (!tok || !id) {
    throw Object.assign(new Error('That upload cannot be matched to a ticket.'), { status: 400 });
  }

  // Spent on the way in. Two claims racing on one ticket would both read
  // "unused" if the reading and the marking were apart.
  const [spend] = await db.query(
    `UPDATE design_upload_tickets SET used_at = NOW()
      WHERE token = ? AND used_at IS NULL`, [tok]);
  if (!spend.affectedRows) {
    throw Object.assign(new Error('That upload has already been taken.'), { status: 400 });
  }

  const [[ticket]] = await db.query(
    'SELECT drive_name, file_name, requested_by FROM design_upload_tickets WHERE token = ?', [tok]);
  if (!ticket) throw Object.assign(new Error('No such upload.'), { status: 400 });
  if (ticket.requested_by && email && ticket.requested_by !== email) {
    throw Object.assign(new Error('That upload belongs to somebody else.'), { status: 403 });
  }

  let file;
  try {
    file = await drive.claimUpload(id, ticket.drive_name, designFolder());
  } catch (err) {
    // Nothing was filed, so the ticket goes back rather than being burnt on
    // a failure that was not the designer's doing.
    await db.query('UPDATE design_upload_tickets SET used_at = NULL WHERE token = ?', [tok]);
    throw err;
  }

  await db.query('UPDATE design_upload_tickets SET file_url = ? WHERE token = ?', [file.url, tok]);
  return { url: file.url, name: ticket.file_name };
}

/**
 * What a form means when it sends a token.
 *
 * The URL is read out of the ticket, never out of the request, so a hand-typed
 * `fileUrl` field gets nowhere. A token is good once: `filed_at` is set as it
 * is read, so resubmitting the same form does not attach the same file twice.
 *
 * @param {string|string[]} tokens
 * @returns {Promise<Array<{url: string, name: string}>>}
 */
async function resolve(tokens, email) {
  const list = (Array.isArray(tokens) ? tokens : [tokens])
    .map(t => String(t || '').trim()).filter(Boolean);
  if (!list.length) return [];

  const [rows] = await db.query(
    `SELECT token, file_url, file_name, requested_by FROM design_upload_tickets
      WHERE token IN (?) AND file_url IS NOT NULL AND filed_at IS NULL`, [list]);

  const byToken = new Map(rows.map(r => [r.token, r]));
  const out = [];
  for (const t of list) {
    const row = byToken.get(t);
    if (!row) throw Object.assign(new Error('That upload is no longer available. Please attach the file again.'), { status: 400 });
    if (row.requested_by && email && row.requested_by !== email) {
      throw Object.assign(new Error('That upload belongs to somebody else.'), { status: 403 });
    }
    out.push({ url: row.file_url, name: row.file_name });
  }
  await db.query('UPDATE design_upload_tickets SET filed_at = NOW() WHERE token IN (?)', [list]);
  return out;
}

/** The common case: one optional file on a form. Null when none was sent. */
async function resolveOne(token, email) {
  const [first] = await resolve(token, email);
  return first || null;
}

module.exports = { openSession, claim, resolve, resolveOne, MAX_DIRECT_BYTES };
