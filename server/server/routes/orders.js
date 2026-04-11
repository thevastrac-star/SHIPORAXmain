const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const User = require('../models/User');
const Order = require('../models/Order');
const { NDR, WalletTransaction, BulkUpload, CodReconciliation, ShippingRate, CourierPreference, Courier } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const { fetchPincodeData } = require('../utils/pincode');
const { toCSV } = require('../utils/csv');

const upload = multer({ dest: 'uploads/bulk/' });

// ─── PINCODE AUTO-FETCH ───────────────────────────────────────────────────────
router.get('/pincode/:pincode', protect, async (req, res) => {
  const data = await fetchPincodeData(req.params.pincode);
  res.json(data);
});

// ─── SHIPPING COST CALCULATOR ─────────────────────────────────────────────────
async function calcShippingCost(userId, courierId, weight, paymentMode, codAmount) {
  // Look for per-client rate first, fall back to global
  let rate = await ShippingRate.findOne({ courier: courierId, user: userId, isActive: true });
  if (!rate) rate = await ShippingRate.findOne({ courier: courierId, user: null, isActive: true });
  if (!rate) return { cost: null, codCharge: 0, total: 0, noRate: true };

  // Use zone D as default domestic rate
  const baseRate = rate.zones.d || rate.zones.a || 0;
  const w = parseFloat(weight) || 0.5;
  let cost = baseRate;
  if (w > rate.maxWeight) {
    const extra = w - rate.maxWeight;
    cost += Math.ceil(extra / 0.5) * (rate.additionalWeightRate || 0);
  }
  cost += rate.fuelSurcharge || 0;

  let codCharge = 0;
  if (paymentMode === 'cod' && codAmount > 0) {
    const cod = rate.cod;
    if (cod.mode === 'flat_always') {
      codCharge = cod.flat || 0;
    } else if (cod.mode === 'percent_always') {
      codCharge = Math.round((codAmount * (cod.percent || 0)) / 100);
    } else {
      // threshold mode: flat below threshold, percent above
      if (codAmount <= (cod.thresholdAmount || 1500)) {
        codCharge = cod.flat || 30;
      } else {
        codCharge = Math.round((codAmount * (cod.percent || 1.5)) / 100);
      }
    }
  }
  return { cost: Math.round(cost), codCharge: Math.round(codCharge), total: Math.round(cost + codCharge) };
}

// GET /api/orders/calc-cost  – client gets shipping cost estimate before placing
router.get('/calc-cost', protect, async (req, res) => {
  try {
    const { courierId, weight, paymentMode, codAmount } = req.query;
    if (!courierId) return res.status(400).json({ success: false, message: 'courierId required' });
    const result = await calcShippingCost(req.user._id, courierId, weight, paymentMode, codAmount);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
router.post('/', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { recipient, package: pkg, paymentMode, codAmount, pickupWarehouse, source, courierId } = req.body;

    // Phone format validation
    if (!recipient?.phone || !/^[6-9]\d{9}$/.test(recipient.phone)) {
      return res.status(400).json({ success: false, message: 'Invalid Indian phone number (must be 10 digits starting with 6-9)' });
    }
    // Pincode validation
    if (!recipient?.pincode || !/^\d{6}$/.test(recipient.pincode)) {
      return res.status(400).json({ success: false, message: 'Invalid pincode (must be 6 digits)' });
    }

    // Duplicate check: same phone + pincode in last 24h
    const dupeKey = `${recipient.phone}_${recipient.pincode}`;
    const recent = await Order.findOne({
      user: req.user._id, duplicateCheckKey: dupeKey,
      createdAt: { $gte: new Date(Date.now() - 86400000) }
    });
    if (recent) return res.status(400).json({ success: false, message: 'Duplicate order (same phone+pincode in last 24h)', existingOrderId: recent.orderId });

    // Daily limit check
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayCount = await Order.countDocuments({ user: req.user._id, createdAt: { $gte: todayStart } });
    if (todayCount >= user.limits.maxOrdersPerDay) {
      return res.status(429).json({ success: false, message: `Daily order limit (${user.limits.maxOrdersPerDay}) reached` });
    }

    // COD limit check
    const cod = parseFloat(codAmount) || 0;
    if (paymentMode === 'cod' && cod > user.limits.codLimit) {
      return res.status(400).json({ success: false, message: `COD amount exceeds your limit of ₹${user.limits.codLimit}` });
    }

    // Resolve courier (use client's 1st priority if not specified)
    let resolvedCourierId = courierId;
    if (!resolvedCourierId) {
      const pref = await CourierPreference.findOne({ user: req.user._id });
      if (pref?.priorities?.length) {
        const first = pref.priorities.sort((a, b) => a.priority - b.priority)[0];
        resolvedCourierId = first.courier;
      }
    }

    // Calculate shipping cost
    let shippingCharge = 0, codCharge = 0;
    if (resolvedCourierId) {
      const costResult = await calcShippingCost(req.user._id, resolvedCourierId, pkg?.weight || 0.5, paymentMode, cod);
      if (costResult.noRate) {
        return res.status(400).json({ success: false, message: 'No shipping rate configured for the selected courier. Please contact support.' });
      }
      shippingCharge = costResult.total;
      codCharge = costResult.codCharge;
    }

    const order = await Order.create({
      user: req.user._id,
      source: source || 'manual',
      pickupWarehouse,
      recipient,
      package: pkg,
      paymentMode: paymentMode || 'prepaid',
      codAmount: cod,
      assignedCourier: resolvedCourierId || undefined,
      shippingCharge,
      duplicateCheckKey: dupeKey,
      status: 'processing'
    });

    // Deduct shipping from wallet
    if (shippingCharge > 0) {
      if (user.walletBalance < shippingCharge) {
        await Order.findByIdAndDelete(order._id);
        return res.status(400).json({ success: false, message: `Insufficient wallet balance. Need ₹${shippingCharge}, have ₹${user.walletBalance.toFixed(2)}` });
      }
      user.walletBalance -= shippingCharge;
      await user.save();
      await WalletTransaction.create({
        user: req.user._id, type: 'debit', amount: shippingCharge,
        balance: user.walletBalance,
        description: `Shipping charge for ${order.orderId}`,
        reference: order.orderId
      });
      order.walletDeducted = true;
      await order.save();
    }

    // Generate mock AWB (in real integration this comes from courier API)
    order.awbNumber = `AWB${Date.now()}${Math.floor(Math.random() * 1000)}`;
    order.status = 'processing';
    await order.save();

    // COD reconciliation record
    if (paymentMode === 'cod') {
      const codRec = await CodReconciliation.create({
        order: order._id, user: req.user._id,
        awbNumber: order.awbNumber,
        expectedAmount: cod,
        status: 'pending'
      });
      order.codReconciliation = codRec._id;
      await order.save();
    }

    await createNotification(req.user._id, 'order_created', 'Order Created',
      `Order ${order.orderId} placed. AWB: ${order.awbNumber}. Charge: ₹${shippingCharge}`,
      order._id, user.whatsappNotifications);

    await logActivity(req.user._id, req.user.role, 'CREATE_ORDER', 'Order', order._id, { orderId: order.orderId }, req.ip);

    const populated = await Order.findById(order._id).populate('assignedCourier', 'name code');
    res.status(201).json({ success: true, order: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── LIST ORDERS ──────────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;

    if (req.query.status) {
      // Support comma-separated statuses e.g. "draft,processing"
      const statuses = req.query.status.split(',').map(s => s.trim()).filter(Boolean);
      filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (req.query.source) filter.source = req.query.source;
    if (req.query.paymentMode) filter.paymentMode = req.query.paymentMode;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) { const t = new Date(req.query.to); t.setHours(23,59,59,999); filter.createdAt.$lte = t; }
    }
    if (req.query.search) {
      filter.$or = [
        { orderId: new RegExp(req.query.search, 'i') },
        { awbNumber: new RegExp(req.query.search, 'i') },
        { 'recipient.name': new RegExp(req.query.search, 'i') },
        { 'recipient.phone': new RegExp(req.query.search, 'i') }
      ];
    }

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate('user', 'name email')
      .populate('assignedCourier', 'name code')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ success: true, total, page, limit, pages: Math.ceil(total / limit), orders });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/orders/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const order = await Order.findOne(filter)
      .populate('user', 'name email phone')
      .populate('assignedCourier')
      .populate('codReconciliation');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/orders/bulk-ship  – client ships multiple orders at once
router.post('/bulk-ship', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const results = [];
    for (const id of orderIds) {
      const order = await Order.findOne({ _id: id, user: req.user._id, status: { $in: ['draft','processing'] } });
      if (!order) { results.push({ id, success: false, message: 'Not found or already shipped' }); continue; }
      order.status = 'processing';
      order.awbNumber = order.awbNumber || `AWB${Date.now()}${Math.floor(Math.random() * 1000)}`;
      await order.save();
      results.push({ id, success: true, orderId: order.orderId, awb: order.awbNumber });
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/orders/bulk-delete  – client deletes draft orders
router.delete('/bulk-delete', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const result = await Order.deleteMany({ _id: { $in: orderIds }, user: req.user._id, status: { $in: ['draft', 'processing'] } });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/orders/:id/ship  – client ships a single order (action button)
router.patch('/:id/ship', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'draft' && order.status !== 'processing') {
      return res.status(400).json({ success: false, message: `Cannot ship order in status: ${order.status}` });
    }

    const user = await User.findById(req.user._id);

    // If courierId provided in body, assign and calculate cost
    const courierId = req.body.courierId || order.assignedCourier;
    let shippingCharge = order.shippingCharge || 0;

    if (courierId && !order.shippingCharge) {
      // Only calculate if not already charged at creation
      const costResult = await calcShippingCost(
        req.user._id, courierId,
        order.package?.weight || 0.5,
        order.paymentMode, order.codAmount || 0
      );
      if (costResult.noRate) {
        return res.status(400).json({ success: false, message: 'No shipping rate configured for this courier. Contact admin.' });
      }
      shippingCharge = costResult.total;
    }

    // Deduct wallet if charge > 0 and not already deducted
    if (shippingCharge > 0 && !order.walletDeducted) {
      if (user.walletBalance < shippingCharge) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. Need ₹${shippingCharge}, have ₹${user.walletBalance.toFixed(2)}`
        });
      }
      user.walletBalance -= shippingCharge;
      await user.save();
      await WalletTransaction.create({
        user: req.user._id, type: 'debit', amount: shippingCharge,
        balance: user.walletBalance,
        description: `Shipping charge for ${order.orderId}`,
        reference: order.orderId
      });
      order.shippingCharge = shippingCharge;
      order.walletDeducted = true;
    }

    // Assign courier if provided
    if (courierId) order.assignedCourier = courierId;

    order.status = 'shipped';
    if (!order.awbNumber) {
      let prefix = 'AWB';
      if (order.assignedCourier) {
        try {
          const courierDoc = await Courier.findById(order.assignedCourier);
          if (courierDoc?.code) prefix = courierDoc.code.toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,6);
        } catch(_) {}
      }
      order.awbNumber = `${prefix}${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;
    }
    await order.save();

    await createNotification(req.user._id, 'shipped', 'Order Shipped',
      `Order ${order.orderId} shipped with AWB: ${order.awbNumber}. Charged ₹${shippingCharge}`, order._id, user.whatsappNotifications);

    const populated = await Order.findById(order._id).populate('assignedCourier', 'name code');
    res.json({ success: true, order: populated, shippingCharge });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/orders/:id/cancel-shipment  – client cancels a shipped order → refund to wallet + reset to processing
router.post('/:id/cancel-shipment', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Only allow cancel if order is shipped / in_transit (not delivered/rto)
    const cancellableStatuses = ['shipped', 'processing'];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel order with status: ${order.status}. Only shipped or processing orders can be cancelled.` });
    }

    const refundAmount = order.shippingCharge || 0;

    // Refund shipping charge to wallet if it was deducted
    if (refundAmount > 0 && order.walletDeducted) {
      await User.findByIdAndUpdate(req.user._id, { $inc: { walletBalance: refundAmount } });
      // Log wallet transaction
      const { WalletTransaction } = require('../models/index');
      const user = await User.findById(req.user._id);
      await WalletTransaction.create({
        user: req.user._id,
        type: 'credit',
        amount: refundAmount,
        balanceAfter: (user.walletBalance),
        description: `Refund for cancelled shipment: ${order.orderId} (AWB: ${order.awbNumber || 'N/A'})`,
        reference: order._id
      });
    }

    // Reset order: remove AWB, reset status to processing so it appears back in My Orders
    order.status = 'processing';
    order.awbNumber = null;
    order.walletDeducted = false;
    order.cancelledAt = new Date();
    order.cancellationReason = req.body.reason || 'Cancelled by client';
    await order.save();

    await logActivity(req.user._id, 'client', 'CANCEL_SHIPMENT', 'Order', order._id,
      { refundAmount, reason: order.cancellationReason }, req.ip);

    res.json({
      success: true,
      message: `Shipment cancelled. ₹${refundAmount} refunded to your wallet.`,
      refundAmount,
      order
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/orders/:id/status  – admin updates status
router.patch('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status, awbNumber, ndrReason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.status = status;
    if (awbNumber) order.awbNumber = awbNumber;
    if (status === 'ndr' && !order.ndr.isNDR) {
      order.ndr.isNDR = true;
      await NDR.create({ order: order._id, user: order.user, awbNumber: order.awbNumber, reason: ndrReason });
    }
    await order.save();
    await logActivity(req.user._id, 'admin', 'UPDATE_ORDER_STATUS', 'Order', order._id, { status }, req.ip);
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/orders/:id/convert-shipment  – convert integration order to shipment
router.patch('/:id/convert-shipment', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.status = 'processing';
    if (!order.awbNumber) order.awbNumber = `AWB${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await order.save();
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── BULK UPLOAD ──────────────────────────────────────────────────────────────
router.post('/bulk-upload', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ success: false, message: 'File is empty or has no data rows' });

    const headers = lines[0].split(',').map(h => h.replace(/["\r]/g, '').trim().toLowerCase());
    const rows = lines.slice(1);

    const bulkRecord = await BulkUpload.create({
      user: req.user._id, fileName: req.file.originalname,
      totalRows: rows.length, status: 'processing'
    });

    let success = 0, failed = 0;
    const errors = [];
    const createdOrders = [];

    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].trim()) continue;
      const cols = rows[i].split(',').map(c => c.replace(/["\r]/g, '').trim());
      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
      try {
        const phone = row['recipient_phone'] || row['phone'] || '';
        const pincode = row['pincode'] || row['recipient_pincode'] || '';
        if (!row['recipient_name'] && !row['name']) throw new Error('Missing recipient name');
        if (!phone) throw new Error('Missing phone');
        if (!pincode) throw new Error('Missing pincode');
        if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('Invalid phone format');
        if (!/^\d{6}$/.test(pincode)) throw new Error('Invalid pincode format');

        const order = await Order.create({
          user: req.user._id,
          source: 'bulk_upload',
          status: 'draft',
          recipient: {
            name: row['recipient_name'] || row['name'],
            phone,
            email: row['email'] || '',
            address: row['address'] || row['recipient_address'] || '',
            city: row['city'] || '',
            state: row['state'] || '',
            pincode,
            landmark: row['landmark'] || ''
          },
          package: {
            weight: parseFloat(row['weight']) || 0.5,
            description: row['description'] || '',
            value: parseFloat(row['value']) || 0
          },
          paymentMode: (row['payment_mode'] || row['payment'] || '').toLowerCase() === 'cod' ? 'cod' : 'prepaid',
          codAmount: parseFloat(row['cod_amount'] || row['cod']) || 0,
          duplicateCheckKey: `${phone}_${pincode}`
        });
        createdOrders.push(order._id);
        success++;
      } catch (e) {
        failed++;
        errors.push({ row: i + 2, error: e.message });
      }
    }

    bulkRecord.successRows = success;
    bulkRecord.failedRows = failed;
    bulkRecord.errors = errors;
    bulkRecord.status = 'completed';
    await bulkRecord.save();
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    res.json({ success: true, totalRows: rows.length, successRows: success, failedRows: failed, errors, bulkRecord });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
router.get('/export/csv', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from) filter.createdAt = { $gte: new Date(req.query.from) };
    if (req.query.to) filter.createdAt = { ...(filter.createdAt || {}), $lte: new Date(req.query.to) };

    const orders = await Order.find(filter).lean();
    const fields = ['orderId', 'status', 'paymentMode', 'codAmount', 'shippingCharge', 'awbNumber',
      'recipient.name', 'recipient.phone', 'recipient.pincode', 'recipient.city', 'recipient.state',
      'package.weight', 'createdAt'];
    const csvData = toCSV(orders, fields);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    res.send(csvData);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
