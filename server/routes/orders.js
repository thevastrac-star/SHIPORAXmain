const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const fs       = require('fs');
const User     = require('../models/User');
const Order    = require('../models/Order');
const {
  NDR, WalletTransaction, BulkUpload, CodReconciliation,
  ShippingRate, CourierPreference, Courier, Warehouse,
  CourierSelloshipMapping
} = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { createNotification }  = require('../utils/notifications');
const { fetchPincodeData }     = require('../utils/pincode');
const { toCSV }                = require('../utils/csv');
const {
  getSelloToken,
  orderToPayloadParams,
  createWaybill
} = require('../utils/selloship');

const upload = multer({ dest: 'uploads/bulk/' });

// ─── SHIPPING COST ────────────────────────────────────────────────────────────
async function calcShippingCost(userId, courierId, weight, paymentMode, codAmount) {
  let rate = await ShippingRate.findOne({ courier: courierId, user: userId, isActive: true });
  if (!rate) rate = await ShippingRate.findOne({ courier: courierId, user: null, isActive: true });
  if (!rate) return { cost: null, codCharge: 0, total: 0, noRate: true };

  const baseRate = rate.zones.d || rate.zones.a || 0;
  const w = parseFloat(weight) || 0.5;
  let cost = baseRate;
  if (w > rate.maxWeight)
    cost += Math.ceil((w - rate.maxWeight) / 0.5) * (rate.additionalWeightRate || 0);
  cost += rate.fuelSurcharge || 0;

  let codCharge = 0;
  if (paymentMode === 'cod' && codAmount > 0) {
    const cod = rate.cod;
    if (cod.mode === 'flat_always')         codCharge = cod.flat || 0;
    else if (cod.mode === 'percent_always') codCharge = Math.round((codAmount * (cod.percent || 0)) / 100);
    else codCharge = codAmount <= (cod.thresholdAmount || 1500)
      ? (cod.flat || 30)
      : Math.round((codAmount * (cod.percent || 1.5)) / 100);
  }
  return { cost: Math.round(cost), codCharge: Math.round(codCharge), total: Math.round(cost + codCharge) };
}

// GET /api/orders/calc-cost
router.get('/calc-cost', protect, async (req, res) => {
  try {
    const { courierId, weight, paymentMode, codAmount } = req.query;
    if (!courierId) return res.status(400).json({ success: false, message: 'courierId required' });
    const result = await calcShippingCost(req.user._id, courierId, weight, paymentMode, codAmount);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── SELLOSHIP HELPER ─────────────────────────────────────────────────────────
// Resolves admin's courier→selloship mapping, calls Selloship, returns AWB data.
async function shipViaSelloship(order, courierId) {
  // Resolve warehouse
  let warehouse = order.pickupWarehouse
    ? await Warehouse.findById(order.pickupWarehouse) : null;
  if (!warehouse) warehouse = await Warehouse.findOne({ user: order.user, isDefault: true });
  if (!warehouse) throw new Error('No pickup warehouse found. Add a warehouse first.');

  const token  = await getSelloToken();
  const params = orderToPayloadParams(order, warehouse);

  // Lookup admin courier→selloship mapping
  if (courierId) {
    const mapping = await CourierSelloshipMapping.findOne({ courier: courierId, isActive: true });
    if (mapping && !mapping.isAutoRoute) {
      // Admin has mapped this courier to a specific Selloship courier
      if (mapping.selloshipCourierId)   params.courierId   = mapping.selloshipCourierId;
      if (mapping.selloshipCourierName) params.courierName = mapping.selloshipCourierName;
    }
    // if isAutoRoute or no mapping → no courierId/Name in payload → Selloship auto-selects
  }

  const result = await createWaybill(token, params);
  return {
    awbNumber:   result.waybill,
    labelUrl:    result.shippingLabel,
    courierName: result.courierName,
    routingCode: result.routingCode
  };
}

// ─── STATIC ROUTES (before /:id) ─────────────────────────────────────────────

// GET /api/orders/pincode/:pincode
router.get('/pincode/:pincode', protect, async (req, res) => {
  const data = await fetchPincodeData(req.params.pincode);
  res.json(data);
});

// GET /api/orders/export/csv
router.get('/export/csv', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from) filter.createdAt = { $gte: new Date(req.query.from) };
    if (req.query.to)   filter.createdAt = { ...(filter.createdAt || {}), $lte: new Date(req.query.to) };
    const orders = await Order.find(filter).lean();
    const fields = ['orderId','status','paymentMode','codAmount','shippingCharge','awbNumber',
      'recipient.name','recipient.phone','recipient.pincode','recipient.city','recipient.state',
      'package.weight','createdAt'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    res.send(toCSV(orders, fields));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/orders/bulk-ship
router.post('/bulk-ship', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds?.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const results = [];
    for (const id of orderIds) {
      const order = await Order.findOne({ _id: id, user: req.user._id, status: { $in: ['draft','processing'] } });
      if (!order) { results.push({ id, success: false, message: 'Not found or already shipped' }); continue; }
      try {
        const courierId = order.assignedCourier ? order.assignedCourier.toString() : null;
        const shipped   = await shipViaSelloship(order, courierId);
        order.awbNumber = shipped.awbNumber;
        order.status    = 'shipped';
        order.selloship = { waybill: shipped.awbNumber, courierName: shipped.courierName,
          routingCode: shipped.routingCode, labelUrl: shipped.labelUrl, shippedAt: new Date() };
        await order.save();
        results.push({ id, success: true, orderId: order.orderId, awb: shipped.awbNumber, labelUrl: shipped.labelUrl });
      } catch (e) {
        results.push({ id, success: false, message: e.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/orders/bulk-delete
router.delete('/bulk-delete', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds?.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const result = await Order.deleteMany({
      _id: { $in: orderIds }, user: req.user._id, status: { $in: ['draft','processing'] }
    });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
router.post('/', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { recipient, package: pkg, paymentMode, codAmount, pickupWarehouse, source, courierId } = req.body;

    if (!recipient?.phone || !/^[6-9]\d{9}$/.test(recipient.phone))
      return res.status(400).json({ success: false, message: 'Invalid phone (10 digits, start 6-9)' });
    if (!recipient?.pincode || !/^\d{6}$/.test(recipient.pincode))
      return res.status(400).json({ success: false, message: 'Invalid pincode (6 digits)' });

    const dupeKey = `${recipient.phone}_${recipient.pincode}`;
    const recent  = await Order.findOne({ user: req.user._id, duplicateCheckKey: dupeKey,
      createdAt: { $gte: new Date(Date.now() - 86400000) } });
    if (recent) return res.status(400).json({ success: false, message: 'Duplicate order (same phone+pincode in last 24h)', existingOrderId: recent.orderId });

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayCount = await Order.countDocuments({ user: req.user._id, createdAt: { $gte: todayStart } });
    if (todayCount >= user.limits.maxOrdersPerDay)
      return res.status(429).json({ success: false, message: `Daily limit (${user.limits.maxOrdersPerDay}) reached` });

    const cod = parseFloat(codAmount) || 0;
    if (paymentMode === 'cod' && cod > user.limits.codLimit)
      return res.status(400).json({ success: false, message: `COD exceeds limit ₹${user.limits.codLimit}` });

    let resolvedCourierId = courierId;
    if (!resolvedCourierId) {
      const pref = await CourierPreference.findOne({ user: req.user._id });
      if (pref?.priorities?.length)
        resolvedCourierId = pref.priorities.sort((a,b) => a.priority - b.priority)[0].courier;
    }

    let shippingCharge = 0;
    if (resolvedCourierId) {
      const costResult = await calcShippingCost(req.user._id, resolvedCourierId, pkg?.weight || 0.5, paymentMode, cod);
      if (costResult.noRate) return res.status(400).json({ success: false, message: 'No shipping rate for this courier.' });
      shippingCharge = costResult.total;
    }

    const order = await Order.create({
      user: req.user._id, source: source || 'manual', pickupWarehouse,
      recipient, package: pkg, paymentMode: paymentMode || 'prepaid',
      codAmount: cod, assignedCourier: resolvedCourierId || undefined,
      shippingCharge, duplicateCheckKey: dupeKey, status: 'processing'
    });

    if (shippingCharge > 0) {
      if (user.walletBalance < shippingCharge) {
        await Order.findByIdAndDelete(order._id);
        return res.status(400).json({ success: false, message: `Insufficient balance. Need ₹${shippingCharge}, have ₹${user.walletBalance.toFixed(2)}` });
      }
      user.walletBalance -= shippingCharge;
      await user.save();
      await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: shippingCharge,
        balance: user.walletBalance, description: `Shipping for ${order.orderId}`, reference: order.orderId });
      order.walletDeducted = true;
      await order.save();
    }

    if (paymentMode === 'cod') {
      const codRec = await CodReconciliation.create({ order: order._id, user: req.user._id,
        awbNumber: '', expectedAmount: cod, status: 'pending' });
      order.codReconciliation = codRec._id;
      await order.save();
    }

    await logActivity(req.user._id, req.user.role, 'CREATE_ORDER', 'Order', order._id, { orderId: order.orderId }, req.ip);
    const populated = await Order.findById(order._id).populate('assignedCourier', 'name code');
    res.status(201).json({ success: true, order: populated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── LIST ORDERS ──────────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;
    if (req.query.status) {
      const statuses = req.query.status.split(',').map(s => s.trim()).filter(Boolean);
      filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (req.query.source)      filter.source      = req.query.source;
    if (req.query.paymentMode) filter.paymentMode = req.query.paymentMode;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   { const t = new Date(req.query.to); t.setHours(23,59,59,999); filter.createdAt.$lte = t; }
    }
    if (req.query.search) filter.$or = [
      { orderId:           new RegExp(req.query.search, 'i') },
      { awbNumber:         new RegExp(req.query.search, 'i') },
      { 'recipient.name':  new RegExp(req.query.search, 'i') },
      { 'recipient.phone': new RegExp(req.query.search, 'i') }
    ];

    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate('user', 'name email')
      .populate('assignedCourier', 'name code')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit);
    res.json({ success: true, total, page, limit, pages: Math.ceil(total / limit), orders });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── SHIP ORDER (client presses "Ship") ──────────────────────────────────────
// PATCH /api/orders/:id/ship
// 1. Client selects courier → saved as assignedCourier
// 2. Admin has mapped that courier to a Selloship courierId/name in CourierSelloshipMapping
// 3. We lookup the mapping → call Selloship with right courier override (or auto if no mapping)
// 4. Save AWB + label URL back on order
router.patch('/:id/ship', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['draft','processing'].includes(order.status))
      return res.status(400).json({ success: false, message: `Cannot ship order in status: ${order.status}` });

    // GUARD: never overwrite a real AWB already on the order
    if (order.awbNumber && order.awbNumber.trim())
      return res.status(400).json({ success: false, message: `Order already has AWB: ${order.awbNumber}. Cancel shipment first.` });

    const user = await User.findById(req.user._id);
    const courierId = req.body.courierId || (order.assignedCourier ? order.assignedCourier.toString() : null);

    // Deduct shipping charge if not done yet
    let shippingCharge = order.shippingCharge || 0;
    if (courierId && !order.walletDeducted) {
      const costResult = await calcShippingCost(
        req.user._id, courierId, order.package?.weight || 0.5, order.paymentMode, order.codAmount || 0
      );
      if (costResult.noRate)
        return res.status(400).json({ success: false, message: 'No shipping rate for this courier. Contact admin.' });
      shippingCharge = costResult.total;

      if (shippingCharge > 0) {
        if (user.walletBalance < shippingCharge)
          return res.status(400).json({ success: false, message: `Insufficient balance. Need ₹${shippingCharge}, have ₹${user.walletBalance.toFixed(2)}` });
        user.walletBalance -= shippingCharge;
        await user.save();
        await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: shippingCharge,
          balance: user.walletBalance, description: `Shipping for ${order.orderId}`, reference: order.orderId });
        order.shippingCharge = shippingCharge;
        order.walletDeducted = true;
      }
    }

    if (courierId) order.assignedCourier = courierId;

    // Call Selloship (with auto-rollback on failure)
    let shipped;
    try {
      shipped = await shipViaSelloship(order, courierId);
    } catch (selloErr) {
      // Rollback wallet deduction from this call
      if (shippingCharge > 0 && order.walletDeducted) {
        await User.findByIdAndUpdate(req.user._id, { $inc: { walletBalance: shippingCharge } });
        await WalletTransaction.create({ user: req.user._id, type: 'credit', amount: shippingCharge,
          balance: user.walletBalance + shippingCharge, description: `Refund - ship error ${order.orderId}` });
        order.walletDeducted = false;
        order.shippingCharge = 0;
        await order.save();
      }
      return res.status(502).json({ success: false, message: `Selloship error: ${selloErr.message}` });
    }

    order.awbNumber = shipped.awbNumber;
    order.status    = 'shipped';
    order.selloship = {
      waybill: shipped.awbNumber, courierName: shipped.courierName,
      routingCode: shipped.routingCode, labelUrl: shipped.labelUrl, shippedAt: new Date()
    };
    await order.save();

    if (order.codReconciliation)
      await CodReconciliation.findByIdAndUpdate(order.codReconciliation, { awbNumber: shipped.awbNumber });

    await createNotification(req.user._id, 'shipped', 'Order Shipped',
      `Order ${order.orderId} shipped. AWB: ${shipped.awbNumber}`, order._id, user.whatsappNotifications);
    await logActivity(req.user._id, 'client', 'SHIP_ORDER', 'Order', order._id, { awb: shipped.awbNumber }, req.ip);

    const populated = await Order.findById(order._id).populate('assignedCourier', 'name code');
    res.json({ success: true, order: populated, awbNumber: shipped.awbNumber,
      labelUrl: shipped.labelUrl, shippingCharge });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/orders/:id/cancel-shipment
router.post('/:id/cancel-shipment', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['shipped','processing'].includes(order.status))
      return res.status(400).json({ success: false, message: `Cannot cancel: ${order.status}` });

    const refundAmount = order.shippingCharge || 0;
    if (refundAmount > 0 && order.walletDeducted) {
      const updatedUser = await User.findByIdAndUpdate(
        req.user._id, { $inc: { walletBalance: refundAmount } }, { new: true }
      );
      await WalletTransaction.create({ user: req.user._id, type: 'credit', amount: refundAmount,
        balance: updatedUser.walletBalance, description: `Refund: cancelled ${order.orderId}`, reference: order._id });
    }

    order.status = 'processing'; order.awbNumber = null;
    order.walletDeducted = false; order.selloship = undefined;
    order.cancelledAt = new Date(); order.cancellationReason = req.body.reason || 'Cancelled by client';
    await order.save();

    await logActivity(req.user._id, 'client', 'CANCEL_SHIPMENT', 'Order', order._id,
      { refundAmount }, req.ip);
    res.json({ success: true, message: `Cancelled. ₹${refundAmount} refunded.`, refundAmount, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/orders/:id/status  — admin
router.patch('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status, awbNumber, ndrReason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.status = status;
    if (awbNumber) {
      const trimmed = awbNumber.trim();
      // Reject placeholder/sample AWB patterns — real AWBs must come from Selloship API only
      const samplePatterns = /^(XSE\d+|SAMPLE|TEST|DEMO|FAKE|DUMMY|AWB\d{5,}|1234|0000)/i;
      if (samplePatterns.test(trimmed))
        return res.status(400).json({ success: false, message: 'Sample/test AWB numbers cannot be assigned. AWBs are assigned by Selloship API only.' });
      order.awbNumber = trimmed;
    }
    if (status === 'ndr' && !order.ndr?.isNDR) {
      order.ndr = { ...order.ndr, isNDR: true };
      await NDR.create({ order: order._id, user: order.user, awbNumber: order.awbNumber, reason: ndrReason });
    }
    await order.save();
    await logActivity(req.user._id, 'admin', 'UPDATE_ORDER_STATUS', 'Order', order._id, { status }, req.ip);
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/orders/:id/convert-shipment
router.patch('/:id/convert-shipment', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.status = 'processing';
    await order.save();
    res.json({ success: true, order });
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

// ─── BULK UPLOAD ──────────────────────────────────────────────────────────────
router.post('/bulk-upload', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const lines = fs.readFileSync(req.file.path, 'utf8').trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ success: false, message: 'Empty file' });
    const headers = lines[0].split(',').map(h => h.replace(/["|\r]/g,'').trim().toLowerCase());
    const rows    = lines.slice(1);

    const bulkRecord = await BulkUpload.create({
      user: req.user._id, fileName: req.file.originalname, totalRows: rows.length, status: 'processing'
    });

    let success = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].trim()) continue;
      const cols = rows[i].split(',').map(c => c.replace(/["|\r]/g,'').trim());
      const row  = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
      try {
        const phone   = row['recipient_phone'] || row['phone'] || '';
        const pincode = row['pincode'] || row['recipient_pincode'] || '';
        if (!row['recipient_name'] && !row['name']) throw new Error('Missing recipient name');
        if (!phone)                                 throw new Error('Missing phone');
        if (!pincode)                               throw new Error('Missing pincode');
        if (!/^[6-9]\d{9}$/.test(phone))           throw new Error('Invalid phone');
        if (!/^\d{6}$/.test(pincode))              throw new Error('Invalid pincode');
        await Order.create({
          user: req.user._id, source: 'bulk_upload', status: 'draft',
          recipient: { name: row['recipient_name'] || row['name'], phone,
            email: row['email'] || '', address: row['address'] || row['recipient_address'] || '',
            city: row['city'] || '', state: row['state'] || '', pincode, landmark: row['landmark'] || '' },
          package: { weight: parseFloat(row['weight']) || 0.5,
            description: row['description'] || '', value: parseFloat(row['value']) || 0 },
          paymentMode: (row['payment_mode']||row['payment']||'').toLowerCase() === 'cod' ? 'cod' : 'prepaid',
          codAmount: parseFloat(row['cod_amount']||row['cod']) || 0,
          duplicateCheckKey: `${phone}_${pincode}`
        });
        success++;
      } catch (e) { failed++; errors.push({ row: i + 2, error: e.message }); }
    }

    bulkRecord.successRows = success; bulkRecord.failedRows = failed;
    bulkRecord.errors = errors; bulkRecord.status = 'completed';
    await bulkRecord.save();
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    res.json({ success: true, totalRows: rows.length, successRows: success, failedRows: failed, errors, bulkRecord });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: clear stale AWBs from unshipped orders ───────────────────────────
// POST /api/orders/admin/clear-stale-awbs
// Clears awbNumber from any order in draft/processing status (shouldn't have AWB)
router.post('/admin/clear-stale-awbs', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    const result = await Order.updateMany(
      { status: { $in: ['draft', 'processing'] }, awbNumber: { $exists: true, $ne: null, $ne: '' } },
      { $unset: { awbNumber: '', selloship: '' }, $set: { walletDeducted: false } }
    );
    res.json({ success: true, cleared: result.modifiedCount, message: `Cleared stale AWBs from ${result.modifiedCount} orders` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
