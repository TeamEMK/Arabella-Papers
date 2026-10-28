// ══════════════════════════════════════════════════════
// SCHEDULED WORK
//
// Vercel's scheduler calls these; nobody else should be able to. It sends a
// bearer token taken from CRON_SECRET, and a request without it is refused -
// these are public URLs on a public domain, and a nightly mail anybody can
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

function authorised(req) {
  const want = process.env.CRON_SECRET;
  // With no secret set, only Vercel's own scheduler header gets through -
  // which is what runs on the deployment - rather than everything.
  if (!want) return req.headers['x-vercel-cron'] === '1';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return got === want || req.headers['x-vercel-cron'] === '1';
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

module.exports = router;
