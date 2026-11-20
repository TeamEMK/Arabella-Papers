/* ══════════════════════════════════════════════════════
   "A NEW VERSION IS READY"

   This app is one shell page with its CSS written inside it, and the
   sections are fetched into it rather than loaded as pages. So a tab left
   open - or the app installed on a phone, which is a tab that is never
   closed - keeps running the build it was opened with, however many times
   the site is deployed. Nothing tells the person, and what they see are
   symptoms of bugs that were fixed days ago. We lost an afternoon to exactly
   that once.

   So: remember the build this page started on, ask the server now and then,
   and when the answer changes, offer a reload. It only ever offers. A page
   that reloaded itself would throw away a half-typed remark.

   Nothing is cached, here or in the service worker, so one reload is all it
   takes to be current.
   ══════════════════════════════════════════════════════ */
(function () {
  var ENDPOINT = '/api/version';
  var EVERY = 5 * 60 * 1000;   // a deploy takes longer than this to matter
  var started = null;          // the build this page is running
  var bar = null;

  function ask() {
    // Signed out, offline, or mid-deploy: all three are "ask again later".
    return fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && j.build ? j.build : null; })
      .catch(function () { return null; });
  }

  function show() {
    if (bar) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', 'A new version is ready');

    // Stands on the tab bar where the app has one, not over it.
    var nav = document.querySelector('.bottom-nav');
    var lift = nav ? Math.round(nav.getBoundingClientRect().height) : 0;

    bar.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px',
      'bottom:calc(' + (12 + lift) + 'px + env(safe-area-inset-bottom))',
      'z-index:2147483000', 'display:flex', 'align-items:center', 'gap:12px',
      'padding:12px 14px', 'border-radius:12px',
      'background:#212529', 'color:#f1f1f1',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)',
      'font-family:system-ui,Segoe UI,sans-serif', 'font-size:14px', 'line-height:1.35',
    ].join(';');

    var text = document.createElement('div');
    text.style.cssText = 'flex:1;min-width:0';
    text.innerHTML = '<div style="font-weight:600">A new version is ready</div>'
      + '<div style="opacity:.75;font-size:12.5px">Reload to pick up the latest changes</div>';

    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Update';
    go.style.cssText = [
      'flex:0 0 auto', 'min-height:44px', 'padding:0 16px', 'border:0', 'border-radius:8px',
      'cursor:pointer', 'background:#ffcc00', 'color:#212529', 'font-weight:700', 'font-size:14px',
    ].join(';');
    go.addEventListener('click', function () {
      go.disabled = true;
      go.textContent = '...';
      // The service worker holds nothing, so there is nothing to clear
      // first - but if one is ever given a cache, this is where it goes.
      window.location.reload();
    });

    var later = document.createElement('button');
    later.type = 'button';
    later.setAttribute('aria-label', 'Later');
    later.innerHTML = '&times;';
    later.style.cssText = [
      'flex:0 0 44px', 'width:44px', 'min-height:44px', 'border:0',
      'background:transparent', 'color:#adb5bd', 'font-size:22px', 'line-height:1', 'cursor:pointer',
    ].join(';');
    // Put away, not turned off: the next check brings it back, because the
    // page really is out of date and saying so once is not enough.
    later.addEventListener('click', function () { hide(); });

    bar.appendChild(text); bar.appendChild(go); bar.appendChild(later);
    document.body.appendChild(bar);
  }

  function hide() { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); bar = null; }

  function check() {
    ask().then(function (build) {
      if (!build) return;
      if (!started) { started = build; return; }   // first answer is the baseline
      if (build !== started) show();
    });
  }

  check();
  setInterval(check, EVERY);

  // Coming back to the app is the moment somebody is about to use it, and
  // for an installed app it may be the only moment for days.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) check();
  });
}());
