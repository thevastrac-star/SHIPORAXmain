require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── STATIC FILES (uploads only) ─────────────────────────────────────────────
const uploadDirs = ['uploads/kyc', 'uploads/bulk'];
uploadDirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/wallet',        require('./routes/wallet'));
app.use('/api/kyc',           require('./routes/kyc'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/ndr',           require('./routes/ndr'));
app.use('/api/cod',           require('./routes/cod'));
app.use('/api/couriers',      require('./routes/couriers'));
app.use('/api/tickets',       require('./routes/tickets'));
app.use('/api/warehouses',    require('./routes/warehouses'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/settings',      require('./routes/settings'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/notifications', require('./routes/notifications'));

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── ROOT — API INFO (no HTML, no login page) ────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'ShipoRAX API',
    version: '1.0.0',
    status: 'running',
    endpoints: [
      'POST /api/auth/login',
      'POST /api/auth/register',
      'GET  /api/auth/me',
      'GET  /api/orders',
      'GET  /api/wallet',
      'GET  /api/users',
      'GET  /api/analytics',
      'GET  /health'
    ]
  });
});

// ─── 404 FALLBACK ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── DATABASE + AUTO-SEED ─────────────────────────────────────────────────────
const autoSeed = require('./config/autoSeed');

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log('MongoDB connected');
  await autoSeed();
})
.catch(err => console.error('MongoDB error:', err));

// ─── KEEP-ALIVE PING ─────────────────────────────────────────────────────────
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
const PING_INTERVAL = 7 * 60 * 1000;
const keepAlive = () => {
  const url = new URL(BACKEND_URL + '/health');
  const lib = url.protocol === 'https:' ? https : http;
  lib.get(url.href, (res) => {
    console.log(`[Keep-Alive] ${new Date().toISOString()} – ${res.statusCode}`);
  }).on('error', (e) => console.warn('[Keep-Alive] failed:', e.message));
};
setTimeout(() => { setInterval(keepAlive, PING_INTERVAL); }, 10000);

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ShipoRAX API running on port ${PORT}`);
});

module.exports = app;
