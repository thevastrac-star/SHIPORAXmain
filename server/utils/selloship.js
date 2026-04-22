// utils/selloship.js — Selloship API Integration v2.1
// Fixed against official CURL samples (Selloship 2.0 API):
//
// BUG FIXES vs v2.0:
//   [FIX-1]  serviceType "Air"/"Surface" was MISSING — caused "Insufficient parameters"
//   [FIX-2]  courierId field: CURL uses lowercase "courierId", not "courierID"
//   [FIX-3]  itemPrice must be a STRING "199.00", not a number — per CURL sample
//   [FIX-4]  Shipment.weight must be plain "500" string, NOT "500.0000"
//   [FIX-5]  address2 must ALWAYS be sent (empty string ""), not omitted
//   [FIX-6]  email must ALWAYS be sent in all address objects (empty string ok)
//   [FIX-7]  alternatePhone must ALWAYS be sent in deliveryAddressDetails
//   [FIX-8]  courierId/courierName must ALWAYS be sent (empty string ok, not omitted)

const axios  = require('axios');
const crypto = require('crypto');

const BASE = 'https://selloship.com/api/lock_actvs/channels';

const TIMEOUT_AUTH     = 15000;
const TIMEOUT_SHIP     = 30000;
const TIMEOUT_TRACK    = 15000;
const TIMEOUT_CANCEL   = 15000;
const TIMEOUT_MANIFEST = 30000;

// Per-username token cache (55-min TTL)
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

// ─── PAYLOAD BUILDER ─────────────────────────────────────────────────────────
//
// Built to EXACTLY match official Selloship CURL sample structure.
// Every field present in CURL is sent — empty string where optional but expected.
//
// CURL reference (waybillRVP):
// {
//   "Shipment": { orderCode, items[{name,skuCode,category,quantity,itemPrice}],
//                 height, length, breadth, weight },
//   "isLablePdf": false,
//   "courierId": "",           ← always sent, even if empty
//   "courierName": "",         ← always sent, even if empty
//   "paymentMode": "COD",
//   "serviceType": "Air",      ← REQUIRED, was missing before
//   "totalAmount": "199.00",
//   "collectableAmount": "199.00",
//   "pickupAddressDetails":   { name, email, phone, address1, address2, city, state, pincode, country },
//   "returnAddressDetails":   { name, email, phone, address1, address2, city, state, pincode, country },
//   "deliveryAddressDetails": { name, email, phone, alternatePhone, address1, address2,
//                               city, state, pincode, country }
// }

function buildWaybillPayload(params) {
  const {
    shipment,
    deliveryAddress,
    pickupAddress,
    returnAddress,
    paymentMode,
    totalAmount,
    collectableAmount,
    courierName   = '',
    courierId     = '',
    isLablePdf    = false,
    serviceType   = 'Surface'   // [FIX-1] REQUIRED field — "Air" or "Surface"
  } = params;

  if (!shipment)        throw new Error('shipment is required');
  if (!deliveryAddress) throw new Error('deliveryAddress is required');
  if (!pickupAddress)   throw new Error('pickupAddress is required');
  if (!returnAddress)   throw new Error('returnAddress is required');
  if (!paymentMode)     throw new Error('paymentMode is required');
  if (totalAmount === undefined || totalAmount === null) throw new Error('totalAmount is required');
  if (collectableAmount === undefined || collectableAmount === null)
    throw new Error('collectableAmount is required');

  if (!['COD','PREPAID'].includes(paymentMode.toUpperCase()))
    throw new Error('paymentMode must be COD or PREPAID');

  validateFields(shipment, ['orderCode','weight','length','height','breadth','items'], 'shipment');
  if (!Array.isArray(shipment.items) || !shipment.items.length)
    throw new Error('[shipment.items] Must be a non-empty array');

  shipment.items.forEach((item, i) => {
    validateFields(item, ['name','quantity','skuCode','itemPrice'], `shipment.items[${i}]`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1)
      throw new Error(`[shipment.items[${i}].quantity] Must be a positive integer`);
  });

  const addrReq = ['name','phone','address1','pincode','city','state','country'];
  validateFields(deliveryAddress, addrReq, 'deliveryAddress');
  validateFields(pickupAddress,   addrReq, 'pickupAddress');
  validateFields(returnAddress,   addrReq, 'returnAddress');

  // [FIX-4] weight as plain integer string "500", NOT "500.0000"
  const weightStr = String(Math.round(parseFloat(shipment.weight)));

  // [FIX-5,6] address builder — always includes email, address2 (empty string ok)
  const buildAddr = (addr) => ({
    name:     String(addr.name     || ''),
    email:    String(addr.email    || ''),
    phone:    String(addr.phone    || ''),
    address1: String(addr.address1 || ''),
    address2: String(addr.address2 || ''),
    city:     String(addr.city     || ''),
    state:    String(addr.state    || ''),
    pincode:  String(addr.pincode  || ''),
    country:  String(addr.country  || 'India')
  });

  // [FIX-7] deliveryAddress always includes alternatePhone
  const buildDeliveryAddr = (addr) => ({
    ...buildAddr(addr),
    alternatePhone: String(addr.alternatePhone || '')
  });

  return {
    Shipment: {
      orderCode: String(shipment.orderCode),
      // [FIX-4] weight as plain "500" not "500.0000"
      weight:  weightStr,
      length:  String(shipment.length),
      height:  String(shipment.height),
      breadth: String(shipment.breadth),
      items: shipment.items.map(item => ({
        name:      String(item.name),
        skuCode:   String(item.skuCode),
        category:  String(item.category || ''),
        quantity:  item.quantity,
        // [FIX-3] itemPrice as STRING "199.00" per CURL sample
        itemPrice: String(parseFloat(item.itemPrice).toFixed(2))
      }))
    },
    isLablePdf,
    // [FIX-2] lowercase "courierId" per CURL sample (not "courierID")
    // [FIX-8] always sent, even if empty string
    courierId:   String(courierId   || ''),
    courierName: String(courierName || ''),
    paymentMode: paymentMode.toUpperCase(),
    // [FIX-1] serviceType always sent — this was the main cause of "Insufficient parameters"
    serviceType: serviceType || 'Surface',
    totalAmount:       String(parseFloat(totalAmount).toFixed(2)),
    collectableAmount: String(parseFloat(collectableAmount).toFixed(2)),
    pickupAddressDetails:   buildAddr(pickupAddress),
    returnAddressDetails:   buildAddr(returnAddress),
    deliveryAddressDetails: buildDeliveryAddr(deliveryAddress)
  };
}

// ─── ORDER → PAYLOAD ADAPTER ─────────────────────────────────────────────────

function orderToPayloadParams(order, warehouse) {
  const pkg = order.package   || {};
  const rec = order.recipient || {};
  const wh  = warehouse       || {};

  const isCOD     = order.paymentMode === 'cod';
  const itemValue = Number(pkg.value || order.codAmount || 1);
  const codAmt    = isCOD ? Number(order.codAmount || 0) : 0;

  // kg → grams as integer (e.g. 0.5kg → 500), minimum 10g
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
      orderCode: order.orderId,
      weight:    weightGrams,  // integer grams — buildWaybillPayload will String() it
      length:    String(pkg.length  || 15),
      height:    String(pkg.height  || 10),
      breadth:   String(pkg.breadth || 15),
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
    courierId:         '',
    courierName:       ''
  };
}

// ─── FORWARD WAYBILL ─────────────────────────────────────────────────────────

async function createWaybill(token, params) {
  const payload = buildWaybillPayload(params);
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
    return {
      waybill:       res.data.waybill,
      shippingLabel: res.data.shippingLabel,
      courierName:   res.data.courierName,
      routingCode:   res.data.routingCode
    };
  });
}

// ─── REVERSE WAYBILL ─────────────────────────────────────────────────────────

async function createReverseWaybill(token, params) {
  const payload = buildWaybillPayload(params);
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
    return {
      waybill:       res.data.waybill,
      shippingLabel: res.data.shippingLabel,
      courierName:   res.data.courierName,
      routingCode:   res.data.routingCode
    };
  });
}

// ─── TRACK ───────────────────────────────────────────────────────────────────

async function getWaybillStatus(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be non-empty array');
  if (awbNumbers.length > 50) throw new Error('Max 50 AWBs per call');
  return safeCall(async () => {
    const res = await axios.get(`${BASE}/waybillDetails`, {
      headers: authHeaders(token),
      params:  { waybills: awbNumbers.join(',') },
      timeout: TIMEOUT_TRACK
    });
    // Selloship tracking response uses capital "Status"
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
// Selloship has NO serviceability endpoint — returns [] so callers don't break.

async function getServiceability(token, params = {}) {
  return [];
}

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

module.exports = {
  BASE,
  getSelloToken,
  getCredentials,
  getToken,
  clearTokenCache,
  buildWaybillPayload,
  orderToPayloadParams,
  createWaybill,
  createReverseWaybill,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  getServiceability,
  verifyWebhookSignature
};
