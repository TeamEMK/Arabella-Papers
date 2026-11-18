// ══════════════════════════════════════════════════════
// THE ROLE IN THE COOKIE IS YESTERDAY'S ANSWER
//
// Everything in this app decides what somebody may do from
// req.session.user.role and .domain, and those two were written once, at
// sign-in, and never looked at again. The session lasts eight hours. So:
//
//   Somebody is taken off SuperAdmin at ten o'clock and still deletes
//   orders at five, because their cookie still says SuperAdmin.
//
//   An account is deleted - the person has left - and their open tab keeps
//   working until the session expires on its own.
//
//   Sections are taken away and the screens go, but the API routes those
//   screens called still answer, because the grant check reads the role
//   from the same stale cookie.
//
// The row in `users` is the only place that holds the truth, so it is read
// again - not on every request, which would be a query in front of every
// tile on every dashboard, but once every half minute per session. A
// demotion takes effect within thirty seconds without anybody being asked
// to sign out and in, and a deleted account is turned away on its next
// request.
//
// IT FAILS OPEN, deliberately and in one direction only: if the database
// cannot be read, the session carries on with what it had. The alternative
// is a database blip signing the whole company out mid-order. What it does
// NOT do is carry on when the row is read and says the account is gone -
// that answer is acted on.
// ══════════════════════════════════════════════════════
const db = require('../config/db');

// Thirty seconds. Long enough that a dashboard opening twenty panels asks
// once, short enough that "I have taken his access away" is true before
// anybody has finished saying it. Overridable so the tests can ask for the
// check on every request.
const RECHECK_MS = Number(process.env.ROLE_RECHECK_MS || 30000);

// What the session is allowed to hold about a person. Written here so the
// shape cannot drift from routes/auth.js without somebody noticing.
function shape(row) {
  return {
    id: row.id,
    empId: row.emp_id,
    username: row.username,
    email: row.email,
    role: row.role,
    domain: row.domain,
  };
}

function gone(req, res) {
  const background = req.xhr
    || req.get('Sec-Fetch-Dest') === 'empty'
    || /^\/(api|views)\//.test(req.originalUrl);
  // The session is destroyed rather than left to expire: the account does
  // not exist, so neither should the thing that speaks for it.
  req.session.destroy(() => {
    if (background) {
      return res.status(401).json({
        success: false,
        error: 'Session expired. Please log in again.',
      });
    }
    res.redirect('/login');
  });
}

async function freshUser(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || !user.id) return next();

  const now = Date.now();
  if (req.session.userReadAt && now - req.session.userReadAt < RECHECK_MS) {
    return next();
  }

  try {
    const [[row]] = await db.query(
      'SELECT id, emp_id, username, email, role, domain FROM users WHERE id = ?',
      [user.id]);

    if (!row) return gone(req, res);

    const before = user.role + '|' + user.domain;
    req.session.user = shape(row);
    req.session.userReadAt = now;
    const after = row.role + '|' + row.domain;
    if (before !== after) {
      console.log('[freshUser] ' + row.email + ' is now ' + after
        + ' (session held ' + before + ')');
    }
  } catch (err) {
    // See the note at the top: a session with a slightly old role is a far
    // smaller problem than the whole office being signed out.
    console.error('[freshUser] could not re-read the account, keeping the '
      + 'session as it was:', err.message);
  }

  next();
}

module.exports = { freshUser, RECHECK_MS };
