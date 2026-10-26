const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ══════════════════════════════════════════════════════
// PUBLIC ORDER TRACKING
//
// The client hands this link to their own customers, who type an order
// number and see how far it has got. No login - that is the point of it.
//
// Which also makes it the only part of this system a stranger can reach, so
// two rules hold everywhere below:
//
//   1. It answers with a stage and nothing else. No money, no dealer, no
//      designer, no internal remark. A tracking page needs none of them, and
//      what is not sent cannot leak.
//   2. Order numbers run in sequence - K-160437, K-160438 - so the number is
//      not a secret and anybody can count upwards. The office was told this
//      and chose to keep the page open on the number alone, so the guessing
//      is slowed down here instead: a handful of lookups per minute per
//      address, which a customer checking their order will never notice and
//      somebody walking the whole range will.
// ══════════════════════════════════════════════════════

// Same expressions the internal boards use, so the public page cannot drift
// into telling a customer something different from what the office sees.
const DEAD_ORDER = `(
  LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%rejected%'
  OR LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%cancel%'
  OR LOWER(IFNULL(design_status, '')) LIKE '%cancel%'
)`;
const LEFT_FOR_DISPATCH = `((status_4 IS NOT NULL AND status_4 <> '') OR actual_4 IS NOT NULL)`;
const REACHED_PRODUCTION = `(
  TRIM(IFNULL(design_approval_status_from_client, '')) NOT IN ('Proofing Done', '')
  OR LOWER(IFNULL(paper_cutting, ''))  LIKE '%done%'
  OR LOWER(IFNULL(printing, ''))       LIKE '%done%'
  OR LOWER(IFNULL(card_assembly, ''))  LIKE '%done%'
  OR LOWER(IFNULL(dye_status, ''))     LIKE '%done%'
  OR LOWER(IFNULL(block_status, ''))   LIKE '%printed%'
)`;

// What a customer is told, in their words rather than the factory's. Inside,
// an order moves through GNA, Paper Cutting, Dye, Block, Printing, Edges,
// Laser, Output and Assembly; none of that means anything to somebody waiting
// for their wedding cards, and several of them are nobody's business.
const STEPS = [
  { key: 'received',   label: 'Order received' },
  { key: 'design',     label: 'Design in progress' },
  { key: 'production', label: 'In production' },
  { key: 'dispatched', label: 'Dispatched' },
];

// A few lookups a minute per address. Held in memory, which on a serverless
// host means per instance and reset on every cold start - that is weaker than
// a shared counter and still enough to make walking 9,000 numbers tedious.
const HITS = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;

function tooMany(ip) {
  const now = Date.now();
  const seen = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  seen.push(now);
  HITS.set(ip, seen);
  // The map would otherwise grow for every address that ever called.
  if (HITS.size > 5000) {
    for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > WINDOW_MS) HITS.delete(k);
  }
  return seen.length > MAX_PER_WINDOW;
}

function callerIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',');
  return (chain[0] || '').trim() || req.socket?.remoteAddress || 'unknown';
}

// GET /track — the page itself.
router.get('/', (req, res) => {
  res.render('track', { orderId: String(req.query.order || '').trim().slice(0, 50) });
});

// GET /track/api/:orderId — the stage, and only the stage.
router.get('/api/:orderId', async (req, res) => {
  try {
    if (tooMany(callerIp(req))) {
      return res.status(429).json({
        success: false,
        error: 'Too many lookups just now. Please wait a minute and try again.',
      });
    }

    // Typed by a customer, so it arrives with spaces, lower case, and the
    // space-after-the-dash that has bitten this office before: "k- 160190"
    // is the same order as "K-160190" and refusing it helps nobody.
    const raw = String(req.params.orderId || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/([A-Za-z0-9])\s*-\s*([A-Za-z]?\d)/g, '$1-$2')
      .replace(/\s/g, '');
    if (!raw) return res.json({ success: false, error: 'Enter your order number.' });

    const [rows] = await db.query(
      `SELECT order_id, client_name, timestamp,
              actual_1, actual_2, actual_4,
              ups_dhl_fedex_tracking_number AS docket, courier,
              ${DEAD_ORDER} AS is_dead,
              ${LEFT_FOR_DISPATCH} AS has_left,
              ${REACHED_PRODUCTION} AS reached
         FROM orders
        WHERE order_id = ? OR order_id LIKE ?
        ORDER BY id DESC
        LIMIT 1`,
      [raw, raw + '-%'],
    );

    if (!rows.length) {
      // Deliberately the same answer for a number that never existed and one
      // that does but is not theirs to see: anything else turns this into a
      // way of finding out which numbers are real.
      return res.json({ success: false, error: 'No order found with that number. Please check and try again.' });
    }

    const r = rows[0];
    const stage = r.is_dead ? 'cancelled'
      : r.has_left ? 'dispatched'
      : r.reached ? 'production'
      : 'design';

    const reached = { received: true, design: true, production: false, dispatched: false };
    if (stage === 'production') reached.production = true;
    if (stage === 'dispatched') { reached.production = true; reached.dispatched = true; }

    const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB',
      { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');

    res.json({
      success: true,
      data: {
        orderId: r.order_id,
        // The customer's own name, so they can see they have the right order.
        // It is the one thing here that is about a person, and it is the one
        // they already know.
        client: r.client_name || '',
        placed: day(r.timestamp),
        stage,
        cancelled: stage === 'cancelled',
        steps: STEPS.map(s => ({ label: s.label, done: !!reached[s.key] })),
        // Only once it has actually gone, and only the carrier and number -
        // enough to follow it on the courier's own site.
        courier: stage === 'dispatched' ? (r.courier || '') : '',
        docket: stage === 'dispatched' ? (r.docket || '') : '',
        dispatchedOn: stage === 'dispatched' ? day(r.actual_4) : '',
      },
    });
  } catch (err) {
    console.error('Track lookup failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
