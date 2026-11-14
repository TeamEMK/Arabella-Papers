// ══════════════════════════════════════════════════════
// WORDS TO FIND A LINER BY
//
// "blue flower" has to find a blue floral liner, and neither half of that
// comes from the file name. So every design carries a handful of words:
//
//   the colours actually in the picture   blue cream green
//   where it lives                        classic traditional floral botanical
//
// and the search box matches a typed phrase against them.
//
// WHAT THIS IS NOT. Nothing here looks at the picture and understands it.
// "Blue" is arithmetic on the pixels, and "flower" is the category the office
// filed it under - so a rose photographed on a blue table would be tagged
// blue, and a liner of blue roses filed under Geometric would not be found by
// "flower". It answers the question the office actually asks - the colour and
// the kind - and it does it without sending anybody's artwork to a service.
//
// The naming of a colour lives HERE and nowhere else. The browser samples the
// pixels of a picture being uploaded and the tagging script gets them out of
// the stored thumbnails through Python, but both hand the numbers to this
// file, because two definitions of "teal" is one too many.
// ══════════════════════════════════════════════════════

/**
 * One colour, named the way somebody would say it.
 *
 * Hue decides which colour it is; how grey and how light decide whether it is
 * a colour at all. Liners are mostly a pattern on a pale ground, so the pale
 * ground has its own names - cream and ivory are not "white" to anybody
 * choosing paper.
 */
function colourName(r, g, b) {
  const R = Math.max(0, Math.min(255, Number(r) || 0)) / 255;
  const G = Math.max(0, Math.min(255, Number(g) || 0)) / 255;
  const B = Math.max(0, Math.min(255, Number(b) || 0)) / 255;

  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const light = (max + min) / 2;
  const span = max - min;
  const sat = span === 0 ? 0 : span / (1 - Math.abs(2 * light - 1));

  // Nearly colourless: it is a shade, not a colour.
  if (sat < 0.12 || span < 0.06) {
    if (light > 0.92) return 'white';
    if (light > 0.78) return 'cream';
    if (light > 0.55) return 'grey';
    if (light > 0.22) return 'charcoal';
    return 'black';
  }

  let hue;
  if (max === R) hue = ((G - B) / span) % 6;
  else if (max === G) hue = (B - R) / span + 2;
  else hue = (R - G) / span + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;

  // A dark, weak orange is brown, and a pale one is beige - neither reads as
  // "orange" on a sheet of paper.
  if (hue >= 20 && hue < 45) {
    if (light < 0.35) return 'brown';
    if (light > 0.75 && sat < 0.45) return 'beige';
    if (sat > 0.45 && light > 0.45) return 'gold';
    return 'brown';
  }
  if (hue < 12 || hue >= 345) return light > 0.72 ? 'blush' : 'red';
  if (hue < 20) return light > 0.7 ? 'peach' : 'rust';
  if (hue < 65) return light > 0.8 ? 'cream' : 'yellow';
  if (hue < 95) return 'olive';
  if (hue < 160) return light < 0.3 ? 'forest' : 'green';
  if (hue < 190) return 'teal';
  if (hue < 250) return light > 0.75 ? 'sky' : 'blue';
  if (hue < 290) return 'purple';
  if (hue < 330) return light > 0.72 ? 'pink' : 'magenta';
  return light > 0.72 ? 'blush' : 'red';
}

// Colours that mean the same thing to a person looking for paper. Typing
// "navy" has to find the blues; typing "blue" should not miss a sky one.
const COLOUR_FAMILY = {
  blue: ['blue', 'sky', 'navy', 'teal', 'indigo'],
  sky: ['sky', 'blue'],
  navy: ['blue'],
  teal: ['teal', 'blue', 'green'],
  green: ['green', 'olive', 'forest', 'sage', 'teal'],
  olive: ['olive', 'green'],
  forest: ['forest', 'green'],
  sage: ['olive', 'green'],
  red: ['red', 'rust', 'maroon', 'burgundy'],
  maroon: ['red', 'rust'],
  burgundy: ['red', 'rust'],
  rust: ['rust', 'red', 'brown'],
  pink: ['pink', 'blush', 'magenta'],
  blush: ['blush', 'pink'],
  magenta: ['magenta', 'pink', 'purple'],
  purple: ['purple', 'magenta', 'lilac'],
  lilac: ['purple'],
  gold: ['gold', 'yellow', 'beige', 'brown'],
  yellow: ['yellow', 'gold'],
  beige: ['beige', 'cream', 'gold'],
  cream: ['cream', 'beige', 'white'],
  ivory: ['cream', 'white'],
  white: ['white', 'cream'],
  grey: ['grey', 'gray', 'charcoal'],
  gray: ['grey', 'charcoal'],
  charcoal: ['charcoal', 'grey', 'black'],
  black: ['black', 'charcoal'],
  brown: ['brown', 'rust', 'beige'],
  peach: ['peach', 'blush', 'orange'],
  orange: ['peach', 'rust', 'gold'],
  silver: ['grey', 'white'],
};

// What somebody types, against what the categories are actually called.
// "flower" is the one that started this; the rest are the same thought.
const WORD_FAMILY = {
  flower: ['floral', 'botanical'],
  flowers: ['floral', 'botanical'],
  floral: ['floral', 'botanical'],
  leaf: ['botanical', 'floral'],
  leaves: ['botanical', 'floral'],
  plant: ['botanical'],
  rose: ['floral', 'botanical'],
  bird: ['birds', 'wildlife'],
  birds: ['birds', 'wildlife'],
  butterfly: ['butterflies', 'wildlife'],
  animal: ['wildlife', 'birds', 'butterflies'],
  sea: ['coastal', 'nautical'],
  beach: ['coastal', 'nautical'],
  ocean: ['coastal', 'nautical'],
  boat: ['nautical', 'coastal'],
  map: ['maps', 'cityscapes'],
  maps: ['maps', 'cityscapes'],
  city: ['cityscapes', 'maps'],
  stripe: ['stripes', 'lattice'],
  stripes: ['stripes', 'lattice'],
  check: ['checks', 'lattice'],
  checks: ['checks', 'lattice'],
  geometric: ['geometric', 'deco'],
  deco: ['deco', 'geometric'],
  monogram: ['monograms', 'crests', 'personalised'],
  initials: ['monograms', 'personalised'],
  crest: ['crests', 'monograms'],
  wedding: ['romantic', 'feminine', 'celebrations'],
  christmas: ['holiday', 'seasonal'],
  holiday: ['holiday', 'seasonal'],
  jewish: ['jewish', 'judaica', 'heritage'],
  simple: ['minimal', 'micro'],
  plain: ['minimal', 'micro'],
  metallic: ['foil', 'metallic'],
  foil: ['foil', 'metallic'],
  texture: ['embossed', 'debossed'],
  embossed: ['embossed', 'debossed'],
  vintage: ['vintage', 'heritage'],
  classic: ['classic', 'traditional'],
  modern: ['modern', 'contemporary'],
  bold: ['bold', 'statement'],
};

/** A name broken into the words worth searching on. */
function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !['and', 'the', 'for'].includes(w));
}

/**
 * Every word a design should answer to.
 *
 * Its colours, its category, its section, and nothing else - the file name is
 * left out on purpose, because "Floral & botanical.pdf" adds nothing the
 * category has not already said and "IMG_2043" adds noise.
 */
function tagsFor({ section, category, colours }) {
  const out = new Set();
  for (const w of words(section)) out.add(w);
  for (const w of words(category)) out.add(w);
  for (const c of colours || []) {
    if (c) out.add(String(c).toLowerCase());
  }
  return [...out];
}

/**
 * Does a typed phrase describe this design?
 *
 * EVERY word has to land, which is what makes "blue flower" different from
 * "blue" and from "flower". A word lands on a tag, on the start of a tag, or
 * through one of the families above - so "flower" reaches "floral" and "navy"
 * reaches "blue".
 */
function matches(query, tags) {
  const asked = words(query);
  if (!asked.length) return true;
  const has = new Set((tags || []).map(t => String(t).toLowerCase()));

  return asked.every(word => {
    const tries = new Set([word]);
    for (const alt of COLOUR_FAMILY[word] || []) tries.add(alt);
    for (const alt of WORD_FAMILY[word] || []) tries.add(alt);
    for (const t of tries) {
      if (has.has(t)) return true;
      // "botanic" should still find "botanical" - but only from four letters
      // up. At three, "sea" reached "seasonal" and a search for sea liners
      // came back full of Christmas, which is the kind of wrong that makes
      // somebody stop using the box. Short words have the families above to
      // get them where they are going.
      if (t.length < 4) continue;
      for (const tag of has) {
        if (tag.length >= 4 && (tag.startsWith(t) || t.startsWith(tag))) return true;
      }
    }
    return false;
  });
}

// NODE ONLY, and that is the whole point of how the upload works.
//
// The browser has the picture on a canvas already, so it is the only thing
// that can see the pixels of a design being added - but it sends back three
// NUMBERS per colour and lets the server name them. If it named them itself
// this file would have to be served to it, and then there would be two
// definitions of "teal" waiting to disagree. Numbers travel; opinions stay
// here.
module.exports = { colourName, tagsFor, matches, words, COLOUR_FAMILY, WORD_FAMILY };
