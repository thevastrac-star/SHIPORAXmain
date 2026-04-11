const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { WalletTransaction, WalletRecharge } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { toCSV } = require('../utils/csv');
const { createNotification } = require('../utils/notifications');

// GET /api/wallet/balance  – client
router.get('/balance', protect, async (req, res) => {
  const user = await User.findById(req.user._id).select('walletBalance');
  res.json({ success: true, balance: user.walletBalance });
});

// GET /api/wallet/transactions  – client (own) or admin with ?userId
router.get('/transactions', protect, async (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.query.userId ? req.query.userId : req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const total = await WalletTransaction.countDocuments({ user: userId });
    const txns = await WalletTransaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('performedBy', 'name email');
    res.json({ success: true, total, page, limit, transactions: txns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/wallet/recharge  – client initiates (UI only, no gateway)
router.post('/recharge', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
    const recharge = await WalletRecharge.create({ user: req.user._id, amount, status: 'pending' });
    // In real flow: redirect to payment gateway. Here we just record it.
    res.json({ success: true, message: 'Recharge request created. Awaiting payment.', recharge });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/wallet/recharges  – client
router.get('/recharges', protect, async (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.query.userId ? req.query.userId : req.user._id;
    const recharges = await WalletRecharge.find({ user: userId }).sort({ createdAt: -1 });
    res.json({ success: true, recharges });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

// GET /api/wallet/admin/user/:userId  – admin views user wallet
router.get('/admin/user/:userId', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('name email walletBalance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const txns = await WalletTransaction.find({ user: req.params.userId }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, user, transactions: txns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/wallet/admin/adjust  – admin credit/debit
router.post('/admin/adjust', protect, adminOnly, async (req, res) => {
  try {
    const { userId, type, amount, description } = req.body;
    if (!['credit', 'debit'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid type' });
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (type === 'debit' && user.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    user.walletBalance += type === 'credit' ? amount : -amount;
    await user.save();

    const txn = await WalletTransaction.create({
      user: userId, type, amount,
      balance: user.walletBalance,
      description: description || `Admin ${type}`,
      performedBy: req.user._id
    });

    await logActivity(req.user._id, 'admin', `WALLET_${type.toUpperCase()}`, 'User', userId,
      { amount, description }, req.ip);

    await createNotification(userId,
      type === 'credit' ? 'wallet_credit' : 'wallet_debit',
      `Wallet ${type}`, `₹${amount} ${type}ed. New balance: ₹${user.walletBalance}`, txn._id,
      user.whatsappNotifications
    );

    res.json({ success: true, balance: user.walletBalance, transaction: txn });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/wallet/admin/recharges  – full list with filters
router.get('/admin/recharges', protect, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.userId) filter.user = req.query.userId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from) filter.createdAt = { $gte: new Date(req.query.from) };
    if (req.query.to) filter.createdAt = { ...(filter.createdAt || {}), $lte: new Date(req.query.to) };

    const total = await WalletRecharge.countDocuments(filter);
    const recharges = await WalletRecharge.find(filter)
      .populate('user', 'name email')
      .sort({ createdAt: -1 });
    const totalAmount = recharges.reduce((s, r) => s + r.amount, 0);
    res.json({ success: true, total, totalAmount, recharges });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/wallet/export/transactions  – CSV download
router.get('/export/transactions', protect, async (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.query.userId ? req.query.userId : req.user._id;
    const txns = await WalletTransaction.find({ user: userId }).sort({ createdAt: -1 }).lean();
    const fields = ['_id', 'type', 'amount', 'balance', 'description', 'reference', 'createdAt'];
    const csv = toCSV(txns, fields);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=wallet_transactions.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
