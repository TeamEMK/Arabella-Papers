// ══════════════════════════════════════════════════════
// ORDER NUMBERS, AS PEOPLE TYPE THEM
//
// Every order in the book is K- and then digits: 8,663 of them and not one
// exception. So the hyphen carries no information - it is punctuation the
// office has to remember, and forgetting it used to mean "no order with that
// number" on a number that exists.
//
// Three slips, all of them the same order:
//
//   K-160471    what is on the paperwork
//   k160471     typed from memory, no hyphen        <- was refused
//   k- 160190   a space that crept in on a copy     <- already handled
//
// One file, because this is asked in four places - raising a correction and
// its live preview, the public tracker, and searching - and four copies of a
// rule is four chances for them to drift. The browser gets the same rule
// from /js/orderId.js, which is this file served as-is.
// ══════════════════════════════════════════════════════

/**
 * Tidy one typed order number into the form the database holds.
 *
 * It only ever repairs punctuation. An id it does not recognise is returned
 * trimmed and otherwise untouched, so a number that is genuinely wrong still
 * reads back as what the person typed.
 */
function tidyOrderId(v) {
  let s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';

  // "k- 160190" and "k -160190" are one number typed in a hurry. The hyphen
  // is pulled back onto what sits either side of it when a digit follows, so
  // the -R1 on a repeat survives.
  s = s.replace(/\s+/g, ' ').replace(/([A-Za-z0-9])\s*-\s*([A-Za-z]?\d)/g, '$1-$2');

  // The hyphen itself, when it was never typed: letters then digits.
  s = s.replace(/^([A-Za-z]+)[\s.]*(\d)/, '$1-$2');

  // Digits alone. Every order is K-, so a bare number can only be one thing -
  // and the office quotes them to each other that way all day.
  if (/^\d{4,8}$/.test(s)) s = 'K-' + s;

  return s.replace(/\s/g, '');
}

/**
 * A pasted list of order numbers, in the order they were typed.
 *
 * They arrive out of a mail, a sheet cell or a chat message, separated by
 * commas, spaces, semicolons or line breaks, and often several of those at
 * once. Repeats are dropped rather than refused: pasting the same number
 * twice is a slip, and raising two identical corrections would be the wrong
 * answer to it.
 */
function parseOrderIds(input) {
  const typed = Array.isArray(input)
    ? input
    : String(input || '')
        // The space-hyphen repair has to happen before the split, or one
        // number becomes two halves and two "not found"s.
        .replace(/([A-Za-z0-9])\s*-\s*([A-Za-z]?\d)/g, '$1-$2')
        .split(/[\s,;]+/);

  const out = [];
  const seen = new Set();
  for (const piece of typed) {
    const id = tidyOrderId(piece);
    if (!id) continue;
    // "K-160190 - K-160191" is two orders with a dash between them, and the
    // repair above deliberately leaves it alone - which left the dash itself
    // in the list, reported back as "no order with that number". Nothing
    // without a digit in it can be an order number.
    if (!/\d/.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

const api = { tidyOrderId, parseOrderIds };

// Loaded by Node as a module and by the browser as a plain script, so the
// preview in the Corrections box answers with exactly what will be raised.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ArabellaOrderId = api;
