// ══════════════════════════════════════════════════════
// WHAT A FILE ACTUALLY IS, NOT WHAT IT SAYS IT IS
//
// Every upload check in this app read `req.file.mimetype`. That field is not
// a fact about the file - it is a line the browser typed into the request,
// and anything that can post a form can type a different one. So
// "image/png" on a Windows executable, a .js, a macro-laden .docm, got
// through every one of them.
//
// Two of those endpoints mail the file straight to somebody in the office,
// and the catalogue one hands it back out again to whoever opens the
// customer page. A file nobody ever checked, served from our own address.
//
// So the first bytes are read instead - every real format starts with its
// own signature - and THE EXTENSION HAS TO AGREE WITH THEM. Both halves
// matter, and for different reasons:
//
//   the signature stops a program dressed as a picture;
//   the extension agreeing stops the opposite - a real JPEG saved as
//   invoice.pdf.exe, which is what the person double-clicking sees.
//
// SVG IS NOT ALLOWED ANYWHERE. It looks like a picture and is a document:
// it can carry <script>, and served from our own origin that script is in
// our session. A catalogue design is a photograph of paper; it has no
// business being one.
// ══════════════════════════════════════════════════════

// Each kind: the extensions it is allowed to wear, and the type we will
// state when we hand it back. The claimed type is never stored - what goes
// into the database is the one from this table.
const KINDS = {
  jpeg: { mime: 'image/jpeg', ext: ['jpg', 'jpeg', 'jpe'] },
  png: { mime: 'image/png', ext: ['png'] },
  gif: { mime: 'image/gif', ext: ['gif'] },
  webp: { mime: 'image/webp', ext: ['webp'] },
  heic: { mime: 'image/heic', ext: ['heic', 'heif'] },
  pdf: { mime: 'application/pdf', ext: ['pdf'] },
  doc: { mime: 'application/msword', ext: ['doc', 'xls', 'ppt'] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: ['docx'],
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: ['xlsx', 'xlsm'],
  },
  csv: { mime: 'text/csv', ext: ['csv', 'txt'] },
};

const starts = (buf, bytes, at) => bytes.every((b, i) => buf[(at || 0) + i] === b);

/**
 * The kind these bytes really are, or null for anything not listed.
 *
 * Null is the answer for an executable, a zip, a script, a video - and null
 * is refused everywhere. A list of what is allowed, never a list of what is
 * banned: a banned list is always missing this year's new thing.
 */
function sniff(buf) {
  if (!buf || buf.length < 8) return null;

  if (starts(buf, [0xFF, 0xD8, 0xFF])) return 'jpeg';
  if (starts(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png';
  const six = buf.slice(0, 6).toString('latin1');
  if (six === 'GIF87a' || six === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF'
    && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  // HEIC says what it is a few bytes in, after the box length.
  if (buf.slice(4, 8).toString('latin1') === 'ftyp'
    && /^(heic|heix|hevc|hevx|mif1|msf1)/.test(buf.slice(8, 12).toString('latin1'))) {
    return 'heic';
  }
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // The old Office formats are all one container, and only the extension
  // tells .doc from .xls - which is why those three share a kind here.
  if (starts(buf, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return 'doc';

  // docx and xlsx are zips. The part names sit in the first few hundred
  // bytes, so one of the two is named there, and a plain zip - which is what
  // a disguised bundle of anything looks like - matches neither.
  if (starts(buf, [0x50, 0x4B, 0x03, 0x04])) {
    const head = buf.slice(0, 2000).toString('latin1');
    if (head.includes('word/')) return 'docx';
    if (head.includes('xl/')) return 'xlsx';
    return null;
  }

  // A spreadsheet export has no signature at all. Accepted only as text:
  // every byte printable, a tab, a newline or a carriage return. A binary
  // slipped in as .csv fails on its first odd byte, and anything that opens
  // like a document a browser would render is refused outright.
  const sample = buf.slice(0, 4096);
  const textish = sample.every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 247));
  if (textish && !/<\s*(script|svg|html|\?xml)/i.test(sample.toString('latin1'))) return 'csv';

  return null;
}

const extensionOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
};

const listFor = (kinds) => kinds
  .map(k => (KINDS[k] ? KINDS[k].ext[0].toUpperCase() : k)).join(', ');

/**
 * Is this upload one of the kinds this endpoint takes?
 *
 * @param file   a multer file: { originalname, buffer }
 * @param kinds  the kinds allowed here, e.g. ['jpeg', 'png']
 * @returns {ok: true, kind, mime} or {ok: false, error} - the error is a
 *          sentence for the person, naming the file they chose.
 */
function checkFile(file, kinds) {
  const name = String((file && file.originalname) || 'that file');
  if (!file || !file.buffer || !file.buffer.length) {
    return { ok: false, error: name + ' arrived empty.' };
  }

  const kind = sniff(file.buffer);
  if (!kind || !kinds.includes(kind)) {
    // Deliberately does not say what it WAS. "That is a Windows program" is
    // a useful answer to somebody probing what gets through.
    return { ok: false, error: name + ' is not a ' + listFor(kinds) + ' file.' };
  }

  const ext = extensionOf(name);
  if (ext && !KINDS[kind].ext.includes(ext)) {
    return {
      ok: false,
      error: name + ' is really a ' + KINDS[kind].ext[0].toUpperCase()
        + ' - rename it and send it again.',
    };
  }

  return { ok: true, kind, mime: KINDS[kind].mime };
}

/** Every file at once; the first complaint is the one shown. */
function checkFiles(files, kinds) {
  for (const f of files || []) {
    const r = checkFile(f, kinds);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// ── HANDING THEM BACK ──
//
// The browser is told the stored type and told not to guess (nosniff).
// Anything not on this list - an SVG uploaded before this file existed, a
// type no longer accepted - goes out as bytes to save rather than a page to
// open, so an old row cannot run anything either.
const SAFE_INLINE = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf',
]);

function sendHeaders(res, bytes, storedMime, fileName) {
  const safe = SAFE_INLINE.has(String(storedMime || '').toLowerCase());
  const clean = String(fileName || 'file').replace(/[^\w. -]+/g, '_').slice(0, 120);
  res.setHeader('Content-Type', safe ? storedMime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    (safe ? 'inline' : 'attachment') + '; filename="' + clean + '"');
  res.setHeader('Content-Length', bytes.length);
  return res;
}

module.exports = { sniff, checkFile, checkFiles, sendHeaders, KINDS, SAFE_INLINE };
