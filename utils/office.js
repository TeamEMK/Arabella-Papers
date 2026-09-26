// ══════════════════════════════════════════════════════
// THE OFFICE, AS EVERY CANDIDATE IS TOLD IT
//
// Standing text, not something typed per candidate. It is the same address
// every time, and retyping it is exactly how a line meant for one person on
// one day — "ask for so-and-so at reception" — ends up in somebody else's
// letter months later. A candidate's letter should name the company and
// nobody inside it.
//
// It lives in its own file because two different things say it: the interview
// and reschedule emails print a "Where to come" block from it, and the offer
// letter PDF puts it at the head of the page. An emailed PDF has no printed
// letterhead behind it, so without this the letter arrives on a blank sheet.
// Kept in one place so a move never corrects one of them and misses the other.
//
//   address: the building and locality, one line per line
//   map:     a Google Maps share link, or blank for no map button
//
// No floor: the office has one, but not which — and an invitation that sends
// somebody to the wrong floor is worse than one that sends them to the gate.
// RIICO rather than Ricco, because it is an acronym and this is the line a
// candidate reads off their phone at a gate.
// ══════════════════════════════════════════════════════

const COMPANY = 'Arabella Papers Private Limited';

const OFFICE = {
  address: 'Arabella Papers Pvt. Ltd.\nG1-592, RIICO Industrial Area, Sitapura\nJaipur 302022',
  map: 'https://maps.app.goo.gl/PK9DVNy3AmncHHYP6',
};

/** The address as plain lines, blank ones dropped. */
function officeLines() {
  return String(OFFICE.address || '').split('\n').map(l => l.trim()).filter(Boolean);
}

module.exports = { COMPANY, OFFICE, officeLines };
