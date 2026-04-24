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
  getSelloToken, orderToPayloadParams, createWaybill, fetchLabelUrl
} = require('../utils/selloship');
const shippingQueue = require('../utils/shippingQueue');
const axios    = require('axios');
const archiver = require('archiver');

// ─── INLINE Code128 BARCODE GENERATOR (no external dep) ─────────────────────
const _C128_PATTERNS = [
  '11011001100','11001101100','11001100110','10010011000','10010001100',
  '10001001100','10011001000','10011000100','10001100100','11001001000',
  '11001000100','11000100100','10110011100','10011011100','10011001110',
  '10111001100','10011101100','10011100110','11001110010','11001011100',
  '11001001110','11011100100','11001110100','11101101110','11101001100',
  '11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000',
  '10001000110','10110001000','10001101000','10001100010','11010001000',
  '11000101000','11000100010','10110111000','10110001110','10001101110',
  '10111011000','10111000110','10001110110','11101110110','11010001110',
  '11000101110','11011101000','11011100010','11011101110','11101011000',
  '11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100',
  '10010110000','10010000110','10000101100','10000100110','10110010000',
  '10110000100','10011010000','10011000010','10000110100','10000110010',
  '11000010010','11001010000','11110111010','11000010100','10001111010',
  '10100111100','10010111100','10010011110','10111100100','10011110100',
  '10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110',
  '10111101000','10111100010','11110101000','11110100010','10111011110',
  '10111101110','11101011110','11110101110','11010000100','11010010000',
  '11010011100','11000111010'
];
function generateBarcodeSVG(text, opts = {}) {
  const bw = opts.barWidth || 2, h = opts.height || 60, fs = opts.fontSize || 11;
  const col = opts.color || '#000';
  const vals = [104]; let ck = 104;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) - 32;
    if (code < 0 || code > 95) continue;
    vals.push(code); ck += code * (i + 1);
  }
  vals.push(ck % 103); vals.push(106);
  const quiet = '0000000000';
  const bits  = quiet + vals.map(v => _C128_PATTERNS[v]).join('') + '11' + quiet;
  const W = bits.length * bw, totalH = h + fs + 6;
  let bars = ''; let i = 0;
  while (i < bits.length) {
    const bit = bits[i]; let j = i;
    while (j < bits.length && bits[j] === bit) j++;
    const w = (j - i) * bw;
    if (bit === '1') bars += `<rect x="${i*bw}" y="0" width="${w}" height="${h}" fill="${col}"/>`;
    i = j;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">${bars}<text x="${W/2}" y="${h+fs+2}" text-anchor="middle" font-family="monospace" font-size="${fs}" fill="${col}">${text}</text></svg>`;
}
// ─────────────────────────────────────────────────────────────────────────────


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
  let labelUrl = result.shippingLabel;
  if (!labelUrl && result.waybill) {
    try { labelUrl = await fetchLabelUrl(token, result.waybill); } catch (_) {}
  }
  return { awbNumber: result.waybill, labelUrl: labelUrl || '',
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

      // If label URL was not in waybill response (common with Amazon Shipping),
      // try to fetch it from Selloship label endpoint
      let labelUrl = shipped.labelUrl;
      if (!labelUrl && shipped.awbNumber) {
        try {
          const tok = await getSelloToken();
          labelUrl = await fetchLabelUrl(tok, shipped.awbNumber);
        } catch (_) {}
      }

      updatedOrder.selloship = { waybill: shipped.awbNumber, courierName: shipped.courierName,
        routingCode: shipped.routingCode, labelUrl: labelUrl || '', shippedAt: new Date() };
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
function buildLabelHtml(o, opts = {}) {
  const isCOD  = o.paymentMode === 'cod';
  const wh     = o.pickupWarehouse || {};
  const c      = o.assignedCourier || {};
  const r      = o.recipient || {};
  const pkg    = o.package || {};
  const bc     = '#0D1B3E';
  const awb    = o.awbNumber || o.orderId || '';
  const size   = (opts && opts.labelSize) || 'a4';
  const isA4   = size === 'a4';
  const labelW = isA4 ? '190mm' : '96mm';
  const fz     = isA4 ? '9pt' : '8pt';

  // Amazon / Selloship label — embed as iframe with info header
  if (o.selloship && o.selloship.labelUrl) {
    const isAmazon = /^\d{12}$/.test(awb);
    return '<div style="font-family:Arial,sans-serif;margin-bottom:6mm;page-break-inside:avoid;width:' + labelW + ';max-width:' + labelW + '">' +
      '<div style="background:#f8f8f8;border:1px solid #ddd;padding:3mm;margin-bottom:2mm;border-radius:4px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2mm">' +
          '<b style="color:' + bc + ';font-size:' + (isA4?'10pt':'8.5pt') + '">' + (isAmazon?'Amazon Shipping':'Selloship Label') + '</b>' +
          (isCOD ? '<span style="background:#c00;color:#fff;padding:2px 7px;border-radius:3px;font-weight:bold;font-size:8pt">COD &#8377;' + (o.codAmount||0) + '</span>'
                 : '<span style="background:#059669;color:#fff;padding:2px 7px;border-radius:3px;font-weight:bold;font-size:8pt">PREPAID</span>') +
        '</div>' +
        '<div style="font-size:7pt;color:#555">AWB: <b>' + awb + '</b> &nbsp;|&nbsp; Order: ' + o.orderId + '</div>' +
        '<div style="font-size:7pt;color:#555;margin-top:1mm">To: ' + (r.name||'') + ', ' + (r.city||'') + ' - ' + (r.pincode||'') + '</div>' +
      '</div>' +
      '<iframe src="' + o.selloship.labelUrl + '" style="width:100%;height:' + (isA4?'420px':'340px') + ';border:1.5px solid #ccc;border-radius:4px" title="Shipping Label"></iframe>' +
      '<div style="font-size:6pt;color:#999;margin-top:2px"><a href="' + o.selloship.labelUrl + '" target="_blank">Open in new tab</a></div>' +
    '</div>';
  }

  // Self-generated barcode label
  const barcodeSvg = generateBarcodeSVG(awb, { barWidth: isA4?2:1.6, height: isA4?55:40, showText: true, fontSize: isA4?10:9 });
  const barcodeB64 = Buffer.from(barcodeSvg).toString('base64');
  const barcodeImg = '<img src="data:image/svg+xml;base64,' + barcodeB64 + '" style="width:100%;max-width:' + (isA4?'150px':'120px') + ';display:block;margin:0 auto" alt="AWB"/>';

  return '<div style="font-family:Arial,sans-serif;font-size:' + fz + ';padding:' + (isA4?'4mm':'3mm') + ';border:2px solid #000;background:#fff;line-height:1.45;width:' + labelW + ';max-width:' + labelW + ';box-sizing:border-box;page-break-inside:avoid;margin-bottom:4mm">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #ccc;padding-bottom:3mm;margin-bottom:3mm">' +
      '<div style="font-weight:bold;font-size:' + (isA4?'11pt':'9pt') + ';color:' + bc + '">SHIPORAX</div>' +
      (isCOD ? '<div style="background:#c00;color:#fff;padding:3px 8px;border-radius:3px;font-weight:bold;font-size:9pt">COD &#8377;' + (o.codAmount||0) + '</div>'
             : '<div style="background:#059669;color:#fff;padding:3px 8px;border-radius:3px;font-weight:bold;font-size:9pt">PREPAID</div>') +
    '</div>' +
    '<div style="margin-bottom:3mm">' +
      '<div style="font-size:6pt;color:#666;text-transform:uppercase;font-weight:bold">Ship To:</div>' +
      '<div style="font-weight:bold;font-size:' + (isA4?'11pt':'9pt') + '">' + (r.name||'') + '</div>' +
      '<div style="font-size:' + (isA4?'8.5pt':'7.5pt') + '">' + (r.address||'') + (r.city?', '+r.city:'') + (r.state?', '+r.state:'') + '</div>' +
      '<div style="font-size:' + (isA4?'8pt':'7pt') + '">Ph: ' + (r.phone||'') + '</div>' +
      '<div style="font-size:' + (isA4?'9pt':'8pt') + ';font-weight:bold;margin-top:1mm">' + (r.pincode||'') + '</div>' +
    '</div>' +
    '<div style="border:1.5px solid #000;padding:' + (isA4?'3mm':'2mm') + ';text-align:center;margin-bottom:3mm;background:#fafafa">' +
      barcodeImg +
      '<div style="font-size:6pt;color:#555;margin-top:1mm;font-family:monospace">' + awb + '</div>' +
      '<div style="font-size:5.5pt;color:#888">Order: ' + new Date(o.createdAt||Date.now()).toLocaleDateString('en-IN') + ' | ' + o.orderId + '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;font-size:' + (isA4?'7.5pt':'7pt') + ';border-top:1px solid #ccc;padding-top:2mm;margin-bottom:2mm">' +
      '<div><div style="font-weight:bold;color:' + bc + '">' + (c.name||'Auto-Selected') + '</div>' + (o.selloship&&o.selloship.routingCode?'<div style="font-size:6pt;color:#888">'+o.selloship.routingCode+'</div>':'') + '</div>' +
      '<div style="text-align:right"><div style="font-weight:600">Wt: ' + (pkg.weight||'—') + ' kg</div>' + (pkg.length?'<div style="font-size:6pt;color:#888">'+pkg.length+'x'+pkg.breadth+'x'+pkg.height+' cm</div>':'') + '</div>' +
    '</div>' +
    (wh.name ? '<div style="border-top:1px solid #ccc;padding-top:2mm;font-size:' + (isA4?'7pt':'6.5pt') + '"><div style="font-weight:bold;color:#444">From / Return:</div><div>' + (wh.contactName||wh.name) + '</div><div>' + (wh.address||'') + ' ' + (wh.pincode||'') + '</div>' + (wh.phone?'<div>Ph: '+wh.phone+'</div>':'') + '</div>' : '') +
    '<div style="border-top:1px solid #eee;padding-top:2mm;margin-top:2mm;font-size:5.5pt;color:#999">This is a computer generated document.</div>' +
  '</div>';
}


router.get('/job-status/:jobId', protect, (req, res) => {
  const status = shippingQueue.status(req.params.jobId);
  if (!status) return res.status(404).json({ success: false, message: 'Job not found or expired' });
  res.json({ success: true, ...status });
});

// ─── [FIX-LABEL-1] POST /bulk-labels — MISSING ENDPOINT NOW ADDED ─────────────
router.post('/bulk-labels', protect, async (req, res) => {
  try {
    const { orderIds, labelSize = 'a4' } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs' });
    const filter = { _id: { $in: orderIds } };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const orders = await Order.find(filter)
      .populate('assignedCourier', 'name code')
      .populate('pickupWarehouse')
      .lean();
    if (!orders.length) return res.status(404).json({ success: false, message: 'No orders found' });

    const is4x6    = labelSize === '4x6';
    const is100x150= labelSize === '100x150';
    const isThermal= is4x6 || is100x150;

    // Thermal: 1 label per page. A4: 4 labels per page (2x2 grid)
    let bodyHtml = '';
    if (isThermal) {
      const w = is4x6 ? '101.6mm' : '100mm';
      const h = is4x6 ? '152.4mm' : '150mm';
      bodyHtml = orders.map((o, i) =>
        `<div class="label-page" style="width:${w};min-height:${h};${i < orders.length-1 ? 'page-break-after:always;' : ''}">${buildLabelHtml(o,{labelSize})}</div>`
      ).join('');
    } else {
      // A4: 4 labels per page in a 2-column grid
      const rows = [];
      for (let i = 0; i < orders.length; i += 4) {
        const chunk = orders.slice(i, i + 4);
        const cells = chunk.map(o =>
          `<td style="width:50%;vertical-align:top;padding:2mm;border:1px dashed #ccc">${buildLabelHtml(o,{labelSize})}</td>`
        ).join('');
        const isLast = i + 4 >= orders.length;
        rows.push(`<tr>${cells}</tr>${!isLast ? '<tr><td colspan="2" style="page-break-after:always;height:0;padding:0;border:none"></td></tr>' : ''}`);
      }
      bodyHtml = `<table style="width:100%;border-collapse:collapse;table-layout:fixed">${rows.join('')}</table>`;
    }

    const pageStyle = isThermal
      ? `@page{size:${is4x6?'4in 6in':'100mm 150mm'};margin:2mm}body{margin:0}`
      : `@page{size:A4;margin:8mm}body{margin:0}`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Labels (${orders.length})</title>
<style>
*{box-sizing:border-box}
${pageStyle}
body{font-family:Arial,sans-serif;background:#fff}
.print-bar{position:fixed;top:0;left:0;right:0;background:#0D1B3E;color:#fff;padding:8px 16px;display:flex;gap:10px;align-items:center;z-index:999;font-size:13px}
.print-bar button{background:#fff;color:#0D1B3E;border:none;padding:5px 14px;border-radius:4px;font-weight:bold;cursor:pointer}
.print-bar select{padding:4px 8px;border-radius:4px;border:none;font-size:12px}
.labels-wrap{padding:${isThermal?'0':'52px 0 0'}}
@media print{.print-bar{display:none!important}}
</style></head><body>
<div class="print-bar">
  <span>📦 ${orders.length} Label(s)</span>
  <button onclick="window.print()">🖨 Print All</button>
  <button onclick="window.close()">✕ Close</button>
  <span style="font-size:11px;opacity:.8">Size: ${labelSize.toUpperCase()}</span>
</div>
<div class="labels-wrap">${bodyHtml}</div>
<script>setTimeout(()=>window.print(),700)</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /bulk-labels-zip — download all Selloship label PDFs as ZIP ─────────
// Uses archiver + parallel axios streams so large batches are fast.
router.post('/bulk-labels-zip', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs' });

    const filter = { _id: { $in: orderIds } };
    if (req.user.role !== 'admin') filter.user = req.user._id;

    const orders = await Order.find(filter).select('orderId awbNumber selloship').lean();
    if (!orders.length) return res.status(404).json({ success: false, message: 'No orders found' });

    // Get Selloship token for authenticated label fetches
    let selloToken = null;
    try { selloToken = await getSelloToken(); } catch(_) {}

    // All orders — those with URL get PDF fetched, rest get self-generated HTML label
    const fullOrders = await Order.find(filter)
      .populate('assignedCourier', 'name code').populate('pickupWarehouse').lean();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="labels_${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { if (!res.headersSent) res.status(500).end(); });
    archive.pipe(res);

    const CONCURRENCY = 5;
    for (let i = 0; i < fullOrders.length; i += CONCURRENCY) {
      const batch = fullOrders.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (o) => {
        const filename = `${o.orderId || o._id}_${o.awbNumber || 'label'}`;
        const labelUrl = o.selloship && o.selloship.labelUrl;
        if (labelUrl) {
          try {
            const headers = { 'Accept': 'application/pdf,*/*' };
            if (selloToken) headers['Authorization'] = selloToken;
            const resp = await axios.get(labelUrl, { responseType: 'stream', timeout: 25000, headers });
            archive.append(resp.data, { name: filename + '.pdf' });
            return;
          } catch (_) { /* fall through to HTML fallback */ }
        }
        // Fallback: generate our own label as HTML (works for Amazon + any order without Selloship PDF)
        const labelHtml = buildLabelHtml(o, { labelSize: order?.selloship?.labelSize || 'a4' });
        const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}@media print{body{margin:0}}</style></head><body>${labelHtml}</body></html>`;
        archive.append(Buffer.from(fullHtml, 'utf-8'), { name: filename + '.html' });
      }));
    }

    await archive.finalize();
  } catch (err) { if (!res.headersSent) res.status(500).json({ success: false, message: err.message }); }
});

// ─── [FIX-LABEL-3] GET /:id/label — single label download ─────────────────────
router.get('/:id/label', protect, async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const order = await Order.findOne(filter)
      .populate('assignedCourier', 'name code').populate('pickupWarehouse').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Amazon / Selloship label: proxy PDF bytes so browser downloads it directly
    if (order.selloship && order.selloship.labelUrl) {
      try {
        const tok = await getSelloToken();
        const resp = await axios.get(order.selloship.labelUrl, {
          responseType: 'stream', timeout: 25000,
          headers: { Authorization: tok, Accept: 'application/pdf,*/*' }
        });
        const ct = resp.headers['content-type'] || 'application/pdf';
        res.setHeader('Content-Type', ct);
        res.setHeader('Content-Disposition', `inline; filename="${order.orderId}_label.pdf"`);
        return resp.data.pipe(res);
      } catch (_) {
        // PDF fetch failed — fall through to HTML label
      }
    }

    // Fallback: generated HTML label
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Label ' + order.orderId + '</title>' +
      '<style>*{box-sizing:border-box}body{font-family:Arial;margin:0;padding:16px;background:#f5f5f5}' +
      '.no-print{margin-bottom:12px}.no-print button{background:#0D1B3E;color:#fff;border:none;padding:8px 20px;' +
      'border-radius:4px;cursor:pointer;font-size:14px;margin-right:8px}' +
      '@media print{.no-print{display:none}body{padding:0;background:#fff}}</style></head><body>' +
      '<div class="no-print"><button onclick="window.print()">🖨 Print Label</button>' +
      '<button onclick="window.close()">✕ Close</button></div>' +
      buildLabelHtml(order) +
      '<script>setTimeout(()=>window.print(),500)<\/script></body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── REFETCH LABEL URL from Selloship (for Amazon orders where label was missing) ──
router.post('/:id/refetch-label', protect, async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const order = await Order.findOne(filter);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.awbNumber) return res.status(400).json({ success: false, message: 'Order not shipped yet' });
    const tok = await getSelloToken();
    const labelUrl = await fetchLabelUrl(tok, order.awbNumber);
    if (!labelUrl) return res.status(404).json({ success: false, message: 'Label not available from Selloship yet. Try again in a moment.' });
    if (!order.selloship) order.selloship = {};
    order.selloship.labelUrl = labelUrl;
    order.markModified('selloship');
    await order.save();
    res.json({ success: true, labelUrl });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── LABEL SETTINGS ──────────────────────────────────────────────────────────
router.get('/label-settings', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('labelSettings').lean();
    res.json({ success: true, settings: user?.labelSettings || {} });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/label-settings', protect, async (req, res) => {
  try {
    const allowed = ['showLogo','customLogoUrl','showSupportEmail','supportEmail','supportPhone',
      'hideCustomerPhone','hidePickupAddress','hidePickupPhone','hideRtoAddress','hideRtoPhone',
      'hideGst','showItemTable','labelNote','labelFooter','brandColor','labelSize'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[`labelSettings.${k}`] = req.body[k];
    await User.findByIdAndUpdate(req.user._id, { $set: update });
    res.json({ success: true, message: 'Label settings saved' });
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
    const { orderIds, courierId: bulkCourierId } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });
    const results = [];
    for (const id of orderIds) {
      const order = await Order.findOne({
        _id: id, user: req.user._id, status: { $in: ['draft','processing'] }
      }).populate('pickupWarehouse');
      if (!order) { results.push({ id, success: false, message: 'Not found or already shipped' }); continue; }
      if (order.awbNumber) { results.push({ id, success: false, message: 'Already has AWB' }); continue; }
      // Use bulk-selected courier if provided, else fall back to order's assigned courier
      if (bulkCourierId) { order.assignedCourier = bulkCourierId; await order.save(); }
      const courierId = bulkCourierId || (order.assignedCourier ? order.assignedCourier.toString() : null);
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

    // Amazon / Selloship label: proxy PDF bytes directly
    if (order.selloship && order.selloship.labelUrl) {
      try {
        const tok = await getSelloToken();
        const resp = await axios.get(order.selloship.labelUrl, {
          responseType: 'stream', timeout: 25000,
          headers: { Authorization: tok, Accept: 'application/pdf,*/*' }
        });
        res.setHeader('Content-Type', resp.headers['content-type'] || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${order.orderId}_label.pdf"`);
        return resp.data.pipe(res);
      } catch (_) { /* fall through to HTML label */ }
    }

    const size = (req.query.size || 'a4').toLowerCase();
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Label ' + order.orderId + '</title>' +
      '<style>*{box-sizing:border-box}body{font-family:Arial;margin:0;padding:8mm;background:#fff}' +
      `@page{size:${size==='4x6'?'4in 6in':size==='100x150'?'100mm 150mm':'A4'};margin:6mm}` +
      '@media print{body{padding:0}}</style></head><body>' +
      buildLabelHtml(order, { labelSize: size }) +
      '<script>setTimeout(()=>window.print(),500)<\/script></body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /v1/bulk-labels — API key bulk label download ───────────────────────
router.post('/v1/bulk-labels', apiKeyAuth, async (req, res) => {
  try {
    const { orderIds, labelSize = 'a4' } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs' });
    const orders = await Order.find({ orderId: { $in: orderIds }, user: req.user._id })
      .populate('assignedCourier', 'name code').populate('pickupWarehouse').lean();
    if (!orders.length) return res.status(404).json({ success: false, message: 'No orders found' });
    const is4x6 = labelSize === '4x6', is100 = labelSize === '100x150';
    const isThermal = is4x6 || is100;
    const w = is4x6 ? '101.6mm' : '100mm', h = is4x6 ? '152.4mm' : '150mm';
    const pageStyle = isThermal
      ? `@page{size:${is4x6?'4in 6in':'100mm 150mm'};margin:2mm}body{margin:0}`
      : `@page{size:A4;margin:8mm}body{margin:0}`;
    let bodyHtml;
    if (isThermal) {
      bodyHtml = orders.map((o, i) => {
        const pb = i < orders.length - 1 ? 'page-break-after:always;' : '';
        return '<div style="width:' + w + ';min-height:' + h + ';' + pb + '">' + buildLabelHtml(o, {labelSize}) + '</div>';
      }).join('');
    } else {
      const rows = [];
      for (let i = 0; i < orders.length; i += 4) {
        const chunk = orders.slice(i, i + 4);
        const cells = chunk.map(o => '<td style="width:50%;vertical-align:top;padding:2mm;border:1px dashed #ccc">' + buildLabelHtml(o, {labelSize}) + '</td>').join('');
        rows.push('<tr>' + cells + '</tr>');
      }
      bodyHtml = '<table style="width:100%;border-collapse:collapse;table-layout:fixed">' + rows.join('') + '</table>';
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Labels</title><style>*{box-sizing:border-box}${pageStyle}</style></head><body>${bodyHtml}</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
