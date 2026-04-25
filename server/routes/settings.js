const express = require('express');
const router = express.Router();
const { Settings } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');

// GET /api/settings  – admin
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    const settings = await Settings.find(filter);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/settings  – upsert a setting
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const { key, value, category, label } = req.body;
    const setting = await Settings.findOneAndUpdate(
      { key },
      { value, category, label, updatedBy: req.user._id, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    await logActivity(req.user._id, 'admin', 'SETTING_UPDATE', 'Settings', key, { value }, req.ip);
    res.json({ success: true, setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/settings/bulk  – save multiple settings at once
router.post('/bulk', protect, adminOnly, async (req, res) => {
  try {
    const { settings } = req.body; // [{ key, value, category, label }]
    const ops = settings.map(s => ({
      updateOne: {
        filter: { key: s.key },
        update: { $set: { ...s, updatedBy: req.user._id, updatedAt: new Date() } },
        upsert: true
      }
    }));
    await Settings.bulkWrite(ops);
    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
