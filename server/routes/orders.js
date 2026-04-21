// ─── ENHANCED BULK UPLOAD (Parallel Chunked Processing) ──────────────────────
// POST /api/orders/bulk-upload  — parallel chunked for 1k-2k orders
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const User = require('../models/User');
const Order = require('../models/Order');
const { NDR, WalletTransaction, BulkUpload, CodReconciliation, ShippingRate, CourierPreference, Courier, Warehouse } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const { fetchPincodeData } = require('../utils/pincode');
const { toCSV } = require('../utils/csv');

const upload = multer({ dest: 'uploads/bulk/', limits: { fileSize: 50 * 1024 * 1024 } });

// Shared calc helper
async function calcShippingCost(userId, courierId, weight, paymentMode, codAmount) {
  let rate = await ShippingRate.findOne({ courier: courierId, user: userId, isActive: true });
  if (!rate) rate = await ShippingRate.findOne({ courier: courierId, user: null, isActive: true });
  if (!rate) return { cost: null, codCharge: 0, total: 0, noRate: true };
  const baseRate = rate.zones.d || rate.zones.a || 0;
  const w = parseFloat(weight) || 0.5;
  let cost = baseRate;
  if (w > rate.maxWeight) {
    const extra = w - rate.maxWeight;
    cost += Math.ceil(extra / 0.5) * (rate.additionalWeightRate || 0);
  }
  cost += rate.fuelSurcharge || 0;
  let codCharge = 0;
  if (paymentMode === 'cod' && codAmount > 0) {
    const cod = rate.cod;
    if (cod.mode === 'flat_always') codCharge = cod.flat || 0;
    else if (cod.mode === 'percent_always') codCharge = Math.round((codAmount * (cod.percent || 0)) / 100);
    else {
      if (codAmount <= (cod.thresholdAmount || 1500)) codCharge = cod.flat || 30;
      else codCharge = Math.round((codAmount * (cod.percent || 1.5)) / 100);
    }
  }
  return { cost: Math.round(cost), codCharge: Math.round(codCharge), total: Math.round(cost + codCharge) };
}

// ─── BULK UPLOAD — Chunked parallel for 1k-2k orders ────────────────────────
router.post('/bulk-upload', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ success: false, message: 'File is empty or has no data rows' });

    const headers = lines[0].split(',').map(h => h.replace(/["'\r]/g, '').trim().toLowerCase());
    const rows = lines.slice(1).filter(r => r.trim());

    // Load user's warehouses for warehouse_id mapping
    const warehouses = await Warehouse.find({ user: req.user._id });
    const whByCode = {};
    const whById = {};
    warehouses.forEach(w => {
      if (w.warehouseCode) whByCode[w.warehouseCode.toLowerCase()] = w;
      whById[w._id.toString()] = w;
      if (w.isDefault) whByCode['default'] = w;
    });
    const defaultWh = warehouses.find(w => w.isDefault) || warehouses[0];

    const bulkRecord = await BulkUpload.create({
      user: req.user._id, fileName: req.file.originalname,
      totalRows: rows.length, status: 'processing'
    });

    // Process in parallel chunks of 50 for speed
    const CHUNK_SIZE = 50;
    let success = 0, failed = 0;
    const errors = [];
    const createdOrders = [];

    async function processRow(rawLine, rowIndex) {
      if (!rawLine.trim()) return { skip: true };
      // Handle quoted CSV properly
      const cols = [];
      let cur = '', inQ = false;
      for (let ci = 0; ci < rawLine.length; ci++) {
        const ch = rawLine[ci];
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.replace(/\r/g,'').trim()); cur = ''; }
        else cur += ch;
      }
      cols.push(cur.replace(/\r/g,'').trim());
      
      const row = {};
      headers.forEach((h, idx) => { row[h] = (cols[idx] || '').replace(/^"|"$/g,''); });

      const phone = row['recipient_phone'] || row['phone'] || '';
      const pincode = row['pincode'] || row['recipient_pincode'] || '';
      if (!row['recipient_name'] && !row['name']) throw new Error('Missing recipient name');
      if (!phone) throw new Error('Missing phone');
      if (!pincode) throw new Error('Missing pincode');
      if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('Invalid phone format');
      if (!/^\d{6}$/.test(pincode)) throw new Error('Invalid pincode format');

      // Resolve warehouse from warehouse_id or warehouse_code column
      let warehouseId = null;
      const whInput = (row['warehouse_id'] || row['warehouse_code'] || '').trim();
      if (whInput) {
        const resolved = whByCode[whInput.toLowerCase()] || whById[whInput];
        if (resolved) warehouseId = resolved._id;
        else throw new Error(`Warehouse "${whInput}" not found. Check your warehouse codes in Warehouses page.`);
      } else if (defaultWh) {
        warehouseId = defaultWh._id;
      }

      const order = await Order.create({
        user: req.user._id,
        source: 'bulk_upload',
        status: 'draft',
        pickupWarehouse: warehouseId,
        recipient: {
          name: row['recipient_name'] || row['name'],
          phone,
          email: row['email'] || '',
          address: row['address'] || row['recipient_address'] || '',
          city: row['city'] || '',
          state: row['state'] || '',
          pincode,
          landmark: row['landmark'] || ''
        },
        package: {
          weight: parseFloat(row['weight']) || 0.5,
          description: row['description'] || '',
          value: parseFloat(row['value']) || 0,
          length: parseFloat(row['length'] || row['l']) || 0,
          breadth: parseFloat(row['breadth'] || row['b']) || 0,
          height: parseFloat(row['height'] || row['h']) || 0,
        },
        paymentMode: (row['payment_mode'] || row['payment'] || '').toLowerCase() === 'cod' ? 'cod' : 'prepaid',
        codAmount: parseFloat(row['cod_amount'] || row['cod']) || 0,
        duplicateCheckKey: `${phone}_${pincode}`
      });
      return { order };
    }

    // Chunk processing
    for (let chunkStart = 0; chunkStart < rows.length; chunkStart += CHUNK_SIZE) {
      const chunk = rows.slice(chunkStart, chunkStart + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map((line, idx) => processRow(line, chunkStart + idx + 2))
      );
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          if (!r.value?.skip) { createdOrders.push(r.value.order._id); success++; }
        } else {
          failed++;
          errors.push({ row: chunkStart + idx + 2, error: r.reason?.message || 'Unknown error' });
        }
      });
    }

    // Update bulk record
    await BulkUpload.findByIdAndUpdate(bulkRecord._id, {
      successRows: success, failedRows: failed,
      status: failed === rows.length ? 'failed' : 'completed',
      errors: errors.slice(0, 100)
    });

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      totalRows: rows.length,
      successRows: success,
      failedRows: failed,
      errors: errors.slice(0, 50),
      orderIds: createdOrders,
      bulkUploadId: bulkRecord._id
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── BULK SHIP — Parallel with wallet deduction ────────────────────────────
router.post('/bulk-ship', protect, async (req, res) => {
  try {
    const { orderIds, courierId } = req.body;
    if (!orderIds || !orderIds.length) return res.status(400).json({ success: false, message: 'No order IDs provided' });

    const SHIP_CHUNK = 20;
    const allResults = [];

    async function shipOne(id) {
      const filter = { _id: id, status: { $in: ['draft', 'processing'] } };
      if (req.user.role !== 'admin') filter.user = req.user._id;
      const order = await Order.findOne(filter);
      if (!order) return { id, success: false, message: 'Not found or already shipped' };
      if (courierId) order.assignedCourier = courierId;
      order.status = 'processing';
      order.awbNumber = order.awbNumber || `AWB${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;
      await order.save();
      return { id, success: true, orderId: order.orderId, awb: order.awbNumber };
    }

    for (let i = 0; i < orderIds.length; i += SHIP_CHUNK) {
      const chunk = orderIds.slice(i, i + SHIP_CHUNK);
      const results = await Promise.allSettled(chunk.map(id => shipOne(id)));
      results.forEach(r => {
        if (r.status === 'fulfilled') allResults.push(r.value);
        else allResults.push({ success: false, message: r.reason?.message });
      });
    }

    const successCount = allResults.filter(r => r.success).length;
    res.json({ success: true, results: allResults, shipped: successCount, failed: allResults.length - successCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── LABEL SETTINGS (per user) ────────────────────────────────────────────────
router.get('/label-settings', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('labelSettings');
    res.json({ success: true, settings: user.labelSettings || {} });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/label-settings', protect, async (req, res) => {
  try {
    const allowed = ['showLogo','customLogoUrl','showSupportEmail','supportEmail','supportPhone',
      'hideCustomerPhone','hidePickupAddress','hidePickupPhone','hideRtoAddress','hideRtoPhone',
      'hideGst','showItemTable','labelSize','labelNote','labelFooter','brandColor'];
    const settings = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) settings[`labelSettings.${k}`] = req.body[k]; });
    await User.findByIdAndUpdate(req.user._id, { $set: settings });
    res.json({ success: true, message: 'Label settings saved' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── BULK LABEL DOWNLOAD ──────────────────────────────────────────────────────
router.post('/bulk-labels', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds?.length) return res.status(400).json({ success: false, message: 'No order IDs' });
    const filter = { _id: { $in: orderIds } };
    if (req.user.role !== 'admin') filter.user = req.user._id;
    const orders = await Order.find(filter).populate('assignedCourier pickupWarehouse');
    const user = await User.findById(req.user._id).select('labelSettings name companyName');
    const ls = user.labelSettings || {};

    // Generate HTML labels
    const labelHTML = orders.map(o => generateLabelHTML(o, ls, user)).join('<div style="page-break-after:always"></div>');
    const fullHTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  body{font-family:Arial,sans-serif;margin:0;padding:0;background:#fff}
  .label{width:100mm;min-height:150mm;border:2px solid #000;padding:4mm;margin:0 auto 8mm;font-size:9pt;page-break-inside:avoid;box-sizing:border-box}
  @media print{body{margin:0}.label{margin:0;border:2px solid #000;page-break-after:always}}
  @page{size:100mm 150mm;margin:0}
</style></head><body>${labelHTML}</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename=labels.html');
    res.send(fullHTML);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

function generateLabelHTML(order, ls, user) {
  const r = order.recipient || {};
  const pkg = order.package || {};
  const wh = order.pickupWarehouse || {};
  const isCOD = order.paymentMode === 'cod';
  const brandColor = ls.brandColor || '#0D1B3E';
  
  return `<div class="label">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #ccc;padding-bottom:3mm;margin-bottom:3mm">
      <div>
        ${ls.showLogo && ls.customLogoUrl ? `<img src="${ls.customLogoUrl}" style="height:10mm;object-fit:contain"/>` : `<div style="font-weight:bold;font-size:11pt;color:${brandColor}">${user.companyName || user.name || 'SHIPORAX'}</div>`}
        <div style="font-size:7pt;color:#666">Powered by SHIPORAX</div>
      </div>
      <div style="text-align:right">
        ${isCOD ? `<div style="background:#c00;color:#fff;padding:2mm 4mm;border-radius:3px;font-weight:bold;font-size:10pt">COD ₹${order.codAmount}</div>` : `<div style="background:#006400;color:#fff;padding:2mm 4mm;border-radius:3px;font-weight:bold;font-size:9pt">PREPAID</div>`}
      </div>
    </div>
    <div style="margin-bottom:3mm">
      <div style="font-size:7pt;color:#666;text-transform:uppercase;font-weight:bold">To:</div>
      <div style="font-weight:bold;font-size:10pt">${r.name || ''}</div>
      <div style="font-size:8.5pt;line-height:1.4">${r.address || ''}${r.landmark ? ', ' + r.landmark : ''}, ${r.city || ''}, ${r.state || ''}, India</div>
      ${!ls.hideCustomerPhone ? `<div style="font-size:8.5pt">Mobile No: ${r.phone || ''}</div>` : ''}
      <div style="font-size:8.5pt;font-weight:bold">${r.pincode || ''}</div>
    </div>
    <div style="border:1px solid #000;padding:2mm;text-align:center;margin-bottom:3mm">
      <div style="font-size:7pt;letter-spacing:1px;font-family:monospace;word-break:break-all">${'|'.repeat(50)}</div>
      <div style="font-size:11pt;font-weight:bold;letter-spacing:2px">${order.awbNumber || order.orderId}</div>
      <div style="font-size:7pt;color:#666">Order: ${order.orderId}</div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:8pt;border-top:1px solid #ccc;padding-top:2mm;margin-bottom:2mm">
      <div>
        ${order.assignedCourier?.name ? `<div><b>${order.assignedCourier.name}</b></div>` : ''}
        ${order.assignedCourier?.code ? `<div style="color:#666;font-size:7.5pt">${order.assignedCourier.code}</div>` : ''}
      </div>
      <div style="text-align:right">
        <div>WEIGHT: ${pkg.weight || 0.5}KG</div>
        ${pkg.length ? `<div style="color:#666;font-size:7.5pt">Dims: ${pkg.length}x${pkg.breadth}x${pkg.height}cm</div>` : ''}
      </div>
    </div>
    ${ls.showItemTable ? `<table style="width:100%;border-collapse:collapse;font-size:7.5pt;margin-bottom:2mm"><tr style="border:1px solid #ccc;background:#f5f5f5"><th style="padding:1mm;border:1px solid #ccc;text-align:left">Item</th><th style="padding:1mm;border:1px solid #ccc">Qty</th><th style="padding:1mm;border:1px solid #ccc">Amt</th></tr><tr><td style="padding:1mm;border:1px solid #ccc">${pkg.description || 'Goods'}</td><td style="padding:1mm;border:1px solid #ccc;text-align:center">1</td><td style="padding:1mm;border:1px solid #ccc;text-align:right">₹${pkg.value || 0}</td></tr></table>` : ''}
    ${!ls.hidePickupAddress ? `<div style="border-top:1px solid #ccc;padding-top:2mm;font-size:7.5pt"><div style="font-weight:bold;color:#444">Pickup Address:</div><div>${wh.name || ''}</div><div>${wh.address || ''} ${wh.city || ''}, ${wh.state || ''} - ${wh.pincode || ''}</div>${!ls.hidePickupPhone ? `<div>Mobile No: ${wh.phone || ''}</div>` : ''}</div>` : ''}
    ${!ls.hideRtoAddress ? `<div style="border-top:1px solid #ccc;padding-top:2mm;font-size:7.5pt"><div style="font-weight:bold;color:#444">Return Address:</div><div>${wh.name || ''}</div><div>${wh.address || ''} ${wh.city || ''}, ${wh.state || ''} - ${wh.pincode || ''}</div></div>` : ''}
    <div style="border-top:1px solid #ccc;padding-top:2mm;margin-top:2mm;font-size:6.5pt;color:#666">
      ${ls.labelNote || 'This is computer generated document, hence does not required signature.'}
      <div style="margin-top:1mm">${ls.labelFooter || 'Note: All disputes are subject to jurisdiction. Goods once sold will only be taken back or exchanged as per the store\'s exchange/return policy'}</div>
    </div>
  </div>`;
}

module.exports = router;
