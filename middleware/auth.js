// Everything under /api and /views is pulled in by fetch, never navigated to.
// Redirecting those to /login just hands the caller a page of login HTML: the
// dashboard fetch happily painted it inside the shell, so an expired session
// looked like a login form growing out of the sidebar.
function isBackgroundRequest(req) {
  return req.xhr
    || req.get('Sec-Fetch-Dest') === 'empty'
    || /^\/(api|views)\//.test(req.originalUrl);
}

function refuse(req, res) {
  if (isBackgroundRequest(req)) {
    return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  }
  return res.redirect('/login');
}

// Require login
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return refuse(req, res);
  }
  next();
}

// Require specific roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return refuse(req, res);
    }
    const userRole = req.session.user.role || '';
    const userDomain = req.session.user.domain || '';
    const allowed = roles.some(r => {
      if (r === 'Head') return userDomain === 'Head';
      return userRole === r || userRole.includes(r);
    });
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
  };
}

// Inject user into all views
function injectUser(req, res, next) {
  res.locals.user = req.session?.user || null;
  next();
}

module.exports = { requireLogin, requireRole, injectUser };
