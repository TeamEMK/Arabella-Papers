// ══════════════════════════════════════════════════════
// WHAT AN ERROR IS ALLOWED TO SAY
//
// A hundred and thirteen routes in this app answer a failure with
// `error: err.message`, which is whatever the MySQL driver said. That text
// names tables, columns, the database user and the host - "Access denied
// for user 'arabella'@'10.0.0.4'", "Table 'railway.orders' doesn't exist",
// "User arabella already has more than 'max_user_connections' active
// connections". A stranger who makes a page fail gets a free map of the
// system, and the person reading it on screen can do nothing with it
// either.
//
// Rewriting all hundred and thirteen would be a hundred and thirteen
// chances to miss one, and the next route written would miss it too. So the
// rule lives in one place and sits in FRONT of them all: the answer is
// changed on its way out.
//
// Two rules, and they are deliberately different:
//
//   5xx - the app broke. Nobody but a SuperAdmin is told how. The real
//         message goes to the server log, where it is actually useful.
//
//   The driver's own words - "busy", "access denied", "no such table" -
//         are replaced for EVERYBODY, admin included. They name the
//         database user and host, which is the one thing nobody needs to
//         read on a screen, and "the server is busy" is what the sentence
//         means anyway.
//
// 4xx is left exactly as it is. Those are the app's own sentences, written
// for the person reading them: "Order Quantity must be 1 or more" has to
// come through untouched.
// ══════════════════════════════════════════════════════

const GENERIC = 'Something went wrong. Please try again.';
const BUSY = 'The server is busy. Please try again in a moment.';

// The shapes a mysql2 or socket failure arrives in. Matched on the text
// because by the time a route has put it in `error` the code is long gone.
const DRIVER = /(max_user_connections|ER_[A-Z_]+|access denied for user|unknown (column|database)|doesn't exist|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|connect ECONN|pool is closed|Too many connections)/i;

/** True when this sentence is the database talking, not the app. */
function fromTheDriver(text) {
  return DRIVER.test(String(text || ''));
}

const isAdmin = (req) => {
  const u = req.session && req.session.user;
  return !!u && (u.role === 'SuperAdmin' || u.domain === 'Head');
};

/**
 * Rewrites the body on its way out.
 *
 * Wrapping res.json rather than adding a handler at the end, because these
 * routes do not throw - they catch their own error and answer with it, so
 * nothing ever reaches an error handler. What they all share is this one
 * function call.
 */
function apiErrors(req, res, next) {
  const send = res.json.bind(res);
  res.json = (body) => {
    try {
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        const original = body.error;
        if (fromTheDriver(original)) {
          console.error('[api] driver error on ' + req.method + ' ' + req.originalUrl
            + ': ' + original);
          body = Object.assign({}, body, { error: BUSY });
        } else if (res.statusCode >= 500 && !isAdmin(req)) {
          console.error('[api] 5xx on ' + req.method + ' ' + req.originalUrl
            + ': ' + original);
          body = Object.assign({}, body, { error: GENERIC });
        }
      }
    } catch (err) {
      // Never let the thing that tidies an error become the error.
      console.error('[api] could not tidy an error body:', err.message);
    }
    return send(body);
  };
  next();
}

module.exports = { apiErrors, fromTheDriver, GENERIC, BUSY };
