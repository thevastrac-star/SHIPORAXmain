const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const User = require('../models/User');
const { WalletRecharge, WalletTransaction, CodReconciliation, SupportTicket, NDR } = require('../models/index');
const { protect, adminOnly } = require('../middleware/auth');

// GET /api/analytics/admin/dashboard
router.get('/admin/dashboard', protect, adminOnly, async (req, res) => {
  try {
    const [
      totalOrders,
      rtoCount,
      deliveredCount,
      processingCount,
      ndrCount,
      totalUsers,
      blockedUsers,
      flaggedUsers,
      openTickets,
      pendingKYC
    ] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: 'rto' }),
      Order.countDocuments({ status: 'delivered' }),
      Order.countDocuments({ status: { $in: ['processing', 'shipped', 'in_transit'] } }),
      Order.countDocuments({ status: 'ndr' }),
      User.countDocuments({ role: 'client' }),
      User.countDocuments({ isBlocked: true }),
      User.countDocuments({ isFlagged: true }),
      SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
      User.countDocuments({ 'kyc.status': 'pending' })
    ]);

    // COD pending amount
    const codAgg = await CodReconciliation.aggregate([
      { $match: { status: { $in: ['pending', 'partial'] } } },
      { $group: { _id: null, total: { $sum: '$expectedAmount' }, received: { $sum: '$receivedAmount' } } }
    ]);
    const codPending = codAgg[0] ? codAgg[0].total - codAgg[0].received : 0;

    // Total wallet recharges
    const rechargeAgg = await WalletRecharge.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const totalRecharge = rechargeAgg[0] ? rechargeAgg[0].total : 0;
    const rechargeCount = rechargeAgg[0] ? rechargeAgg[0].count : 0;

    // Recent recharges (last 5)
    const recentRecharges = await WalletRecharge.find({ status: 'completed' })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(5);

    // Orders per day (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const ordersByDay = await Order.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      stats: {
        totalOrders, rtoCount, deliveredCount, processingCount, ndrCount,
        totalUsers, blockedUsers, flaggedUsers,
        openTickets, pendingKYC,
        codPending,
        totalRecharge, rechargeCount
      },
      recentRecharges,
      ordersByDay
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/analytics/client/dashboard
router.get('/client/dashboard', protect, async (req, res) => {
  try {
    const uid = req.user._id;
    const [
      totalOrders,
      deliveredCount,
      rtoCount,
      ndrCount,
      pendingCOD
    ] = await Promise.all([
      Order.countDocuments({ user: uid }),
      Order.countDocuments({ user: uid, status: 'delivered' }),
      Order.countDocuments({ user: uid, status: 'rto' }),
      Order.countDocuments({ user: uid, status: 'ndr' }),
      CodReconciliation.aggregate([
        { $match: { user: uid, status: { $in: ['pending', 'partial'] } } },
        { $group: { _id: null, total: { $sum: '$expectedAmount' } } }
      ])
    ]);

    const user = await User.findById(uid).select('walletBalance kyc.status');

    res.json({
      success: true,
      stats: {
        totalOrders, deliveredCount, rtoCount, ndrCount,
        pendingCOD: pendingCOD[0]?.total || 0,
        walletBalance: user.walletBalance,
        kycStatus: user.kyc.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
