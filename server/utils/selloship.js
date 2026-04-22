// utils/selloship.js — Selloship API Integration
// Based on official Selloship 2.0 API documentation.
// Endpoints confirmed from docs: authToken, waybill, waybillRVP,
// waybillDetails, cancel, manifest.
// NOTE: Selloship has NO serviceability/courier-listing endpoint.
// Courier selection is done by passing courierName + courierID in the
// waybill payload, or leaving blank for Selloship auto-routing.

const axios  = require('axios');
const crypto = require('crypto');

const BASE = 'https://selloship.com/api/lock_actvs/channels';

const TIMEOUT_AUTH     = 15000;
const TIMEOUT_SHIP     = 30000;
const TIMEOUT_TRACK    = 15000;
const TIMEOUT_CANCEL   = 15000;
const TIMEOUT_MANIFEST = 30000;

// Per-username token cache
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

// ─── PAYLOAD BUILDER ──────────────────────────────────────────────────────────
// Exactly matches official Selloship 2.0 API spec:
//   weight → string e.g. "500.0000" (grams)
//   courierID (capital ID, not courierId) → maps to doc field "courierID"
//   courierName → string
//   isLablePdf → boolean

function buildWaybillPayload(params) {
  const {
    shipment, deliveryAddress, pickupAddress, returnAddress,
    paymentMode, totalAmount, collectableAmount,
    courierName, courierId, isLablePdf = true
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

  // weight must be a string per official docs e.g. "500.0000"
  const weightStr = parseFloat(shipment.weight).toFixed(4);

  return {
    Shipment: {
      orderCode: String(shipment.orderCode),
      weight:    weightStr,           // string per spec: "500.0000"
      length:    String(shipment.length),
      height:    String(shipment.height),
      breadth:   String(shipment.breadth),
      items: shipment.items.map(item => ({
        name:      item.name,
        quantity:  item.quantity,
        skuCode:   item.skuCode,
        itemPrice: item.itemPrice,
        ...(item.category && { category: item.category })
      }))
    },
    deliveryAddressDetails: {
      name:     deliveryAddress.name,
      phone:    deliveryAddress.phone,
      address1: deliveryAddress.address1,
      pincode:  deliveryAddress.pincode,
      city:     deliveryAddress.city,
      state:    deliveryAddress.state,
      country:  deliveryAddress.country,
      ...(deliveryAddress.address2       && { address2:       deliveryAddress.address2 }),
      ...(deliveryAddress.email          && { email:          deliveryAddress.email }),
      ...(deliveryAddress.alternatePhone && { alternatePhone: deliveryAddress.alternatePhone })
    },
    pickupAddressDetails: {
      name:     pickupAddress.name,
      phone:    pickupAddress.phone,
      address1: pickupAddress.address1,
      pincode:  pickupAddress.pincode,
      city:     pickupAddress.city,
      state:    pickupAddress.state,
      country:  pickupAddress.country,
      ...(pickupAddress.address2 && { address2: pickupAddress.address2 }),
      ...(pickupAddress.email    && { email:    pickupAddress.email })
    },
    returnAddressDetails: {
      name:     returnAddress.name,
      phone:    returnAddress.phone,
      address1: returnAddress.address1,
      pincode:  returnAddress.pincode,
      city:     returnAddress.city,
      state:    returnAddress.state,
      country:  returnAddress.country,
      ...(returnAddress.address2 && { address2: returnAddress.address2 }),
      ...(returnAddress.email    && { email:    returnAddress.email })
    },
    paymentMode:       paymentMode.toUpperCase(),
    totalAmount:       String(totalAmount),
    collectableAmount: String(collectableAmount),
    isLablePdf,
    // Official doc field is "courierName" + "courierID" (capital ID)
    ...(courierName && { courierName }),
    ...(courierId   && { courierID: courierId })   // FIX: was courierId, must be courierID per spec
  };
}

// ─── ORDER → PAYLOAD PARAMS ADAPTER ──────────────────────────────────────────

function orderToPayloadParams(order, warehouse) {
  const pkg = order.package   || {};
  const rec = order.recipient || {};
  const wh  = warehouse       || {};

  const isCOD     = order.paymentMode === 'cod';
  // totalAmount must never be 0 — use codAmount for COD, or minimum 1
  const itemValue = Number(pkg.value || order.codAmount || 1);
  const codAmt    = isCOD ? Number(order.codAmount || 0) : 0;

  // weight: kg → grams, minimum 10g
  const weightGrams = parseFloat((Math.max(pkg.weight || 0.5, 0.01) * 1000).toFixed(4));

  // Clean phone: digits only, last 10
  const cleanPhone = (p) => (p || '').replace(/\D/g, '').slice(-10);

  // Validate critical fields before sending — surface clear errors
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

  return {
    shipment: {
      orderCode: order.orderId,
      weight:    weightGrams,
      length:    String(pkg.length  || 150),
      height:    String(pkg.height  || 100),
      breadth:   String(pkg.breadth || 100),
      items: [{
        name:      (pkg.description || 'Shipment').substring(0, 100),
        quantity:  1,
        skuCode:   String(order.orderId),
        itemPrice: itemValue
      }]
    },
    deliveryAddress: {
      name:     (rec.name || 'Customer').substring(0, 100),
      phone:    cleanPhone(rec.phone),
      address1: (rec.address || rec.address1 || '').substring(0, 200),
      address2: rec.landmark || undefined,
      pincode:  String(rec.pincode),
      city:     rec.city,
      state:    rec.state,
      country:  'India',
      ...(rec.email && { email: rec.email })
    },
    pickupAddress: {
      name:     (wh.contactName || wh.name || 'Sender').substring(0, 100),
      phone:    cleanPhone(wh.phone),
      address1: (wh.address || '').substring(0, 200),
      pincode:  String(wh.pincode),
      city:     wh.city,
      state:    wh.state,
      country:  'India',
      ...(wh.email && { email: wh.email })
    },
    returnAddress: {
      name:     (wh.contactName || wh.name || 'Sender').substring(0, 100),
      phone:    cleanPhone(wh.phone),
      address1: (wh.address || '').substring(0, 200),
      pincode:  String(wh.pincode),
      city:     wh.city,
      state:    wh.state,
      country:  'India',
      ...(wh.email && { email: wh.email })
    },
    paymentMode:       isCOD ? 'COD' : 'PREPAID',
    totalAmount:       itemValue.toFixed(2),
    collectableAmount: codAmt.toFixed(2)
  };
}

// ─── FORWARD WAYBILL ─────────────────────────────────────────────────────────

async function createWaybill(token, params) {
  const payload = buildWaybillPayload(params);
  console.log('[Selloship createWaybill] payload:', JSON.stringify(payload).slice(0, 400));
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybill`, payload, {
      headers: authHeaders(token), timeout: TIMEOUT_SHIP
    });
    console.log('[Selloship createWaybill] response:', JSON.stringify(res.data).slice(0, 300));
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
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybillRVP`, payload, {
      headers: authHeaders(token), timeout: TIMEOUT_SHIP
    });
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
// Endpoint: GET /waybillDetails?waybills=AWB1,AWB2

async function getWaybillStatus(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be non-empty array');
  if (awbNumbers.length > 50) throw new Error('Max 50 AWBs per call');
  return safeCall(async () => {
    const query = awbNumbers.join(',');
    const res   = await axios.get(`${BASE}/waybillDetails`, {
      headers: authHeaders(token),
      params:  { waybills: query },
      timeout: TIMEOUT_TRACK
    });
    if (res.data.Status !== 'SUCCESS') throw new Error(`Track failed: ${JSON.stringify(res.data)}`);
    return res.data.waybillDetails;
  });
}

// ─── CANCEL ──────────────────────────────────────────────────────────────────

async function cancelWaybill(token, awb) {
  if (!awb) throw new Error('AWB number is required');
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/cancel`, { waybill: awb },
      { headers: authHeaders(token), timeout: TIMEOUT_CANCEL });
    if (res.data.status !== 'SUCCESS') throw new Error(`Cancel failed: ${res.data.message}`);
    return res.data;
  });
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────

async function generateManifest(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be non-empty array');
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/manifest`, { awbNumbers },
      { headers: authHeaders(token), timeout: TIMEOUT_MANIFEST });
    if (res.data.status !== 'SUCCESS') throw new Error(`Manifest failed: ${res.data.message}`);
    return res.data;
  });
}

// ─── SERVICEABILITY ──────────────────────────────────────────────────────────
// Selloship has NO serviceability endpoint per official documentation.
// This stub returns empty array so existing callers don't break.
// Courier selection = pass courierName+courierID in waybill payload,
// or leave blank for Selloship auto-routing.

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
  buildWaybillPayload,
  orderToPayloadParams,
  createWaybill,
  createReverseWaybill,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  getServiceability,
  clearTokenCache,
  verifyWebhookSignature
};
