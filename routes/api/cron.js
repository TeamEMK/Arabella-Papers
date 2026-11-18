// ══════════════════════════════════════════════════════
// SCHEDULED WORK
//
// Vercel's scheduler calls these; nobody else can. It sends a bearer token
// taken from CRON_SECRET and that token is the only way in - no secret
// configured means every request is refused, including the platform's own.
// These are public URLs on a public domain, and a nightly mail anybody can
// trigger is a nightly mail anybody can trigger a hundred times.
//
// Vercel's cron runs on UTC, so the schedule in vercel.json is written in UTC
// and the hour here is checked in IST. Without that check a daylight or
// platform shift would quietly move the report an hour and nobody would know
// which evening's numbers they were reading.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { sendVectorReport } = require('../../utils/vectorReport');
const { sendStageReport } = require('../../utils/stageReport');

const crypto = require('crypto');

/**
 * Only the scheduler, and only with the secret.
 *
 * WHAT THIS STOPS. These are plain GET URLs on a public domain. Before
 * this, two things opened them to anybody: with CRON_SECRET unset the only
 * test was `x-vercel-cron: 1`, which is a header any caller can type, and
 * even with the secret set that header still let them through. Either way a
 * stranger could fire the nightly mail to the whole office, a hundred times
 * if they liked.
 *
 * So the bearer token is the ONLY way in, and there is no fallback: with no
 * secret configured every request is refused. Vercel sends exactly this
 * header on scheduled runs when CRON_SECRET is set in the project, so the
 * platform's own scheduler is the one caller that passes.
 *
 * Compared byte by byte in constant time. A plain === returns as soon as
 * two characters differ, and the time it takes is a measurement somebody
 * can use to learn the secret one character at a time.
 */
function authorised(req) {
  const want = String(process.env.CRON_SECRET || '');
  if (!want) return false;
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  // Lengths first: timingSafeEqual throws on a mismatch, and a throw is
  // itself a signal about the secret's length.
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// GET /api/cron/vector-report — the evening list of who still owes files.
router.get('/vector-report', async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const out = await sendVectorReport();
    console.log('[cron] vector report:', JSON.stringify(out));
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[cron] vector report failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/cron/stage-report — the morning list of orders with stages still
// open. Nine o'clock IST, before the floor gets going.
router.get('/stage-report', async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const out = await sendStageReport();
    console.log('[cron] stage report:', JSON.stringify(out));
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[cron] stage report failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
