const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { getNavMenu } = require('../utils/access');

// GET / — Main App Shell
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const user = req.session.user;
    const navMenu = await getNavMenu(user);
    res.render('app', { user, navMenu });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
