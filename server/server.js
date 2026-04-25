require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');

const app = express();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const MODE    = (process.env.MODE || 'both').toLowerCase();
const API_URL = process.env.API_URL || '';

// FIX #8: CORS should whitelist allowed origins, not use '*' with credentials:true
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and whitelisted origins
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(morgan('dev'));

// Raw body needed for webhook HMAC verification (must come BEFORE express.json)
app.use('/api/selloship/webhook',        express.raw({ type: '*/*' }));
app.use('/api/shopify/webhook',          express.raw({ type: '*/*' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── UPLOADS ─────────────────────────────────────────────────────────────────
['uploads/kyc', 'uploads/bulk'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── HTML HELPER ─────────────────────────────────────────────────────────────
const PUB = path.join(__dirname, 'public');

function serveHTML(res, filePath) {
  try {
    let html = fs.readFileSync(filePath, 'utf8');
    if (API_URL) html = html.replace('</head>', `<script>window.__API_URL="${API_URL}";</script>\n</head>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('serveHTML error:', filePath, err.message);
    res.status(500).send('<h2>Page load error. Please try again.</h2>');
  }
}

// ─── FRONTEND ROUTES ──────────────────────────────────────────────────────────
app.get('/admin',        (q,r) => serveHTML(r, `${PUB}/admin/index.html`));
app.get('/admin/login',  (q,r) => serveHTML(r, `${PUB}/admin/login.html`));
app.get('/client',          (q,r) => serveHTML(r, `${PUB}/client/index.html`));
app.get('/client/login',    (q,r) => serveHTML(r, `${PUB}/client/login.html`));
app.get('/client/register', (q,r) => serveHTML(r, `${PUB}/client/register.html`));

if (MODE === 'admin') {
  app.get('/',      (q,r) => serveHTML(r, `${PUB}/admin/login.html`));
  app.get('/login', (q,r) => serveHTML(r, `${PUB}/admin/login.html`));
} else if (MODE === 'client') {
  app.get('/',      (q,r) => serveHTML(r, `${PUB}/client/login.html`));
  app.get('/login', (q,r) => serveHTML(r, `${PUB}/client/login.html`));
} else {
  app.get('/',      (q,r) => serveHTML(r, `${PUB}/login.html`));
  app.get('/login', (q,r) => serveHTML(r, `${PUB}/login.html`));
}

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
app.use('/api/selloship',     require('./routes/selloship'));
app.use('/api/shopify',       require('./routes/shopify'));

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (q,r) => r.json({ ok: true, mode: MODE, api: API_URL, time: new Date() }));

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api'))
    return res.status(404).json({ success: false, message: `No route: ${req.originalUrl}` });
  if (MODE === 'admin')  return res.redirect('/admin/login');
  if (MODE === 'client') return res.redirect('/client/login');
  return res.redirect('/');
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('✅ MongoDB connected');
    await require('./config/autoSeed')();
  })
  .catch(e => {
    console.error('❌ MongoDB connection failed:', e.message);
    process.exit(1);
  });

// FIX #26: keep-alive pings the public API_URL (not localhost) so it works on Render
// Only starts if API_URL is set and not localhost
setTimeout(() => {
  if (!API_URL || API_URL.includes('localhost')) {
    console.log('[ping] Keep-alive disabled (no external API_URL set)');
    return;
  }
  const pingUrl = API_URL + '/health';
  setInterval(() => {
    try {
      const u = new URL(pingUrl);
      (u.protocol === 'https:' ? https : http)
        .get(u.href, r => console.log(`[ping] ${new Date().toISOString()} ${r.statusCode}`))
        .on('error', e => console.warn('[ping fail]', e.message));
    } catch (_) {}
  }, 7 * 60 * 1000);
  console.log('🔔 Keep-alive started →', pingUrl);
}, 15000);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 SHIPORAX  PORT=${PORT}  MODE=${MODE.toUpperCase()}`);
  console.log(`📡 API_URL="${API_URL || '(same origin)'}"\n`);
  console.log(`Admin:  /admin/login`);
  console.log(`Client: /client/login\n`);
});

module.exports = app;
