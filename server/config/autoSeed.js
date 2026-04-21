// autoSeed.js — runs on server start, idempotent
const User         = require('../models/User');
const { Courier, ShippingRate, Settings } = require('../models/index');

async function autoSeed() {
  try {
    console.log('🌱 Running auto-seed checks...');

    // ── Admin user ────────────────────────────────────────────────────────────
    const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@kourierwale.com';
    const adminPassword = process.env.ADMIN_PASSWORD;

    // FIX #11: crash if ADMIN_PASSWORD not set — never use default in production
    if (!adminPassword) {
      console.error('❌ ADMIN_PASSWORD env var is not set! Server cannot seed admin safely. Set it and restart.');
      process.exit(1);
    }

    const adminExists = await User.findOne({ email: adminEmail });
    if (!adminExists) {
      await User.create({ name: 'Super Admin', email: adminEmail, password: adminPassword,
        role: 'admin', kyc: { status: 'approved' } });
      console.log(`✅ Admin created → ${adminEmail}`);
    } else {
      console.log(`✔  Admin already exists → ${adminEmail}`);
    }

    // ── Demo client (dev-only) ────────────────────────────────────────────────
    if (process.env.NODE_ENV !== 'production') {
      const clientExists = await User.findOne({ email: 'client@test.com' });
      if (!clientExists) {
        await User.create({ name: 'Test Client', email: 'client@test.com', password: 'client123',
          phone: '9876543210', role: 'client', walletBalance: 5000, kyc: { status: 'approved' } });
        console.log('✅ Demo client created → client@test.com / client123');
      }
    }

    // ── Couriers ──────────────────────────────────────────────────────────────
    const couriers = [
      { name: 'Delhivery',  code: 'DELHIVERY',  supportsCOD: true, isActive: true },
      { name: 'Blue Dart',  code: 'BLUEDART',   supportsCOD: true, isActive: true },
      { name: 'Ekart',      code: 'EKART',       supportsCOD: true, isActive: true },
      { name: 'DTDC',       code: 'DTDC',        supportsCOD: true, isActive: true },
      { name: 'Xpressbees', code: 'XPRESSBEES', supportsCOD: true, isActive: true }
    ];
    for (const c of couriers) {
      await Courier.findOneAndUpdate({ code: c.code }, c, { upsert: true, new: true });
    }
    console.log('✅ Couriers ready (5)');

    // FIX #6: seed uses correct ShippingRate schema fields (zones.a/b/c/d/e, additionalWeightRate, cod.*)
    const delhivery = await Courier.findOne({ code: 'DELHIVERY' });
    if (delhivery) {
      const rateExists = await ShippingRate.findOne({ courier: delhivery._id, user: null });
      if (!rateExists) {
        await ShippingRate.insertMany([
          {
            courier: delhivery._id, user: null, slabName: 'Light (up to 500g)',
            zones: { a: 40, b: 55, c: 60, d: 70, e: 90 },
            minWeight: 0, maxWeight: 0.5, additionalWeightRate: 20,
            cod: { mode: 'threshold', flat: 30, percent: 1.5, thresholdAmount: 1500 },
            fuelSurcharge: 0, isActive: true
          },
          {
            courier: delhivery._id, user: null, slabName: 'Standard (500g–2kg)',
            zones: { a: 55, b: 70, c: 80, d: 90, e: 120 },
            minWeight: 0.5, maxWeight: 2, additionalWeightRate: 25,
            cod: { mode: 'threshold', flat: 30, percent: 1.5, thresholdAmount: 1500 },
            fuelSurcharge: 0, isActive: true
          }
        ]);
        console.log('✅ Sample rates created for Delhivery');
      }
    }

    // ── Default Settings ──────────────────────────────────────────────────────
    const defaultSettings = [
      { key: 'company_name',        value: 'Kourierwale',             category: 'general',         label: 'Company Name' },
      { key: 'support_email',       value: 'support@kourierwale.com', category: 'general',         label: 'Support Email' },
      { key: 'support_phone',       value: '+91-9999999999',          category: 'general',         label: 'Support Phone' },
      { key: 'razorpay_key',        value: '',                        category: 'payment_gateway', label: 'Razorpay Key ID' },
      { key: 'razorpay_secret',     value: '',                        category: 'payment_gateway', label: 'Razorpay Secret' },
      { key: 'whatsapp_url',        value: '',                        category: 'notifications',   label: 'WhatsApp API URL' },
      { key: 'whatsapp_key',        value: '',                        category: 'notifications',   label: 'WhatsApp API Key' },
      { key: 'selloship.username',  value: '',                        category: 'courier_api',     label: 'Selloship Username' },
      { key: 'selloship.password',  value: '',                        category: 'courier_api',     label: 'Selloship Password' }
    ];
    for (const s of defaultSettings) {
      await Settings.findOneAndUpdate({ key: s.key }, s, { upsert: true });
    }
    console.log('✅ Default settings ready');
    console.log('🎉 Auto-seed complete.\n');
  } catch (err) {
    console.error('⚠️  Auto-seed error (non-fatal):', err.message);
  }
}

module.exports = autoSeed;
