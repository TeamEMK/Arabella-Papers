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

module.exports = { STATUSES, DEFAULT_STATUS, matchStatus };
