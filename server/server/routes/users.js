const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Order = require('../models/Order');
const { ActivityLog } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { toCSV } = require('../utils/csv');

// GET /api/users  – admin list all users
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const filter = { role: 'client' };
    if (req.query.isBlocked !== undefined) filter.isBlocked = req.query.isBlocked === 'true';
    if (req.query.isFlagged !== undefined) filter.isFlagged = req.query.isFlagged === 'true';
    if (req.query.kycStatus) filter['kyc.status'] = req.query.kycStatus;
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { email: { $regex: req.query.search, $options: 'i' } }
      ];
    }
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('-password -tempLoginToken')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    res.json({ success: true, total, page, limit, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/users/:id
router.get('/:id', protect, adminOnly, async (req, res) => {
  const user = await User.findById(req.params.id).select('-password -tempLoginToken');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

// PATCH /api/users/:id/block  – toggle block
router.patch('/:id/block', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    user.isBlocked = !user.isBlocked;
    await user.save();
    await logActivity(req.user._id, 'admin', `USER_${user.isBlocked ? 'BLOCK' : 'UNBLOCK'}`,
      'User', user._id, {}, req.ip);
    res.json({ success: true, isBlocked: user.isBlocked });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/users/:id/flag  – toggle flag
router.patch('/:id/flag', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    user.isFlagged = !user.isFlagged;
    await user.save();
    await logActivity(req.user._id, 'admin', `USER_${user.isFlagged ? 'FLAG' : 'UNFLAG'}`,
      'User', user._id, {}, req.ip);
    res.json({ success: true, isFlagged: user.isFlagged });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/users/:id/limits  – set fraud limits
router.patch('/:id/limits', protect, adminOnly, async (req, res) => {
  try {
    const { maxOrdersPerDay, codLimit } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    if (maxOrdersPerDay !== undefined) user.limits.maxOrdersPerDay = maxOrdersPerDay;
    if (codLimit !== undefined) user.limits.codLimit = codLimit;
    await user.save();
    await logActivity(req.user._id, 'admin', 'USER_LIMITS_UPDATE', 'User', user._id, { maxOrdersPerDay, codLimit }, req.ip);
    res.json({ success: true, limits: user.limits });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/users/export/csv  – admin
router.get('/export/csv', protect, adminOnly, async (req, res) => {
  try {
    const users = await User.find({ role: 'client' }).select('-password').lean();
    const fields = ['_id', 'name', 'email', 'phone', 'walletBalance', 'isBlocked', 'isFlagged', 'kyc.status', 'createdAt'];
    const csv = toCSV(users, fields);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/users/activity-logs  – admin
router.get('/logs/activity', protect, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.actor) filter.actor = req.query.actor;
    if (req.query.action) filter.action = req.query.action;
    const logs = await ActivityLog.find(filter)
      .populate('actor', 'name email role')
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/users/me/profile  – client updates own profile
router.get('/me/profile', protect, async (req, res) => {
  const user = await User.findById(req.user._id).select('-password -tempLoginToken');
  res.json({ success: true, user });
});

// PATCH /api/users/me/profile
router.patch('/me/profile', protect, async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'whatsappNotifications', 'whatsappNumber'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/users/me/integrations  – save shopify/woocommerce creds
router.patch('/me/integrations', protect, async (req, res) => {
  try {
    const { platform, config } = req.body; // platform: 'shopify' | 'woocommerce'
    if (!['shopify', 'woocommerce'].includes(platform)) return res.status(400).json({ success: false, message: 'Invalid platform' });
    const update = { [`integrations.${platform}`]: { ...config, connected: true } };
    const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, { new: true }).select('integrations');
    res.json({ success: true, integrations: user.integrations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/users/me/integrations/:platform  – disconnect
router.delete('/me/integrations/:platform', protect, async (req, res) => {
  try {
    const { platform } = req.params;
    if (!['shopify', 'woocommerce'].includes(platform)) return res.status(400).json({ success: false, message: 'Invalid platform' });
    const reset = platform === 'shopify'
      ? { 'integrations.shopify': { connected: false } }
      : { 'integrations.woocommerce': { connected: false } };
    await User.findByIdAndUpdate(req.user._id, { $set: reset });
    res.json({ success: true, message: `${platform} disconnected` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
