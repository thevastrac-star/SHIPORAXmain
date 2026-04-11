const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { NDR } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');

// GET /api/ndr  – list NDR orders
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;

    if (req.query.status) filter.status = req.query.status;

    const ndrs = await NDR.find(filter)
      .populate('order', 'orderId awbNumber status recipient')
      .populate('user', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, ndrs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ndr/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const ndr = await NDR.findById(req.params.id)
      .populate('order')
      .populate('user', 'name email');
    if (!ndr) return res.status(404).json({ success: false, message: 'NDR not found' });
    if (req.user.role !== 'admin' && String(ndr.user._id) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    res.json({ success: true, ndr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/ndr/:id/reattempt  – client requests reattempt
router.post('/:id/reattempt', protect, async (req, res) => {
  try {
    const ndr = await NDR.findOne({ _id: req.params.id, user: req.user._id });
    if (!ndr) return res.status(404).json({ success: false, message: 'NDR not found' });

    ndr.status = 'reattempt_requested';
    ndr.clientNote = req.body.note || '';
    ndr.updatedAt = new Date();
    await ndr.save();

    // Also update order
    await Order.findByIdAndUpdate(ndr.order, {
      'ndr.reattemptRequested': true,
      'ndr.reattemptNote': req.body.note || '',
      'ndr.adminStatus': 'reattempt_scheduled'
    });

    res.json({ success: true, message: 'Reattempt requested successfully', ndr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/ndr/:id  – admin update NDR status
router.patch('/:id', protect, adminOnly, async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const validStatuses = ['pending', 'reattempt_requested', 'reattempt_scheduled', 'rto_initiated', 'resolved'];
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

    const ndr = await NDR.findById(req.params.id);
    if (!ndr) return res.status(404).json({ success: false, message: 'NDR not found' });

    ndr.status = status;
    if (adminNote) ndr.adminNote = adminNote;
    ndr.updatedAt = new Date();
    await ndr.save();

    // Sync to order
    await Order.findByIdAndUpdate(ndr.order, { 'ndr.adminStatus': status });

    if (status === 'rto_initiated') {
      await Order.findByIdAndUpdate(ndr.order, { status: 'rto' });
    }

    await logActivity(req.user._id, 'admin', 'NDR_UPDATE', 'NDR', ndr._id,
      { status, adminNote }, req.ip);

    res.json({ success: true, ndr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
