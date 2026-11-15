/**
 * WHAT A LINER IS CALLED.
 *
 *   node scripts/smoke-liner-code.js
 *
 * No database and no server: this is the rule itself, checked against the
 * office's own twenty-one categories and against the things that would make
 * two designs share a name.
 */
const path = require('path');
const { initials, codeFor, clashes } = require('../utils/linerCode');
const { ENVELOPE_LINEAR_SEED } = require('../config/initDb');

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};
const NL = String.fromCharCode(10);

// What the word search would do with a phrase on its own, used to show
// why a code must never reach it.
const { matches } = require('../utils/linerTags');
function matchesEverything(q) {
  return matches(q, ['classic', 'traditional', 'floral', 'botanical']) === true
    && matches(q, ['speciality', 'statement', 'embossed']) === true;
}

console.log(NL + 'The letters come off the name');
check('two words give two letters', initials('Classic & Traditional') === 'CT',
  initials('Classic & Traditional'));
check('the ampersand is not a word', initials('Floral & Botanical') === 'FB',
  initials('Floral & Botanical'));
check('nor are the slashes',
  initials('Birds / Butterflies / Wildlife') === 'BBW',
  initials('Birds / Butterflies / Wildlife'));
check('a comma does not glue two words together',
  initials('Stripes, Checks & Lattice') === 'SCL',
  initials('Stripes, Checks & Lattice'));
// A single letter is not a name somebody can say down a telephone.
check('one word gives three letters, not one', initials('Chinoiserie') === 'CHI',
  initials('Chinoiserie'));
check('and a word shorter than three gives what it has', initials('Ink') === 'INK');
check('a name of nothing gives nothing', initials('   ') === '', initials('   '));
check('and so does no name at all', initials(null) === '');

console.log(NL + 'The code itself');
check('section, category, then the number',
  codeFor('Classic & Traditional', 'Floral & Botanical', 1) === 'CT-FB-01',
  codeFor('Classic & Traditional', 'Floral & Botanical', 1));
// Padded so a list of them sorts the way somebody reads it: 02 before 10.
check('single figures are padded',
  codeFor('Speciality & Statement', 'Embossed / Debossed', 6) === 'SS-ED-06');
check('and three figures are not cut short',
  codeFor('Speciality & Statement', 'Embossed / Debossed', 104) === 'SS-ED-104');
// Counting starts at one, so a zero or a missing number is the first design
// rather than a design called 00 that nobody can find.
check('a number below one is still the first',
  codeFor('Classic & Traditional', 'Floral & Botanical', 0) === 'CT-FB-01',
  codeFor('Classic & Traditional', 'Floral & Botanical', 0));
check('and so is no number at all',
  codeFor('Classic & Traditional', 'Floral & Botanical') === 'CT-FB-01');

// Deliberate, and worth writing down because it bites: "and", "the", "of",
// "a" and the rest are dropped, so a ONE-LETTER word that happens to be one
// of them disappears from the initials. Real category names do not run into
// this, and if two of them ever did collide because of it, clashes() refuses
// to write either rather than handing out a name that means two things.
check('little joining words are dropped', initials('Birds of Paradise') === 'BP',
  initials('Birds of Paradise'));
check('and a lone "a" goes with them', initials('A Line') === 'LIN',
  initials('A Line'));

console.log(NL + "The office's own twenty-one");
const pairs = [];
for (const [section, cats] of ENVELOPE_LINEAR_SEED) {
  for (const category of cats) pairs.push([section, category]);
}
check('the seed still holds five sections', ENVELOPE_LINEAR_SEED.length === 5,
  ENVELOPE_LINEAR_SEED.length);
check('and twenty-one categories', pairs.length === 21, pairs.length);

// The whole point. Two categories sharing a prefix means two designs sharing
// a name, and a name that means two things is worse than no name.
const bad = clashes(pairs);
check('no two of them share a prefix', bad.length === 0, bad);

const codes = pairs.map(([s, c]) => codeFor(s, c, 1));
check('so the first design of each is a different code',
  new Set(codes).size === codes.length, codes.length - new Set(codes).size);
check('and every one of them is readable',
  codes.every(c => /^[A-Z]{2,3}-[A-Z]{2,3}-\d{2}$/.test(c)),
  codes.filter(c => !/^[A-Z]{2,3}-[A-Z]{2,3}-\d{2}$/.test(c)));

console.log(NL + 'It notices a clash rather than writing one');
check('two categories that would collide are named',
  clashes([['Nature Places', 'Coastal Nautical'],
           ['Nature Places', 'Celebrations Nothing']]).length === 1);
check('and the message says which two',
  /Coastal Nautical/.test(clashes([['Nature Places', 'Coastal Nautical'],
    ['Nature Places', 'Celebrations Nothing']])[0] || ''));
// The same category name under two different sections is fine - that is what
// the section half is for.
check('the same name in two sections is not a clash',
  clashes([['Classic Traditional', 'Floral Botanical'],
           ['Modern Contemporary', 'Floral Botanical']]).length === 0);

console.log(NL + 'Looking a design up by its own name');
const { looksLikeCode, codeMatches, words: tagWords } = require('../utils/linerTags');

check('a code is recognised as one', looksLikeCode('CT-TS-07'));
check('however it is spaced or cased', looksLikeCode('ct ts 07') && looksLikeCode('ctts07'));
check('a description is not', !looksLikeCode('blue flower'));
// Bare digits are not a name either - there is a 07 in every category.
check('and neither is a number on its own', !looksLikeCode('07'));

check('the whole code finds the design', codeMatches('CT-TS-07', 'CT-TS-07'));
check('and so does the end of it', codeMatches('TS-07', 'CT-TS-07'));
check('punctuation and case are ignored',
  codeMatches('ct ts 07', 'CT-TS-07') && codeMatches('ctts07', 'CT-TS-07'));
check('a different design is not found', !codeMatches('CT-TS-07', 'CT-FB-07'));

// THE TRAP THIS EXISTS TO AVOID. Broken into words, a code is two-letter
// scraps and a number, every one of them too short to search on - and the
// word search treats a phrase with nothing searchable left in it as no
// phrase at all, which matches everything. A search for one design would
// have answered with the whole book.
check('a code has no searchable words in it', tagWords('CT-TS-07').length === 0,
  tagWords('CT-TS-07'));
check('and the word search alone would have matched anything at all',
  matchesEverything('CT-TS-07'));

console.log(NL + 'The parts that do the naming agree on where it lives');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'routes/api/envelopeLinears.js'), 'utf8');
const imp = fs.readFileSync(path.join(ROOT, 'scripts/import-envelope-linears.py'), 'utf8');
check('the API names a design from the one rule',
  /require\(['"]\.\.\/\.\.\/utils\/linerCode['"]\)/.test(api) && /codeFor\(/.test(api));
// The import is Python and the rule is JavaScript, so it must not keep its
// own copy - it hands the job to the same script a person would run.
check('and the import hands the job over rather than copying the rule',
  /code-envelope-linears\.js/.test(imp) && !/CT-|initials\(/.test(imp));
// Once given, a code must go on meaning the same design.
check('the filler only ever fills a blank',
  /if \(String\(r\.code \|\| ''\)\.trim\(\)\) \{ already\+\+; continue; \}/
    .test(fs.readFileSync(path.join(ROOT, 'scripts/code-envelope-linears.js'), 'utf8')));
check('and it counts from the highest used, not from how many there are',
  /highest = Math\.max\(highest, Number\(m\[1\]\)\)/
    .test(fs.readFileSync(path.join(ROOT, 'scripts/code-envelope-linears.js'), 'utf8')));

console.log(NL + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
