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

// One lowercase segment and nothing else. A loose pattern here would swallow
// /api, /views, /track and the static files, and the first anybody would know
// of it is an upload answering with a page of HTML.
router.get(`${BASE}/:slug`, (req, res, next) => {
  if (!SLUG_RE.test(req.params.slug)) return next();
  return requireLogin(req, res, () => shell(req, res, next));
});

module.exports = router;
