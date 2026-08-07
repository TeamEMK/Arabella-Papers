const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');

const ALLOWED_VIEWS = ['dashboard', 'tillApproval', 'productionBD', 'dispatchBD', 'o2dsummary', 'users'];

// GET /views/:page — returns rendered dashboard HTML
router.get('/:page', requireLogin, (req, res) => {
  const page = req.params.page;
  if (!ALLOWED_VIEWS.includes(page)) {
    return res.status(404).send('<div class="alert alert-danger m-3">Page not found.</div>');
  }

  const user = req.session.user;

  // Access control per page
  const role = user.role || '';
  const domain = user.domain || '';

  const checks = {
    dashboard: () => role === 'SuperAdmin' || domain === 'Head' || role.includes('Designer'),
    tillApproval: () => role === 'SuperAdmin' || domain === 'Head' || role.includes('TillApprover'),
    productionBD: () => role === 'SuperAdmin' || role.includes('Production Manager'),
    dispatchBD: () => role === 'SuperAdmin' || role === 'Accounts',
    o2dsummary: () => role === 'SuperAdmin' || domain === 'Head',
    users: () => role === 'SuperAdmin',
  };

  if (checks[page] && !checks[page]()) {
    return res.status(403).send('<div class="alert alert-danger m-3">Access Denied.</div>');
  }

  res.render(`views/${page}`, { user }, (err, html) => {
    if (err) {
      console.error('View render error:', err);
      return res.status(500).send('<div class="alert alert-danger m-3">Error rendering view.</div>');
    }
    res.send(html);
  });
});

module.exports = router;
