// routes/shopify.js — Shopify OAuth 2026 multi-store integration
//
// ┌─ FLOW ──────────────────────────────────────────────────────────────────────
// │  1. Client clicks "Connect Shopify" → GET /api/shopify/auth?shop=x.myshopify.com
// │  2. We redirect to Shopify OAuth consent screen
// │  3. Shopify redirects to GET /api/shopify/callback?code=xxx&shop=xxx&hmac=xxx
// │  4. We exchange code → permanent access token
// │  5. Register webhooks (orders/create, orders/updated, app/uninstalled, etc.)
// │  6. Store ShopifyStore document in DB
// │
// │  Webhooks arrive at POST /api/shopify/webhook/:topic
// │  Fulfillment sync: POST /api/shopify/stores/:shop/fulfill/:orderId
// └─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const crypto   = require('crypto');
const axios    = require('axios');
const router   = express.Router();

const { protect, adminOnly } = require('../middleware/auth');
const Order        = require('../models/Order');
const User         = require('../models/User');
const ShopifyStore = require('../models/ShopifyStore');
const { Warehouse } = require('../models/index');

// ─── ENV / CONFIG ─────────────────────────────────────────────────────────────
const SHOPIFY_API_KEY     = process.env.SHOPIFY_API_KEY     || '';
const SHOPIFY_API_SECRET  = process.env.SHOPIFY_API_SECRET  || '';
const APP_URL             = process.env.APP_URL || process.env.API_URL || 'https://yourdomain.com';
const CALLBACK_URL        = `${APP_URL}/api/shopify/callback`;
const API_VERSION         = '2024-01';   // Shopify API version — bump annually

const REQUIRED_SCOPES = [
  'read_orders', 'write_orders',
  'read_fulfillments', 'write_fulfillments',
  'read_inventory', 'write_inventory',
  'read_products', 'write_products',
  'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'
].join(',');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function shopifyBase(shop) {
  return `https://${shop}/admin/api/${API_VERSION}`;
}

function validateShopDomain(shop) {
  return /^[a-zA-Z0-9\-]+\.myshopify\.com$/.test(shop);
}

// Verify Shopify HMAC for OAuth callback
function verifyOAuthHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac || !SHOPIFY_API_SECRET) return false;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac)); } catch { return false; }
}

// Verify Shopify webhook HMAC
function verifyWebhookHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_API_SECRET || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET)
    .update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader)); } catch { return false; }
}

// Map Shopify order → our Order document
async function mapShopifyOrder(shopifyOrder, userId, shop) {
  const addr   = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};
  const cust   = shopifyOrder.customer || {};
  const phone  = addr.phone || cust.phone || '';
  const isCOD  = (shopifyOrder.payment_gateway || '').toLowerCase().includes('cod') ||
                 shopifyOrder.financial_status === 'pending';
  const codAmt = isCOD ? parseFloat(shopifyOrder.total_price || 0) : 0;

  return {
    user:        userId,
    source:      'shopify',
    orderId:     null,   // will be set by DB trigger/autoSeed
    externalOrderId: String(shopifyOrder.id),
    recipient: {
      name:    addr.name || (cust.first_name ? `${cust.first_name} ${cust.last_name || ''}`.trim() : 'Customer'),
      phone:   phone.replace(/\D/g, '').slice(-10),
      email:   cust.email || '',
      address: [addr.address1, addr.address2].filter(Boolean).join(', '),
      city:    addr.city     || '',
      state:   addr.province || addr.province_code || '',
      pincode: addr.zip      || '',
      country: addr.country  || 'India'
    },
    package: {
      weight:      shopifyOrder.total_weight
        ? (shopifyOrder.total_weight / 1000)   // Shopify sends grams
        : 0.5,
      description: (shopifyOrder.line_items || []).map(i => i.name).join(', ').slice(0, 100),
      value:       parseFloat(shopifyOrder.total_price || 0)
    },
    paymentMode:  isCOD ? 'cod' : 'prepaid',
    codAmount:    codAmt,
    status:       'draft',
    shopifyOrderId:   String(shopifyOrder.id),
    shopifyOrderName: shopifyOrder.name,        // e.g. #1001
    shopifyShop:      shop,
    shopifyLineItems: (shopifyOrder.line_items || []).map(i => ({
      lineItemId: String(i.id),
      title:      i.name,
      sku:        i.sku || '',
      quantity:   i.quantity,
      price:      parseFloat(i.price || 0)
    }))
  };
}

// Register webhooks for a store
async function registerWebhooks(shop, token) {
  const topics = [
    'orders/create',
    'orders/updated',
    'fulfillments/create',
    'app/uninstalled'
  ];
  const registered = [];
  for (const topic of topics) {
    try {
      const r = await axios.post(
        `${shopifyBase(shop)}/webhooks.json`,
        { webhook: { topic, address: `${APP_URL}/api/shopify/webhook/${topic.replace('/', '_')}`, format: 'json' } },
        { headers: shopifyHeaders(token), timeout: 10000 }
      );
      registered.push({ topic, webhookId: String(r.data.webhook?.id || '') });
    } catch (err) {
      console.warn(`[Shopify] Failed to register webhook ${topic}:`, err.response?.data || err.message);
    }
  }
  return registered;
}

// ─── STEP 1: INITIATE OAUTH ───────────────────────────────────────────────────
// GET /api/shopify/auth?shop=mystore.myshopify.com
// Called from client integrations page — user must be logged in
router.get('/auth', protect, (req, res) => {
  const shop  = (req.query.shop || '').toLowerCase().trim();
  if (!shop) return res.status(400).json({ success: false, message: 'shop param required (e.g. yourstore.myshopify.com)' });
  if (!validateShopDomain(shop)) return res.status(400).json({ success: false, message: 'Invalid Shopify shop domain' });
  if (!SHOPIFY_API_KEY) return res.status(500).json({ success: false, message: 'SHOPIFY_API_KEY not configured in .env' });

  // Encode userId in state so we can retrieve it after redirect
  const state = Buffer.from(JSON.stringify({ uid: String(req.user._id), shop })).toString('base64url');
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${REQUIRED_SCOPES}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&state=${state}`;
  res.json({ success: true, authUrl });
});

// ─── STEP 2: OAUTH CALLBACK ───────────────────────────────────────────────────
// GET /api/shopify/callback — Shopify redirects here after merchant approves
router.get('/callback', async (req, res) => {
  try {
    const { code, shop, state, hmac } = req.query;

    // Verify HMAC
    if (!verifyOAuthHmac(req.query))
      return res.status(403).send('<h2>Invalid HMAC. Request may be tampered.</h2>');

    if (!validateShopDomain(shop))
      return res.status(400).send('<h2>Invalid shop domain.</h2>');

    // Decode state to recover user
    let userId, stateShop;
    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
      userId = parsed.uid; stateShop = parsed.shop;
    } catch {
      return res.status(400).send('<h2>Invalid state parameter.</h2>');
    }
    if (stateShop !== shop)
      return res.status(400).send('<h2>Shop mismatch in state.</h2>');

    const user = await User.findById(userId);
    if (!user) return res.status(404).send('<h2>User not found. Please log in again.</h2>');

    // Exchange code for permanent access token
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      { client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code },
      { timeout: 15000 }
    );
    const { access_token: accessToken, scope: scopes } = tokenRes.data;
    if (!accessToken) return res.status(500).send('<h2>Failed to get access token from Shopify.</h2>');

    // Register webhooks
    const webhooks = await registerWebhooks(shop, accessToken);

    // Save/update store
    await ShopifyStore.findOneAndUpdate(
      { shop },
      { user: userId, shop, accessToken, scopes, isActive: true, webhooks, installedAt: new Date(), uninstalledAt: null },
      { upsert: true, new: true }
    );

    // Redirect back to client panel with success flag
    res.redirect(`/client?shopify_connected=1&shop=${encodeURIComponent(shop)}`);
  } catch (err) {
    console.error('[Shopify callback error]', err.message);
    res.status(500).send(`<h2>Shopify connection failed: ${err.message}</h2>`);
  }
});

// ─── WEBHOOKS ─────────────────────────────────────────────────────────────────
// POST /api/shopify/webhook/:topic
// Raw body is available because server.js adds express.raw() for /api/shopify/webhook
router.post('/webhook/:topic', express.raw({ type: '*/*' }), async (req, res) => {
  const shop     = req.headers['x-shopify-shop-domain'] || '';
  const hmacHdr  = req.headers['x-shopify-hmac-sha256'] || '';
  const rawBody  = req.body;                       // Buffer

  // Verify HMAC
  if (!verifyWebhookHmac(rawBody, hmacHdr)) {
    console.warn('[Shopify webhook] Invalid HMAC from', shop);
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');   // Respond immediately — process async

  let payload;
  try { payload = JSON.parse(rawBody.toString()); } catch { return; }

  const topic = req.params.topic;

  const store = await ShopifyStore.findOne({ shop, isActive: true }).catch(() => null);
  if (!store && topic !== 'app_uninstalled') return;

  try {
    if (topic === 'orders_create') {
      await handleOrderCreate(payload, store);
    } else if (topic === 'orders_updated') {
      await handleOrderUpdated(payload, store);
    } else if (topic === 'app_uninstalled') {
      await ShopifyStore.findOneAndUpdate({ shop }, { isActive: false, uninstalledAt: new Date() });
      console.log(`[Shopify] Store uninstalled: ${shop}`);
    }
  } catch (err) {
    console.error(`[Shopify webhook ${topic}]`, err.message);
    if (store) {
      store.syncErrors.push({ message: `webhook ${topic}: ${err.message}` });
      if (store.syncErrors.length > 50) store.syncErrors = store.syncErrors.slice(-50);
      await store.save().catch(() => {});
    }
  }
});

async function handleOrderCreate(shopifyOrder, store) {
  const exists = await Order.findOne({ shopifyOrderId: String(shopifyOrder.id), shopifyShop: store.shop });
  if (exists) return;   // deduplicate

  const orderData = await mapShopifyOrder(shopifyOrder, store.user, store.shop);

  // Generate orderId via existing sequence logic
  const user = await User.findById(store.user);
  const prefix = (user?.orderPrefix || 'ORD').toUpperCase();
  const { OrderCounter } = require('../models/index');
  const counter = await OrderCounter.findOneAndUpdate(
    { prefix }, { $inc: { seq: 1 } }, { upsert: true, new: true }
  );
  orderData.orderId = `${prefix}${String(counter.seq).padStart(6, '0')}`;

  await Order.create(orderData);
  store.lastOrderSync = new Date();
  store.totalSynced   = (store.totalSynced || 0) + 1;
  await store.save();
  console.log(`[Shopify] New order synced: ${orderData.orderId} (${shopifyOrder.name})`);
}

async function handleOrderUpdated(shopifyOrder, store) {
  // Update matching order if it exists and hasn't been processed
  await Order.findOneAndUpdate(
    { shopifyOrderId: String(shopifyOrder.id), shopifyShop: store.shop, status: 'draft' },
    { $set: { 'package.value': parseFloat(shopifyOrder.total_price || 0) } }
  );
}

// ─── MANUAL SYNC ─────────────────────────────────────────────────────────────
// POST /api/shopify/stores/:shop/sync
// Pulls recent unfulfilled orders from Shopify and upserts them
router.post('/stores/:shop/sync', protect, async (req, res) => {
  try {
    const shop  = req.params.shop;
    const store = await ShopifyStore.findOne({ shop, user: req.user._id, isActive: true });
    if (!store) return res.status(404).json({ success: false, message: 'Store not found or not connected' });

    const r = await axios.get(
      `${shopifyBase(shop)}/orders.json?status=open&fulfillment_status=unfulfilled&limit=50`,
      { headers: shopifyHeaders(store.accessToken), timeout: 20000 }
    );
    const orders = r.data.orders || [];
    let synced = 0, skipped = 0;

    const user = await User.findById(req.user._id);
    const prefix = (user?.orderPrefix || 'ORD').toUpperCase();
    const { OrderCounter } = require('../models/index');

    for (const so of orders) {
      const exists = await Order.findOne({ shopifyOrderId: String(so.id), shopifyShop: shop });
      if (exists) { skipped++; continue; }
      const orderData = await mapShopifyOrder(so, req.user._id, shop);
      const counter   = await OrderCounter.findOneAndUpdate(
        { prefix }, { $inc: { seq: 1 } }, { upsert: true, new: true }
      );
      orderData.orderId = `${prefix}${String(counter.seq).padStart(6, '0')}`;
      await Order.create(orderData);
      synced++;
    }

    store.lastOrderSync = new Date();
    store.totalSynced   = (store.totalSynced || 0) + synced;
    await store.save();

    res.json({ success: true, synced, skipped, total: orders.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── FULFILLMENT SYNC (Our Panel → Shopify) ───────────────────────────────────
// POST /api/shopify/stores/:shop/fulfill/:orderId
// Called automatically after AWB generation; also callable manually
router.post('/stores/:shop/fulfill/:orderId', protect, async (req, res) => {
  try {
    const { shop, orderId } = req.params;
    const store = await ShopifyStore.findOne({ shop, isActive: true });
    if (!store) return res.status(404).json({ success: false, message: 'Shopify store not connected' });

    const order = await Order.findOne({ _id: orderId, shopifyOrderId: { $exists: true, $ne: null } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found or not from Shopify' });
    if (!order.awbNumber) return res.status(400).json({ success: false, message: 'No AWB yet. Book shipment first.' });

    const shopifyOrderId = order.shopifyOrderId;
    const courierName    = order.selloship?.courierName || req.body.courierName || 'Shiporax';
    const trackingNumber = order.awbNumber;
    const trackingUrl    = req.body.trackingUrl || `${APP_URL}/track/${trackingNumber}`;

    // Get fulfillment order ID from Shopify
    const foRes = await axios.get(
      `${shopifyBase(shop)}/orders/${shopifyOrderId}/fulfillment_orders.json`,
      { headers: shopifyHeaders(store.accessToken), timeout: 15000 }
    );
    const fulfillmentOrders = foRes.data.fulfillment_orders || [];
    const openFO = fulfillmentOrders.find(fo => fo.status === 'open');
    if (!openFO) return res.status(400).json({ success: false, message: 'No open fulfillment order on Shopify' });

    // Create fulfillment
    const fulfillBody = {
      fulfillment: {
        line_items_by_fulfillment_order: [{
          fulfillment_order_id: openFO.id,
          fulfillment_order_line_items: openFO.line_items.map(li => ({
            id: li.id, quantity: li.remaining_quantity
          }))
        }],
        tracking_info: {
          company: courierName,
          number:  trackingNumber,
          url:     trackingUrl
        },
        notify_customer: true
      }
    };

    const fulfillRes = await axios.post(
      `${shopifyBase(shop)}/fulfillments.json`,
      fulfillBody,
      { headers: shopifyHeaders(store.accessToken), timeout: 15000 }
    );

    const fulfillment = fulfillRes.data.fulfillment;
    await Order.findByIdAndUpdate(orderId, {
      $set: {
        'shopifyFulfillmentId':     String(fulfillment?.id || ''),
        'shopifyFulfillmentStatus': fulfillment?.status || 'success'
      }
    });

    res.json({ success: true, fulfillmentId: fulfillment?.id, status: fulfillment?.status });
  } catch (err) {
    const detail = err.response?.data?.errors || err.message;
    res.status(500).json({ success: false, message: 'Shopify fulfillment failed', detail });
  }
});

// ─── GET CONNECTED STORES (client: own stores, admin: all) ───────────────────
router.get('/stores', protect, async (req, res) => {
  try {
    const filter = req.user.role === 'admin' ? {} : { user: req.user._id };
    const stores = await ShopifyStore.find(filter)
      .populate('user', 'name email')
      .sort({ installedAt: -1 })
      .lean();
    res.json({ success: true, stores });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DISCONNECT A STORE ───────────────────────────────────────────────────────
router.delete('/stores/:shop', protect, async (req, res) => {
  try {
    const filter = { shop: req.params.shop };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    await ShopifyStore.findOneAndUpdate(filter, { isActive: false, uninstalledAt: new Date() });
    res.json({ success: true, message: 'Store disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: STORES LIST + SYNC LOGS ──────────────────────────────────────────
router.get('/admin/stores', protect, adminOnly, async (req, res) => {
  try {
    const stores = await ShopifyStore.find()
      .populate('user', 'name email')
      .sort({ installedAt: -1 }).lean();
    res.json({ success: true, stores });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
