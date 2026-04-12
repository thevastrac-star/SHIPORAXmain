// selloship.js — Selloship API Integration
// Credentials loaded from DB Settings (keys: selloship.username, selloship.password)

const axios = require('axios');

const BASE = 'https://selloship.com/api/lock_actvs/channels';

// ─── AXIOS DEFAULTS ───────────────────────────────────────────────────────────
// Selloship API can be slow — use 30s timeouts throughout
const TIMEOUT_AUTH    = 15000;
const TIMEOUT_SHIP    = 30000;
const TIMEOUT_TRACK   = 15000;
const TIMEOUT_CANCEL  = 15000;
const TIMEOUT_MANIFEST= 30000;

let _cache = { token: null, expiry: null };

// ─── GET TOKEN (cached 55 min) ────────────────────────────────────────────────
async function getToken(username, password) {
  if (_cache.token && _cache.expiry && Date.now() < _cache.expiry) {
    return _cache.token;
  }
  if (!username || !password) throw new Error('Selloship credentials not configured. Set them in Admin → Settings → Courier APIs.');
  const res = await axios.post(`${BASE}/authToken`, { username, password }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: TIMEOUT_AUTH
  });
  if (res.data.status !== 'SUCCESS') throw new Error(`Selloship auth failed: ${JSON.stringify(res.data)}`);
  _cache.token = res.data.token;
  _cache.expiry = Date.now() + 55 * 60 * 1000;
  return _cache.token;
}

// Force token refresh (call when 401 received)
function clearTokenCache() {
  _cache = { token: null, expiry: null };
}

// ─── LOAD CREDENTIALS FROM DB ────────────────────────────────────────────────
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
function headers(token) {
  return { 'Content-Type': 'application/json', 'Authorization': token };
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    // If token expired mid-session, clear cache and retry once
    if (err?.response?.status === 401) {
      clearTokenCache();
      return await fn();
    }
    throw err;
  }
}

// ─── FORWARD WAYBILL ─────────────────────────────────────────────────────────
async function createWaybill(token, payload) {
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybill`, payload, { headers: headers(token), timeout: TIMEOUT_SHIP });
    if (res.data.status !== 'SUCCESS') throw new Error(`Waybill failed: ${res.data.message || res.data.reason}`);
    return res.data;
  });
}

// ─── REVERSE WAYBILL ─────────────────────────────────────────────────────────
async function createReverseWaybill(token, payload) {
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/waybillRVP`, payload, { headers: headers(token), timeout: TIMEOUT_SHIP });
    if (res.data.status !== 'SUCCESS') throw new Error(`RVP failed: ${res.data.message || res.data.reason}`);
    return res.data;
  });
}

// ─── TRACK WAYBILLS ──────────────────────────────────────────────────────────
async function getWaybillStatus(token, awbNumbers) {
  if (!Array.isArray(awbNumbers) || !awbNumbers.length) throw new Error('awbNumbers must be a non-empty array');
  if (awbNumbers.length > 50) throw new Error('Max 50 AWBs per call');
  return safeCall(async () => {
    const query = awbNumbers.map(a => encodeURIComponent(a)).join(',');
    const res = await axios.post(`${BASE}/waybillDetails?waybills=${query}`, {}, {
      headers: headers(token), timeout: TIMEOUT_TRACK
    });
    if (res.data.Status !== 'SUCCESS') throw new Error(`Track failed: ${JSON.stringify(res.data)}`);
    return res.data.waybillDetails;
  });
}

// ─── CANCEL WAYBILL ──────────────────────────────────────────────────────────
async function cancelWaybill(token, awb) {
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/cancel`, { waybill: awb }, { headers: headers(token), timeout: TIMEOUT_CANCEL });
    if (res.data.status !== 'SUCCESS') throw new Error(`Cancel failed: ${res.data.message}`);
    return res.data;
  });
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────
async function generateManifest(token, awbNumbers) {
  return safeCall(async () => {
    const res = await axios.post(`${BASE}/manifest`, { awbNumbers }, { headers: headers(token), timeout: TIMEOUT_MANIFEST });
    if (res.data.status !== 'SUCCESS') throw new Error(`Manifest failed: ${res.data.message}`);
    return res.data;
  });
}

// ─── BUILD WAYBILL PAYLOAD from Order ────────────────────────────────────────
// Converts our internal Order + Warehouse to Selloship's expected format
function buildWaybillPayload(order, warehouse) {
  const pkg = order.package || {};
  const rec = order.recipient || {};
  const wh  = warehouse || {};

  return {
    Shipment: {
      orderCode:   order.orderId,
      invoiceCode: order.orderId,
      weight:      String(Math.round((pkg.weight || 0.5) * 1000)), // kg → grams
      length:      String(pkg.length  || 15),  // mm
      height:      String(pkg.height  || 10),
      breadth:     String(pkg.breadth || 10),
      items: [{
        name:      pkg.description || 'Shipment',
        quantity:  1,
        skuCode:   order.orderId,
        itemPrice: pkg.value || order.codAmount || 0
      }]
    },
    pickupAddressDetails: {
      name:     wh.contactName || wh.name || 'Sender',
      email:    wh.email || '',
      phone:    (wh.phone || '').replace(/\D/g,'').slice(-10),
      address1: wh.address || '',
      city:     wh.city    || '',
      state:    wh.state   || '',
      pincode:  wh.pincode || '',
      country:  'India'
    },
    returnAddressDetails: {
      name:     wh.contactName || wh.name || 'Sender',
      email:    wh.email || '',
      phone:    (wh.phone || '').replace(/\D/g,'').slice(-10),
      address1: wh.address || '',
      city:     wh.city    || '',
      state:    wh.state   || '',
      pincode:  wh.pincode || '',
      country:  'India'
    },
    deliveryAddressDetails: {
      name:     rec.name     || '',
      email:    rec.email    || '',
      phone:    (rec.phone   || '').replace(/\D/g,'').slice(-10),
      address1: rec.address  || '',
      address2: rec.landmark || '',
      city:     rec.city     || '',
      state:    rec.state    || '',
      pincode:  rec.pincode  || '',
      country:  'India'
    },
    paymentMode:       order.paymentMode === 'cod' ? 'COD' : 'PREPAID',
    serviceType:       'Air',
    totalAmount:       String((pkg.value || order.codAmount || 0).toFixed(2)),
    collectableAmount: order.paymentMode === 'cod' ? String((order.codAmount || 0).toFixed(2)) : '0',
    currencyCode:      'INR',
    courierId:         '',
    courierName:       '',
    isLablePdf:        false
  };
}

module.exports = {
  getSelloToken,
  getCredentials,
  createWaybill,
  createReverseWaybill,
  getWaybillStatus,
  cancelWaybill,
  generateManifest,
  buildWaybillPayload,
  clearTokenCache
};
