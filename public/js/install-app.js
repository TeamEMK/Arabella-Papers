/* ══════════════════════════════════════════════════════
   "INSTALL THE APP" — THE BUTTON AND THE TWO BROWSERS

   Android/Chrome fires beforeinstallprompt when it decides the site is
   installable. That event is the only way to open the install dialogue from
   a button, and it can only be used once, in response to a real tap - so it
   is caught, held, and spent when the button is pressed.

   iPhone/Safari fires nothing and has no dialogue. There, installing is
   Share -> Add to Home Screen, done by hand, so the button says that instead
   of pretending it can do it for them.

   The button draws itself rather than being written into each page: this
   file is loaded by both the sign-in screen and the app shell, and those two
   have completely different stylesheets. Nothing here touches either.
   ══════════════════════════════════════════════════════ */
(function () {
  // Already installed - running in its own window - so there is nothing to
  // offer. Checked both ways: iOS reports it on navigator, everyone else
  // through the display mode.
  var installed = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (installed) return;

  // A desktop with a mouse is not who this is for.
  var isPhone = window.matchMedia('(max-width: 991.98px)').matches
    || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isPhone) return;

  var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  var DISMISSED = 'arabella_install_dismissed';

  // Put away for a week once dismissed, so it does not nag on every visit.
  try {
    var until = parseInt(localStorage.getItem(DISMISSED) || '0', 10);
    if (until && Date.now() < until) return;
  } catch (e) { /* private window - just show it */ }

  var deferred = null;
  var bar = null;

  function remember() {
    try { localStorage.setItem(DISMISSED, String(Date.now() + 7 * 24 * 60 * 60 * 1000)); }
    catch (e) { /* nothing to remember it with */ }
  }

  function build(label, onTap) {
    if (bar) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Install this app');
    // The app shell carries a bar of its own along the bottom. Sitting on
    // top of it would hide the tabs behind an advert for an app they are
    // already using, so this stands on it rather than over it. The sign-in
    // screen has no such bar and the measurement comes back zero.
    var nav = document.querySelector('.bottom-nav');
    var lift = nav ? Math.round(nav.getBoundingClientRect().height) : 0;

    bar.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px',
      // Clear of the rounded-off corner of a phone, and of the tab bar.
      'bottom:calc(' + (12 + lift) + 'px + env(safe-area-inset-bottom))',
      'z-index:2147483000', 'display:flex', 'align-items:center', 'gap:12px',
      'padding:12px 14px', 'border-radius:12px',
      'background:#212529', 'color:#f1f1f1',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)',
      'font-family:system-ui,Segoe UI,sans-serif', 'font-size:14px',
      'line-height:1.35',
    ].join(';');

    var icon = document.createElement('img');
    icon.src = '/icons/icon-192.png';
    icon.alt = '';
    icon.width = 36; icon.height = 36;
    icon.style.cssText = 'border-radius:8px;flex:0 0 36px';

    var text = document.createElement('div');
    text.style.cssText = 'flex:1;min-width:0';
    text.innerHTML = '<div style="font-weight:600">Arabella Papers</div>'
      + '<div style="opacity:.75;font-size:12.5px">' + label + '</div>';

    var act = document.createElement('button');
    act.type = 'button';
    act.textContent = isIOS ? 'How' : 'Install';
    act.style.cssText = [
      'flex:0 0 auto', 'min-height:44px', 'padding:0 16px',
      'border:0', 'border-radius:8px', 'cursor:pointer',
      'background:#ffcc00', 'color:#212529', 'font-weight:700', 'font-size:14px',
    ].join(';');
    act.addEventListener('click', onTap);

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Not now');
    close.innerHTML = '&times;';
    close.style.cssText = [
      'flex:0 0 44px', 'width:44px', 'min-height:44px',
      'border:0', 'background:transparent', 'color:#adb5bd',
      'font-size:22px', 'line-height:1', 'cursor:pointer',
    ].join(';');
    close.addEventListener('click', function () { remember(); hide(); });

    bar.appendChild(icon); bar.appendChild(text);
    bar.appendChild(act); bar.appendChild(close);
    document.body.appendChild(bar);
  }

  function hide() { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); bar = null; }

  // ── ANDROID / CHROME ──
  window.addEventListener('beforeinstallprompt', function (e) {
    // Hold it: without this the browser shows its own banner on its own
    // schedule, which on this app means on top of the sign-in form.
    e.preventDefault();
    deferred = e;
    build('Add it to your home screen', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') hide(); else { remember(); hide(); }
        deferred = null;
      });
    });
  });

  window.addEventListener('appinstalled', function () { remember(); hide(); });

  // ── IPHONE / SAFARI ──
  // No event and no dialogue, so the button explains the two taps instead.
  if (isIOS) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        build('Add it to your home screen', function () {
          alert('To install:\n\n1. Tap the Share button at the bottom of Safari\n'
            + '2. Choose "Add to Home Screen"');
        });
      }, 1200);
    });
  }
}());
