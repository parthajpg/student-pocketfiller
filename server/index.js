// index.js — Student Pocket Filler API Server
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const authRoutes     = require('./routes/auth');
const surveyRoutes   = require('./routes/surveys');
const walletRoutes   = require('./routes/wallet');
const adminRoutes    = require('./routes/admin');
const postbackRoutes = require('./routes/postback');
// ── CPX Anti-Fraud Webhook (v1 — in-memory store) ────────
const cpxRoutes      = require('./routes/cpx');

const app = express();

// ── Security Headers ─────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: Origin not allowed'));
  },
  credentials: true,
}));

// ── Body Parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait and try again.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Stricter for auth endpoints
  message: { error: 'Too many auth attempts. Please wait 15 minutes.' }
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/surveys',  surveyRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/postback', postbackRoutes);
// ── CPX Research Anti-Fraud Webhook (versioned) ──────────
//    GET  /api/v1/cpx-webhook      → postback handler
//    POST /api/v1/request-survey   → iframe loader + cooldown
//    GET  /api/v1/admin/audit-log  → admin fraud log viewer
//    GET  /api/v1/wallet/:userId   → dev wallet inspector
app.use('/api/v1',       cpxRoutes);

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Student Pocket Filler API',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ── Serve Frontend (for production on Render) ─────────────────
// Uncomment this block when deploying to Render + serving frontend from backend
// app.use(express.static(path.join(__dirname, '../')));
// app.get('*', (req, res) => {
//   res.sendFile(path.join(__dirname, '../index.html'));
// });

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('🎓 Student Pocket Filler — API Server');
  console.log(`🚀 Running on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log('');
});

module.exports = app;
