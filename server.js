require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');

const db = require('./config/db');
const { ensureSchema } = require('./config/initDb');
const { injectUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const trackRoutes = require('./routes/track');
const catalogueRoutes = require('./routes/catalogue');
const linearsRoutes = require('./routes/linears');
const quoteRoutes = require('./routes/quote');
const catalogueApi = require('./routes/api/catalogue');
const indexRoutes = require('./routes/index');
const viewsRoutes = require('./routes/views');
const ordersApi = require('./routes/api/orders');
const uploadsApi = require('./routes/api/uploads');
const dashboardsApi = require('./routes/api/dashboards');
const accountApi = require('./routes/api/account');
const usersApi = require('./routes/api/users');
const bulkApi = require('./routes/api/bulk');
const logsApi = require('./routes/api/logs');
const userActivityApi = require('./routes/api/userActivity');
const hrApi = require('./routes/api/hr');
const leavesApi = require('./routes/api/leaves');
const stockApi = require('./routes/api/stock');
const inventoryApi = require('./routes/api/inventory');
const correctionsApi = require('./routes/api/corrections');
const exportApi = require('./routes/api/export');
const fmsApi = require('./routes/api/fms');
const fmsTasksApi = require('./routes/api/fmsTasks');
const accessApi = require('./routes/api/access');
const recruitmentApi = require('./routes/api/recruitment');
const joiningApi = require('./routes/api/joining');
const scotApi = require('./routes/api/scot');
const cronApi = require('./routes/api/cron');
const pricingApi = require('./routes/api/pricing');
const prospectsApi = require('./routes/api/prospects');
const ccProspectsApi = require('./routes/api/ccProspects');
const bfProspectsApi = require('./routes/api/bfProspects');
const envelopeLinearsApi = require('./routes/api/envelopeLinears');
const pmsApi = require('./routes/api/pms');

const app = express();
const PORT = process.env.PORT || 3000;
const isServerless = !!process.env.VERCEL;

// ── SESSION STORE (MySQL) ──
// Reuse the app's mysql2 pool instead of opening a second one — on serverless a
// separate store pool would double the connections Railway MySQL has to hold.
const sessionStore = new MySQLStore({
  createDatabaseTable: true,
  // The periodic cleanup timer never gets to run in a serverless function and
  // only keeps the lambda handle open, so leave it to the long-lived process.
  clearExpired: !isServerless,
  schema: {
    tableName: 'sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
  },
}, db);

// ── MIDDLEWARE ──
// Vercel terminates TLS at its proxy; without this Express sees http and
// refuses to set the secure session cookie.
if (isServerless) app.set('trust proxy', 1);

// ── THE HEADERS EVERY ANSWER CARRIES ──
//
// Before the static files, deliberately: a header middleware mounted after
// express.static covers the pages and none of the files, and the files are
// most of what a browser actually loads.
//
// What each one stops:
//   frameguard      - the app inside somebody else's <iframe>, with their
//                     buttons drawn over ours (clickjacking).
//   noSniff         - a browser deciding an upload "looks like" HTML or a
//                     script and running it instead of downloading it.
//   HSTS            - the first http request, where a network in between
//                     can read the session cookie or rewrite the page.
//   Referrer-Policy - order numbers and tokens in our URLs being posted to
//                     whatever site somebody clicks through to.
//   x-powered-by    - the free hint about what to look up exploits for.
//
// CSP IS OFF, AND THAT IS A DECISION, NOT AN OVERSIGHT. Every screen in
// this app is drawn with inline onclick handlers - some two thousand of
// them - and a content policy strict enough to be worth having would stop
// every one from firing. Turning it on is a separate piece of work: move
// the handlers to addEventListener first, screen by screen, then switch it
// on. Same for COEP, which would block the CDN that serves Bootstrap and
// Font Awesome.
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // Both the app and the customer pages pull fonts and icons from CDNs, and
  // the liner book draws its pictures from our own origin into canvases.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 15552000, includeSubDomains: true },
}));

// ── AND NOTHING UNDER /api IS KEPT ──
//
// Every one of these answers is about one person: their orders, their
// board, their activity log. Without this a browser - or a CDN sitting in
// front of us - may hold one and hand it to the next person on that
// machine, or hand back a 304 for a board that has moved on since.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// What a failure is allowed to say - see middleware/apiErrors.js. Mounted
// here, in front of every /api route, because those routes catch their own
// errors and answer with them; nothing reaches an error handler at the end.
const { apiErrors } = require('./middleware/apiErrors');
app.use('/api', apiErrors);

// 10mb rather than the 100kb default: an equipment photo is posted as a data
// URL inside the JSON body. The browser shrinks it to roughly 1000px first, so
// what actually arrives is a couple of hundred kilobytes - the headroom is for
// the odd large one, not the normal case.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// One copy of the order-number rule, read by the server and sent to the
// browser. utils/orderId.js is required below as well, so the bundler keeps
// the file on disk for this to serve.
require('./utils/orderId');
app.get('/js/orderId.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.sendFile(path.join(__dirname, 'utils', 'orderId.js'));
});

// The same arrangement for the nine production stages: the board draws its
// badges from this and the morning mail reads it, so a stage cannot be green
// on the screen and late in somebody's inbox.
require('./utils/productionStages');
app.get('/js/productionStages.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.sendFile(path.join(__dirname, 'utils', 'productionStages.js'));
});

// And again for how long an urgent order has left. The boards colour a RUSH
// order from this and the morning mail counts the same days, so an order
// cannot read "due tomorrow" on screen and "overdue" in an inbox.
require('./utils/urgency');
app.get('/js/urgency.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.sendFile(path.join(__dirname, 'utils', 'urgency.js'));
});

// And again for the section slugs. Express decides from this which paths
// serve the shell; the shell decides from it what to put in the address bar.
// Two copies of that rule would mean a page reachable at one spelling and
// linked at another.
const sectionSlug = require('./utils/sectionSlug');
app.get('/js/sectionSlug.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.sendFile(path.join(__dirname, 'utils', 'sectionSlug.js'));
});

// Said at boot, not discovered later. Two sections slugging to the same path
// would make one of them unreachable, and the symptom - a tab that opens the
// wrong page - looks like anything but a naming clash.
{
  const clashes = sectionSlug.collisions(require('./utils/nav').SECTION_IDS);
  if (clashes.length) throw new Error('Section slug clash: ' + clashes.join('; '));
}

// Build the schema on the first request against an empty database. Runs before
// the session middleware so the store is not querying tables that don't exist.
app.use((req, res, next) => {
  ensureSchema().then(() => next(), next);
});

// ── THE SESSION SECRET, AND WHY THERE IS NO FALLBACK ──
//
// This string signs the cookie that says who you are. Anybody holding it can
// mint a cookie for any account - the SuperAdmin included - without a
// password, and this repository is on GitHub, so a literal written here is a
// literal everybody has.
//
// So: live refuses to start without it. Not a warning, not a default - a
// server that boots with a known secret is a server with no login at all,
// and it would boot looking perfectly healthy.
//
// Off the platform (a laptop, a smoke test) it makes one up per run. That
// signs out whoever was signed in when the process restarted, which is the
// right trade on a machine where the alternative is developing against the
// production secret.
function sessionSecret() {
  const set = String(process.env.SESSION_SECRET || '').trim();
  if (set) return set;
  if (isServerless || process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET is not set. Refusing to start: without it '
      + 'the session cookie would be signed with a value anybody can read.');
    process.exit(1);
  }
  return require('crypto').randomBytes(32).toString('hex');
}

app.use(session({
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: isServerless || process.env.HTTPS === 'true',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// Closing the tab ends the session. The beacon is answered before anything
// else can redirect it, and every other request is checked for a tab that
// never came back - see middleware/tabClose.js for why it is done this way
// round and not with a shorter cookie.
const tabClose = require('./middleware/tabClose');
app.post('/api/session/closing', tabClose.closing);
app.use(tabClose.enforce);

// The role in the cookie was written at sign-in and never looked at again,
// so a demotion took effect only when the person next signed in - eight
// hours later. The account is re-read every half minute instead. Before
// injectUser, so the screens are drawn from the same answer the routes use.
app.use(require('./middleware/freshUser').freshUser);

app.use(injectUser);

// ── VIEW ENGINE ──
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── ROUTES ──
// Public: no session, no login. Mounted before the app's own
// routes so nothing downstream can decide it needs one.
app.use('/track', trackRoutes);

// ── ONE LINK TO GIVE OUT, NOT FOUR ──
//
// The liner book, the design catalogue and the two price calculators used
// to be four addresses a customer could be sent. They are rooms inside the
// client portal now - see routes/clientPortal.js - and these four send
// anybody holding an old link to the door of the right one.
//
// A redirect, not a dead end: the liner book link is already in somebody's
// chat and read out over a telephone, and a 404 would make the office look
// as though it had taken the book away.
//
// /track is deliberately NOT here. It is the page the CLIENT gives their
// own customers to follow an order, and it has nothing behind it worth
// signing in for.
const toPortal = (where) => (req, res) => res.redirect(302, where);
app.get('/liners', toPortal('/client/arabella/liners'));
app.get('/catalogue', toPortal('/client/arabella/catalogue'));
app.get('/quote/arabella', toPortal('/client/arabella/quote'));
app.get('/quote/kpc', toPortal('/client/kpc/quote'));

// AND EVERYTHING UNDERNEATH THEM IS SHUT.
//
// The pages were the addresses people were given; these are what those
// pages used to ask for - /liners/api/board, /catalogue/api/items,
// /quote/<brand>/api/send. Left open they are the same book, the same
// catalogue and the same quote-writing endpoint, reachable by anybody who
// has ever looked at the page they came from. The rooms inside the portal
// do not use them: each asks its own address, under /client/<brand>/...
//
// ONE EXCEPTION, AND IT IS NOT AN OVERSIGHT. The catalogue email embeds
// <img src=".../catalogue/image/12">. Closing that route would empty every
// mail the office has already sent, in inboxes it cannot reach. A picture
// id is not an address anybody was given and it opens nothing but that one
// picture, which is already in the mail.
const shut = (req, res) => res.status(404).json({
  success: false,
  error: 'This address has moved. Your account is at /client/arabella.',
});
app.use('/liners', shut);
app.use('/quote', shut);
app.use('/catalogue/api', shut);
app.get('/catalogue/image/:id', (req, res, next) => {
  // Handed to the router the way a mount would hand it over: it matches on
  // the whole url, and '/catalogue/image/12' matches none of its routes.
  req.url = '/image/' + req.params.id;
  catalogueRoutes(req, res, next);
});
app.use('/catalogue', shut);
// The liner book, for a customer. No login: see the note at the top of
// routes/linears.js for exactly what that opens up.
// THE OLD SPELLING IS NOT A SECOND PAGE, ONLY A SIGNPOST. /linears was
// the first spelling and it is already in somebody's chat, so instead of
// serving the book twice it says, once and permanently, where the book
// moved to. Everything under it comes along: /linears/api/board becomes
// /liners/api/board.
app.use('/linears', (req, res) => res.redirect(301, '/liners' + req.url.replace(/^\/?$/, '')));
// The client portal: two links, each opening the liner book, the design
// catalogue and that brand's price calculator behind a sign-in of the
// customer's own. Accounts live in client_users and are kept on the session
// under their own key - see routes/clientPortal.js.
app.use('/client', require('./routes/clientPortal'));
// Two public links, one per brand - see routes/quote.js.
app.use('/', authRoutes);
app.use('/', indexRoutes);
app.use('/views', viewsRoutes);
app.use('/api/orders', ordersApi);
app.use('/api/uploads', uploadsApi);
app.use('/api/dashboards', dashboardsApi);
app.use('/api/account', accountApi);
app.use('/api/users', usersApi);
app.use('/api/bulk', bulkApi);
app.use('/api/logs', logsApi);
app.use('/api/user-activity', userActivityApi);
app.use('/api/catalogue', catalogueApi);
app.use('/api/hr', hrApi);
app.use('/api/leaves', leavesApi);
app.use('/api/stock', stockApi);
app.use('/api/inventory', inventoryApi);
app.use('/api/corrections', correctionsApi);
app.use('/api/export', exportApi);
app.use('/api/fms', fmsApi);
app.use('/api/fms-tasks', fmsTasksApi);
app.use('/api/pms', pmsApi);
app.use('/api/access', accessApi);
app.use('/api/recruitment', recruitmentApi);
// The onboarding form's own two routes, and the only ones in the app outside
// the login. A new hire has no account here - the token in the emailed link is
// what says whose form this is, and it is checked on both of them. Everything
// an employee of Arabella does with that form is in /api/recruitment instead.
app.use('/api/joining', joiningApi);
app.use('/api/scot', scotApi);
app.use('/api/cron', cronApi);
app.use('/api/pricing', pricingApi);
app.use('/api/prospects', prospectsApi);
app.use('/api/cc-prospects', ccProspectsApi);
app.use('/api/bf-prospects', bfProspectsApi);
app.use('/api/envelope-linears', envelopeLinearsApi);
// Delegation + Checklist tasks (modules/tasks, from the E-Marketing ERP):
// /api/tasks, /api/approvals, /api/transfers, /api/comments, /api/holidays …
require('./modules/tasks/arabella')(app);

// ── 404 FALLBACK ──
app.use((req, res) => {
  res.status(404).send('<h2>404 - Page Not Found</h2><a href="/">Back to Home</a>');
});

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  // Multer rejects oversized uploads before the route runs — surface the real
  // reason instead of a generic 500, since 4MB is easy to hit with design files.
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large — maximum 4MB per file.' });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ success: false, error: 'Too many files — maximum 10 per upload.' });
  }
  console.error('Unhandled Error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── START ──
// On Vercel the platform owns the listener — api/index.js just exports this app.
if (!isServerless) {
  app.listen(PORT, () => {
    console.log(`✅ Arabella Papers FMS running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    // Report at boot rather than waiting for the first request to reveal a
    // broken database.
    ensureSchema().then(
      r => {
        // A database already built by this exact build reports nothing but
        // the fingerprint - there is no seed result to print, because
        // nothing was seeded. Reading r.admin regardless took the whole
        // server down on boot the moment that skip started happening.
        if (r.skipped) {
          console.log(`   Database: already built (${r.fingerprint})`);
          return;
        }
        console.log(`   Database: ${r.created ? 'schema created' : 'schema already present'}`);
        if (r.columns && r.columns.length) console.log(`   Migrated: ${r.columns.join(', ')}`);
        if (r.admin) {
          console.log(r.admin.seeded
            ? `   Admin:    created ${r.admin.email}`
            : `   Admin:    not created (${r.admin.reason})`);
        }
      },
      err => console.error('   Database: schema setup FAILED —', err.message),
    );
  });
}

module.exports = app;
