// routes/selloship.js — Selloship API routes
// Mount: app.use('/api/selloship', require('./routes/selloship'))

const express   = require('express');
const router    = express.Router();
const Order     = require('../models/Order');
const { Warehouse } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const {
  getSelloToken,
  getServiceability,
  createWaybill,
  createReverseWaybill,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  orderToPayloadParams,
  verifyWebhookSignature
} = require('../utils/selloship');

// ─── MIDDLEWARE: inject token (skip webhook — it has no auth token) ───────────
router.use((req, res, next) => {
  if (req.path === '/webhook') return next(); // webhook verifies via HMAC
  getSelloToken()
    .then(token => { req.selloToken = token; next(); })
    .catch(err  => res.status(503).json({
      success: false,
      message: 'Selloship credentials not configured or auth failed. Go to Admin → Settings → Courier APIs.',
      detail:  err.message
    }));
});

// ─── PING ────────────────────────────────────────────────────────────────────
router.get('/ping', protect, adminOnly, (req, res) =>
  res.json({ success: true, message: 'Selloship credentials are valid ✅' })
);

// ─── AVAILABLE COURIERS (serviceability) ─────────────────────────────────────
router.get('/couriers', protect, async (req, res) => {
  try {
    const couriers = await getServiceability(req.selloToken, req.query);
    res.json({ success: true, couriers });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── SHIP ORDER (forward) ─────────────────────────────────────────────────────
router.post('/ship/:orderId', protect, async (req, res) => {
  try {
    const query = req.user.role === 'admin'
      ? { _id: req.params.orderId }
      : { _id: req.params.orderId, user: req.user._id };

    const order = await Order.findOne(query).populate('assignedCourier');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['draft','processing'].includes(order.status))
      return res.status(400).json({ success: false, message: `Cannot ship order with status: ${order.status}` });

    // GUARD: never re-ship if a real AWB is already assigned
    if (order.awbNumber && order.awbNumber.trim())
      return res.status(400).json({ success: false, message: `Order already has AWB: ${order.awbNumber}. Cancel first.` });

    // Resolve warehouse
    let warehouse = order.pickupWarehouse
      ? await Warehouse.findById(order.pickupWarehouse)
      : null;
    if (!warehouse) warehouse = await Warehouse.findOne({ user: order.user, isDefault: true });
    if (!warehouse)
      return res.status(400).json({ success: false, message: 'No pickup warehouse found. Add a warehouse first.' });

    // Build params using adapter (converts Order+Warehouse → buildWaybillPayload params)
    const params = orderToPayloadParams(order, warehouse);

    // Apply courier override from request (e.g. "Delhivery Fr" selected in UI)
    if (req.body.courierId)   params.courierId   = String(req.body.courierId);
    if (req.body.courierName) params.courierName = String(req.body.courierName);

    const result = await createWaybill(req.selloToken, params);

    order.awbNumber = result.waybill;
    order.status    = 'shipped';
    order.selloship = {
      waybill:     result.waybill,
      courierName: result.courierName || req.body.courierName || '',
      routingCode: result.routingCode,
      labelUrl:    result.shippingLabel,
      shippedAt:   new Date()
    };
    await order.save();

    await logActivity(req.user._id, req.user.role, 'SELLOSHIP_SHIP', 'Order', order._id,
      { awb: result.waybill, courier: result.courierName }, req.ip);

    res.json({
      success:     true,
      waybill:     result.waybill,
      courierName: result.courierName,
      labelUrl:    result.shippingLabel,
      routingCode: result.routingCode,
      order
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── REVERSE PICKUP ───────────────────────────────────────────────────────────
router.post('/reverse/:orderId', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.orderId, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    let warehouse = order.pickupWarehouse ? await Warehouse.findById(order.pickupWarehouse) : null;
    if (!warehouse) warehouse = await Warehouse.findOne({ user: order.user, isDefault: true });
    if (!warehouse) return res.status(400).json({ success: false, message: 'No warehouse found for return address' });

    const result = await createReverseWaybill(req.selloToken, orderToPayloadParams(order, warehouse));

    order.selloship = {
      ...(order.selloship?.toObject?.() || order.selloship || {}),
      reverseWaybill:  result.waybill,
      reverseLabelUrl: result.shippingLabel,
      reversedAt:      new Date()
    };
    await order.save();

    res.json({ success: true, waybill: result.waybill, labelUrl: result.shippingLabel, order });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── TRACK ────────────────────────────────────────────────────────────────────
router.get('/track', protect, async (req, res) => {
  try {
    const awbs = req.query.awbs?.split(',').map(a => a.trim()).filter(Boolean);
    if (!awbs?.length) return res.status(400).json({ success: false, message: 'awbs query param required' });
    const result = await getWaybillStatus(req.selloToken, awbs);
    res.json({ success: true, tracking: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── CANCEL ───────────────────────────────────────────────────────────────────
router.post('/cancel/:orderId', protect, async (req, res) => {
  try {
    const query = req.user.role === 'admin'
      ? { _id: req.params.orderId }
      : { _id: req.params.orderId, user: req.user._id };

    const order = await Order.findOne(query);
    if (!order)           return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.awbNumber) return res.status(400).json({ success: false, message: 'No AWB to cancel' });

    const result = await cancelWaybill(req.selloToken, order.awbNumber);
    order.status             = 'cancelled';
    order.cancelledAt        = new Date();
    order.cancellationReason = req.body.reason || 'Cancelled via Selloship';
    await order.save();

    await logActivity(req.user._id, req.user.role, 'SELLOSHIP_CANCEL', 'Order', order._id,
      { awb: order.awbNumber }, req.ip);

    res.json({ success: true, message: result.errorMessage || 'Cancelled', order });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── MANIFEST ────────────────────────────────────────────────────────────────
router.post('/manifest', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds?.length) return res.status(400).json({ success: false, message: 'orderIds required' });

    const query = req.user.role === 'admin'
      ? { _id: { $in: orderIds } }
      : { _id: { $in: orderIds }, user: req.user._id };

    const orders = await Order.find(query);
    const awbs   = orders.map(o => o.awbNumber).filter(Boolean);
    if (!awbs.length) return res.status(400).json({ success: false, message: 'No shipped orders with AWB found' });

    const result = await generateManifest(req.selloToken, awbs);
    res.json({ success: true, manifestNumber: result.manifestNumber, manifestUrl: result.manifestDownloadUrl });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── WEBHOOK (push from Selloship) ───────────────────────────────────────────
// FIX #9: HMAC signature verification — register this URL with Selloship team.
// Set SELLOSHIP_WEBHOOK_SECRET env var to the secret Selloship provides.
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    // Verify HMAC signature
    const sig = req.headers['x-selloship-signature'] || req.headers['x-signature'];
    if (!verifyWebhookSignature(req.body, sig)) {
      console.warn('[Selloship Webhook] Invalid signature — request rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let body;
    try { body = JSON.parse(req.body.toString()); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    const { waybillDetails, Status } = body;
    if (Status !== 'SUCCESS' || !waybillDetails?.waybill)
      return res.status(400).json({ error: 'Invalid payload' });

    const { waybill, currentStatus } = waybillDetails;
    console.log(`[Selloship Webhook] AWB: ${waybill} → ${currentStatus}`);

    const statusMap = {
      'READY_TO_SHIP':    'processing',
      'MANIFESTED':       'processing',
      'PICKUP_SCHEDULED': 'processing',
      'PICKED_UP':        'in_transit',
      'IN_TRANSIT':       'in_transit',
      'OUT_FOR_DELIVERY': 'out_for_delivery',
      'DELIVERED':        'delivered',
      'NDR':              'ndr',
      'RTO':              'rto',
      'RETURN_RECEIVED':  'rto',
      'CANCELLED':        'cancelled'
    };
    const mappedStatus = statusMap[currentStatus];
    if (mappedStatus) {
      await Order.updateOne(
        { awbNumber: waybill },
        { $set: {
            status:                     mappedStatus,
            'selloship.lastWebhookStatus': currentStatus,
            'selloship.lastWebhookAt':     new Date()
          }
        }
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Selloship Webhook Error]', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── ADMIN: COURIER → SELLOSHIP MAPPING ──────────────────────────────────────
// Admin maps each internal courier to a specific Selloship courierId/name.
// When client ships with courier X, the system passes that Selloship courier
// in the waybill payload so Selloship routes via the correct carrier.
//
// GET  /api/selloship/mappings          — list all mappings
// POST /api/selloship/mappings          — create/update mapping for a courier
// GET  /api/selloship/mappings/:id      — get one mapping
// PATCH /api/selloship/mappings/:id     — update mapping
// DELETE /api/selloship/mappings/:id   — remove mapping (reverts to Selloship auto-route)

const { CourierSelloshipMapping, Courier } = require('../models/index');

// GET all mappings (with populated courier name)
router.get('/mappings', protect, adminOnly, async (req, res) => {
  try {
    const mappings = await CourierSelloshipMapping.find()
      .populate('courier', 'name code isActive')
      .populate('updatedBy', 'name email')
      .sort({ updatedAt: -1 });
    res.json({ success: true, mappings });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET one mapping by id
router.get('/mappings/:id', protect, adminOnly, async (req, res) => {
  try {
    const m = await CourierSelloshipMapping.findById(req.params.id)
      .populate('courier', 'name code');
    if (!m) return res.status(404).json({ success: false, message: 'Mapping not found' });
    res.json({ success: true, mapping: m });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST create or upsert mapping for a courier
// Body: { courierId, selloshipCourierId, selloshipCourierName, isAutoRoute, isActive, notes }
router.post('/mappings', protect, adminOnly, async (req, res) => {
  try {
    const { courierId, selloshipCourierId, selloshipCourierName, isAutoRoute, isActive, notes } = req.body;
    if (!courierId) return res.status(400).json({ success: false, message: 'courierId required' });

    const courier = await Courier.findById(courierId);
    if (!courier) return res.status(404).json({ success: false, message: 'Courier not found' });

    // Upsert by courier
    const mapping = await CourierSelloshipMapping.findOneAndUpdate(
      { courier: courierId },
      {
        courier:              courierId,
        selloshipCourierId:   selloshipCourierId   || '',
        selloshipCourierName: selloshipCourierName || '',
        isAutoRoute:          isAutoRoute          ?? false,
        isActive:             isActive             ?? true,
        notes:                notes                || '',
        updatedBy:            req.user._id,
        updatedAt:            new Date()
      },
      { upsert: true, new: true }
    );
    await mapping.populate('courier', 'name code');

    await logActivity(req.user._id, 'admin', 'SELLOSHIP_MAPPING_UPSERT', 'CourierSelloshipMapping',
      mapping._id, { courierId, selloshipCourierId, selloshipCourierName }, req.ip);

    res.status(201).json({ success: true, mapping });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH update existing mapping
router.patch('/mappings/:id', protect, adminOnly, async (req, res) => {
  try {
    const { selloshipCourierId, selloshipCourierName, isAutoRoute, isActive, notes } = req.body;
    const mapping = await CourierSelloshipMapping.findById(req.params.id);
    if (!mapping) return res.status(404).json({ success: false, message: 'Mapping not found' });

    if (selloshipCourierId   !== undefined) mapping.selloshipCourierId   = selloshipCourierId;
    if (selloshipCourierName !== undefined) mapping.selloshipCourierName = selloshipCourierName;
    if (isAutoRoute          !== undefined) mapping.isAutoRoute          = isAutoRoute;
    if (isActive             !== undefined) mapping.isActive             = isActive;
    if (notes                !== undefined) mapping.notes                = notes;
    mapping.updatedBy = req.user._id;
    mapping.updatedAt = new Date();
    await mapping.save();
    await mapping.populate('courier', 'name code');

    await logActivity(req.user._id, 'admin', 'SELLOSHIP_MAPPING_UPDATE', 'CourierSelloshipMapping',
      mapping._id, {}, req.ip);

    res.json({ success: true, mapping });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE mapping (courier reverts to Selloship auto-route)
router.delete('/mappings/:id', protect, adminOnly, async (req, res) => {
  try {
    const mapping = await CourierSelloshipMapping.findByIdAndDelete(req.params.id);
    if (!mapping) return res.status(404).json({ success: false, message: 'Mapping not found' });
    await logActivity(req.user._id, 'admin', 'SELLOSHIP_MAPPING_DELETE', 'CourierSelloshipMapping',
      mapping._id, {}, req.ip);
    res.json({ success: true, message: 'Mapping deleted. Courier will use Selloship auto-routing.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/selloship/unmapped-couriers  — couriers with no mapping yet (for admin setup UI)
router.get('/unmapped-couriers', protect, adminOnly, async (req, res) => {
  try {
    const mapped   = await CourierSelloshipMapping.distinct('courier');
    const unmapped = await Courier.find({ _id: { $nin: mapped }, isActive: true })
      .select('name code');
    res.json({ success: true, unmapped });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
