// autoSeed.js — runs on server start, idempotent
const User         = require('../models/User');
const { Courier, CourierSelloshipMapping, ShippingRate, Settings } = require('../models/index');

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

    // ── Couriers: only Delhivery FR and Amazon Shipping ──────────────────────
    // Disable any legacy couriers that aren't in our approved list
    await Courier.updateMany(
      { code: { $nin: ['DLVRY', 'AMZN'] } },
      { $set: { isActive: false } }
    );

    const approvedCouriers = [
      {
        courier: { name: 'Delhivery FR', code: 'DLVRY', supportsCOD: true, isActive: true,
          logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Delhivery-Logo.svg/200px-Delhivery-Logo.svg.png' },
        mapping: { selloshipCourierId: '30', selloshipCourierName: 'Delhivery FR', isAutoRoute: false, isActive: true,
          notes: 'Delhivery Forward via Selloship — courier_id 30' }
      },
      {
        courier: { name: 'Amazon Shipping', code: 'AMZN', supportsCOD: true, isActive: true,
          logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/200px-Amazon_logo.svg.png' },
        mapping: { selloshipCourierId: '24', selloshipCourierName: 'Amazon Shipping', isAutoRoute: false, isActive: true,
          notes: 'Amazon Shipping via Selloship — courier_id 24' }
      }
    ];

    for (const def of approvedCouriers) {
      const c = await Courier.findOneAndUpdate(
        { code: def.courier.code },
        def.courier,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      // Upsert the selloship mapping for this courier
      const existingMap = await CourierSelloshipMapping.findOne({ courier: c._id });
      if (!existingMap) {
        await CourierSelloshipMapping.create({ courier: c._id, ...def.mapping });
        console.log(`✅ Courier + mapping created: ${c.name} (Selloship ID: ${def.mapping.selloshipCourierId})`);
      } else {
        await CourierSelloshipMapping.findByIdAndUpdate(existingMap._id, def.mapping);
        console.log(`✔  Courier + mapping verified: ${c.name}`);
      }

      // Seed default rates if none exist
      const rateExists = await ShippingRate.findOne({ courier: c._id, user: null });
      if (!rateExists) {
        await ShippingRate.insertMany([
          {
            courier: c._id, user: null, slabName: 'Light (up to 500g)',
            zones: { a: 40, b: 55, c: 60, d: 70, e: 90 },
            minWeight: 0, maxWeight: 0.5, additionalWeightRate: 20,
            cod: { mode: 'threshold', flat: 30, percent: 1.5, thresholdAmount: 1500 },
            fuelSurcharge: 0, isActive: true
          },
          {
            courier: c._id, user: null, slabName: 'Standard (500g–2kg)',
            zones: { a: 55, b: 70, c: 80, d: 90, e: 120 },
            minWeight: 0.5, maxWeight: 2, additionalWeightRate: 25,
            cod: { mode: 'threshold', flat: 30, percent: 1.5, thresholdAmount: 1500 },
            fuelSurcharge: 0, isActive: true
          }
        ]);
        console.log(`✅ Default rates seeded for ${c.name}`);
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
