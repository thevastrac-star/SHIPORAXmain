const express = require('express');
const router = express.Router();
const { CodReconciliation } = require('../models/index');
const Order = require('../models/Order');
const { protect, adminOnly, logActivity } = require('../middleware/auth');

// GET /api/cod  – list
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;
    if (req.query.status) filter.status = req.query.status;

    const records = await CodReconciliation.find(filter)
      .populate('order', 'orderId awbNumber status')
      .populate('user', 'name email')
      .sort({ createdAt: -1 });

    const totalExpected = records.reduce((s, r) => s + (r.expectedAmount || 0), 0);
    const totalReceived = records.reduce((s, r) => s + (r.receivedAmount || 0), 0);
    const pending = records.filter(r => r.status === 'pending').length;

    res.json({ success: true, records, summary: { totalExpected, totalReceived, pending, balance: totalExpected - totalReceived } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cod  – create COD reconciliation record (auto on order delivered)
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const { orderId, expectedAmount } = req.body;
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.paymentMode !== 'cod') return res.status(400).json({ success: false, message: 'Not a COD order' });

    const existing = await CodReconciliation.findOne({ order: order._id });
    if (existing) return res.status(400).json({ success: false, message: 'Record already exists' });

    const record = await CodReconciliation.create({
      order: order._id,
      user: order.user,
      awbNumber: order.awbNumber,
      expectedAmount: expectedAmount || order.codAmount
    });

    await Order.findByIdAndUpdate(order._id, { codReconciliation: record._id });
    res.status(201).json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cod/:id  – admin update reconciliation
router.patch('/:id', protect, adminOnly, async (req, res) => {
  try {
    const { receivedAmount, status, remarks } = req.body;
    const record = await CodReconciliation.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    // Log history
    record.history.push({
      action: `Updated: received=₹${receivedAmount}, status=${status}`,
      amount: receivedAmount,
      performedBy: req.user._id
    });

    if (receivedAmount !== undefined) record.receivedAmount = receivedAmount;
    if (status) record.status = status;
    if (remarks) record.remarks = remarks;
    if (status === 'settled') record.settlementDate = new Date();
    record.updatedAt = new Date();
    await record.save();

    await logActivity(req.user._id, 'admin', 'COD_UPDATE', 'CodReconciliation', record._id,
      { receivedAmount, status }, req.ip);

    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
