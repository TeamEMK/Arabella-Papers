// Require login
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Require specific roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
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
