const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { getNavMenu } = require('../utils/nav');

// GET / — Main App Shell
router.get('/', requireLogin, (req, res) => {
  const user = req.session.user;
  const navMenu = getNavMenu(user.role, user.domain);
  res.render('app', { user, navMenu });
});

module.exports = router;
