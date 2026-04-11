require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Order = require('../models/Order');
const { Courier, ShippingRate, Settings } = require('../models/index');

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // ── Users ────────────────────────────────────────────────────────────────
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
    console.log(`✅ Admin user created  →  ${adminEmail} / [password from env]`);
  }

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
    console.log('✅ Client user created  →  client@test.com / client123');
  }

  // ── Couriers ─────────────────────────────────────────────────────────────
  const couriers = [
    { name: 'Delhivery', code: 'DELHIVERY', supportsCOD: true },
    { name: 'Blue Dart',  code: 'BLUEDART',  supportsCOD: true },
    { name: 'Ekart',      code: 'EKART',     supportsCOD: true },
    { name: 'DTDC',       code: 'DTDC',      supportsCOD: true },
    { name: 'Xpressbees', code: 'XPRESSBEES',supportsCOD: true },
  ];
  for (const c of couriers) {
    await Courier.findOneAndUpdate({ code: c.code }, c, { upsert: true });
  }
  console.log('✅ Couriers seeded');

  // ── Default Rates ─────────────────────────────────────────────────────────
  const firstCourier = await Courier.findOne({ code: 'DELHIVERY' });
  if (firstCourier) {
    const rateExists = await ShippingRate.findOne({ courier: firstCourier._id });
    if (!rateExists) {
      await ShippingRate.create([
        { courier: firstCourier._id, zone: 'within_city', minWeight: 0, maxWeight: 0.5, baseRate: 40, ratePerKg: 0, codCharge: 30 },
        { courier: firstCourier._id, zone: 'metro',       minWeight: 0, maxWeight: 0.5, baseRate: 55, ratePerKg: 0, codCharge: 30 },
        { courier: firstCourier._id, zone: 'national',    minWeight: 0, maxWeight: 0.5, baseRate: 70, ratePerKg: 15, codCharge: 40 },
      ]);
      console.log('✅ Sample rates seeded for Delhivery');
    }
  }

  // ── Default Settings ──────────────────────────────────────────────────────
  const defaults = [
    { key: 'company_name',  value: 'Kourierwale',            category: 'general',   label: 'Company Name' },
    { key: 'support_email', value: 'support@kourierwale.com',category: 'general',   label: 'Support Email' },
    { key: 'support_phone', value: '+91-9999999999',         category: 'general',   label: 'Support Phone' },
    { key: 'razorpay_key',  value: '',                       category: 'payment_gateway', label: 'Razorpay Key ID' },
    { key: 'razorpay_secret',value:'',                       category: 'payment_gateway', label: 'Razorpay Secret' },
    { key: 'whatsapp_url',  value: '',                       category: 'notifications',  label: 'WhatsApp API URL' },
    { key: 'whatsapp_key',  value: '',                       category: 'notifications',  label: 'WhatsApp API Key' },
  ];
  for (const s of defaults) {
    await Settings.findOneAndUpdate({ key: s.key }, s, { upsert: true });
  }
  console.log('✅ Default settings seeded');

  console.log('\n🎉 Seed complete!\n');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
