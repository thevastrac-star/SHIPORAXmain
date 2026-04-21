// utils/selloship.js — Selloship API Integration
// Payload matches official Waybill Generation API spec exactly.
// Credentials from DB Settings (keys: selloship.username, selloship.password)

const axios  = require('axios');
const crypto = require('crypto');

const BASE = 'https://selloship.com/api/lock_actvs/channels';

const TIMEOUT_AUTH     = 15000;
const TIMEOUT_SHIP     = 30000;
const TIMEOUT_TRACK    = 15000;
const TIMEOUT_CANCEL   = 15000;
const TIMEOUT_MANIFEST = 30000;

// Per-username token cache (FIX #18)
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
// Matches official Selloship API spec exactly:
//   Lv 4     Shipment: orderCode, weight (Float, grams, max 6 digits 4dp),
//             length/height/breadth (string, mm), items[]
//   Lv 4.13  items: name, quantity (int), skuCode, itemPrice (float), [category]
//   Lv 6     deliveryAddressDetails: name, phone, address1, [address2], pincode, city, state, country, [email, alternatePhone]
//   Lv 8     pickupAddressDetails:   name, phone, address1, [address2], pincode, city, state, country, [email]
//   Lv 10    returnAddressDetails:   same as pickup
//   Lv 12    paymentMode: "COD" | "PREPAID"
//   Lv 13    totalAmount: string "200.00"
//   Lv 14    collectableAmount: string "0.00" for PREPAID
//   Lv 15    courierName (opt)
//   Lv 16    courierId (opt)
//   Lv 17    isLablePdf: boolean (default true)

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
  if (!totalAmount)     throw new Error('totalAmount is required');
  if (collectableAmount === undefined || collectableAmount === null)
    throw new Error('collectableAmount is required');

  if (!['COD','PREPAID'].includes(paymentMode.toUpperCase()))
    throw new Error('paymentMode must be COD or PREPAID');

  validateFields(shipment, ['orderCode','weight','length','height','breadth','items'], 'shipment');
  if (!Array.isArray(shipment.items) || !shipment.items.length)
    throw new Error('[shipment.items] Must be a non-empty array');

  // Weight: max 6 total digits, 4 decimal places (spec 4.9)
  const wStr  = String(shipment.weight);
  const wMatch = wStr.match(/^(\d+)(\.\d+)?$/);
  if (!wMatch) throw new Error('[shipment.weight] Must be a positive number');
  const intP = wMatch[1], decP = wMatch[2] ? wMatch[2].slice(1) : '';
  if (intP.length + decP.length > 6) throw new Error('[shipment.weight] Max 6 total digits');
  if (decP.length > 4)               throw new Error('[shipment.weight] Max 4 decimal places');

  shipment.items.forEach((item, i) => {
    validateFields(item, ['name','quantity','skuCode','itemPrice'], `shipment.items[${i}]`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1)
      throw new Error(`[shipment.items[${i}].quantity] Must be a positive integer`);
  });

  const addrReq = ['name','phone','address1','pincode','city','state','country'];
  validateFields(deliveryAddress, addrReq, 'deliveryAddress');
  validateFields(pickupAddress,   addrReq, 'pickupAddress');
  validateFields(returnAddress,   addrReq, 'returnAddress');

  return {
    Shipment: {
      orderCode: shipment.orderCode,
      weight:    shipment.weight,
      length:    String(shipment.length),
      height:    String(shipment.height),
      breadth:   String(shipment.breadth),
      items: shipment.items.map(item => ({
        name: item.name, quantity: item.quantity,
        skuCode: item.skuCode, itemPrice: item.itemPrice,
        ...(item.category && { category: item.category })
      }))
    },
    deliveryAddressDetails: {
      name: deliveryAddress.name, phone: deliveryAddress.phone,
      address1: deliveryAddress.address1, pincode: deliveryAddress.pincode,
      city: deliveryAddress.city, state: deliveryAddress.state, country: deliveryAddress.country,
      ...(deliveryAddress.address2       && { address2:       deliveryAddress.address2 }),
      ...(deliveryAddress.email          && { email:          deliveryAddress.email }),
      ...(deliveryAddress.alternatePhone && { alternatePhone: deliveryAddress.alternatePhone })
    },
    pickupAddressDetails: {
      name: pickupAddress.name, phone: pickupAddress.phone,
      address1: pickupAddress.address1, pincode: pickupAddress.pincode,
      city: pickupAddress.city, state: pickupAddress.state, country: pickupAddress.country,
      ...(pickupAddress.address2 && { address2: pickupAddress.address2 }),
      ...(pickupAddress.email    && { email:    pickupAddress.email })
    },
    returnAddressDetails: {
      name: returnAddress.name, phone: returnAddress.phone,
      address1: returnAddress.address1, pincode: returnAddress.pincode,
      city: returnAddress.city, state: returnAddress.state, country: returnAddress.country,
      ...(returnAddress.address2 && { address2: returnAddress.address2 }),
      ...(returnAddress.email    && { email:    returnAddress.email })
    },
    paymentMode:       paymentMode.toUpperCase(),
    totalAmount:       String(totalAmount),
    collectableAmount: String(collectableAmount),
    isLablePdf,
    ...(courierName && { courierName }),
    ...(courierId   && { courierId })
  };
}

// ─── ORDER → PAYLOAD PARAMS ADAPTER ──────────────────────────────────────────
// Converts our internal Order + Warehouse documents into buildWaybillPayload params.
// Called from routes/orders.js shipViaSelloship().

function orderToPayloadParams(order, warehouse) {
  const pkg = order.package   || {};
  const rec = order.recipient || {};
  const wh  = warehouse       || {};

  const isCOD    = order.paymentMode === 'cod';
  const itemValue = Number(pkg.value || order.codAmount || 0);
  const codAmt    = isCOD ? Number(order.codAmount || 0) : 0;

  // weight: kg → grams, as Float with max 4dp
  const weightGrams = parseFloat(((pkg.weight || 0.5) * 1000).toFixed(4));

  return {
    shipment: {
      orderCode: order.orderId,
      weight:    weightGrams,
      length:    String(pkg.length  || 150),  // mm defaults
      height:    String(pkg.height  || 100),
      breadth:   String(pkg.breadth || 100),
      items: [{
        name:      pkg.description || 'Shipment',
        quantity:  1,
        skuCode:   order.orderId,
        itemPrice: itemValue
      }]
    },
    deliveryAddress: {
      name:     rec.name     || 'Customer',
      phone:    (rec.phone   || '').replace(/\D/g, '').slice(-10),
      address1: rec.address  || '',
      address2: rec.landmark || undefined,
      pincode:  rec.pincode  || '',
      city:     rec.city     || '',
      state:    rec.state    || '',
      country:  'India',
      email:    rec.email    || undefined
    },
    pickupAddress: {
      name:     wh.contactName || wh.name || 'Sender',
      phone:    (wh.phone || '').replace(/\D/g, '').slice(-10),
      address1: wh.address || '',
      pincode:  wh.pincode || '',
      city:     wh.city    || '',
      state:    wh.state   || '',
      country:  'India',
      email:    wh.email   || undefined
    },
    returnAddress: {
      name:     wh.contactName || wh.name || 'Sender',
      phone:    (wh.phone || '').replace(/\D/g, '').slice(-10),
      address1: wh.address || '',
      pincode:  wh.pincode || '',
      city:     wh.city    || '',
      state:    wh.state   || '',
      country:  'India',
      email:    wh.email   || undefined
    },
    paymentMode:       isCOD ? 'COD' : 'PREPAID',
    totalAmount:       itemValue.toFixed(2),
    collectableAmount: codAmt.toFixed(2)
  };
}

// ─── FORWARD WAYBILL ─────────────────────────────────────────────────────────

async function createWaybill(token, params) {
  const payload = buildWaybillPayload(params);
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybill`, payload, {
      headers: authHeaders(token), timeout: TIMEOUT_SHIP
    });
    if (res.data.status !== 'SUCCESS') {
      const msg    = res.data.message || res.data.msg || JSON.stringify(res.data);
      const reason = res.data.reason  || res.data.errorMessage || '';
      throw new Error(`Waybill failed: ${msg}${reason ? ' (' + reason + ')' : ''} (Something Went Wrong.)`);
    }
    return { waybill: res.data.waybill, shippingLabel: res.data.shippingLabel,
      courierName: res.data.courierName, routingCode: res.data.routingCode };
  });
}

// ─── REVERSE WAYBILL ─────────────────────────────────────────────────────────

async function createReverseWaybill(token, params) {
  const payload = buildWaybillPayload(params);
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybillRVP`, payload, {
      headers: authHeaders(token), timeout: TIMEOUT_SHIP
    });
    if (res.data.status !== 'SUCCESS')
      throw new Error(`RVP failed: ${res.data.message} (${res.data.reason})`);
    return { waybill: res.data.waybill, shippingLabel: res.data.shippingLabel,
      courierName: res.data.courierName, routingCode: res.data.routingCode };
  });
}

// ─── TRACK ───────────────────────────────────────────────────────────────────

async function getWaybillStatus(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be non-empty array');
  if (awbNumbers.length > 50) throw new Error('Max 50 AWBs per call');
  return safeCall(async () => {
    const query = awbNumbers.join(',');
    const res   = await axios.post(
      `${BASE}/waybillDetails?waybills=${encodeURIComponent(query)}`, {},
      { headers: authHeaders(token), timeout: TIMEOUT_TRACK }
    );
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

async function getServiceability(token, { pincode, weight, paymentMode } = {}) {
  const weightGrams = String(Math.round((parseFloat(weight) || 0.5) * 1000));
  const params = {
    pincode:     pincode || '',
    weight:      weightGrams,
    paymentMode: (paymentMode || 'PREPAID').toUpperCase()
  };
  let res;
  try {
    res = await axios.get(`${BASE}/serviceability`, {
      headers: authHeaders(token),
      params,
      timeout: TIMEOUT_TRACK
    });
  } catch (err) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Selloship serviceability] HTTP error:', msg);
    throw new Error('Selloship serviceability failed: ' + msg);
  }

  console.log('[Selloship serviceability] response:', JSON.stringify(res.data).slice(0, 600));

  const d = res.data;
  // Handle multiple possible response shapes
  const isSuccess = d?.status === 'SUCCESS' || d?.Status === 'SUCCESS';
  if (isSuccess) {
    const list = d.couriers || d.Couriers || d.data || d.courierList || [];
    if (Array.isArray(list)) return list;
    if (typeof list === 'object' && list !== null) return Object.values(list);
    return [];
  }
  const errMsg = d?.message || d?.Message || d?.error || JSON.stringify(d);
  throw new Error('Selloship serviceability: ' + errMsg);
}

// ─── WEBHOOK HMAC VERIFICATION (FIX #9) ─────────────────────────────────────

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
  buildWaybillPayload,     // for unit tests
  orderToPayloadParams,    // Order + Warehouse → buildWaybillPayload params
  createWaybill,
  createReverseWaybill,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  getServiceability,
  clearTokenCache,
  verifyWebhookSignature
};
