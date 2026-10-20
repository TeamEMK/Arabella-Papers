// ══════════════════════════════════════════════════════
// THE HIRING PIPELINE, IN THE ORDER IT RUNS
//
// Its own file because two routes decide things from it: the Recruitment API
// refuses a status that is not on the list, and the bulk import refuses a
// spreadsheet cell that is not on it either. Written down twice, the second
// copy is the one that gets forgotten when a stage is added - and a sheet
// that imports a status the app will not show is a worse bug than either.
//
// Applied is where everybody starts and the only stage that is not a decision
// somebody took - it just means the name is on the list. Onboarding sits
// between the selection and the offer because that is the shape the office
// asked for: the candidate is told they are in, then asked
// for their details, and only once those are back does the offer letter go.
// Rejected is last because it is not a stage so much as a way out of them.
// ══════════════════════════════════════════════════════

const STATUSES = ['Applied', 'Scheduled', 'Rescheduled', 'Selected', 'Onboarding', 'Offer Sent', 'Rejected'];

/**
 * Where a candidate starts: on the list, with nothing arranged.
 *
 * Everybody used to start at Scheduled, which was a lie on any row without a
 * date - the board said an interview was booked and the Interview column said
 * nothing. A whole sheet imported at once made it three lies at a glance.
 * Applied is the honest state, and a row leaves it the moment a date is put
 * on the candidate.
 */
const DEFAULT_STATUS = 'Applied';

/**
 * The status a cell meant, whatever case or spacing it was typed in, or null
 * if it was not one of ours. A spreadsheet filled in by hand says "offer
 * sent", "Offer  Sent" and "OFFER SENT", and all three mean the same thing.
 */
function matchStatus(value) {
  const wanted = String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  if (!wanted) return null;
  return STATUSES.find(s => s.toLowerCase() === wanted) || null;
}

// ══════════════════════════════════════════════════════
// WHAT A CALLER'S OWN WORDS MEANT
//
// A recruitment sheet kept by the people making the calls does not have a
// Status column in this app's sense. It has the outcome of a phone call, in
// the words whoever made it would use: "not responding", "asking for WFH
// only", "currently working not looking foe job", "wrong no". Of the 206 rows
// in the office's own list, ten matched a stage.
//
// So the import reads intent rather than demanding a match. The rule is only
// as clever as it needs to be, and it answers one question: is this person
// still worth a second call?
//
//   No  -> Rejected. They said no, or they want something the job is not
//          (another city, more money, work from home, an internship), or
//          there was never a person on the other end of the number.
//   Yes -> Applied. Interested, call back later, not responding, phone
//          switched off, nothing typed at all. None of those are a decision,
//          and Applied is this pipeline's word for "on the list, nothing
//          arranged" - which is exactly what they are.
//
// "not responding" and "switch off" sit on the Yes side on purpose. Nobody
// declined; the call did not happen. Filing them as Rejected would quietly
// throw away forty people the office has not actually spoken to yet.
//
// What this never does is decide anything on its own and lose the evidence:
// the cell's original wording is kept against the candidate, so a guess made
// here can always be checked against what the caller actually wrote.
// ══════════════════════════════════════════════════════

const NOT_PROCEEDING = [
  /reject/,              // "rejected(zero knowledge of excel)"
  /not\s*inter/,         // also "not intersted", "not interested (location issue)"
  /n[o']?t\s*look/,      // "not looking for job change", "NOT Looking", "not looking foe job"
  /wfh|work\s*from\s*home/,
  /inters?ship|internship/,
  /wrong\s*(no|num)/,
];

/**
 * The stage a caller's note amounts to, and whether that took interpreting.
 *
 * Returns { status, matched }. `matched` is true only when the cell already
 * named one of our stages exactly - so the import can show the office which
 * rows it read literally and which ones it had to read into.
 */
function mapStatus(value) {
  const exact = matchStatus(value);
  if (exact) return { status: exact, matched: true };

  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return { status: DEFAULT_STATUS, matched: true };

  const rejected = NOT_PROCEEDING.some(re => re.test(text));
  return { status: rejected ? 'Rejected' : DEFAULT_STATUS, matched: false };
}

module.exports = { STATUSES, DEFAULT_STATUS, matchStatus, mapStatus };
