const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ══════════════════════════════════════════════════════
// PUBLIC ORDER TRACKING
//
// The client hands this link to their own customers, who give their name and
// an order number and see where the job has reached - every stage it has
// passed, when, and roughly when the parcel should go.
//
// No login, so it is the only part of this system a stranger can reach. Two
// rules hold everywhere below:
//
//   1. Both the name and the number, and both have to match. Order numbers
//      run in sequence - K-160437, K-160438 - so the number alone is not a
//      secret and anybody could count upwards through the whole book. The
//      name is what makes a lookup belong to the person making it.
//   2. It answers with stages and dates. No money, no dealer, no designer,
//      no internal remark, no email address. What is not sent cannot leak.
// ══════════════════════════════════════════════════════

const DEAD_ORDER = `(
  LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%rejected%'
  OR LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%cancel%'
  OR LOWER(IFNULL(design_status, '')) LIKE '%cancel%'
)`;

// How long the work really takes, measured over the orders that finished
// rather than taken from a column: dispatch_days exists on the order form
// and is filled in on none of the 9,435, so an estimate built on it would be
// a blank pretending to be a promise.
//
// Counted from the client's approval, never from the day the order was
// placed. The office turns proofs around the same day; what sits is the wait
// for the client to approve - a median of ten days and sometimes a month -
// and that is the customer's own time. Starting the clock earlier would
// print their delay as Arabella's.
const TYPICAL_DAYS = 7;   // median, approval to dispatch, last 120 days
const USUALLY_BY = 14;    // four out of five are gone by here

// Twelve a minute is plenty for somebody checking their own order and far
// too few to read the book by counting upwards. The override exists so the
// smoke suite can turn the limiter off for the stage checks and back down
// for the one check that is about the limiter.
const MAX_PER_WINDOW = Number(process.env.TRACK_MAX_PER_MIN) || 12;
const WINDOW_MS = 60 * 1000;
const HITS = new Map();

function tooMany(ip) {
  const now = Date.now();
  const seen = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  seen.push(now);
  HITS.set(ip, seen);
  if (HITS.size > 5000) {
    for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > WINDOW_MS) HITS.delete(k);
  }
  return seen.length > MAX_PER_WINDOW;
}

function callerIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',');
  return (chain[0] || '').trim() || req.socket?.remoteAddress || 'unknown';
}

// "k- 160190" is the same order as "K-160190". The space-after-the-dash is a
// slip this office already knows well - it broke the Corrections lookup - and
// refusing a customer over it helps nobody.
function tidyOrderId(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/([A-Za-z0-9])\s*-\s*([A-Za-z]?\d)/g, '$1-$2')
    .replace(/\s/g, '');
}

// Names are typed from memory, so this is forgiving on purpose: case, extra
// spaces and punctuation are ignored, and giving part of the name is enough.
// It is a check that the person knows whose order this is, not a password.
const foldName = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function nameMatches(typed, stored) {
  const a = foldName(typed);
  const b = foldName(stored);
  if (!a || !b) return false;
  if (a.length < 3) return false;
  return b.includes(a) || a.includes(b);
}

const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB',
  { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');

// Each stage's own word for "nothing to do here". The office records these
// as real answers and they are not failures: an order with no die needs no
// die cutting, and a customer should see that rather than a step that never
// completes.
// Read off the orders themselves rather than guessed: the floor writes "No
// Dye", "No Edges", "NO BLOCK", "No Guest List" or plain "No", so anything
// opening with "no" is the answer "this one does not need it". Careful not
// to catch "DIE NOT RECEIVED", which is a real holdup and opens with DIE.
const NOT_NEEDED = /^(no\b|none\b|not required|n\/?a$)/i;

// And some rows carry the column's own label back - "Dye Status", "Block
// Status" - which is a dropdown nobody touched, not work under way. 341 of
// them. Showing those as in progress would tell a customer the floor had
// started on something it has not.
const PLACEHOLDER = /^(dye|block|design|output|printing|edges|guest\s*name)\s*status$/i;

const DONE_WORDS = /(done|printed|received|complete|dispatched|delivered)/i;

// "DIE NOT RECEIVED" and "BLOCK NOT RECEIVED" contain "received" and would
// otherwise be read as finished - the worst of the possible misreadings,
// since it would show a customer a completed stage for work that is stuck.
const NEGATED = /\b(not|non|never|awaited|pending)\b/i;

/**
 * One row of the timeline.
 *
 * Three states and no fourth: done, not needed, or still to come. A stage
 * with a blank status has not been reached - most of the book has never gone
 * to production at all - and saying "pending" about it would promise work
 * that has not been scheduled.
 */
function step(label, status, at) {
  const s = String(status || '').trim();
  if (PLACEHOLDER.test(s)) return { label, state: 'waiting', note: '', at: '' };
  if (NOT_NEEDED.test(s)) return { label, state: 'skipped', note: 'Not needed', at: '' };
  if (s && DONE_WORDS.test(s) && !NEGATED.test(s)) return { label, state: 'done', note: s, at: day(at) };
  if (s) return { label, state: 'doing', note: s, at: day(at) };
  return { label, state: 'waiting', note: '', at: '' };
}

// GET /track — the page itself.
router.get('/', (req, res) => {
  res.render('track', {
    orderId: String(req.query.order || '').trim().slice(0, 50),
    name: String(req.query.name || '').trim().slice(0, 120),
  });
});

// GET /track/api?order=&name=
router.get('/api', async (req, res) => {
  try {
    if (tooMany(callerIp(req))) {
      return res.status(429).json({
        success: false,
        error: 'Too many lookups just now. Please wait a minute and try again.',
      });
    }

    const orderId = tidyOrderId(req.query.order);
    const name = String(req.query.name || '').trim();
    if (!orderId) return res.json({ success: false, error: 'Enter your order number.' });
    if (foldName(name).length < 3) {
      return res.json({ success: false, error: 'Enter the name the order was placed in.' });
    }

    const [rows] = await db.query(
      `SELECT order_id, client_name, timestamp,
              design_status, no_of_design_revision,
              actual_1, actual_2, design_approval_status_from_client,
              guest_name, guest_name_actual_time,
              paper_cutting, paper_cutting_actual_time,
              dye_status, dye_status_actual_time,
              block_status, block_status_actual_time,
              printing, printing_actual_time,
              edges, edges_actual_time,
              laser_cutting,
              COALESCE(done_laser_cutting_actual_time, no_laser_cutting_actual_time,
                       pending_laser_cutting_actual_time) AS laser_at,
              output,
              COALESCE(output_done_actual_time, no_output_actual_time,
                       output_pending_actual_time) AS output_at,
              card_assembly, card_assembly_actual_time,
              status_4, actual_4,
              ups_dhl_fedex_tracking_number AS docket, courier,
              ${DEAD_ORDER} AS is_dead
         FROM orders
        WHERE (order_id = ? OR order_id LIKE ?) AND is_deleted = 0
        ORDER BY id DESC
        LIMIT 1`,
      [orderId, orderId + '-%'],
    );

    // One answer for a number that does not exist, a number that does but is
    // not theirs, and a name that does not match. Three different messages
    // would turn this page into a way of finding out which is which.
    const miss = { success: false, error: 'We could not find that. Check the name and the order number, and try again.' };
    if (!rows.length) return res.json(miss);

    const r = rows[0];
    if (!nameMatches(name, r.client_name)) return res.json(miss);

    const approval = String(r.design_approval_status_from_client || '').trim();
    const approved = approval && approval !== 'Proofing Done';
    const gone = !!(r.actual_4 || (r.status_4 && /dispatch|deliver/i.test(r.status_4)));

    // A parcel that has gone settles everything behind it. Plenty of the
    // older orders went out with the approval column never filled in, and
    // showing "with you for approval" under a dispatch date would read as
    // though the job had been sent without anybody agreeing to it.
    const proofed = !!r.actual_1 || gone;
    const signedOff = approved || gone;

    const before = [
      step('Order received', 'Done', r.timestamp),
      step('Design proof ready', proofed ? 'Done' : '', r.actual_1),
      {
        label: 'Approved by you',
        state: r.is_dead ? 'skipped' : signedOff ? 'done' : r.actual_1 ? 'doing' : 'waiting',
        note: approved ? approval : signedOff ? 'Approved' : r.actual_1 ? 'With you for approval' : '',
        at: signedOff ? day(r.actual_2) : '',
      },
    ];

    // Once the parcel has gone the floor is finished with it, whatever the
    // last person left in the column. A stage still reading "Pending" under
    // a dispatch date is the office's own paperwork showing, and it reads
    // to a customer as work outstanding on something already delivered.
    // No date is invented for these - only the state is corrected.
    const settle = (st) => (gone && st.state !== 'skipped'
      ? { label: st.label, state: 'done', note: st.at ? st.note : 'Done', at: st.at }
      : st);

    // The nine the floor works through, in the order it works them.
    const production = [
      step('Guest list (GNA)', r.guest_name, r.guest_name_actual_time),
      step('Paper cutting', r.paper_cutting, r.paper_cutting_actual_time),
      step('Die cutting', r.dye_status, r.dye_status_actual_time),
      step('Block printing', r.block_status, r.block_status_actual_time),
      step('Printing', r.printing, r.printing_actual_time),
      step('Edges', r.edges, r.edges_actual_time),
      step('Laser cutting', r.laser_cutting, r.laser_at),
      step('Output', r.output, r.output_at),
      step('Card assembly', r.card_assembly, r.card_assembly_actual_time),
    ].map(settle);

    const after = [{
      label: 'Dispatched',
      state: gone ? 'done' : 'waiting',
      note: gone ? (r.status_4 || 'Dispatched') : '',
      at: gone ? day(r.actual_4) : '',
    }];

    // The estimate, and only where it means something.
    //
    // Before approval there is no date to give: the clock starts when the
    // client approves, and inventing one earlier would be promising on their
    // behalf. After dispatch there is nothing to estimate either.
    let estimate = null;
    if (!r.is_dead && !gone) {
      if (!approved) {
        estimate = {
          kind: 'waiting-on-you',
          text: 'Once you approve the design, orders usually leave us in about '
            + TYPICAL_DAYS + ' days, and four out of five within ' + USUALLY_BY + '.',
        };
      } else if (r.actual_2) {
        const from = new Date(r.actual_2);
        const by = new Date(from.getTime() + TYPICAL_DAYS * 86400000);
        const outer = new Date(from.getTime() + USUALLY_BY * 86400000);
        const late = Date.now() > outer.getTime();
        estimate = {
          kind: late ? 'running-late' : 'on-the-way',
          // Said as a likelihood, because that is what it is: these are the
          // office's own finished orders, not a date anybody committed to.
          text: late
            ? 'This one is taking longer than most. Please speak to the person you ordered through.'
            : 'Most orders leave us around ' + day(by) + ', and four out of five by ' + day(outer) + '.',
        };
      }
    }

    res.json({
      success: true,
      data: {
        orderId: r.order_id,
        client: r.client_name || '',
        placed: day(r.timestamp),
        cancelled: !!r.is_dead,
        revisions: r.no_of_design_revision || 0,
        before,
        production,
        after,
        estimate,
        courier: gone ? (r.courier || '') : '',
        docket: gone ? (r.docket || '') : '',
        dispatchedOn: gone ? day(r.actual_4) : '',
      },
    });
  } catch (err) {
    console.error('Track lookup failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
