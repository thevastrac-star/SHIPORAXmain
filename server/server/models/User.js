const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  phone: { type: String },
  companyName: { type: String, trim: true },
  role: { type: String, enum: ['admin', 'client'], default: 'client' },
  isActive: { type: Boolean, default: true },
  isBlocked: { type: Boolean, default: false },
  isFlagged: { type: Boolean, default: false },

  // Wallet
  walletBalance: { type: Number, default: 0 },

  // KYC
  kyc: {
    status: { type: String, enum: ['not_submitted', 'pending', 'approved', 'rejected'], default: 'not_submitted' },
    panNumber: { type: String },
    aadhaarNumber: { type: String },
    panDocument: { type: String },       // file path/URL
    aadhaarDocument: { type: String },
    rejectionReason: { type: String },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },

  // Fraud / Control limits
  limits: {
    maxOrdersPerDay: { type: Number, default: 100 },
    codLimit: { type: Number, default: 50000 }
  },

  // WhatsApp notifications
  whatsappNotifications: { type: Boolean, default: false },
  whatsappNumber: { type: String },

  // Integrations
  integrations: {
    shopify: {
      connected: { type: Boolean, default: false },
      storeUrl: { type: String },
      apiKey: { type: String },
      apiSecret: { type: String },
      accessToken: { type: String }
    },
    woocommerce: {
      connected: { type: Boolean, default: false },
      storeUrl: { type: String },
      consumerKey: { type: String },
      consumerSecret: { type: String }
    }
  },

  // Per-customer courier lock/unlock (array of courier ObjectIds that are LOCKED for this user)
  lockedCouriers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Courier' }],

  // Impersonation
  tempLoginToken: { type: String },
  tempLoginExpiry: { type: Date },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  this.updatedAt = new Date();
  next();
});

UserSchema.methods.comparePassword = async function (pwd) {
  return bcrypt.compare(pwd, this.password);
};

module.exports = mongoose.model('User', UserSchema);
