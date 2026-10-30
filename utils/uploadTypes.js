// ══════════════════════════════════════════════════════
// WHAT THE FILE PICKER OFFERS
//
// Six boxes in this app take a file from a designer, and five of them used
// to refuse Illustrator artwork - so somebody with K-160471-BodyBio
// Menu-V3.ai in front of them clicked Choose and the file was not there to
// pick. Nothing was broken on the server; the picker simply would not show
// it.
//
// One list, used by all of them. A filter copied into six boxes is five
// chances to forget a format.
//
// EXTENSIONS, NOT MIME TYPES. Windows calls a .ai file
// application/postscript, macOS calls it application/illustrator, and a
// modern one is a PDF inside (this one starts %PDF-1.6). Naming the type
// means guessing which of those the machine will say; naming the extension
// does not.
//
// This is a convenience, never a guard. `accept` is a hint to the dialog and
// nothing stops a file arriving without it, so what actually matters is on
// the server.
// ══════════════════════════════════════════════════════

/** Print-ready artwork, as the designers hand it over. */
const ARTWORK = ['.ai', '.eps', '.cdr', '.svg', '.pdf', '.psd', '.indd'];

/** Proofs and approvals: a picture or a document. */
const PICTURES = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff'];

/**
 * Every box a designer puts work into offers both. A proof arrives as a JPEG
 * most days and as an .ai on the others, and which box it went in is not
 * worth refusing somebody over.
 */
const DESIGN_FILES = [...new Set([...ARTWORK, ...PICTURES])].join(',');

/** The vector box, which is for artwork and says so. */
const VECTOR_FILES = ARTWORK.join(',');

module.exports = { ARTWORK, PICTURES, DESIGN_FILES, VECTOR_FILES };
