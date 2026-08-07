require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');

const { injectUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const indexRoutes = require('./routes/index');
const viewsRoutes = require('./routes/views');
const ordersApi = require('./routes/api/orders');
const dashboardsApi = require('./routes/api/dashboards');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SESSION STORE (MySQL) ──
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  createDatabaseTable: true,
  schema: {
    tableName: 'sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
  },
});

// ── MIDDLEWARE ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'arabella-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    httpOnly: true,
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
  console.error('Unhandled Error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`✅ Arabella Paper FMS running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
