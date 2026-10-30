const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { getNavMenu } = require('../utils/access');
// The ceiling every file box has to respect - see utils/uploadTypes.js.
const { MAX_UPLOAD_BYTES } = require('../utils/uploadTypes');

// GET / — Main App Shell
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const user = req.session.user;
    const navMenu = await getNavMenu(user);
    res.render('app', { user, navMenu, maxUploadBytes: MAX_UPLOAD_BYTES });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
