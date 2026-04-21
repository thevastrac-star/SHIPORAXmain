const express = require('express');
const router  = express.Router();
const { Warehouse } = require('../models/index');
const { protect }   = require('../middleware/auth');

// Deterministic warehouse code from userId + sequential number
function makeWarehouseCode(userId, count) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const uid = userId.toString();
  const p1  = letters[(parseInt(uid.slice(-1),  16)) % letters.length];
  const p2  = letters[(parseInt(uid.slice(-2,-1), 16)) % letters.length];
  const p3  = letters[(parseInt(uid.slice(-3,-2), 16)) % letters.length];
  return `WH-${p1}${p2}${p3}-${String(count + 1).padStart(3, '0')}`;
}

// GET /api/warehouses
router.get('/', protect, async (req, res) => {
  try {
    const warehouses = await Warehouse.find({ user: req.user._id })
      .sort({ isDefault: -1, createdAt: -1 });
    res.json({ success: true, warehouses });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/warehouses
// FIX #13 + #14: warehouseCode, gstNumber, landmark now in schema → Mongoose saves them
router.post('/', protect, async (req, res) => {
  try {
    const { name, contactName, phone, email, address, city, state, pincode,
            landmark, isDefault, gstNumber } = req.body;

    if (isDefault) await Warehouse.updateMany({ user: req.user._id }, { isDefault: false });

    const count         = await Warehouse.countDocuments({ user: req.user._id });
    const warehouseCode = makeWarehouseCode(req.user._id, count);

    const wh = await Warehouse.create({
      user: req.user._id,
      name, contactName, phone, email, address, city, state, pincode,
      landmark:      landmark    || '',
      gstNumber:     gstNumber   || '',
      warehouseCode,
      isDefault:     isDefault   || false
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
