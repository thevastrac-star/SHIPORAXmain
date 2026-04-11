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

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// MODE env var controls what this Render service shows at /
//   MODE=admin  → shiporaxadmin.onrender.com shows Admin panel
//   MODE=client → shiporaxclient.onrender.com shows Client panel
//   MODE=both   → kourierwale.onrender.com shows combined login (default)
const MODE = (process.env.MODE || 'both').toLowerCase();

// API_URL: where is the /api backend?
// - For all 3 services this is kourierwale.onrender.com
// - Empty string means "same origin" (safe for single-server dev)
const API_URL = process.env.API_URL || '';

const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── UPLOADS ─────────────────────────────────────────────────────────────────
['uploads/kyc', 'uploads/bulk'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── HTML HELPER — injects window.__API_URL before </head> ───────────────────
function serveHTML(res, filePath) {
  try {
    let html = fs.readFileSync(filePath, 'utf8');
    // Inject the API URL so all fetch() calls go to the right server
    html = html.replace(
      '</head>',
      `<script>window.__API_URL="${API_URL}";</script>\n</head>`
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('serveHTML error:', filePath, err.message);
    res.status(500).send('Page load error. Please try again.');
  }
}

const PUB = path.join(__dirname, 'public');

// ─── ROUTES ───────────────────────────────────────────────────────────────────
if (MODE === 'admin') {
  // shiporaxadmin.onrender.com — admin only
  app.get('/',             (q,r) => serveHTML(r, `${PUB}/admin/login.html`));
  app.get('/login',        (q,r) => serveHTML(r, `${PUB}/admin/login.html`));
  app.get('/admin',        (q,r) => serveHTML(r, `${PUB}/admin/index.html`));
  app.get('/admin/login',  (q,r) => serveHTML(r, `${PUB}/admin/login.html`));

} else if (MODE === 'client') {
  // shiporaxclient.onrender.com — client only
  app.get('/',             (q,r) => serveHTML(r, `${PUB}/client/login.html`));
  app.get('/login',        (q,r) => serveHTML(r, `${PUB}/client/login.html`));
  app.get('/client',       (q,r) => serveHTML(r, `${PUB}/client/index.html`));
  app.get('/client/login', (q,r) => serveHTML(r, `${PUB}/client/login.html`));

} else {
  // kourierwale.onrender.com — API server + combined login
  app.get('/',             (q,r) => serveHTML(r, `${PUB}/login.html`));
  app.get('/login',        (q,r) => serveHTML(r, `${PUB}/login.html`));
  app.get('/admin',        (q,r) => serveHTML(r, `${PUB}/admin/index.html`));
  app.get('/admin/login',  (q,r) => serveHTML(r, `${PUB}/admin/login.html`));
  app.get('/client',       (q,r) => serveHTML(r, `${PUB}/client/index.html`));
  app.get('/client/login', (q,r) => serveHTML(r, `${PUB}/client/login.html`));
}

// Static assets
app.use(express.static(PUB));

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

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (q,r) => r.json({ ok:true, mode:MODE, api:API_URL, time:new Date() }));

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api'))
    return res.status(404).json({ success:false, message:`No route: ${req.originalUrl}` });
  res.redirect('/');
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser:true, useUnifiedTopology:true })
  .then(async () => { console.log('✅ MongoDB connected'); await require('./config/autoSeed')(); })
  .catch(e => console.error('❌ MongoDB:', e.message));

// ─── KEEP-ALIVE ───────────────────────────────────────────────────────────────
setTimeout(() => {
  setInterval(() => {
    try {
      const u = new URL(BACKEND_URL + '/health');
      (u.protocol === 'https:' ? https : http).get(u.href, r =>
        console.log(`[ping] ${new Date().toISOString()} ${r.statusCode}`)
      ).on('error', e => console.warn('[ping fail]', e.message));
    } catch(e) {}
  }, 7 * 60 * 1000);
  console.log('🔔 Keep-alive started');
}, 15000);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 SHIPORAX  PORT=${PORT}  MODE=${MODE.toUpperCase()}`);
  console.log(`📡 API_URL="${API_URL || '(same origin)'}" \n`);
});

module.exports = app;
