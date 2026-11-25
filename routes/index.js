const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { getNavMenu } = require('../utils/access');
// The ceiling every file box has to respect - see utils/uploadTypes.js.
const { MAX_UPLOAD_BYTES } = require('../utils/uploadTypes');

const { BASE, SLUG_RE } = require('../utils/sectionSlug');

// GET /, /app, /app/<slug> — Main App Shell
//
// Every page of the app is this one file; which section opens is decided in
// the browser from the address. So all three of these have to answer with the
// shell, or a refresh on /app/till-approval is a 404 and the whole point of
// having an address per page is lost.
//
// WHICH page is not resolved here. The shell already knows the menu this user
// is allowed - it is rendered into the page - and the fallback for a name
// that is unknown or not permitted is the same either way. Deciding it twice
// is how the two answers start to differ.
//
// '/' stays, and is not a redirect. The login lands on it, the held logout
// comes back to /?vectors=due, the morning production mail has /?tab=... in
// two inboxes already, and people have it bookmarked. The shell rewrites the
// address to /app/<slug> once it knows what opened, so those keep working
// without this route having to know about any of them.
async function shell(req, res, next) {
  try {
    const user = req.session.user;
    const navMenu = await getNavMenu(user);
    res.render('app', { user, navMenu, maxUploadBytes: MAX_UPLOAD_BYTES });
  } catch (err) {
    next(err);
  }
}

router.get('/', requireLogin, shell);
router.get(BASE, requireLogin, shell);

// ── ADDRESSES A SECTION USED TO HAVE ──
//
// A section's address is built from its id, so renaming one moves its
// address with it - and whoever had the old one bookmarked, or pasted it
// into a message last week, lands on a page that quietly shows the
// dashboard instead. That is the kind of thing nobody reports; they just
// stop using the link.
//
// So an old name is kept here and sent on, once, permanently. One line per
// rename, and the comment says when and why.
const MOVED = {
  // 25 November: CC Prospects became Bella Papers, a room with the Carlson
  // Craft list as its first line.
  'cc-prospects': 'bella-papers',
};

// One lowercase segment and nothing else. A loose pattern here would swallow
// /api, /views, /track and the static files, and the first anybody would know
// of it is an upload answering with a page of HTML.
router.get(`${BASE}/:slug`, (req, res, next) => {
  if (!SLUG_RE.test(req.params.slug)) return next();
  const moved = MOVED[req.params.slug];
  if (moved) {
    // 301: the old address is not coming back, and a browser that remembers
    // that saves the round trip next time.
    return res.redirect(301, `${BASE}/${moved}` + (req.url.includes('?')
      ? req.url.slice(req.url.indexOf('?')) : ''));
  }
  return requireLogin(req, res, () => shell(req, res, next));
});

module.exports = router;
