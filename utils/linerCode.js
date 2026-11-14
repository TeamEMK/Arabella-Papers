// ══════════════════════════════════════════════════════
// WHAT A LINER IS CALLED
//
// Every design needs a name somebody can quote down a telephone, and
// "Design 7" is not one: there are twenty-one categories and a Design 7 in
// most of them. So a liner is called after where it lives and what number it
// is in there - CT-FB-01 is the first liner in Floral & Botanical, which is
// in Classic & Traditional.
//
// DERIVED, NOT WRITTEN DOWN. A hand-kept table of abbreviations is a table
// somebody forgets to add a row to, and the symptom - two categories quietly
// sharing a prefix - is the kind nobody notices until an order goes out with
// the wrong liner on it. The initials come off the names themselves.
//
// A CODE NEVER MOVES ONCE IT IS GIVEN. Delete the fifth of eighteen and the
// rest keep their numbers; the next one added takes the number after the
// highest, not the gap. A code that has been read out to a customer must
// still mean the same design next month, and renumbering is how it stops
// meaning anything at all.
// ══════════════════════════════════════════════════════

// Words that carry no meaning in a name and would only pad the initials out.
// "Birds / Butterflies / Wildlife" is BBW; the slashes are not letters.
const SKIP = new Set(['and', 'the', 'of', 'in', 'or', 'a', 'an']);

/**
 * The initials of a name: CLASSIC & TRADITIONAL -> CT.
 *
 * Only letters and digits count as a word. A name that is one word gives up
 * to three of its own letters rather than a single one, because a lone letter
 * is not a name - "Chinoiserie" is CHI.
 */
function initials(name) {
  const words = String(name || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(w => w && !SKIP.has(w.toLowerCase()));
  if (!words.length) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map(w => w[0]).join('').toUpperCase();
}

/**
 * The code for the nth design of a category, counting from one.
 *
 * Both halves on purpose: the category's own initials are not enough, since
 * Coastal & Nautical and Celebrations & Nothing would both be CN. The
 * section in front keeps them apart, and reads as where the thing lives.
 */
function codeFor(section, category, n) {
  const num = Math.max(1, Number(n) || 1);
  return [
    initials(section),
    initials(category),
    String(num).padStart(2, '0'),
  ].filter(Boolean).join('-');
}

/**
 * Every pair of section and category that would end up sharing a prefix.
 *
 * Shouted about rather than silently worked around: two categories sharing a
 * prefix means two designs sharing a code, and a code that means two things
 * is worse than no code. Called by the suite over the real list.
 */
function clashes(pairs) {
  const seen = new Map();
  const bad = [];
  for (const [section, category] of pairs) {
    const prefix = initials(section) + '-' + initials(category);
    if (seen.has(prefix)) {
      bad.push(prefix + ' is both "' + seen.get(prefix) + '" and "' + category + '"');
    } else {
      seen.set(prefix, category);
    }
  }
  return bad;
}

// Node only. This one is never served to a browser - the code is put on the
// row when the design is stored, and the page just shows what came back - so
// it takes no window export. The three files that ARE served had to be shut
// inside functions after two of them collided on a top-level name and killed
// each other; there is no reason to invite that here.
module.exports = { initials, codeFor, clashes };
