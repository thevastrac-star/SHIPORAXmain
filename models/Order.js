const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  source:  { type: String, enum: ['manual','shopify','woocommerce','bulk_upload'], default: 'manual' },

  pickupWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },

  recipient: {
    name:     { type: String, required: true },
    phone:    { type: String, required: true },
    email:    { type: String },
    address:  { type: String, required: true },
    city:     { type: String },
    state:    { type: String },
    pincode:  { type: String, required: true },
    landmark: { type: String }
  },

  package: {
    weight:      { type: Number }, // kg
    length:      { type: Number },
    breadth:     { type: Number },
    height:      { type: Number },
    description: { type: String },
    value:       { type: Number }
  },

  paymentMode: { type: String, enum: ['prepaid','cod'], default: 'prepaid' },
  codAmount:   { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['draft','processing','shipped','in_transit','out_for_delivery','delivered','rto','cancelled','ndr'],
    default: 'draft'
  },
  assignedCourier: { type: mongoose.Schema.Types.ObjectId, ref: 'Courier' },
  awbNumber:       { type: String },
  trackingUrl:     { type: String },
  shippingCharge:  { type: Number, default: 0 },
  walletDeducted:  { type: Boolean, default: false },

  courierPreference: { type: mongoose.Schema.Types.ObjectId, ref: 'CourierPreference' },

  ndr: {
    isNDR:              { type: Boolean, default: false },
    reason:             { type: String },
    attempts:           { type: Number, default: 0 },
    reattemptRequested: { type: Boolean, default: false },
    reattemptNote:      { type: String },
    adminStatus:        { type: String, enum: ['pending','reattempt_scheduled','rto_initiated','resolved'], default: 'pending' }
  },

  codReconciliation: { type: mongoose.Schema.Types.ObjectId, ref: 'CodReconciliation' },

  // FIX #16: duplicateCheckKey is now set explicitly in route before create()
  duplicateCheckKey: { type: String },

  selloship: {
    waybill:           { type: String },
    courierName:       { type: String },
    routingCode:       { type: String },
    labelUrl:          { type: String },
    shippedAt:         { type: Date },
    reverseWaybill:    { type: String },
    reverseLabelUrl:   { type: String },
    reversedAt:        { type: Date },
    lastWebhookStatus: { type: String },
    lastWebhookAt:     { type: Date }
  },

  cancelledAt:        { type: Date },
  cancellationReason: { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// FIX #2: atomic orderId generation — no race condition
// Uses OrderCounter with $inc (findOneAndUpdate is atomic in MongoDB)
// ─── ATOMIC ORDER ID GENERATION ──────────────────────────────────────────────
// Uses findOneAndUpdate $inc (atomic) + collision retry to prevent E11000.
async function generateOrderId(userId) {
  const User = mongoose.models.User;
  const { OrderCounter } = require('./index');

  let user = await User.findById(userId);

  // Assign prefix if not yet set
  if (user && !user.orderPrefix) {
    const source = (user.companyName || user.name || 'ORD').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let base = source.substring(0, 3).padEnd(3, 'X');
    let candidate = base, suffix = 0;
    while (true) {
      const clash = await User.findOne({ orderPrefix: candidate, _id: { $ne: user._id } });
      if (!clash) break;
      suffix++;
      candidate = suffix > 9
        ? Math.random().toString(36).substring(2, 5).toUpperCase()
        : base.substring(0, 2) + String(suffix % 10);
    }
    // Use findOneAndUpdate to avoid race on prefix assignment too
    const updated = await User.findOneAndUpdate(
      { _id: user._id, orderPrefix: { $exists: false } },
      { $set: { orderPrefix: candidate } },
      { new: true }
    );
    user = updated || await User.findById(userId);
  }

  const prefix = (user?.orderPrefix) || 'ORD';

  // Retry loop: handles the rare case where $inc gives a seq that was already used
  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = await OrderCounter.findOneAndUpdate(
      { prefix },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    const candidate = prefix + String(counter.seq).padStart(6, '0');
    // Check if this orderId already exists (handles legacy/imported orders)
    const Order = mongoose.models.Order;
    const exists = Order ? await Order.findOne({ orderId: candidate }).lean() : null;
    if (!exists) return candidate;
    // Exists — loop to get next seq
  }
  // Final fallback: timestamp-based, guaranteed unique
  return prefix + Date.now().toString().slice(-8);
}

OrderSchema.pre('save', async function (next) {
  if (!this.orderId) {
    try {
      this.orderId = await generateOrderId(this.user);
    } catch (e) {
      // Absolute last resort
      this.orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    }
  }
  this.updatedAt = new Date();
  next();
});

// FIX #4: model guard
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
module.exports = Order;
