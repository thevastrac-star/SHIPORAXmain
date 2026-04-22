const express = require('express');
const router  = express.Router();
const { Courier, ShippingRate, CourierPreference } = require('../models/index');
const User    = require('../models/User');
const { protect, adminOnly, logActivity } = require('../middleware/auth');

// ─── COURIERS ─────────────────────────────────────────────────────────────────

router.get('/', protect, async (req, res) => {
  try {
    const filter = req.user.role !== 'admin' ? { isActive: true } : {};
    let couriers = await Courier.find(filter).select('-apiConfig');
    if (req.user.role !== 'admin') {
      const user   = await User.findById(req.user._id).select('lockedCouriers');
      const locked = (user.lockedCouriers || []).map(c => c.toString());
      if (locked.length) couriers = couriers.filter(c => !locked.includes(c._id.toString()));
    }
    res.json({ success: true, couriers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const courier = await Courier.create(req.body);
    await logActivity(req.user._id, 'admin', 'COURIER_CREATE', 'Courier', courier._id, { name: courier.name }, req.ip);
    res.status(201).json({ success: true, courier });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── SHIPPING RATES — static paths BEFORE /:id to prevent route conflicts (FIX #12) ──

// GET /api/couriers/rates/all
router.get('/rates/all', protect, adminOnly, async (req, res) => {
  try {
    const rates = await ShippingRate.find({ user: null })
      .populate('courier', 'name code')
      .sort({ courier: 1, minWeight: 1 });
    res.json({ success: true, rates });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/couriers/rates/clients-list
router.get('/rates/clients-list', protect, adminOnly, async (req, res) => {
  try {
    const clients = await User.find({ role: 'client' }).select('name email').sort({ name: 1 });
    res.json({ success: true, clients });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/couriers/rates/me
router.get('/rates/me', protect, async (req, res) => {
  try {
    let rates = await ShippingRate.find({ user: req.user._id, isActive: true })
      .populate('courier', 'name code logoUrl');
    if (!rates.length) {
      rates = await ShippingRate.find({ user: null, isActive: true })
        .populate('courier', 'name code logoUrl');
    }
    res.json({ success: true, rates });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/couriers/rates/client/:userId
router.get('/rates/client/:userId', protect, adminOnly, async (req, res) => {
  try {
    const [clientRates, globalRates] = await Promise.all([
      ShippingRate.find({ user: req.params.userId }).populate('courier', 'name code'),
      ShippingRate.find({ user: null }).populate('courier', 'name code')
    ]);
    res.json({ success: true, clientRates, globalRates });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/couriers/rates
router.post('/rates', protect, adminOnly, async (req, res) => {
  try {
    const { courierId, userId, slabName, zones, minWeight, maxWeight,
            additionalWeightRate, cod, fuelSurcharge } = req.body;
    const rate = await ShippingRate.create({
      courier: courierId, user: userId || null, slabName: slabName || 'Standard',
      zones, minWeight, maxWeight, additionalWeightRate, cod, fuelSurcharge
    });
    await logActivity(req.user._id, 'admin', 'RATE_CREATE', 'ShippingRate', rate._id,
      { courierId, userId: userId || 'global' }, req.ip);
    const populated = await ShippingRate.findById(rate._id).populate('courier', 'name code');
    res.status(201).json({ success: true, rate: populated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/couriers/rates/:id
router.patch('/rates/:id', protect, adminOnly, async (req, res) => {
  try {
    const rate = await ShippingRate.findById(req.params.id);
    if (!rate) return res.status(404).json({ success: false, message: 'Rate not found' });
    rate.history.push({ changedAt: new Date(), changedBy: req.user._id, snapshot: rate.toObject() });
    const { zones, minWeight, maxWeight, additionalWeightRate, cod, fuelSurcharge, slabName, isActive } = req.body;
    if (zones)                        rate.zones                = zones;
    if (minWeight !== undefined)       rate.minWeight            = minWeight;
    if (maxWeight !== undefined)       rate.maxWeight            = maxWeight;
    if (additionalWeightRate !== undefined) rate.additionalWeightRate = additionalWeightRate;
    if (cod)                           rate.cod                  = cod;
    if (fuelSurcharge !== undefined)   rate.fuelSurcharge        = fuelSurcharge;
    if (slabName)                      rate.slabName             = slabName;
    if (isActive !== undefined)        rate.isActive             = isActive;
    rate.updatedAt = new Date();
    await rate.save();
    await logActivity(req.user._id, 'admin', 'RATE_UPDATE', 'ShippingRate', rate._id, {}, req.ip);
    res.json({ success: true, rate });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/couriers/rates/:id
router.delete('/rates/:id', protect, adminOnly, async (req, res) => {
  try {
    await ShippingRate.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Rate deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── COURIER LOCKS ────────────────────────────────────────────────────────────

// Static /locks/… BEFORE /:id
router.get('/locks/:userId', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('name email lockedCouriers').populate('lockedCouriers', 'name code');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, lockedCouriers: user.lockedCouriers || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/locks/:userId/toggle', protect, adminOnly, async (req, res) => {
  try {
    const { courierId } = req.body;
    if (!courierId) return res.status(400).json({ success: false, message: 'courierId required' });
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.lockedCouriers) user.lockedCouriers = [];
    const idx = user.lockedCouriers.findIndex(c => c.toString() === courierId);
    const action = idx >= 0 ? 'unlocked' : 'locked';
    if (idx >= 0) user.lockedCouriers.splice(idx, 1);
    else          user.lockedCouriers.push(courierId);
    await user.save();
    await logActivity(req.user._id, 'admin', `COURIER_${action.toUpperCase()}_FOR_USER`,
      'User', user._id, { courierId }, req.ip);
    res.json({ success: true, action, lockedCouriers: user.lockedCouriers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── COURIER PREFERENCES ─────────────────────────────────────────────────────

router.get('/preference/mine', protect, async (req, res) => {
  const pref = await CourierPreference.findOne({ user: req.user._id })
    .populate('priorities.courier', 'name code logoUrl');
  res.json({ success: true, preference: pref });
});

router.post('/preference/save', protect, async (req, res) => {
  try {
    const { priorities } = req.body;
    let pref = await CourierPreference.findOne({ user: req.user._id });
    if (pref) { pref.priorities = priorities; pref.updatedAt = new Date(); await pref.save(); }
    else        pref = await CourierPreference.create({ user: req.user._id, priorities });
    res.json({ success: true, preference: pref });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── /:id ROUTES LAST ─────────────────────────────────────────────────────────

router.get('/:id', protect, adminOnly, async (req, res) => {
  const courier = await Courier.findById(req.params.id);
  if (!courier) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, courier });
});

router.patch('/:id', protect, adminOnly, async (req, res) => {
  try {
    const courier = await Courier.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!courier) return res.status(404).json({ success: false, message: 'Not found' });
    await logActivity(req.user._id, 'admin', 'COURIER_UPDATE', 'Courier', courier._id, {}, req.ip);
    res.json({ success: true, courier });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:id/toggle', protect, adminOnly, async (req, res) => {
  try {
    const courier = await Courier.findById(req.params.id);
    if (!courier) return res.status(404).json({ success: false, message: 'Not found' });
    courier.isActive = !courier.isActive;
    await courier.save();
    await logActivity(req.user._id, 'admin', `COURIER_${courier.isActive ? 'ENABLE' : 'DISABLE'}`,
      'Courier', courier._id, {}, req.ip);
    res.json({ success: true, isActive: courier.isActive });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:id/api-config', protect, adminOnly, async (req, res) => {
  try {
    const courier = await Courier.findById(req.params.id);
    if (!courier) return res.status(404).json({ success: false, message: 'Not found' });
    courier.apiConfig = { ...courier.apiConfig, ...req.body };
    await courier.save();
    await logActivity(req.user._id, 'admin', 'COURIER_API_CONFIG', 'Courier', courier._id, {}, req.ip);
    res.json({ success: true, message: 'API config saved' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const { CourierSelloshipMapping } = require('../models/index');
    await Courier.findByIdAndDelete(req.params.id);
    await CourierSelloshipMapping.deleteMany({ courier: req.params.id });
    await logActivity(req.user._id, 'admin', 'COURIER_DELETE', 'Courier', req.params.id, {}, req.ip);
    res.json({ success: true, message: 'Courier deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
