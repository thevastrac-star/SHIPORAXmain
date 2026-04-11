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

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto generate orderId
OrderSchema.pre('save', async function (next) {
  if (!this.orderId) {
    const count = await mongoose.model('Order').countDocuments();
    this.orderId = 'ORD' + String(count + 1).padStart(6, '0');
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Order', OrderSchema);
