const express = require('express');
const router = express.Router();
const { Warehouse } = require('../models/index');
const { protect } = require('../middleware/auth');

// GET /api/warehouses
router.get('/', protect, async (req, res) => {
  const warehouses = await Warehouse.find({ user: req.user._id }).sort({ isDefault: -1, createdAt: -1 });
  res.json({ success: true, warehouses });
});

// POST /api/warehouses
router.post('/', protect, async (req, res) => {
  try {
    const { name, contactName, phone, address, city, state, pincode, landmark, isDefault } = req.body;

    // If setting as default, unset others
    if (isDefault) await Warehouse.updateMany({ user: req.user._id }, { isDefault: false });

    const wh = await Warehouse.create({ user: req.user._id, name, contactName, phone, address, city, state, pincode, landmark, isDefault: isDefault || false });
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
