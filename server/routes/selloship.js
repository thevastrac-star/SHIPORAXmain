// routes/selloship.js — Selloship API routes
// Mount: app.use('/api/selloship', require('./routes/selloship'))

const express = require('express');
const router  = express.Router();
const Order   = require('../models/Order');
const { Warehouse } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const {
  getSelloToken,
  getCredentials,
  createWaybill,
  createReverseWaybill,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  buildWaybillPayload
} = require('../utils/selloship');

// ─── MIDDLEWARE: inject token ─────────────────────────────────────────────────
router.use(async (req, res, next) => {
  try {
    req.selloToken = await getSelloToken();
    next();
  } catch (err) {
    res.status(503).json({
      success: false,
      message: 'Selloship credentials not configured or auth failed. Go to Admin → Settings → Courier APIs.',
      detail: err.message
    });
  }
});

// ─── TEST CONNECTION ──────────────────────────────────────────────────────────
// GET /api/selloship/ping  — used by admin settings to verify credentials
router.get('/ping', protect, adminOnly, async (req, res) => {
  res.json({ success: true, message: 'Selloship credentials are valid ✅' });
});

// ─── LIST AVAILABLE COURIERS (shipping partners) ──────────────────────────────
// GET /api/selloship/couriers?pincode=400001&weight=0.5&paymentMode=prepaid
// Returns available courier options from Selloship so user can pick one
router.get('/couriers', protect, async (req, res) => {
  try {
    const { pincode, weight, paymentMode } = req.query;

    // Try to fetch serviceability / courier list from Selloship
    // Selloship exposes a serviceability check endpoint
    const axios = require('axios');
    const params = {
      pincode:     pincode || '',
      weight:      String(Math.round((parseFloat(weight) || 0.5) * 1000)),
      paymentMode: (paymentMode || 'prepaid').toUpperCase()
    };

    let couriers = [];
    try {
      const resp = await axios.get(`${require('../utils/selloship').BASE || 'https://selloship.com/api/lock_actvs/channels'}/serviceability`, {
        headers: { 'Content-Type': 'application/json', 'Authorization': req.selloToken },
        params,
        timeout: 15000
      });
      if (resp.data?.status === 'SUCCESS' && Array.isArray(resp.data?.couriers)) {
        couriers = resp.data.couriers;
      }
    } catch (_) {
      // Selloship may not have a public serviceability endpoint — return empty so
      // the frontend falls back to showing internal couriers
    }

    res.json({ success: true, couriers });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── SHIP ORDER (forward) ─────────────────────────────────────────────────────
// POST /api/selloship/ship/:orderId
// Body (optional): { courierId: "selloship_courier_id", courierName: "Delhivery" }
router.post('/ship/:orderId', protect, async (req, res) => {
  try {
    const query = req.user.role === 'admin'
      ? { _id: req.params.orderId }
      : { _id: req.params.orderId, user: req.user._id };

    const order = await Order.findOne(query).populate('assignedCourier');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (!['draft','processing'].includes(order.status))
      return res.status(400).json({ success: false, message: `Cannot ship order with status: ${order.status}` });

    // Get pickup warehouse
    let warehouse = null;
    if (order.pickupWarehouse) {
      warehouse = await Warehouse.findById(order.pickupWarehouse);
    }
    if (!warehouse) {
      warehouse = await Warehouse.findOne({ user: order.user, isDefault: true });
    }
    if (!warehouse) {
      return res.status(400).json({ success: false, message: 'No pickup warehouse found. Add a warehouse first.' });
    }

    const payload = buildWaybillPayload(order, warehouse);

    // ── Shipping partner selection ──────────────────────────────────────────
    // Client/admin can pass courierId (Selloship courier ID) + optional courierName
    // This tells Selloship which carrier to use for the shipment.
    if (req.body.courierId) {
      payload.courierId   = String(req.body.courierId);
      payload.courierName = req.body.courierName || '';
    }

    const result = await createWaybill(req.selloToken, payload);

    order.awbNumber = result.waybill;
    order.status    = 'shipped';
    order.selloship = {
      waybill:      result.waybill,
      courierName:  result.courierName || req.body.courierName || '',
      routingCode:  result.routingCode,
      labelUrl:     result.shippingLabel,
      shippedAt:    new Date()
    };
    await order.save();

    await logActivity(
      req.user._id, req.user.role, 'SELLOSHIP_SHIP', 'Order', order._id,
      { awb: result.waybill, courier: result.courierName }, req.ip
    );

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
// POST /api/selloship/reverse/:orderId
router.post('/reverse/:orderId', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.orderId, user: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    let warehouse = null;
    if (order.pickupWarehouse) warehouse = await Warehouse.findById(order.pickupWarehouse);
    if (!warehouse)            warehouse = await Warehouse.findOne({ user: order.user, isDefault: true });
    if (!warehouse) return res.status(400).json({ success: false, message: 'No warehouse found for return address' });

    const payload = buildWaybillPayload(order, warehouse);
    const result  = await createReverseWaybill(req.selloToken, payload);

    order.selloship = {
      ...( order.selloship?.toObject?.() || order.selloship || {} ),
      reverseWaybill: result.waybill,
      reverseLabelUrl: result.shippingLabel,
      reversedAt: new Date()
    };
    await order.save();

    res.json({ success: true, waybill: result.waybill, labelUrl: result.shippingLabel, order });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── TRACK ────────────────────────────────────────────────────────────────────
// GET /api/selloship/track?awbs=AWB1,AWB2
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
// POST /api/selloship/cancel/:orderId
router.post('/cancel/:orderId', protect, async (req, res) => {
  try {
    const query = req.user.role === 'admin'
      ? { _id: req.params.orderId }
      : { _id: req.params.orderId, user: req.user._id };

    const order = await Order.findOne(query);
    if (!order)             return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.awbNumber)   return res.status(400).json({ success: false, message: 'No AWB to cancel' });

    const result = await cancelWaybill(req.selloToken, order.awbNumber);

    order.status         = 'cancelled';
    order.cancelledAt    = new Date();
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
// POST /api/selloship/manifest   body: { orderIds: [...] }
router.post('/manifest', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds?.length) return res.status(400).json({ success: false, message: 'orderIds required' });

    const query = req.user.role === 'admin'
      ? { _id: { $in: orderIds } }
      : { _id: { $in: orderIds }, user: req.user._id };

    const orders  = await Order.find(query);
    const awbs    = orders.map(o => o.awbNumber).filter(Boolean);
    if (!awbs.length) return res.status(400).json({ success: false, message: 'No shipped orders with AWB found' });

    const result = await generateManifest(req.selloToken, awbs);
    res.json({ success: true, manifestNumber: result.manifestNumber, manifestUrl: result.manifestDownloadUrl });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── WEBHOOK (push from Selloship) ───────────────────────────────────────────
// POST /api/selloship/webhook   ← register this URL with Selloship team
router.post('/webhook', async (req, res) => {
  try {
    const { waybillDetails, Status } = req.body;

    if (Status !== 'SUCCESS' || !waybillDetails?.waybill) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const { waybill, currentStatus, statusDate } = waybillDetails;
    console.log(`[Selloship Webhook] AWB: ${waybill} → ${currentStatus} at ${statusDate}`);

    // Map Selloship status → our internal status
    const statusMap = {
      'READY_TO_SHIP':    'processing',    // Selloship accepted but not yet picked up
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
        {
          $set: {
            status: mappedStatus,
            'selloship.lastWebhookStatus': currentStatus,
            'selloship.lastWebhookAt': new Date()
          }
        }
      );
    }

    res.json({ received: true }); // Selloship expects 200
  } catch (err) {
    console.error('[Selloship Webhook Error]', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
