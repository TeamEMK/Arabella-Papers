// ══════════════════════════════════════════════════════
// THE FILES, HANDED OVER BY THIS APP AND NOT BY GOOGLE
//
// Every file this app put on Drive was shared "anyone with the link can
// read" the moment it landed - artwork, customer proofs, whatever an FMS
// row had attached. A Drive id is long and not guessable, but a link is a
// thing that travels: it sits in a sheet cell, in a mail, in a WhatsApp
// message, in somebody's browser history on a shared machine. Wherever it
// got to, the file came with it, with no login in front of it.
//
// So new uploads are not shared publicly at all. The link stored against an
// order is this route instead, and the bytes come out of Drive through the
// service account AFTER a session has been checked. The office opens the
// same button it always did; a stranger holding the link gets the login
// page.
//
// TWO THINGS THIS ROUTE WILL NOT DO:
//
//   It will not serve a file outside our own folders. The service account
//   can read everything it has ever been given, so without that check this
//   route would be a logged-in window onto all of it.
//
//   It will not let the browser guess a type. The name and type come from
//   Drive, and anything not safe to open inline is sent as a download -
//   see utils/fileKind.js.
//
// Files uploaded before today are untouched and still public; their links
// still point at Drive. Breaking the ones already pasted into sheets and
// mails would be a worse day than leaving them, and they can be unshared
// later as a separate decision.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { requireLogin } = require('../../middleware/auth');
const { sendHeaders } = require('../../utils/fileKind');
const { getDriveClient, ourFolders } = require('../../utils/drive');

// A Drive id, and nothing that could be a path or a query of its own.
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

router.get('/:id', requireLogin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).send('No such file.');

  try {
    const drive = getDriveClient();
    const { data } = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, size, parents',
      supportsAllDrives: true,
    });

    // Ours or nothing. A file the service account can read but that this
    // app never put there is not this app's to hand out.
    const folders = ourFolders();
    const parents = data.parents || [];
    if (folders.length && !parents.some(p => folders.includes(p))) {
      console.warn('[files] refused ' + id + ' - not in our folders, asked for by '
        + ((req.session.user && req.session.user.email) || 'nobody'));
      return res.status(404).send('No such file.');
    }

    const stream = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' });

    // The length is whatever Drive said when we asked for the metadata; a
    // stream has none of its own to state.
    sendHeaders(res, { length: Number(data.size || 0) }, data.mimeType, data.name);
    if (!data.size) res.removeHeader('Content-Length');
    // These are customer artwork and ID documents. Nothing in front of us
    // keeps a copy.
    res.setHeader('Cache-Control', 'private, no-store');

    stream.data.on('error', (err) => {
      console.error('[files] stream broke for ' + id + ':', err.message);
      res.destroy();
    });
    stream.data.pipe(res);
  } catch (err) {
    // A missing file and a file we may not read answer the same way, so the
    // difference between the two says nothing about what exists.
    console.error('[files] could not serve ' + id + ':', err.message);
    res.status(404).send('No such file.');
  }
});

module.exports = router;
