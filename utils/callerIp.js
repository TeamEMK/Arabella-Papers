// ══════════════════════════════════════════════════════
// WHO IS CALLING - ONE ANSWER, IN ONE PLACE
//
// Four public endpoints had a rate limit keyed on the first entry of
// `x-forwarded-for`: the client portal's register/login/reset, the quote
// page, the catalogue's email box, and the tracking page. That header is
// not a fact about the caller - it is a line in their request, and they can
// write a different one each time. A limiter keyed on it is a limiter with
// no key: twenty attempts become twenty thousand, each looking like the
// first visit of a new person.
//
// The login form already did this properly (utils/loginGuard.js), so the
// same function lives here and all of them use it.
//
// On Vercel the platform OVERWRITES x-vercel-forwarded-for and x-real-ip
// with the address it saw the connection come from, and those are the ones
// to read. Anywhere else - a laptop, a smoke test, a box behind nothing -
// the socket address is the only thing that is true. The caller's own
// x-forwarded-for is never used for anything that has to be trustworthy.
// ══════════════════════════════════════════════════════

/** The caller's address, as close to the real one as the proxies allow. */
function callerIp(req) {
  if (process.env.VERCEL) {
    const platform = String(
      (req.headers && (req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'])) || '',
    ).split(',')[0].trim();
    // ::ffff:1.2.3.4 is an IPv4 address wearing an IPv6 coat.
    if (platform) return platform.replace(/^::ffff:/, '').slice(0, 64);
  }
  const direct = (req.socket && req.socket.remoteAddress) || '';
  return String(direct).replace(/^::ffff:/, '').slice(0, 64) || 'unknown';
}

module.exports = { callerIp };
