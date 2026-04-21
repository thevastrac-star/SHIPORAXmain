const express = require('express');
const router = express.Router();
const { Warehouse } = require('../models/index');
const { protect } = require('../middleware/auth');

// Generate unique warehouse code: WH-{3LETTERS}-{3DIGITS}
function genWarehouseCode(userId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = 'WH-';
  // Use last 3 chars of userId for uniqueness
  const uid = userId.toString().slice(-3).toUpperCase().replace(/[^A-Z]/g, '');
  const prefix = uid.length >= 3 ? uid : (uid + chars[Math.floor(Math.random()*chars.length)].repeat(3-uid.length));
  code += prefix.slice(0,3) + '-';
  code += String(Math.floor(100 + Math.random() * 900));
  return code;
}

// GET /api/warehouses
router.get('/', protect, async (req, res) => {
  const warehouses = await Warehouse.find({ user: req.user._id }).sort({ isDefault: -1, createdAt: -1 });
  res.json({ success: true, warehouses });
});

// POST /api/warehouses
router.post('/', protect, async (req, res) => {
  try {
    const { name, contactName, phone, address, city, state, pincode, landmark, isDefault, gstNumber } = req.body;
    if (isDefault) await Warehouse.updateMany({ user: req.user._id }, { isDefault: false });

    // Count existing warehouses to create numbered code
    const count = await Warehouse.countDocuments({ user: req.user._id });
    const uid = req.user._id.toString();
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    // Create deterministic prefix from user ID
    const p1 = letters[(parseInt(uid.slice(-1), 16)) % letters.length];
    const p2 = letters[(parseInt(uid.slice(-2,-1), 16)) % letters.length];
    const p3 = letters[(parseInt(uid.slice(-3,-2), 16)) % letters.length];
    const warehouseCode = `WH-${p1}${p2}${p3}-${String(count + 1).padStart(3, '0')}`;

    const wh = await Warehouse.create({ 
      user: req.user._id, name, contactName, phone, address, city, state, pincode, 
      landmark, isDefault: isDefault || false, gstNumber: gstNumber || '',
      warehouseCode
    });
    res.status(201).json({ success: true, warehouse: wh });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/warehouses/:id
router.patch('/:id', protect, async (req, res) => {
  try {
    const wh = await Warehouse.findOne({ _id: req.params.id, user: req.user._id });
    if (!wh) return res.status(404).json({ success: false, message: 'Warehouse not found' });
    if (req.body.isDefault) await Warehouse.updateMany({ user: req.user._id }, { isDefault: false });
    Object.assign(wh, req.body);
    await wh.save();
    res.json({ success: true, warehouse: wh });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/warehouses/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const wh = await Warehouse.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!wh) return res.status(404).json({ success: false, message: 'Warehouse not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
