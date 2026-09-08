const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { SECTION_IDS } = require('../utils/nav');
const { canSee } = require('../utils/access');

// GET /views/:page — returns rendered dashboard HTML
router.get('/:page', requireLogin, async (req, res) => {
  const page = req.params.page;
  if (!SECTION_IDS.includes(page)) {
    return res.status(404).send('<div class="alert alert-danger m-3">Page not found.</div>');
  }

  // The same question the side panel asked when it decided whether to show the
  // tab — role rule plus whatever was granted on the Access Control page — so
  // a page cannot be opened by URL after the tab was taken away.
  try {
    if (!(await canSee(req.session.user, page))) {
      return res.status(403).send('<div class="alert alert-danger m-3">Access Denied.</div>');
    }
  } catch (err) {
    console.error('Access check failed:', err);
    return res.status(500).send('<div class="alert alert-danger m-3">Error checking access.</div>');
  }

  // The two archive tabs are their live boards pointed at the other side of
  // the cutoff, not second copies - one template each, one set of fixes.
  const ARCHIVE_OF = { oldProduction: 'productionBD', oldDispatch: 'dispatchBD' };
  const template = ARCHIVE_OF[page] || page;

  res.render(`views/${template}`, { user: req.session.user, archive: !!ARCHIVE_OF[page] }, (err, html) => {
    if (err) {
      console.error('View render error:', err);
      return res.status(500).send('<div class="alert alert-danger m-3">Error rendering view.</div>');
    }
    res.send(html);
  });
});

module.exports = router;
