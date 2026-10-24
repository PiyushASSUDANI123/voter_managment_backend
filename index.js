// Top-level Process Crash Prevention (Guarantees zero silent terminations)
process.on('uncaughtException', (err) => {
  console.error('💥 [CRITICAL] Uncaught Exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet'); // Security Headers & CSP
let compression = null;
try {
  compression = require('compression'); // Gzip / Deflate Compression for 10x faster payloads
} catch (err) {
  console.log('ℹ️ [Server] compression package not installed; running without response compression.');
}
const logger = require('./lib/logger'); // Structured Logging
const { sanitizeInput } = require('./middleware/sanitizeMiddleware');

dotenv.config();

const db = require('./db');
// Route imports
const authRoutes = require('./routes/auth');
const voterRoutes = require('./routes/voters');
const whatsappRoutes = require('./routes/whatsapp');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');
const featureRoutes = require('./routes/features');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 5002;

// High-Throughput Rate Limiters
const rateLimit = require('express-rate-limit');

// 1. General API Rate Limiter (600 req/min - high headroom for ground workers sharing same hotspot)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 600,
  message: { message: 'Too many requests from this IP, please try again after a minute' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

// 2. Strict Authentication Rate Limiter (Prevents brute force on login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 40, // 40 attempts per 15 min per IP
  message: { message: 'बहुत अधिक लॉगिन प्रयास (Too many login attempts). कृपया 15 मिनट बाद पुनः प्रयास करें।' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

// 3. Upload Rate Limiter (Prevents server exhaustion from spam uploads)
const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 15,
  message: { error: 'फाइल अपलोड की सीमा पार हो गई है। कृपया 1 मिनट बाद पुनः प्रयास करें।' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

const path = require('path');

// Security & Performance Middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
}));

// CORS Configuration: Open and permissive so clients (Vercel, Android WebView, Localhost) NEVER get blocked
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-organization-id', 'x-requested-with', 'Accept']
}));

// High-speed payload compression (shrinks JSON payloads by up to 90% when module is available)
if (compression) {
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    }
  }));
}

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Input sanitization (strips NoSQL injection, prototype pollution, cleans dirty strings)
app.use(sanitizeInput);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/privacy.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// Apply rate limiter to all API routes
app.use('/api', apiLimiter);

// Specific Auth Limiter
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Specific Upload Limiter
app.use('/api/admin/pdf/upload', uploadLimiter);

// Request Logging Middleware
app.use((req, res, next) => {
  logger.info(`Incoming Request: ${req.method} ${req.url}`, { ip: req.ip });
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/voters', voterRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/features', featureRoutes.router);
app.use('/api/admin/pdf', require('./routes/admin_pdf'));

app.get('/api/health', async (_req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } else {
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ status: 'degraded', database: 'error' });
  }
});

app.get('/', (req, res) => {
  res.send('VijaySetu Backend API is running.');
});

// Graceful Safe Error Handling (Never leaks stack traces, DB credentials, or internal paths)
app.use((err, req, res, next) => {
  logger.error(`Unhandled Exception: ${err.message}`, { stack: err.stack, url: req.url });
  res.status(err.status || 500).json({
    message: err.userFacingMessage || 'सर्वर पर अस्थायी समस्या है। कृपया कुछ क्षण बाद पुनः प्रयास करें। (System is experiencing high load)',
    errorId: Date.now()
  });
});

const startServer = () => {
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
};

if (require.main === module) {
  db.connectDB()
    .then(() => startServer())
    .catch((err) => {
      logger.error('Database startup failed', { message: err.message });
      process.exitCode = 1;
    });
}

module.exports = { app, startServer };
