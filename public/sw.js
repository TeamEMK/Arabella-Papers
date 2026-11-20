/* ══════════════════════════════════════════════════════
   THE SERVICE WORKER — AND WHY IT DELIBERATELY DOES NOTHING

   A browser will only offer to install an app that registers one of these
   with a fetch handler. That is the only reason this file exists.

   IT CACHES NOTHING, ON PURPOSE. A caching service worker would serve the
   app's own HTML and CSS from the phone, and this app keeps all of its
   styling inline in the shell page - so a stale copy means a phone running
   last week's CSS with no way for anybody to tell. We have already lost an
   afternoon to exactly that, with a tab that had been left open across a
   deploy. A service worker would make it permanent instead of temporary.

   So every request goes straight to the network, as if this file were not
   here. What installing buys is the home-screen icon and a window with no
   address bar in it - not offline use.

   If offline is ever wanted, it should cache data endpoints deliberately,
   one at a time, and never the shell.
   ══════════════════════════════════════════════════════ */

// A new worker takes over immediately rather than waiting for every tab
// holding the old one to close.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// Present, and passes everything through untouched. Removing this listener
// would make the app uninstallable.
self.addEventListener('fetch', function () { /* straight to the network */ });
