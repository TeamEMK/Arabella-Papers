// ══════════════════════════════════════════════════════
// THE NAME A SECTION GOES BY IN THE ADDRESS BAR
//
// Every page used to live at the same address. Then it lived at /?tab=<id>,
// which could at least be sent to somebody. Now it lives at /app/<slug>,
// because a query string reads like a setting and a path reads like a place.
//
// The slug is DERIVED from the id, never written down. A hand-kept table is a
// table somebody forgets to add a row to, and the symptom - a new tab whose
// link quietly falls back to the dashboard - is the kind that gets noticed a
// month later by a customer. So: tillApproval becomes till-approval and
// nothing has to be remembered.
//
// Pure string work on purpose. utils/nav.js cannot be loaded in a browser -
// its rules are functions over a session user - so this takes the list of ids
// from whoever is calling: SECTION_IDS on the server, NAV_MENU in the shell.
// That also means the two cannot drift, because there is only one function.
// ══════════════════════════════════════════════════════

/**
 * tillApproval -> till-approval, productionBD -> production-bd, scot -> scot.
 *
 * The second replace is what keeps runs of capitals together: without it
 * productionBD comes out production-b-d. A capital only starts a new word
 * when a lowercase or a digit came before it, or when a lowercase follows it.
 */
function slugFor(id) {
  return String(id || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Only ever one lowercase segment, which is what the routes match on. */
var SLUG_RE = /^[a-z0-9-]+$/;

/**
 * The id a slug names, or '' if it names none of them.
 *
 * Matched against the caller's own list rather than parsed back, because
 * un-slugging is guesswork - cc-prospects could be ccProspects or CcProspects
 * - and because the list is the only thing that says which pages exist.
 */
function idFromSlug(slug, ids) {
  var want = String(slug || '').toLowerCase();
  if (!want || !SLUG_RE.test(want)) return '';
  var list = ids || [];
  for (var i = 0; i < list.length; i++) {
    if (slugFor(list[i]) === want) return list[i];
  }
  return '';
}

/** Where the shell lives. One place, so nothing hand-builds these. */
var BASE = '/app';

/** The path for a page. The home page is the bare base, not /app/dashboard. */
function pathFor(id, homeId) {
  if (!id || id === homeId) return BASE;
  return BASE + '/' + slugFor(id);
}

/**
 * The id named by a path, or '' for the base itself and for anything else.
 * Deliberately strict: /app/foo/bar is not a page, it is a typo.
 */
function idFromPath(pathname, ids) {
  var p = String(pathname || '').replace(/\/+$/, '');
  if (p === BASE || p === '') return '';
  if (p.indexOf(BASE + '/') !== 0) return '';
  var rest = p.slice(BASE.length + 1);
  if (rest.indexOf('/') !== -1) return '';
  return idFromSlug(rest, ids);
}

/**
 * Every id gets its own slug - shouted about at boot rather than discovered
 * when two tabs start opening each other. Returns the clashes, empty if fine.
 */
function collisions(ids) {
  var seen = {}, bad = [];
  (ids || []).forEach(function (id) {
    var s = slugFor(id);
    if (seen[s]) bad.push(seen[s] + ' and ' + id + ' both slug to ' + s);
    else seen[s] = id;
    if (!SLUG_RE.test(s)) bad.push(id + ' slugs to "' + s + '", which is not a usable path segment');
  });
  return bad;
}

var api = {
  BASE: BASE,
  SLUG_RE: SLUG_RE,
  slugFor: slugFor,
  idFromSlug: idFromSlug,
  pathFor: pathFor,
  idFromPath: idFromPath,
  collisions: collisions,
};

// Read by Express when it decides which paths serve the shell, and by the
// shell when it decides what to put in the address bar - so a page cannot be
// reachable at one spelling and linked at another.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ArabellaSections = api;
