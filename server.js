require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');

const db = require('./config/db');
const { ensureSchema } = require('./config/initDb');
const { injectUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const indexRoutes = require('./routes/index');
const viewsRoutes = require('./routes/views');
const ordersApi = require('./routes/api/orders');
const dashboardsApi = require('./routes/api/dashboards');

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Build the schema on the first request against an empty database. Runs before
// the session middleware so the store is not querying tables that don't exist.
app.use((req, res, next) => {
  ensureSchema().then(() => next(), next);
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'arabella-secret-key-2024',
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

app.use(injectUser);

// ── VIEW ENGINE ──
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── ROUTES ──
app.use('/', authRoutes);
app.use('/', indexRoutes);
app.use('/views', viewsRoutes);
app.use('/api/orders', ordersApi);
app.use('/api/dashboards', dashboardsApi);

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
    console.log(`✅ Arabella Paper FMS running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    // Report at boot rather than waiting for the first request to reveal a
    // broken database.
    ensureSchema().then(
      r => {
        console.log(`   Database: ${r.created ? 'schema created' : 'schema already present'}`);
        console.log(r.admin.seeded
          ? `   Admin:    created ${r.admin.email}`
          : `   Admin:    not created (${r.admin.reason})`);
      },
      err => console.error('   Database: schema setup FAILED —', err.message),
    );
  });
}

module.exports = app;
