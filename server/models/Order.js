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
    weight: { type: Number },           // in kg
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
  walletDeducted: { type: Boolean, default: false },  // prevent double-deduction

  // Courier preference from user
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

  // COD Reconciliation ref
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
  // Cancellation
  cancelledAt:         { type: Date },
  cancellationReason:  { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ─── AUTO-GENERATE ORDER ID WITH PER-CLIENT PREFIX ───────────────────────────
// Each client gets a unique prefix derived from their company/name.
// Format: <PREFIX><6-digit-sequence>  e.g.  ABC000042
// The sequence is per-user so no cross-client clashes are possible.
OrderSchema.pre('save', async function (next) {
  if (!this.orderId) {
    try {
      // Load the user to get (or generate) their prefix
      const User = mongoose.model('User');
      let user = await User.findById(this.user);

      if (user && !user.orderPrefix) {
        // Generate a unique prefix from companyName or name
        const source = (user.companyName || user.name || 'ORD').toUpperCase().replace(/[^A-Z0-9]/g, '');
        let base = source.substring(0, 3).padEnd(3, 'X');   // always 3 chars

        // Ensure uniqueness — append digit suffix if collision
        let candidate = base;
        let suffix = 0;
        while (true) {
          const clash = await User.findOne({ orderPrefix: candidate, _id: { $ne: user._id } });
          if (!clash) break;
          suffix++;
          candidate = base.substring(0, 2) + String(suffix % 10); // e.g. AB1, AB2 …
          if (suffix > 9) {
            // Last resort: random 3-char alphanumeric
            candidate = Math.random().toString(36).substring(2, 5).toUpperCase();
          }
        }
        user.orderPrefix = candidate;
        await User.updateOne({ _id: user._id }, { orderPrefix: candidate });
      }

      const prefix = (user && user.orderPrefix) ? user.orderPrefix : 'ORD';

      // Per-user sequence count
      const count = await mongoose.model('Order').countDocuments({ user: this.user });
      this.orderId = prefix + String(count + 1).padStart(6, '0');

      // Extremely rare collision guard (concurrent inserts)
      const exists = await mongoose.model('Order').findOne({ orderId: this.orderId });
      if (exists) {
        const total = await mongoose.model('Order').countDocuments();
        this.orderId = prefix + String(total + 1).padStart(6, '0') + Math.floor(Math.random() * 10);
      }
    } catch (e) {
      // Fallback: timestamp-based
      this.orderId = 'ORD' + Date.now();
    }
  }
  this.updatedAt = new Date();
  next();
});

const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
module.exports = Order;
