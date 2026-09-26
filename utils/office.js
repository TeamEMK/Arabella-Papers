// ══════════════════════════════════════════════════════
// WHO THE COMPANY IS, AND WHERE
//
// One file, because four different things say it: the interview and
// reschedule emails print a "Where to come" block, every letter's footer
// carries the address, and the offer letter PDF puts the whole letterhead at
// the head of the page. Kept together so a change never corrects one of them
// and misses the others.
// ══════════════════════════════════════════════════════

const COMPANY = 'Arabella Papers Private Limited';

/**
 * The letterhead, as the office's own Word template draws it: the name on the
 * left, the contact details on the right behind a rule, and a double line
 * under both.
 *
 * `blue` is taken by eye off that template and is the one thing here that is
 * a guess — replace it with the brand's own value when there is one.
 *
 * The contact here is the company's, not whoever signs: SIGNATORY in
 * offerLetter.js is the person, and the two are deliberately different.
 */
const LETTERHEAD = {
  name: 'ARABELLA PAPERS PVT. LTD.',
  lines: [
    'G1-592, Sitapura Industrial Area',
    'Sitapura, Jaipur - 302 022 (Raj.)',
    'M. : +91-876-444-1111',
    'Email : Jitendra@ArabellaPapers.com',
    'CIN. : U18112RJ2025PTC108859',
  ],
  blue: '#5A6E96',
};

/**
 * The postal address on its own, for the letters.
 *
 * Worded as the letterhead words it. It said "RIICO Industrial Area" until
 * the office sent their own template through saying "Sitapura Industrial
 * Area" — their letterhead is the one a candidate will hold, so it wins.
 *
 * No floor: the office has one, but not which — and an invitation that sends
 * somebody to the wrong floor is worse than one that sends them to the gate.
 *
 *   address: one line per line
 *   map:     a Google Maps share link, or blank for no map button
 */
const OFFICE = {
  address: 'Arabella Papers Pvt. Ltd.\nG1-592, Sitapura Industrial Area\nSitapura, Jaipur - 302 022 (Raj.)',
  map: 'https://maps.app.goo.gl/PK9DVNy3AmncHHYP6',
};

/** The address as plain lines, blank ones dropped. */
function officeLines() {
  return String(OFFICE.address || '').split('\n').map(l => l.trim()).filter(Boolean);
}

module.exports = { COMPANY, LETTERHEAD, OFFICE, officeLines };
