// Everything under /api and /views is pulled in by fetch, never navigated to.
// Redirecting those to /login just hands the caller a page of login HTML: the
// dashboard fetch happily painted it inside the shell, so an expired session
// looked like a login form growing out of the sidebar.
function isBackgroundRequest(req) {
  return req.xhr
    || req.get('Sec-Fetch-Dest') === 'empty'
    || /^\/(api|views)\//.test(req.originalUrl);
}

// ── WHERE THEY WERE TRYING TO GO ──
//
// Now that a page has its own address, somebody can be sent a link to one -
// and before this, opening that link while signed out dropped them on the
// dashboard with no sign the link had ever named anything. They had to be
// sent it again.
//
// Only our own app paths are carried. `next` is handed straight back to the
// browser as a redirect, so anything that could leave the site - another
// host, a protocol-relative //evil.test, a backslash that some browsers
// normalise to a slash - is not a destination, it is an open redirect with
// our login page as the bait.
const { BASE, SLUG_RE } = require('../utils/sectionSlug');

function safeNext(value) {
  const raw = String(value || '');
  // Rejected before parsing rather than after: // and /\ are already off-site
  // to a browser, whatever a URL parser makes of them.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '';
  let u;
  try { u = new URL(raw, 'http://placeholder.invalid'); } catch (e) { return ''; }
  if (u.pathname === BASE) return BASE;
  if (!u.pathname.startsWith(BASE + '/')) return '';
  const rest = u.pathname.slice(BASE.length + 1);
  if (!SLUG_RE.test(rest)) return '';
  // The query is kept - ?vectors=due rides on one of these - but the hash is
  // not, because a browser never sends it to us in the first place.
  return u.pathname + u.search;
}

function refuse(req, res) {
  if (isBackgroundRequest(req)) {
    return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  }
  const back = safeNext(req.originalUrl);
  return res.redirect(back ? '/login?next=' + encodeURIComponent(back) : '/login');
}

// Require login
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return refuse(req, res);
  }
  next();
}

// Require specific roles
/**
 * Does this user hold one of these roles?
 *
 * Pulled out of requireRole so that a screen can ASK the same question the
 * gate will answer, instead of keeping its own copy of the rule. A second
 * copy is how a button comes to be drawn for somebody the server then
 * refuses - or worse, hidden from somebody it would have allowed.
 */
function hasRole(user, ...roles) {
  const userRole = (user && user.role) || '';
  const userDomain = (user && user.domain) || '';
  return roles.some(r => {
    if (r === 'Head') return userDomain === 'Head';
    return userRole === r || userRole.includes(r);
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return refuse(req, res);
    }
    const allowed = hasRole(req.session.user, ...roles);
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

module.exports = { requireLogin, requireRole, hasRole, injectUser, safeNext };
