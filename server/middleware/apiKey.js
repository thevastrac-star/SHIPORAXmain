// middleware/apiKey.js — API Key Authentication
// External clients send:  X-API-Key: <key>
// Key is stored on User.apiKey (hashed). We do a fast lookup.

const User = require('../models/User');

async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ success: false, message: 'Missing X-API-Key header' });

  // API keys are stored as plain SHA-256 hash for fast lookup (bcrypt is too slow for every request)
  const crypto = require('crypto');
  const hashed = crypto.createHash('sha256').update(key).digest('hex');

  const user = await User.findOne({ apiKey: hashed, isActive: true, isBlocked: false });
  if (!user) return res.status(401).json({ success: false, message: 'Invalid or revoked API key' });

  req.user = user;
  next();
}

module.exports = { apiKeyAuth };
