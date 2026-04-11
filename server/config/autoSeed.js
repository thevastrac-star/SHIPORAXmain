// autoSeed.js — runs automatically on server start, safe to call multiple times
// Uses upsert / findOne checks so it never duplicates data

const User = require('../models/User');
const { Courier, ShippingRate, Settings } = require('../models/index');

async function autoSeed() {
  try {
    console.log('🌱 Running auto-seed checks...');

    // ── Admin user ──────────────────────────────────────────────────────────
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@kourierwale.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123456';

    const adminExists = await User.findOne({ email: adminEmail });
    if (!adminExists) {
      await User.create({
        name: 'Super Admin',
        email: adminEmail,
        password: adminPassword,
        role: 'admin',
        kyc: { status: 'approved' }
      });
      console.log(`✅ Admin created → ${adminEmail}`);
    } else {
      console.log(`✔  Admin already exists → ${adminEmail}`);
    }

    // ── Demo client (optional, useful for testing) ──────────────────────────
    const clientExists = await User.findOne({ email: 'client@test.com' });
    if (!clientExists) {
      await User.create({
        name: 'Test Client',
        email: 'client@test.com',
        password: 'client123',
        phone: '9876543210',
        role: 'client',
        walletBalance: 5000,
        kyc: { status: 'approved' }
      });
      console.log('✅ Demo client created → client@test.com / client123');
    }

    // ── Couriers ────────────────────────────────────────────────────────────
    const couriers = [
      { name: 'Delhivery',  code: 'DELHIVERY',  supportsCOD: true, isActive: true },
      { name: 'Blue Dart',  code: 'BLUEDART',   supportsCOD: true, isActive: true },
      { name: 'Ekart',      code: 'EKART',       supportsCOD: true, isActive: true },
      { name: 'DTDC',       code: 'DTDC',        supportsCOD: true, isActive: true },
      { name: 'Xpressbees', code: 'XPRESSBEES', supportsCOD: true, isActive: true },
    ];
    for (const c of couriers) {
      await Courier.findOneAndUpdate({ code: c.code }, c, { upsert: true, new: true });
    }
    console.log('✅ Couriers ready (5)');

    // ── Rates for Delhivery ─────────────────────────────────────────────────
    const delhivery = await Courier.findOne({ code: 'DELHIVERY' });
    if (delhivery) {
      const rateExists = await ShippingRate.findOne({ courier: delhivery._id });
      if (!rateExists) {
        await ShippingRate.insertMany([
          { courier: delhivery._id, zone: 'within_city', minWeight: 0, maxWeight: 0.5, baseRate: 40,  ratePerKg: 0,  codCharge: 30 },
          { courier: delhivery._id, zone: 'metro',       minWeight: 0, maxWeight: 0.5, baseRate: 55,  ratePerKg: 0,  codCharge: 30 },
          { courier: delhivery._id, zone: 'national',    minWeight: 0, maxWeight: 0.5, baseRate: 70,  ratePerKg: 15, codCharge: 40 },
          { courier: delhivery._id, zone: 'within_city', minWeight: 0.5, maxWeight: 2, baseRate: 55,  ratePerKg: 20, codCharge: 30 },
          { courier: delhivery._id, zone: 'national',    minWeight: 0.5, maxWeight: 2, baseRate: 90,  ratePerKg: 25, codCharge: 40 },
        ]);
        console.log('✅ Sample rates created for Delhivery');
      }
    }

    // ── Default Settings ────────────────────────────────────────────────────
    const defaultSettings = [
      { key: 'company_name',    value: 'Kourierwale',             category: 'general',          label: 'Company Name' },
      { key: 'support_email',   value: 'support@kourierwale.com', category: 'general',          label: 'Support Email' },
      { key: 'support_phone',   value: '+91-9999999999',          category: 'general',          label: 'Support Phone' },
      { key: 'razorpay_key',    value: '',                        category: 'payment_gateway',  label: 'Razorpay Key ID' },
      { key: 'razorpay_secret', value: '',                        category: 'payment_gateway',  label: 'Razorpay Secret' },
      { key: 'whatsapp_url',    value: '',                        category: 'notifications',    label: 'WhatsApp API URL' },
      { key: 'whatsapp_key',    value: '',                        category: 'notifications',    label: 'WhatsApp API Key' },
    ];
    for (const s of defaultSettings) {
      await Settings.findOneAndUpdate({ key: s.key }, s, { upsert: true });
    }
    console.log('✅ Default settings ready');

    console.log('🎉 Auto-seed complete.\n');
  } catch (err) {
    // Non-fatal — log but don't crash the server
    console.error('⚠️  Auto-seed error (non-fatal):', err.message);
  }
}

module.exports = autoSeed;
