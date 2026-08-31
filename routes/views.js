const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');

const ALLOWED_VIEWS = ['dashboard', 'tillApproval', 'productionBD', 'oldProduction', 'dispatchBD', 'o2dsummary', 'users', 'logs'];

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
    oldProduction: () => role === 'SuperAdmin' || role.includes('Production Manager'),
    dispatchBD: () => role === 'SuperAdmin' || role === 'Accounts',
    o2dsummary: () => role === 'SuperAdmin' || domain === 'Head',
    users: () => role === 'SuperAdmin',
    logs: () => role === 'SuperAdmin' || domain === 'Head',
  };

  if (checks[page] && !checks[page]()) {
    return res.status(403).send('<div class="alert alert-danger m-3">Access Denied.</div>');
  }

  // Old Production is the production board pointed at the other side of the
  // August cutoff, not a second copy of it - one template, one set of fixes.
  const template = page === 'oldProduction' ? 'productionBD' : page;

  res.render(`views/${template}`, { user, archive: page === 'oldProduction' }, (err, html) => {
    if (err) {
      console.error('View render error:', err);
      return res.status(500).send('<div class="alert alert-danger m-3">Error rendering view.</div>');
    }
    res.send(html);
  });
});

module.exports = router;
