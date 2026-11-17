/**
 * CLOSING THE TAB SIGNS YOU OUT.
 *
 * Asked for in those words: cross the tab and the session should end, and the
 * log should say where the person was when it did.
 *
 * WHY A BEACON AND NOT A SHORTER COOKIE. A session cookie with no lifetime
 * ends when the whole BROWSER closes, which on an office machine is once a
 * week. Nothing in a cookie can tell one tab from another. The browser's own
 * `pagehide` is the only moment that means "this page is going away", and
 * navigator.sendBeacon is the only thing allowed to make a request from it -
 * a fetch at that point is cancelled as the page dies.
 *
 * WHAT MAKES IT SAFE TO ACT ON. `pagehide` also fires on a RELOAD and on
 * following a link out, and signing somebody out because they pressed F5
 * would be worse than never signing them out at all. So the beacon does not
 * end the session; it MARKS it, with the time. Any request from the same
 * session within the grace window below means the page came back - a reload,
 * a second tab, a return from a download prompt - and the mark is lifted
 * along with the row it wrote. Only a mark nobody came back to ends the
 * session, on the first request after that.
 *
 * WHY THE ROW IS WRITTEN AT ONCE, AND SOMETIMES TAKEN BACK. Somebody who
 * closes the tab and goes home sends no further request, so a row written
 * "when we notice" would never be written at all - or would be written days
 * later wearing the wrong time. It is written at the beacon, dated the moment
 * the tab closed, and deleted again if that turns out to have been a reload.
 * A provisional row of our own, withdrawn within seconds: the alternative is
 * a log that loses the departures of everyone who leaves properly.
 *
 * THE TAB COUNT IS KEPT IN THE BROWSER, NOT HERE. Two tabs open and one
 * closed is not somebody leaving. The browser half in views/app.ejs keeps a
 * register of live tabs in localStorage and only beacons when the last one
 * goes, which costs no requests at all - a heartbeat to the server would have
 * been a request every few seconds from every open tab, all day.
 *
 * The vector-file gate does not apply here. It stops somebody CHOOSING to
 * sign out while they still owe files; it cannot stop somebody closing a tab,
 * and pretending otherwise would only mean the log missed them. They meet the
 * gate again the moment they sign back in.
 */
const db = require('../config/db');
const { ipOf, locationOf } = require('../utils/whereFrom');
const { SECTIONS } = require('../utils/nav');

// How long a marked session has to prove it is still alive. It must comfortably
// cover a reload on a bad line - the page has to come back and make its first
// request inside this - and nobody notices it, because the only thing waiting
// on it is a session the person has already walked away from.
// Overridable only so the tests do not have to sit through it; nothing sets
// it in the office.
const GRACE_MS = Number(process.env.TAB_GRACE_MS || 20000);

const SCREEN_NAME = new Map(SECTIONS.map(s => [s.id, s.name]));

/** The readable name of a screen, from its id. Anything unknown is nothing. */
function screenName(id) {
  return SCREEN_NAME.get(String(id || '').trim()) || '';
}

/**
 * POST /api/session/closing - the beacon.
 *
 * Answers 204 to everything, including a request with no session. The page
 * sending this is already dying and cannot do anything with an error; and an
 * unauthenticated beacon is simply a tab that was already signed out.
 */
async function closing(req, res) {
  try {
    const user = req.session && req.session.user;
    if (!user || (req.session.closing && req.session.closing.at)) return res.status(204).end();

    const screen = screenName(req.body && req.body.screen);
    const [row] = await db.query(
      `INSERT INTO activity_log (email, action, role, domain, ip_address, location, screen)
       VALUES (?,?,?,?,?,?,?)`,
      [user.email, 'Logout (tab closed)', user.role, user.domain,
        ipOf(req), locationOf(req), screen]);

    req.session.closing = { at: Date.now(), logId: row.insertId, screen };
    // Saved before answering. The page is gone a moment later and nothing
    // will come back to retry this.
    req.session.save(() => res.status(204).end());
  } catch (err) {
    console.error('[tabClose] could not mark the session:', err.message);
    res.status(204).end();
  }
}

/**
 * On every other request: end a session whose tab never came back.
 *
 * Only clears the session. What that means - a redirect to the login page, a
 * 401 to a fetch - is requireLogin's job, which already knows how to tell one
 * caller from the other.
 */
function enforce(req, res, next) {
  const mark = req.session && req.session.closing;
  if (!mark || !mark.at) return next();

  // Still inside the window: the page came back. Lift the mark and withdraw
  // the row, because nobody went anywhere.
  if (Date.now() - mark.at <= GRACE_MS) {
    const id = mark.logId;
    delete req.session.closing;
    if (id) {
      db.query('DELETE FROM activity_log WHERE id = ?', [id])
        .catch(err => console.error('[tabClose] could not withdraw the row:', err.message));
    }
    return next();
  }

  // Nobody came back. The row was written when the tab closed and already
  // carries that time, so there is nothing left to record here.
  req.session.destroy(() => next());
}

module.exports = { closing, enforce, screenName, GRACE_MS };
