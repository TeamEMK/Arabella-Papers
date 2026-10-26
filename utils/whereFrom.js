// ══════════════════════════════════════════════════════
// WHERE A REQUEST CAME FROM
//
// Recorded against a login so "who was on the system at four in the morning"
// has an answer beyond a name. The address alone rarely means anything to the
// person reading the log, so the town is kept beside it.
//
// The town comes from Vercel, which works out the location at the edge and
// passes it down as headers. That matters: the alternative is calling a
// geolocation service on every login, which would put a third party in the
// path of signing in, send them the office's addresses, and make a slow
// morning at that service into a slow morning here. These headers cost
// nothing and arrive before the request does.
//
// Off Vercel - a laptop, a test - the headers are absent and only the address
// is kept. A blank town is a true answer, so nothing is invented to fill it.
// ══════════════════════════════════════════════════════

/** The caller's address, as close to the real one as the proxies allow. */
function ipOf(req) {
  // x-forwarded-for is a chain, oldest first: the client is the first entry.
  // Taking the last would record Vercel's own proxy on every single row.
  const chain = String(req.headers['x-forwarded-for'] || '').split(',');
  const first = chain[0].trim();
  if (first) return first.slice(0, 64);
  const direct = req.socket?.remoteAddress || '';
  // ::ffff:1.2.3.4 is an IPv4 address wearing an IPv6 coat.
  return String(direct).replace(/^::ffff:/, '').slice(0, 64);
}

/** "Jaipur, RJ, IN" where the edge knows, '' where it does not. */
function locationOf(req) {
  const get = (name) => {
    const raw = req.headers[name];
    if (!raw) return '';
    // Vercel percent-encodes these, so a city with a space arrives as
    // "New%20Delhi" and would otherwise be written down that way.
    try { return decodeURIComponent(String(raw)).trim(); } catch (e) { return String(raw).trim(); }
  };
  const parts = [
    get('x-vercel-ip-city'),
    get('x-vercel-ip-country-region'),
    get('x-vercel-ip-country'),
  ].filter(Boolean);
  return parts.join(', ').slice(0, 160);
}

/**
 * What the browser said about itself, if anything, as [lat, lng, accuracy].
 *
 * Checked rather than trusted. These three arrive in the login form, which
 * anybody can post by hand, so a value outside the range the Earth has is not
 * stored - a row claiming latitude 900 is worse than a row claiming nothing.
 * All three travel together or none do: a pair of coordinates with no sense
 * of how wide the guess is reads as precise when it may be a whole city.
 */
function fixFrom(body) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lat = num(body && body.lat);
  const lng = num(body && body.lng);
  if (lat === null || lng === null) return [null, null, null];
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return [null, null, null];
  // Exactly zero on both is the null island off Africa, which is what a
  // broken sensor reports rather than anywhere anybody has ever logged in.
  if (lat === 0 && lng === 0) return [null, null, null];

  let acc = num(body.acc);
  acc = acc === null || acc < 0 ? null : Math.min(Math.round(acc), 2000000);
  return [lat, lng, acc];
}

module.exports = { ipOf, locationOf, fixFrom };
