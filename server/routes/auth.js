const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const User     = require('../models/User');
const { protect, adminOnly, logActivity } = require('../middleware/auth');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// POST /api/auth/register
// FIX #7: role field from request body is IGNORED — all self-registrations are 'client'
//         Only an existing admin can promote via /api/users/:id or direct DB
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, companyName } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'name, email and password required' });

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(400).json({ success: false, message: 'Email already registered' });

    // role is always 'client' for public registration
    const user  = await User.create({ name, email, password, phone, companyName, role: 'client' });
    const token = signToken(user._id);
    res.status(201).json({
      success: true, token,
      user: { id: user._id, name, email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: 'email and password required' });

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (user.isBlocked)
      return res.status(403).json({ success: false, message: 'Account is blocked' });

    const token = signToken(user._id);
    await logActivity(user._id, user.role, 'LOGIN', 'User', user._id, {}, req.ip);
    res.json({
      success: true, token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, walletBalance: user.walletBalance }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/impersonate/:userId  [Admin only]
router.post('/impersonate/:userId', protect, adminOnly, async (req, res) => {
  try {
    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    const tempToken = crypto.randomBytes(32).toString('hex');
    target.tempLoginToken  = tempToken;
    target.tempLoginExpiry = new Date(Date.now() + 3600000);
    await target.save();

    const token = signToken(target._id);
    await logActivity(req.user._id, 'admin', 'IMPERSONATE', 'User', target._id,
      { targetEmail: target.email }, req.ip);

    res.json({
      success: true, token, tempToken,
      user: { id: target._id, name: target.name, email: target.email, role: target.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
