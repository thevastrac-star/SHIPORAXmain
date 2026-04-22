// routes/orders.js — Shiporax v6 (FIXED)
// [FIX-LABEL-1] POST /bulk-labels — was MISSING, causing blank popup
// [FIX-LABEL-2] GET /:id populates pickupWarehouse — fixes empty address on label
// [FIX-LABEL-3] GET /:id/label — single printable label endpoint
// [FIX-QUEUE]   ship route is now async queue-based (instant response)
// [FIX-API]     External API key routes: /v1/ship /v1/bulk-ship /v1/status /v1/label

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const fs       = require('fs');
const crypto   = require('crypto');
const User     = require('../models/User');
const Order    = require('../models/Order');
const {
  NDR, WalletTransaction, BulkUpload, CodReconciliation,
  ShippingRate, CourierPreference, Courier, Warehouse,
  CourierSelloshipMapping
} = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { apiKeyAuth }                       = require('../middleware/apiKey');
const { createNotification }               = require('../utils/notifications');
const { fetchPincodeData }                 = require('../utils/pincode');
const { toCSV }                            = require('../utils/csv');
const {
  getSelloToken, orderToPayloadParams, createWaybill
} = require('../utils/selloship');
const shippingQueue = require('../utils/shippingQueue');

const upload = multer({ dest: 'uploads/bulk/' });

// ─── SHIPPING COST ────────────────────────────────────────────────────────────
async function calcShippingCost(userId, courierId, weight, paymentMode, codAmount) {
  let rate = await ShippingRate.findOne({ courier: courierId, user: userId, isActive: true });
  if (!rate) rate = await ShippingRate.findOne({ courier: courierId, user: null, isActive: true });
  if (!rate) return { cost: null, codCharge: 0, total: 0, noRate: true };
  const baseRate = rate.zones.d || rate.zones.a || 0;
  const w = parseFloat(weight) || 0.5;
  let cost = baseRate;
  if (w > rate.maxWeight) cost += Math.ceil((w - rate.maxWeight) / 0.5) * (rate.additionalWeightRate || 0);
  cost += rate.fuelSurcharge || 0;
  let codCharge = 0;
  if (paymentMode === 'cod' && codAmount > 0) {
    const cod = rate.cod;
    if (cod.mode === 'flat_always')         codCharge = cod.flat || 0;
    else if (cod.mode === 'percent_always') codCharge = Math.round((codAmount * (cod.percent || 0)) / 100);
    else codCharge = codAmount <= (cod.thresholdAmount || 1500)
      ? (cod.flat || 30) : Math.round((codAmount * (cod.percent || 1.5)) / 100);
  }
  return { cost: Math.round(cost), codCharge: Math.round(codCharge), total: Math.round(cost + codCharge) };
}

router.get('/calc-cost', protect, async (req, res) => {
  try {
    const { courierId, weight, paymentMode, codAmount } = req.query;
    if (!courierId) return res.status(400).json({ success: false, message: 'courierId required' });
    const result = await calcShippingCost(req.user._id, courierId, weight, paymentMode, codAmount);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── SELLOSHIP HELPER ─────────────────────────────────────────────────────────
async function shipViaSelloship(order, courierId) {
  let warehouse = order.pickupWarehouse
    ? (order.pickupWarehouse._id ? order.pickupWarehouse : await Warehouse.findById(order.pickupWarehouse))
    : null;
  if (!warehouse) warehouse = await Warehouse.findOne({ user: order.user, isDefault: true });
  if (!warehouse) throw new Error('No pickup warehouse found. Add a warehouse first.');
  const token  = await getSelloToken();
  const params = orderToPayloadParams(order, warehouse);
  if (courierId) {
    const mapping = await CourierSelloshipMapping.findOne({ courier: courierId, isActive: true });
    if (mapping && !mapping.isAutoRoute) {
      if (mapping.selloshipCourierId)   params.courierID   = mapping.selloshipCourierId;
      if (mapping.selloshipCourierName) params.courierName = mapping.selloshipCourierName;
    }
  }
  const result = await createWaybill(token, params);
  return { awbNumber: result.waybill, labelUrl: result.shippingLabel,
    courierName: result.courierName, routingCode: result.routingCode };
}

// ─── QUEUE ENQUEUE HELPER ─────────────────────────────────────────────────────
// Architecture: API → DB → Queue → Worker → Courier API → DB → UI polls
async function enqueueShipment(order, courierId, userId) {
  const jobId = 'ship_' + order._id + '_' + Date.now();
  shippingQueue.enqueue(jobId, {
    handler: async () => {
      const shipped = await shipViaSelloship(order, courierId);
      const updatedOrder = await Order.findById(order._id);
      updatedOrder.awbNumber = shipped.awbNumber;
      updatedOrder.status    = 'shipped';
      updatedOrder.selloship = { waybill: shipped.awbNumber, courierName: shipped.courierName,
        routingCode: shipped.routingCode, labelUrl: shipped.labelUrl, shippedAt: new Date() };
      await updatedOrder.save();
      if (updatedOrder.codReconciliation)
        await CodReconciliation.findByIdAndUpdate(updatedOrder.codReconciliation, { awbNumber: shipped.awbNumber });
      const user = await User.findById(userId);
      await createNotification(userId, 'shipped', 'Order Shipped',
        'Order ' + updatedOrder.orderId + ' shipped. AWB: ' + shipped.awbNumber,
        updatedOrder._id, user && user.whatsappNotifications);
      return { orderId: updatedOrder.orderId, awbNumber: shipped.awbNumber,
        labelUrl: shipped.labelUrl, courierName: shipped.courierName };
    }
  });
  return jobId;
}

// ─── LABEL HTML BUILDER ───────────────────────────────────────────────────────
function buildLabelHtml(o) {
  const isCOD = o.paymentMode === 'cod';
  const wh    = o.pickupWarehouse || {};
  const c     = o.assignedCourier || {};
  const r     = o.recipient || {};
  const pkg   = o.package || {};
  const bc    = '#0D1B3E';

  if (o.selloship && o.selloship.labelUrl) {
    return '<div style="font-family:Arial,sans-serif;margin-bottom:8mm">' +
      '<div style="font-size:7pt;color:#666;margin-bottom:4px">AWB: ' + (o.selloship.waybill || o.awbNumber || '') + ' | ' + o.orderId + '</div>' +
      '<iframe src="' + o.selloship.labelUrl + '" style="width:100%;height:420px;border:1px solid #ccc" title="Shipping Label"></iframe>' +
      '<div style="font-size:6pt;color:#999;margin-top:2px"><a href="' + o.selloship.labelUrl + '" target="_blank">Open label in new tab ↗</a></div>' +
      '</div>';
  }

  return '<div style="font-family:Arial,sans-serif;font-size:9pt;padding:4mm;border:2px solid #000;background:#fff;line-height:1.4;max-width:100mm;margin-bottom:4mm">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #ccc;padding-bottom:3mm;margin-bottom:3mm">' +
      '<div style="font-weight:bold;font-size:11pt;color:' + bc + '">SHIPORAX</div>' +
      (isCOD ? '<div style="background:#c00;color:#fff;padding:3px 8px;border-radius:3px;font-weight:bold;font-size:9pt">COD ₹' + (o.codAmount||0) + '</div>'
             : '<div style="background:#059669;color:#fff;padding:3px 8px;border-radius:3px;font-weight:bold;font-size:9pt">PREPAID</div>') +
    '</div>' +
    '<div style="margin-bottom:3mm">' +
      '<div style="font-size:6.5pt;color:#666;text-transform:uppercase;font-weight:bold">To:</div>' +
      '<div style="font-weight:bold;font-size:10pt">' + (r.name||'') + '</div>' +
      '<div style="font-size:8pt">' + (r.address||r.address1||'') + (r.city?', '+r.city:'') + (r.state?', '+r.state:'') + '</div>' +
      '<div style="font-size:8pt">Mobile: ' + (r.phone||'') + '</div>' +
      '<div style="font-size:9pt;font-weight:bold">' + (r.pincode||'') + '</div>' +
    '</div>' +
    '<div style="border:1px solid #000;padding:3mm;text-align:center;margin-bottom:3mm">' +
      '<div style="font-size:7pt;font-family:monospace;letter-spacing:-0.5px">||||||||||||||||||||||||||||||||||||||||||</div>' +
      '<div style="font-size:11pt;font-weight:bold;letter-spacing:2px">' + (o.awbNumber||o.orderId) + '</div>' +
      '<div style="font-size:6.5pt;color:#666">Order: ' + new Date(o.createdAt).toLocaleDateString('en-IN') + ' | ' + o.orderId + '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;font-size:7.5pt;border-top:1px solid #ccc;padding-top:2mm;margin-bottom:2mm">' +
      '<div style="font-weight:bold;color:' + bc + '">' + (c.name||'Auto') + '</div>' +
      '<div>WT: ' + (pkg.weight||'—') + 'kg</div>' +
    '</div>' +
    (wh.name ? '<div style="border-top:1px solid #ccc;padding-top:2mm;font-size:7pt"><div style="font-weight:bold;color:#444">Pickup:</div><div>' + (wh.contactName||wh.name||'') + '</div><div>' + (wh.address||'') + ' ' + (wh.pincode||'') + '</div>' + (wh.phone ? '<div>' + wh.phone + '</div>' : '') + '</div>' : '') +
    (wh.name ? '<div style="border-top:1px solid #ccc;padding-top:2mm;font-size:7pt"><div style="font-weight:bold;color:#444">Return:</div><div>' + (wh.name||'') + '</div><div>' + (wh.address||'') + ' ' + (wh.pincode||'') + '</div></div>' : '') +
    '<div style="border-top:1px solid #ccc;padding-top:2mm;margin-top:2mm;font-size:6pt;color:#666">This is a computer generated document.</div>' +
    '</div>';
}


// ─── [FIX-QUEUE] GET /job-status/:jobId — UI polls this after ship ─────────────
router.get('/job-status/:jobId', protect, (req, res) => {
  const status = shippingQueue.status(req.params.jobId);
  if (!status) return res.status(404).json({ success: false, message: 'Job not found or expired' });
  res.json({ success: true, ...status });
});

// ─── [FIX-LABEL-1] POST /bulk-labels — MISSING ENDPOINT NOW ADDED ─────────────
router.post('/bulk-labels', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs' });
    const filter = { _id: { $in: orderIds } };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const orders = await Order.find(filter)
      .populate('assignedCourier', 'name code')
      .populate('pickupWarehouse')
      .lean();
    if (!orders.length) return res.status(404).json({ success: false, message: 'No orders found' });
    const labelDivs = orders.map(o => buildLabelHtml(o))
      .join('<div style="page-break-after:always;margin:0;padding:0"></div>');
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Shipping Labels</title>' +
      '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#fff}' +
      '.print-bar{position:fixed;top:0;left:0;right:0;background:#0D1B3E;color:#fff;padding:10px 20px;' +
      'display:flex;gap:12px;align-items:center;z-index:999;font-size:14px}' +
      '.print-bar button{background:#fff;color:#0D1B3E;border:none;padding:6px 18px;border-radius:4px;' +
      'font-weight:bold;cursor:pointer;font-size:13px}.labels-wrap{padding:60px 20px 20px}' +
      '@media print{.no-print{display:none!important}}' +
      '</style></head><body>' +
      '<div class="print-bar no-print">' +
        '<span>📦 ' + orders.length + ' Label(s) Ready</span>' +
        '<button onclick="window.print()">🖨 Print All</button>' +
        '<button onclick="window.close()">✕ Close</button>' +
      '</div>' +
      '<div class="labels-wrap">' + labelDivs + '</div>' +
      '<script>setTimeout(()=>window.print(),600)</script>' +
      '</body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── [FIX-LABEL-3] GET /:id/label — single label download ─────────────────────
router.get('/:id/label', protect, async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const order = await Order.findOne(filter)
      .populate('assignedCourier', 'name code').populate('pickupWarehouse').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Label ' + order.orderId + '</title>' +
      '<style>*{box-sizing:border-box}body{font-family:Arial;margin:0;padding:16px;background:#f5f5f5}' +
      '.no-print{margin-bottom:12px}.no-print button{background:#0D1B3E;color:#fff;border:none;padding:8px 20px;' +
      'border-radius:4px;cursor:pointer;font-size:14px;margin-right:8px}' +
      '@media print{.no-print{display:none}body{padding:0;background:#fff}}</style></head><body>' +
      '<div class="no-print"><button onclick="window.print()">🖨 Print Label</button>' +
      '<button onclick="window.close()">✕ Close</button></div>' +
      buildLabelHtml(order) +
      '<script>setTimeout(()=>window.print(),500)</script></body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── STATIC ROUTES ────────────────────────────────────────────────────────────
router.get('/pincode/:pincode', protect, async (req, res) => {
  const data = await fetchPincodeData(req.params.pincode);
  res.json(data);
});

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

// ─── [FIX-BULK-Q] POST /bulk-ship — queued, fast, 3 concurrent workers ────────
router.post('/bulk-ship', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const results = [];
    for (const id of orderIds) {
      const order = await Order.findOne({
        _id: id, user: req.user._id, status: { $in: ['draft','processing'] }
      }).populate('pickupWarehouse');
      if (!order) { results.push({ id, success: false, message: 'Not found or already shipped' }); continue; }
      if (order.awbNumber) { results.push({ id, success: false, message: 'Already has AWB' }); continue; }
      const courierId = order.assignedCourier ? order.assignedCourier.toString() : null;
      // Wallet deduction is synchronous — must happen before queue to avoid race conditions
      const user = await User.findById(req.user._id);
      if (!order.walletDeducted && order.shippingCharge > 0) {
        if (user.walletBalance < order.shippingCharge) {
          results.push({ id, success: false, message: 'Insufficient balance (need ₹' + order.shippingCharge + ')' });
          continue;
        }
        user.walletBalance -= order.shippingCharge;
        await user.save();
        await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: order.shippingCharge,
          balance: user.walletBalance, description: 'Shipping for ' + order.orderId, reference: order.orderId });
        order.walletDeducted = true;
        await order.save();
      }
      const jobId = await enqueueShipment(order, courierId, req.user._id);
      results.push({ id, success: true, orderId: order.orderId, jobId, status: 'queued' });
    }
    res.json({ success: true, results, message: 'Orders queued. Poll /api/orders/job-status/:jobId for updates.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/bulk-delete', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
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
    const { recipient, package: pkg, paymentMode, codAmount, pickupWarehouse, source, courierId, invoiceCode, serviceType } = req.body;
    if (!recipient || !recipient.phone || !/^[6-9]\d{9}$/.test(recipient.phone))
      return res.status(400).json({ success: false, message: 'Invalid phone (10 digits, start 6-9)' });
    if (!recipient.pincode || !/^\d{6}$/.test(recipient.pincode))
      return res.status(400).json({ success: false, message: 'Invalid pincode (6 digits)' });
    const dupeKey = recipient.phone + '_' + recipient.pincode;
    const recent  = await Order.findOne({ user: req.user._id, duplicateCheckKey: dupeKey,
      createdAt: { $gte: new Date(Date.now() - 86400000) } });
    if (recent) return res.status(400).json({ success: false, message: 'Duplicate order', existingOrderId: recent.orderId });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayCount = await Order.countDocuments({ user: req.user._id, createdAt: { $gte: todayStart } });
    if (todayCount >= user.limits.maxOrdersPerDay)
      return res.status(429).json({ success: false, message: 'Daily limit (' + user.limits.maxOrdersPerDay + ') reached' });
    const cod = parseFloat(codAmount) || 0;
    if (paymentMode === 'cod' && cod > user.limits.codLimit)
      return res.status(400).json({ success: false, message: 'COD exceeds limit ₹' + user.limits.codLimit });
    let resolvedCourierId = courierId;
    if (!resolvedCourierId) {
      const pref = await CourierPreference.findOne({ user: req.user._id });
      if (pref && pref.priorities && pref.priorities.length)
        resolvedCourierId = pref.priorities.sort((a,b) => a.priority - b.priority)[0].courier;
    }
    let shippingCharge = 0;
    if (resolvedCourierId) {
      const costResult = await calcShippingCost(req.user._id, resolvedCourierId, pkg && pkg.weight || 0.5, paymentMode, cod);
      if (costResult.noRate) return res.status(400).json({ success: false, message: 'No shipping rate for this courier.' });
      shippingCharge = costResult.total;
    }
    const order = await Order.create({
      user: req.user._id, source: source || 'manual', pickupWarehouse,
      recipient, package: pkg, paymentMode: paymentMode || 'prepaid',
      codAmount: cod, assignedCourier: resolvedCourierId || undefined,
      shippingCharge, duplicateCheckKey: dupeKey, status: 'processing',
      invoiceCode: invoiceCode || undefined, serviceType: serviceType || 'Surface'
    });
    if (shippingCharge > 0) {
      if (user.walletBalance < shippingCharge) {
        await Order.findByIdAndDelete(order._id);
        return res.status(400).json({ success: false, message: 'Insufficient balance. Need ₹' + shippingCharge + ', have ₹' + user.walletBalance.toFixed(2) });
      }
      user.walletBalance -= shippingCharge;
      await user.save();
      await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: shippingCharge,
        balance: user.walletBalance, description: 'Shipping for ' + order.orderId, reference: order.orderId });
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
      { orderId: new RegExp(req.query.search, 'i') }, { awbNumber: new RegExp(req.query.search, 'i') },
      { 'recipient.name': new RegExp(req.query.search, 'i') }, { 'recipient.phone': new RegExp(req.query.search, 'i') }
    ];
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate('user', 'name email').populate('assignedCourier', 'name code')
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    res.json({ success: true, total, page, limit, pages: Math.ceil(total / limit), orders });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── [FIX-QUEUE] PATCH /:id/ship — NOW ASYNC: instant response + poll jobId ───
router.patch('/:id/ship', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).populate('pickupWarehouse');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['draft','processing'].includes(order.status))
      return res.status(400).json({ success: false, message: 'Cannot ship order in status: ' + order.status });
    if (order.awbNumber && order.awbNumber.trim())
      return res.status(400).json({ success: false, message: 'Order already has AWB: ' + order.awbNumber });
    const user      = await User.findById(req.user._id);
    const courierId = req.body.courierId || (order.assignedCourier ? order.assignedCourier.toString() : null);
    let shippingCharge = order.shippingCharge || 0;
    if (courierId && !order.walletDeducted) {
      const costResult = await calcShippingCost(req.user._id, courierId, order.package && order.package.weight || 0.5, order.paymentMode, order.codAmount || 0);
      if (costResult.noRate) return res.status(400).json({ success: false, message: 'No shipping rate. Contact admin.' });
      shippingCharge = costResult.total;
      if (shippingCharge > 0) {
        if (user.walletBalance < shippingCharge)
          return res.status(400).json({ success: false, message: 'Insufficient balance. Need ₹' + shippingCharge + ', have ₹' + user.walletBalance.toFixed(2) });
        user.walletBalance -= shippingCharge;
        await user.save();
        await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: shippingCharge,
          balance: user.walletBalance, description: 'Shipping for ' + order.orderId, reference: order.orderId });
        order.shippingCharge = shippingCharge;
        order.walletDeducted = true;
      }
    }
    if (courierId) order.assignedCourier = courierId;
    order.status = 'processing';
    await order.save();
    const jobId = await enqueueShipment(order, courierId, req.user._id);
    await logActivity(req.user._id, 'client', 'SHIP_ORDER_QUEUED', 'Order', order._id, { jobId }, req.ip);
    res.json({ success: true, queued: true, jobId, orderId: order.orderId, shippingCharge,
      message: 'Queued. Poll /api/orders/job-status/' + jobId });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/:id/cancel-shipment', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['shipped','processing'].includes(order.status))
      return res.status(400).json({ success: false, message: 'Cannot cancel: ' + order.status });
    let selloshipCancelled = false;
    if (order.awbNumber) {
      try {
        const { getSelloToken, cancelWaybill } = require('../utils/selloship');
        const token = await getSelloToken();
        const result = await cancelWaybill(token, order.awbNumber);
        selloshipCancelled = result && (result.status === 'SUCCESS' || !result.status);
      } catch(e) { return res.status(400).json({ success: false, message: 'Selloship cancel failed: ' + e.message }); }
    } else { selloshipCancelled = true; }
    if (!selloshipCancelled) return res.status(400).json({ success: false, message: 'Selloship did not confirm cancellation.' });
    const refundAmount = order.shippingCharge || 0;
    if (refundAmount > 0 && order.walletDeducted) {
      const updatedUser = await User.findByIdAndUpdate(req.user._id, { $inc: { walletBalance: refundAmount } }, { new: true });
      await WalletTransaction.create({ user: req.user._id, type: 'credit', amount: refundAmount,
        balance: updatedUser.walletBalance, description: 'Refund: cancelled ' + order.orderId, reference: order._id });
    }
    order.status = 'cancelled'; order.awbNumber = null; order.walletDeducted = false;
    order.selloship = undefined; order.cancelledAt = new Date(); order.cancellationReason = req.body.reason || 'Cancelled by client';
    await order.save();
    await logActivity(req.user._id, 'client', 'CANCEL_SHIPMENT', 'Order', order._id, { refundAmount }, req.ip);
    res.json({ success: true, message: 'Cancelled. ₹' + refundAmount + ' refunded to wallet.', refundAmount, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status, awbNumber, ndrReason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.status = status;
    if (awbNumber) {
      const trimmed = awbNumber.trim();
      if (/^(XSE\d+|SAMPLE|TEST|DEMO|FAKE|DUMMY|AWB\d{5,}|1234|0000)/i.test(trimmed))
        return res.status(400).json({ success: false, message: 'Sample/test AWB not allowed.' });
      order.awbNumber = trimmed;
    }
    if (status === 'ndr' && !(order.ndr && order.ndr.isNDR)) {
      order.ndr = Object.assign({}, order.ndr, { isNDR: true });
      await NDR.create({ order: order._id, user: order.user, awbNumber: order.awbNumber, reason: ndrReason });
    }
    await order.save();
    await logActivity(req.user._id, 'admin', 'UPDATE_ORDER_STATUS', 'Order', order._id, { status }, req.ip);
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:id/convert-shipment', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.status = 'processing';
    await order.save();
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── [FIX-LABEL-2] GET /:id — now populates pickupWarehouse ──────────────────
router.get('/:id', protect, async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const order = await Order.findOne(filter)
      .populate('user', 'name email phone')
      .populate('assignedCourier')
      .populate('pickupWarehouse')        // [FIX-LABEL-2] was missing
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
    const headers = lines[0].split(',').map(h => h.replace(/[\"|\r]/g,'').trim().toLowerCase());
    const rows    = lines.slice(1);
    const bulkRecord = await BulkUpload.create({
      user: req.user._id, fileName: req.file.originalname, totalRows: rows.length, status: 'processing'
    });
    let success = 0, failed = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].trim()) continue;
      const cols = rows[i].split(',').map(c => c.replace(/[\"|\r]/g,'').trim());
      const row  = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
      try {
        const phone   = row['recipient_phone'] || row['phone'] || '';
        const pincode = row['pincode'] || row['recipient_pincode'] || '';
        if (!row['recipient_name'] && !row['name']) throw new Error('Missing recipient name');
        if (!phone)   throw new Error('Missing phone');
        if (!pincode) throw new Error('Missing pincode');
        if (!/^[6-9]\d{9}$/.test(phone))  throw new Error('Invalid phone');
        if (!/^\d{6}$/.test(pincode))      throw new Error('Invalid pincode');
        await Order.create({
          user: req.user._id, source: 'bulk_upload', status: 'draft',
          recipient: { name: row['recipient_name'] || row['name'], phone, email: row['email'] || '',
            address: row['address'] || row['recipient_address'] || '',
            city: row['city'] || '', state: row['state'] || '', pincode, landmark: row['landmark'] || '' },
          package: { weight: parseFloat(row['weight']) || 0.5, description: row['description'] || '', value: parseFloat(row['value']) || 0 },
          paymentMode: (row['payment_mode']||row['payment']||'').toLowerCase() === 'cod' ? 'cod' : 'prepaid',
          codAmount: parseFloat(row['cod_amount']||row['cod']) || 0,
          invoiceCode: row['invoice_code'] || row['invoice'] || undefined,
          serviceType: (['Air','air'].includes(row['service_type']||row['service']||'')) ? 'Air' : 'Surface',
          duplicateCheckKey: phone + '_' + pincode
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

router.post('/admin/clear-stale-awbs', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    const result = await Order.updateMany(
      { status: { $in: ['draft', 'processing'] }, awbNumber: { $exists: true, $ne: null, $ne: '' } },
      { $unset: { awbNumber: '', selloship: '' }, $set: { walletDeducted: false } }
    );
    res.json({ success: true, cleared: result.modifiedCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/bulk-cancel', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const { cancelWaybill, getSelloToken } = require('../utils/selloship');
    const results = [];
    for (const id of orderIds) {
      const order = await Order.findOne({ _id: id, user: req.user._id });
      if (!order) { results.push({ id, success: false, message: 'Not found' }); continue; }
      if (!['shipped','processing'].includes(order.status)) { results.push({ id, success: false, message: 'Not cancellable' }); continue; }
      try {
        if (order.awbNumber) {
          try { const token = await getSelloToken(); await cancelWaybill(token, order.awbNumber); } catch(e) {}
        }
        const refund = order.shippingCharge || 0;
        if (refund > 0 && order.walletDeducted) {
          const u = await User.findByIdAndUpdate(req.user._id, { $inc: { walletBalance: refund } }, { new: true });
          await WalletTransaction.create({ user: req.user._id, type: 'credit', amount: refund, balance: u.walletBalance, description: 'Bulk cancel refund: ' + order.orderId });
        }
        order.status = 'cancelled'; order.awbNumber = null; order.walletDeducted = false;
        order.selloship = undefined; order.cancelledAt = new Date(); order.cancellationReason = 'Bulk cancelled';
        await order.save();
        results.push({ id, success: true, orderId: order.orderId, refund });
      } catch(e) { results.push({ id, success: false, message: e.message }); }
    }
    res.json({ success: true, results });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/clone/:id', protect, async (req, res) => {
  try {
    const orig = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!orig) return res.status(404).json({ success: false, message: 'Order not found' });
    const clone = await Order.create({
      user: req.user._id, source: 'manual', status: 'draft',
      pickupWarehouse: orig.pickupWarehouse,
      recipient: Object.assign({}, orig.recipient.toObject()),
      package: Object.assign({}, orig.package.toObject()),
      paymentMode: orig.paymentMode, codAmount: orig.codAmount,
      assignedCourier: orig.assignedCourier, serviceType: orig.serviceType,
      duplicateCheckKey: orig.recipient.phone + '_' + orig.recipient.pincode + '_clone_' + Date.now()
    });
    const populated = await Order.findById(clone._id).populate('assignedCourier', 'name code');
    res.status(201).json({ success: true, order: populated });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// [FIX-API] EXTERNAL API KEY ROUTES
// Header: X-API-Key: <your-api-key>
// POST   /api/orders/v1/ship          → create + ship (returns jobId)
// POST   /api/orders/v1/bulk-ship     → create + ship multiple (returns jobIds)
// GET    /api/orders/v1/job/:jobId    → poll job status
// GET    /api/orders/v1/status/:orderId → order status + label URL
// GET    /api/orders/v1/label/:orderId  → download label (redirect or HTML)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/v1/ship', apiKeyAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { recipient, package: pkg, paymentMode, codAmount, courierId, invoiceCode, serviceType, pickupWarehouseId } = req.body;
    if (!recipient || !recipient.phone) return res.status(400).json({ success: false, message: 'recipient.phone required' });
    if (!recipient.pincode) return res.status(400).json({ success: false, message: 'recipient.pincode required' });
    if (!recipient.name)    return res.status(400).json({ success: false, message: 'recipient.name required' });
    if (!recipient.address) return res.status(400).json({ success: false, message: 'recipient.address required' });
    const cod = parseFloat(codAmount) || 0;
    let shippingCharge = 0;
    if (courierId) {
      const costResult = await calcShippingCost(req.user._id, courierId, pkg && pkg.weight || 0.5, paymentMode || 'prepaid', cod);
      if (!costResult.noRate) shippingCharge = costResult.total;
    }
    if (shippingCharge > 0 && user.walletBalance < shippingCharge)
      return res.status(400).json({ success: false, message: 'Insufficient balance. Need ₹' + shippingCharge + ', have ₹' + user.walletBalance.toFixed(2) });
    const order = await Order.create({
      user: req.user._id, source: 'manual', pickupWarehouse: pickupWarehouseId || undefined,
      recipient, package: pkg || { weight: 0.5 }, paymentMode: paymentMode || 'prepaid', codAmount: cod,
      assignedCourier: courierId || undefined, shippingCharge, status: 'processing',
      invoiceCode: invoiceCode || undefined, serviceType: serviceType || 'Surface',
      duplicateCheckKey: recipient.phone + '_' + recipient.pincode + '_' + Date.now()
    });
    if (shippingCharge > 0) {
      user.walletBalance -= shippingCharge;
      await user.save();
      await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: shippingCharge,
        balance: user.walletBalance, description: 'API Shipping for ' + order.orderId });
      order.walletDeducted = true;
      await order.save();
    }
    const populatedOrder = await Order.findById(order._id).populate('pickupWarehouse');
    const jobId = await enqueueShipment(populatedOrder, courierId, req.user._id);
    res.status(201).json({ success: true, orderId: order.orderId, jobId, shippingCharge,
      message: 'Queued. Poll /api/orders/v1/job/' + jobId + ' for AWB.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/v1/bulk-ship', apiKeyAuth, async (req, res) => {
  try {
    const { orders: ordersList } = req.body;
    if (!Array.isArray(ordersList) || !ordersList.length)
      return res.status(400).json({ success: false, message: 'orders[] array required' });
    if (ordersList.length > 100)
      return res.status(400).json({ success: false, message: 'Max 100 orders per bulk call' });
    const results = [];
    for (const item of ordersList) {
      try {
        const { recipient, package: pkg, paymentMode, codAmount, courierId, invoiceCode, serviceType, pickupWarehouseId } = item;
        if (!recipient || !recipient.phone || !recipient.name || !recipient.pincode || !recipient.address)
          throw new Error('Missing: recipient.phone/name/pincode/address');
        const cod = parseFloat(codAmount) || 0;
        let shippingCharge = 0;
        if (courierId) {
          const costResult = await calcShippingCost(req.user._id, courierId, pkg && pkg.weight || 0.5, paymentMode || 'prepaid', cod);
          if (!costResult.noRate) shippingCharge = costResult.total;
        }
        const freshUser = await User.findById(req.user._id);
        if (shippingCharge > 0 && freshUser.walletBalance < shippingCharge)
          throw new Error('Insufficient balance (need ₹' + shippingCharge + ')');
        const order = await Order.create({
          user: req.user._id, source: 'manual', pickupWarehouse: pickupWarehouseId || undefined,
          recipient, package: pkg || { weight: 0.5 }, paymentMode: paymentMode || 'prepaid', codAmount: cod,
          assignedCourier: courierId || undefined, shippingCharge, status: 'processing',
          invoiceCode: invoiceCode || undefined, serviceType: serviceType || 'Surface',
          duplicateCheckKey: recipient.phone + '_' + recipient.pincode + '_' + Date.now()
        });
        if (shippingCharge > 0) {
          await User.findByIdAndUpdate(req.user._id, { $inc: { walletBalance: -shippingCharge } });
          await WalletTransaction.create({ user: req.user._id, type: 'debit', amount: shippingCharge,
            balance: freshUser.walletBalance - shippingCharge, description: 'API Bulk shipping for ' + order.orderId });
          order.walletDeducted = true;
          await order.save();
        }
        const populatedOrder = await Order.findById(order._id).populate('pickupWarehouse');
        const jobId = await enqueueShipment(populatedOrder, courierId, req.user._id);
        results.push({ success: true, orderId: order.orderId, jobId, shippingCharge });
      } catch (e) { results.push({ success: false, error: e.message }); }
    }
    res.json({ success: true, results, total: ordersList.length,
      queued: results.filter(r=>r.success).length, failed: results.filter(r=>!r.success).length });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/v1/job/:jobId', apiKeyAuth, (req, res) => {
  const status = shippingQueue.status(req.params.jobId);
  if (!status) return res.status(404).json({ success: false, message: 'Job not found or expired (10 min TTL)' });
  res.json({ success: true, ...status });
});

router.get('/v1/status/:orderId', apiKeyAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId, user: req.user._id })
      .populate('assignedCourier', 'name code').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, orderId: order.orderId, status: order.status,
      awbNumber: order.awbNumber, labelUrl: order.selloship && order.selloship.labelUrl,
      courierName: order.selloship && order.selloship.courierName,
      shippedAt: order.selloship && order.selloship.shippedAt, createdAt: order.createdAt });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/v1/label/:orderId', apiKeyAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId, user: req.user._id })
      .populate('assignedCourier', 'name code').populate('pickupWarehouse').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.selloship && order.selloship.labelUrl) return res.redirect(302, order.selloship.labelUrl);
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Label ' + order.orderId + '</title>' +
      '<style>body{font-family:Arial;margin:8mm}@media print{body{margin:0}}</style></head>' +
      '<body>' + buildLabelHtml(order) + '<script>setTimeout(()=>window.print(),500)</script></body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
