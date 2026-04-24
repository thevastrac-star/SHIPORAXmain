// utils/selloship.js — Selloship API Integration v4.0
//
// CHANGES vs v3.0 (derived from tester HTML analysis):
//
//   [FIX-D] invoiceCode added to Shipment block.
//           The tester sends invoiceCode inside Shipment{}; Selloship accepts it.
//           buildShipmentBlock() now includes it when present.
//           orderToPayloadParams() passes order.invoiceCode (falls back to orderId).
//
//   [FIX-E] currencyCode: 'INR' added to both forward and RVP payloads at root level.
//           The tester always includes it; omitting it causes silent failures on some accounts.
//
//   [FIX-F] courierID (uppercase "ID") is the canonical Selloship field name.
//           Confirmed via the tester's cURL builder which uses 'courierID'.
//           v3 used lowercase 'courierId'. Both spellings are now accepted in params,
//           but only the canonical uppercase 'courierID' is sent in the payload.
//
//   [KEPT]  All v3 fixes: weight "500.0000" format (FIX-A), serviceType omitted on
//           /waybill (FIX-B), separate builders for forward vs RVP (FIX-C),
//           auto-retry on 401, 55-min token caching, HMAC webhook verification.

const axios  = require('axios');
const crypto = require('crypto');

const BASE = 'https://selloship.com/api/lock_actvs/channels';

const TIMEOUT_AUTH     = 15000;
const TIMEOUT_SHIP     = 30000;
const TIMEOUT_TRACK    = 15000;
const TIMEOUT_CANCEL   = 15000;
const TIMEOUT_MANIFEST = 30000;

const _caches = {};

// ─── AUTH ────────────────────────────────────────────────────────────────────

async function getToken(username, password) {
  const cache = _caches[username] || {};
  if (cache.token && cache.expiry && Date.now() < cache.expiry) return cache.token;
  if (!username || !password)
    throw new Error('Selloship credentials not configured. Set them in Admin → Settings → Courier APIs.');
  const res = await axios.post(`${BASE}/authToken`, { username, password }, {
    headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_AUTH
  });
  if (res.data.status !== 'SUCCESS')
    throw new Error(`Selloship auth failed: ${JSON.stringify(res.data)}`);
  _caches[username] = { token: res.data.token, expiry: Date.now() + 55 * 60 * 1000 };
  return res.data.token;
}

function clearTokenCache(username) {
  if (username) delete _caches[username];
  else Object.keys(_caches).forEach(k => delete _caches[k]);
}

async function getCredentials() {
  const { Settings } = require('../models/index');
  const [u, p] = await Promise.all([
    Settings.findOne({ key: 'selloship.username' }),
    Settings.findOne({ key: 'selloship.password' })
  ]);
  return { username: u?.value, password: p?.value };
}

async function getSelloToken() {
  const { username, password } = await getCredentials();
  return getToken(username, password);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function authHeaders(token) {
  return { 'Content-Type': 'application/json', 'Authorization': token };
}

function validateFields(obj, required, context) {
  const missing = required.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) throw new Error(`[${context}] Missing required fields: ${missing.join(', ')}`);
}

async function safeCall(fn, username) {
  try { return await fn(); }
  catch (err) {
    if (err?.response?.status === 401) { clearTokenCache(username); return await fn(); }
    throw err;
  }
}

// [FIX-A] "500.0000" format — Selloship requires 4-decimal float string for weight
function gramsToStr(grams) {
  return parseFloat(grams).toFixed(4);
}

function buildAddr(addr) {
  return {
    name:     String(addr.name     || ''),
    email:    String(addr.email    || ''),
    phone:    String(addr.phone    || ''),
    address1: String(addr.address1 || ''),
    address2: String(addr.address2 || ''),
    city:     String(addr.city     || ''),
    state:    String(addr.state    || ''),
    pincode:  String(addr.pincode  || ''),
    country:  String(addr.country  || 'India')
  };
}

function buildDeliveryAddr(addr) {
  return { ...buildAddr(addr), alternatePhone: String(addr.alternatePhone || '') };
}

// [FIX-D] invoiceCode included when provided
function buildShipmentBlock(shipment) {
  validateFields(shipment, ['orderCode', 'weight', 'length', 'height', 'breadth', 'items'], 'shipment');
  if (!Array.isArray(shipment.items) || !shipment.items.length)
    throw new Error('[shipment.items] Must be a non-empty array');
  shipment.items.forEach((item, i) => {
    validateFields(item, ['name', 'quantity', 'skuCode', 'itemPrice'], `shipment.items[${i}]`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1)
      throw new Error(`[shipment.items[${i}].quantity] Must be a positive integer`);
  });

  const block = {
    orderCode: String(shipment.orderCode),
    weight:    gramsToStr(shipment.weight),  // [FIX-A]
    length:    String(shipment.length),
    height:    String(shipment.height),
    breadth:   String(shipment.breadth),
    items: shipment.items.map(item => ({
      name:      String(item.name),
      skuCode:   String(item.skuCode),
      category:  String(item.category || ''),
      quantity:  item.quantity,
      itemPrice: String(parseFloat(item.itemPrice).toFixed(2))
    }))
  };

  // [FIX-D] Include invoiceCode when present
  if (shipment.invoiceCode) block.invoiceCode = String(shipment.invoiceCode);

  return block;
}

function validateCommonParams(params) {
  const { shipment, deliveryAddress, pickupAddress, returnAddress, paymentMode, totalAmount, collectableAmount } = params;
  if (!shipment)        throw new Error('shipment is required');
  if (!deliveryAddress) throw new Error('deliveryAddress is required');
  if (!pickupAddress)   throw new Error('pickupAddress is required');
  if (!returnAddress)   throw new Error('returnAddress is required');
  if (!paymentMode)     throw new Error('paymentMode is required');
  if (totalAmount === undefined || totalAmount === null) throw new Error('totalAmount is required');
  if (collectableAmount === undefined || collectableAmount === null) throw new Error('collectableAmount is required');
  if (!['COD', 'PREPAID'].includes(paymentMode.toUpperCase()))
    throw new Error('paymentMode must be COD or PREPAID');
}

function validateAddresses(d, p, r) {
  const req = ['name', 'phone', 'address1', 'pincode', 'city', 'state', 'country'];
  validateFields(d, req, 'deliveryAddress');
  validateFields(p, req, 'pickupAddress');
  validateFields(r, req, 'returnAddress');
}

// ─── [FIX-C] FORWARD WAYBILL BUILDER (/waybill) ──────────────────────────────
// [FIX-B] serviceType NOT sent — invalid on /waybill
// [FIX-E] currencyCode: 'INR' added
// [FIX-F] courierID (uppercase) is canonical

function buildForwardPayload(params) {
  validateCommonParams(params);
  const {
    shipment, deliveryAddress, pickupAddress, returnAddress,
    paymentMode, totalAmount, collectableAmount,
    courierName = '',
    courierID = '', courierId = '',   // [FIX-F] accept both spellings
    isLablePdf = false
    // serviceType deliberately excluded — [FIX-B]
  } = params;
  validateAddresses(deliveryAddress, pickupAddress, returnAddress);

  return {
    Shipment:               buildShipmentBlock(shipment),
    isLablePdf,
    courierID:              String(courierID || courierId || ''),  // [FIX-F]
    courierName:            String(courierName || ''),
    currencyCode:           'INR',                                  // [FIX-E]
    paymentMode:            paymentMode.toUpperCase(),
    totalAmount:            String(parseFloat(totalAmount).toFixed(2)),
    collectableAmount:      String(parseFloat(collectableAmount).toFixed(2)),
    pickupAddressDetails:   buildAddr(pickupAddress),
    returnAddressDetails:   buildAddr(returnAddress),
    deliveryAddressDetails: buildDeliveryAddr(deliveryAddress)
  };
}

// ─── [FIX-C] REVERSE WAYBILL BUILDER (/waybillRVP) ───────────────────────────
// serviceType IS sent — required on RVP
// [FIX-E] currencyCode: 'INR' added
// [FIX-F] courierID (uppercase)

function buildRVPPayload(params) {
  validateCommonParams(params);
  const {
    shipment, deliveryAddress, pickupAddress, returnAddress,
    paymentMode, totalAmount, collectableAmount,
    courierName = '',
    courierID = '', courierId = '',   // [FIX-F]
    isLablePdf = false,
    serviceType = 'Surface'
  } = params;
  validateAddresses(deliveryAddress, pickupAddress, returnAddress);

  return {
    Shipment:               buildShipmentBlock(shipment),
    isLablePdf,
    courierID:              String(courierID || courierId || ''),  // [FIX-F]
    courierName:            String(courierName || ''),
    currencyCode:           'INR',                                  // [FIX-E]
    paymentMode:            paymentMode.toUpperCase(),
    serviceType:            serviceType || 'Surface',
    totalAmount:            String(parseFloat(totalAmount).toFixed(2)),
    collectableAmount:      String(parseFloat(collectableAmount).toFixed(2)),
    pickupAddressDetails:   buildAddr(pickupAddress),
    returnAddressDetails:   buildAddr(returnAddress),
    deliveryAddressDetails: buildDeliveryAddr(deliveryAddress)
  };
}

// Legacy alias — maps to forward builder
function buildWaybillPayload(params) { return buildForwardPayload(params); }

// ─── ORDER → PAYLOAD ADAPTER ─────────────────────────────────────────────────

function orderToPayloadParams(order, warehouse) {
  const pkg = order.package   || {};
  const rec = order.recipient || {};
  const wh  = warehouse       || {};

  const isCOD     = order.paymentMode === 'cod';
  const itemValue = Number(pkg.value || order.codAmount || 1);
  const codAmt    = isCOD ? Number(order.codAmount || 0) : 0;
  const weightGrams = Math.round(Math.max(parseFloat(pkg.weight) || 0.5, 0.01) * 1000);
  const cleanPhone = (p) => (p || '').replace(/\D/g, '').slice(-10);

  const errors = [];
  if (!rec.address && !rec.address1) errors.push('Delivery address1 is empty');
  if (!rec.pincode)                  errors.push('Delivery pincode is empty');
  if (!rec.city)                     errors.push('Delivery city is empty');
  if (!rec.state)                    errors.push('Delivery state is empty');
  if (!cleanPhone(rec.phone))        errors.push('Delivery phone is empty');
  if (!wh.address)                   errors.push('Pickup warehouse address is empty');
  if (!wh.pincode)                   errors.push('Pickup warehouse pincode is empty');
  if (!wh.city)                      errors.push('Pickup warehouse city is empty');
  if (!wh.state)                     errors.push('Pickup warehouse state is empty');
  if (!cleanPhone(wh.phone))         errors.push('Pickup warehouse phone is empty');
  if (errors.length) throw new Error('Order missing required fields: ' + errors.join('; '));

  const warehouseAddr = {
    name:     (wh.contactName || wh.name || 'Sender').substring(0, 100),
    email:    wh.email    || '',
    phone:    cleanPhone(wh.phone),
    address1: (wh.address || '').substring(0, 200),
    address2: wh.landmark || '',
    pincode:  String(wh.pincode),
    city:     wh.city,
    state:    wh.state,
    country:  'India'
  };

  return {
    shipment: {
      orderCode:   order.orderId,
      invoiceCode: order.invoiceCode || order.orderId,   // [FIX-D]
      weight:      weightGrams,
      length:      String(pkg.length  || 15),
      height:      String(pkg.height  || 10),
      breadth:     String(pkg.breadth || 15),
      items: [{
        name:      (pkg.description || 'Shipment').substring(0, 100),
        quantity:  1,
        skuCode:   String(order.orderId),
        itemPrice: itemValue,
        category:  ''
      }]
    },
    deliveryAddress: {
      name:           (rec.name || 'Customer').substring(0, 100),
      email:          rec.email    || '',
      phone:          cleanPhone(rec.phone),
      alternatePhone: '',
      address1:       (rec.address || rec.address1 || '').substring(0, 200),
      address2:       rec.landmark || '',
      pincode:        String(rec.pincode),
      city:           rec.city,
      state:          rec.state,
      country:        'India'
    },
    pickupAddress:     warehouseAddr,
    returnAddress:     warehouseAddr,
    paymentMode:       isCOD ? 'COD' : 'PREPAID',
    serviceType:       order.serviceType || 'Surface',
    totalAmount:       itemValue.toFixed(2),
    collectableAmount: codAmt.toFixed(2),
    courierID:         '',    // [FIX-F] canonical key
    courierName:       ''
  };
}

// ─── FORWARD WAYBILL ─────────────────────────────────────────────────────────

async function createWaybill(token, params) {
  const payload = buildForwardPayload(params);
  console.log('[Selloship createWaybill] payload:', JSON.stringify(payload, null, 2));
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybill`, payload, {
      headers: authHeaders(token), timeout: TIMEOUT_SHIP
    });
    console.log('[Selloship createWaybill] response:', JSON.stringify(res.data));
    if (res.data.status !== 'SUCCESS') {
      const msg    = res.data.message || res.data.msg || JSON.stringify(res.data);
      const reason = res.data.reason  || res.data.errorMessage || '';
      throw new Error(`Waybill failed: ${msg}${reason ? ' (' + reason + ')' : ''}`);
    }
    const raw = res.data;
    // Selloship may return label URL under different field names depending on courier
    const labelUrl = extractLabelUrl(raw);
    return {
      waybill:       raw.waybill || raw.Waybill || raw.waybillNumber || '',
      shippingLabel: labelUrl,
      courierName:   raw.courierName || raw.courier_name || raw.CourierName || '',
      routingCode:   raw.routingCode || raw.routing_code || ''
    };
  });
}

async function createReverseWaybill(token, params) {
  const payload = buildRVPPayload(params);
  console.log('[Selloship createReverseWaybill] payload:', JSON.stringify(payload, null, 2));
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybillRVP`, payload, {
      headers: authHeaders(token), timeout: TIMEOUT_SHIP
    });
    console.log('[Selloship createReverseWaybill] response:', JSON.stringify(res.data));
    if (res.data.status !== 'SUCCESS') {
      const msg    = res.data.message || res.data.msg || JSON.stringify(res.data);
      const reason = res.data.reason  || res.data.errorMessage || '';
      throw new Error(`RVP failed: ${msg}${reason ? ' (' + reason + ')' : ''}`);
    }
    const raw = res.data;
    const labelUrl = extractLabelUrl(raw);
    return {
      waybill:       raw.waybill || raw.Waybill || raw.waybillNumber || '',
      shippingLabel: labelUrl,
      courierName:   raw.courierName || raw.courier_name || raw.CourierName || '',
      routingCode:   raw.routingCode || raw.routing_code || ''
    };
  });
}

async function getWaybillStatus(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be non-empty array');
  if (awbNumbers.length > 50) throw new Error('Max 50 AWBs per call');
  return safeCall(async () => {
    const res = await axios.get(`${BASE}/waybillDetails`, {
      headers: authHeaders(token),
      params:  { waybills: awbNumbers.join(',') },
      timeout: TIMEOUT_TRACK
    });
    const status = res.data.Status || res.data.status;
    if (status !== 'SUCCESS') throw new Error(`Track failed: ${JSON.stringify(res.data)}`);
    return res.data.waybillDetails;
  });
}

// ─── CANCEL ──────────────────────────────────────────────────────────────────

async function cancelWaybill(token, awb) {
  if (!awb) throw new Error('AWB number is required');
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/cancel`, { waybill: String(awb) }, {
      headers: authHeaders(token), timeout: TIMEOUT_CANCEL
    });
    if (res.data.status !== 'SUCCESS')
      throw new Error(`Cancel failed: ${res.data.message || JSON.stringify(res.data)}`);
    return res.data;
  });
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────

async function generateManifest(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be non-empty array');
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/manifest`, { awbNumbers }, {
      headers: authHeaders(token), timeout: TIMEOUT_MANIFEST
    });
    if (res.data.status !== 'SUCCESS')
      throw new Error(`Manifest failed: ${res.data.message || JSON.stringify(res.data)}`);
    return res.data;
  });
}

// ─── SERVICEABILITY STUB ─────────────────────────────────────────────────────

async function getServiceability(token, params = {}) { return []; }

// ─── WEBHOOK HMAC VERIFICATION ───────────────────────────────────────────────

function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.SELLOSHIP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Selloship Webhook] SELLOSHIP_WEBHOOK_SECRET not set — skipping signature check');
    return true;
  }
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected)); }
  catch (_) { return false; }
}

// ─── EXTRACT LABEL URL from any Selloship response object ───────────────────
// Covers forward waybill, RVP, waybillDetails, and Amazon-specific field names
function extractLabelUrl(raw) {
  if (!raw || typeof raw !== 'object') return '';
  // Direct fields (standard + Amazon-specific)
  const direct =
    raw.shippingLabel  || raw.shipping_label  ||
    raw.label_url      || raw.labelUrl         || raw.LabelUrl      ||
    raw.ShippingLabel  || raw.label            || raw.pdf            || raw.pdfUrl        ||
    raw.printLabel     || raw.PrintLabel       || raw.amazonLabel    || raw.amazon_label  ||
    raw.labelLink      || raw.LabelLink        || raw.trackingLabel  || raw.labelPdfUrl   ||
    raw.shipmentLabel  || raw.ShipmentLabel    || '';
  if (direct) return direct;

  // Nested inside Shipment block (Amazon sometimes wraps it here)
  const nested = raw.Shipment || raw.shipment || raw.data || raw.result;
  if (nested && typeof nested === 'object') {
    const n =
      nested.shippingLabel || nested.label_url   || nested.labelUrl     || nested.LabelUrl  ||
      nested.ShippingLabel || nested.label        || nested.pdf          || nested.pdfUrl    ||
      nested.printLabel    || nested.amazonLabel  || nested.labelLink    || nested.labelPdfUrl || '';
    if (n) return n;
  }

  // waybillDetails array (track endpoint also returns label for Amazon)
  const details = raw.waybillDetails || raw.WaybillDetails;
  if (Array.isArray(details) && details.length) {
    const d0 = details[0];
    const dl =
      d0.shippingLabel || d0.label_url || d0.labelUrl || d0.LabelUrl ||
      d0.ShippingLabel || d0.label     || d0.pdf      || d0.pdfUrl   ||
      d0.printLabel    || d0.amazonLabel || d0.labelLink || '';
    if (dl) return dl;
  }

  return '';
}

// ─── FETCH LABEL URL (for orders where shippingLabel was empty in waybill response) ──
async function fetchLabelUrl(token, awb) {
  if (!awb) return null;

  const tryGet = async (url) => {
    try {
      const res = await axios.get(url, { headers: authHeaders(token), timeout: 15000 });
      return extractLabelUrl(res.data) || null;
    } catch (_) { return null; }
  };

  const tryPost = async (url, body) => {
    try {
      const res = await axios.post(url, body, { headers: authHeaders(token), timeout: 15000 });
      return extractLabelUrl(res.data) || null;
    } catch (_) { return null; }
  };

  // 1. waybillDetails (track) — Amazon returns label here
  const trackLabel = await tryPost(`${BASE}/waybillDetails`, { waybills: String(awb) })
    || await tryGet(`${BASE}/waybillDetails?waybill=${awb}`)
    || await tryGet(`${BASE}/waybillDetails?waybills=${awb}`);
  if (trackLabel) return trackLabel;

  // 2. Dedicated label endpoints
  const endpoints = [
    `${BASE}/label?waybill=${awb}`,
    `${BASE}/getLabel?waybill=${awb}`,
    `${BASE}/waybillLabel?waybill=${awb}`,
    `${BASE}/printLabel?waybill=${awb}`,
    `${BASE}/amazonLabel?waybill=${awb}`,
    `${BASE}/label/${awb}`,
  ];
  for (const url of endpoints) {
    const label = await tryGet(url);
    if (label) return label;
  }
  return null;
}

module.exports = {
  extractLabelUrl,
  BASE,
  getSelloToken,
  getCredentials,
  getToken,
  clearTokenCache,
  buildForwardPayload,
  buildRVPPayload,
  buildWaybillPayload,
  orderToPayloadParams,
  createWaybill,
  createReverseWaybill,
  fetchLabelUrl,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  getServiceability,
  verifyWebhookSignature
};
