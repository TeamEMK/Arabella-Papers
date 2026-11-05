const express = require('express');
const router = express.Router();
const { requireLogin } = require('../../middleware/auth');
const { openSession, claim } = require('../../utils/uploadSession');

// ══════════════════════════════════════════════════════
// THE TWO SMALL REQUESTS EITHER SIDE OF A BIG UPLOAD
//
// Both are a few hundred bytes. The megabytes go from the browser to Google
// and never come near this server - which is the whole point, because this
// server is on a platform that refuses a body over 4.5MB.
//
// Not scoped to an order. A design file is picked before a new order has a
// number, so the ticket is opened first and attached afterwards by whichever
// form sends the token back.
// ══════════════════════════════════════════════════════

function fail(res, err, what) {
  const status = err.status || 500;
  if (status >= 500) console.error('[uploads] ' + what + ':', err);
  res.status(status).json({ success: false, error: err.message || 'Something went wrong.' });
}

// POST /api/uploads/session
router.post('/session', requireLogin, express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    // Google decides from this which page may upload to the address it gives
    // back. Taken from the request rather than configured, so a preview
    // deployment works without anybody remembering to add its name.
    const origin = req.headers.origin
      || (req.headers.host ? (req.protocol === 'http' ? 'http://' : 'https://') + req.headers.host : '');
    const out = await openSession({
      fileName: b.fileName, mimeType: b.mimeType, size: b.size,
      origin, email: req.session.user.email || '',
    });
    res.json({ success: true, ...out });
  } catch (err) { fail(res, err, 'session'); }
});

// POST /api/uploads/claim
router.post('/claim', requireLogin, express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const out = await claim({ token: b.token, fileId: b.fileId, email: req.session.user.email || '' });
    res.json({ success: true, ...out });
  } catch (err) { fail(res, err, 'claim'); }
});

module.exports = router;
