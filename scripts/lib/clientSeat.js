/**
 * A signed-in client, for the suites.
 *
 * The liner book, the design catalogue and the two price calculators used
 * to be public addresses. They are rooms inside the client portal now, so a
 * suite that wants to look at one has to arrive the way a customer does -
 * with an account and a cookie.
 *
 * The account is written straight into client_users rather than registered
 * through the page: these suites are about the ROOMS, and making each of
 * them walk the sign-up, the code and the verification would test the
 * portal three more times and fail three more ways that have nothing to do
 * with what they are checking. The portal's own suite does that walk.
 *
 * The sign-in itself is real, though - the cookie has to come from the
 * route, or the suite would be proving that a seat it invented works.
 */
const bcrypt = require('bcryptjs');

const PASSWORD = 'room-key-2026';

/**
 * Makes a verified account on that brand and signs it in.
 *
 * `go` is the suite's own fetch wrapper (url, opts) -> Response.
 * Returns the cookie, to be sent with anything inside the portal.
 */
async function seat(db, go, brand, email) {
  const who = email || ('room-' + brand + '@test.local');
  const hash = await bcrypt.hash(PASSWORD, 10);
  await db.query(
    `INSERT INTO client_users (brand, email, name, password_hash, verified_at)
     VALUES (?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),
                             verified_at = NOW()`,
    [brand, who, 'Room Probe', hash]);

  const r = await go('/client/' + brand + '/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // THE SESSION COOKIE IS SECURE-ONLY when HTTPS is set, which it is
      // in the office's .env - so over plain http the server answers "you
      // are signed in" and sends no cookie at all. Saying the request came
      // through a proxy is what the app's own screens do; without it this
      // helper looked like a login that worked and a seat that did not.
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ email: who, password: PASSWORD }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const body = await r.json().catch(() => null);
  if (!cookie || !body || body.signedIn !== true) {
    throw new Error('could not seat a client on ' + brand + ': '
      + JSON.stringify(body) + ' / ' + (cookie || 'no cookie'));
  }
  return cookie;
}

module.exports = { seat, PASSWORD };
