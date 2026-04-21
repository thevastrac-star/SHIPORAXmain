const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  source: { type: String, enum: ['manual', 'shopify', 'woocommerce', 'bulk_upload'], default: 'manual' },

  // Sender
  pickupWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },

  // Recipient
  recipient: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    address: { type: String, required: true },
    city: { type: String },
    state: { type: String },
    pincode: { type: String, required: true },
    landmark: { type: String }
  },

  // Package
  package: {
    weight: { type: Number },
    length: { type: Number },
    breadth: { type: Number },
    height: { type: Number },
    description: { type: String },
    value: { type: Number }
  },

  // Payment
  paymentMode: { type: String, enum: ['prepaid', 'cod'], default: 'prepaid' },
  codAmount: { type: Number, default: 0 },

  // Shipment
  status: {
    type: String,
    enum: ['draft', 'processing', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'rto', 'cancelled', 'ndr'],
    default: 'draft'
  },
  assignedCourier: { type: mongoose.Schema.Types.ObjectId, ref: 'Courier' },
  awbNumber: { type: String },
  trackingUrl: { type: String },
  shippingCharge: { type: Number, default: 0 },
  walletDeducted: { type: Boolean, default: false },

  courierPreference: { type: mongoose.Schema.Types.ObjectId, ref: 'CourierPreference' },

  // NDR
  ndr: {
    isNDR: { type: Boolean, default: false },
    reason: { type: String },
    attempts: { type: Number, default: 0 },
    reattemptRequested: { type: Boolean, default: false },
    reattemptNote: { type: String },
    adminStatus: { type: String, enum: ['pending', 'reattempt_scheduled', 'rto_initiated', 'resolved'], default: 'pending' }
  },

  codReconciliation: { type: mongoose.Schema.Types.ObjectId, ref: 'CodReconciliation' },

  // Duplicate prevention
  duplicateCheckKey: { type: String },  // phone+pincode

  // Selloship integration data
  selloship: {
    waybill:            { type: String },
    courierName:        { type: String },
    routingCode:        { type: String },
    labelUrl:           { type: String },
    shippedAt:          { type: Date },
    reverseWaybill:     { type: String },
    reverseLabelUrl:    { type: String },
    reversedAt:         { type: Date },
    lastWebhookStatus:  { type: String },
    lastWebhookAt:      { type: Date }
  },

  cancelledAt:         { type: Date },
  cancellationReason:  { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ─── ATOMIC COUNTER SCHEMA ────────────────────────────────────────────────────
// One document per user, incremented atomically with findOneAndUpdate + $inc.
// This is safe under any level of parallel inserts — no race conditions.
const OrderCounterSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  seq:    { type: Number, default: 0 }
});
const OrderCounter = mongoose.models.OrderCounter || mongoose.model('OrderCounter', OrderCounterSchema);

/**
 * getNextSeq — atomically increments the per-user counter and returns the new value.
 * findOneAndUpdate with $inc is a single atomic operation in MongoDB;
 * concurrent calls always get different numbers.
 */
async function getNextSeq(userId) {
  const doc = await OrderCounter.findOneAndUpdate(
    { userId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
}

// ─── AUTO-GENERATE ORDER ID WITH PER-CLIENT PREFIX ───────────────────────────
// Format: <PREFIX><6-digit-sequence>  e.g.  THE000007, THE000008 …
// PREFIX is derived once from the user's company/name and stored on the User doc.
// The sequence comes from the atomic OrderCounter — safe under bulk parallel inserts.
OrderSchema.pre('save', async function (next) {
  if (!this.orderId) {
    try {
      const User = mongoose.model('User');
      let user = await User.findById(this.user);

      // ── Assign prefix once per user ──────────────────────────────────────
      if (user && !user.orderPrefix) {
        const source = (user.companyName || user.name || 'ORD').toUpperCase().replace(/[^A-Z0-9]/g, '');
        let base = source.substring(0, 3).padEnd(3, 'X');
        let candidate = base;
        let suffix = 0;
        while (true) {
          const clash = await User.findOne({ orderPrefix: candidate, _id: { $ne: user._id } });
          if (!clash) break;
          suffix++;
          candidate = suffix <= 9
            ? base.substring(0, 2) + String(suffix)
            : Math.random().toString(36).substring(2, 5).toUpperCase();
        }
        user.orderPrefix = candidate;
        await User.updateOne({ _id: user._id }, { orderPrefix: candidate });
      }

      const prefix = (user && user.orderPrefix) ? user.orderPrefix : 'ORD';

      // ── Atomic sequence — no race condition ──────────────────────────────
      const seq = await getNextSeq(this.user);
      this.orderId = prefix + String(seq).padStart(6, '0');

    } catch (e) {
      // Last-resort fallback: timestamp + random suffix (still unique)
      this.orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    }
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Order || mongoose.model('Order', OrderSchema);
