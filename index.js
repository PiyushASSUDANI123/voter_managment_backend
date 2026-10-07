const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

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
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/voters', voterRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/features', featureRoutes.router);

app.get('/api/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({
      status: 'degraded',
      database: db.isConfigured() ? 'unavailable' : 'not_configured',
    });
  }
});

app.get('/', (req, res) => {
  res.send('VijaySetu Backend API is running.');
});

const startServer = () => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

if (db.isConfigured()) {
  db.ensureSchema()
    .then(startServer)
    .catch((err) => {
      console.error('Database schema setup failed:', err.message);
      startServer();
    });
} else {
  startServer();
}
