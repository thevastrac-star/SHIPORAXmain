/**
 * migrateCouriers.js
 * ------------------
 * Run once to:
 *  1. Delete ALL existing couriers and their selloship mappings
 *  2. Seed exactly two couriers:
 *       - Delhivery FR  (selloship courier_id: 30)
 *       - Amazon Shipping (selloship courier_id: 24)
 *
 * Usage:
 *   node config/migrateCouriers.js
 *
 * Reads MONGO_URI from environment (or .env if dotenv is installed).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGO_URI not set. Add it to your .env file.');
  process.exit(1);
}

// ── Schema inline (avoids circular model issues) ──────────────────────────────
const CourierSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  code:        { type: String, required: true },
  supportsCOD: { type: Boolean, default: true },
  logoUrl:     { type: String, default: '' },
  isActive:    { type: Boolean, default: true },
  apiConfig:   { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const MappingSchema = new mongoose.Schema({
  courier:              { type: mongoose.Schema.Types.ObjectId, ref: 'Courier', required: true },
  selloshipCourierId:   { type: String, default: '' },
  selloshipCourierName: { type: String, default: '' },
  isAutoRoute:          { type: Boolean, default: false },
  isActive:             { type: Boolean, default: true },
  notes:                { type: String, default: '' }
}, { timestamps: true });

const Courier = mongoose.models.Courier || mongoose.model('Courier', CourierSchema);
const Mapping = mongoose.models.CourierSelloshipMapping || mongoose.model('CourierSelloshipMapping', MappingSchema);

// ── Courier definitions ───────────────────────────────────────────────────────
const COURIERS = [
  {
    courier: {
      name:        'Delhivery FR',
      code:        'DLVRY',
      supportsCOD: true,
      isActive:    true,
      logoUrl:     'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Delhivery-Logo.svg/200px-Delhivery-Logo.svg.png'
    },
    mapping: {
      selloshipCourierId:   '30',
      selloshipCourierName: 'Delhivery FR',
      isAutoRoute: false,
      isActive:    true,
      notes:       'Delhivery Forward (Surface) via Selloship — courier_id 30'
    }
  },
  {
    courier: {
      name:        'Amazon Shipping',
      code:        'AMZN',
      supportsCOD: true,
      isActive:    true,
      logoUrl:     'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/200px-Amazon_logo.svg.png'
    },
    mapping: {
      selloshipCourierId:   '24',
      selloshipCourierName: 'Amazon Shipping',
      isAutoRoute: false,
      isActive:    true,
      notes:       'Amazon Shipping via Selloship — courier_id 24'
    }
  }
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');

  // 1. Wipe existing couriers and mappings
  const deletedMappings = await Mapping.deleteMany({});
  const deletedCouriers = await Courier.deleteMany({});
  console.log(`🗑   Deleted ${deletedCouriers.deletedCount} couriers, ${deletedMappings.deletedCount} mappings`);

  // 2. Seed new couriers + mappings
  for (const def of COURIERS) {
    const courier = await Courier.create(def.courier);
    await Mapping.create({ courier: courier._id, ...def.mapping });
    console.log(`✅  Created courier "${courier.name}" (${courier._id}) → Selloship ID: ${def.mapping.selloshipCourierId}`);
  }

  console.log('\n🎉  Migration complete! Panel now has 2 couriers: Delhivery FR & Amazon Shipping.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌  Migration failed:', err.message);
  mongoose.disconnect();
  process.exit(1);
});
