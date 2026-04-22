const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  email:       { type: String, required: true, unique: true, lowercase: true },
  password:    { type: String, required: true },
  phone:       { type: String },
  companyName: { type: String, trim: true },
  role:        { type: String, enum: ['admin', 'client'], default: 'client' },
  isActive:    { type: Boolean, default: true },
  isBlocked:   { type: Boolean, default: false },
  isFlagged:   { type: Boolean, default: false },

  walletBalance: { type: Number, default: 0 },

  kyc: {
    status:            { type: String, enum: ['not_submitted','pending','approved','rejected'], default: 'not_submitted' },
    panNumber:         { type: String },
    aadhaarNumber:     { type: String },
    panDocument:       { type: String },
    aadhaarDocument:   { type: String },
    bankAccountName:   { type: String },
    bankAccountNumber: { type: String },
    bankIFSC:          { type: String },
    bankName:          { type: String },
    bankDocument:      { type: String },
    gstNumber:         { type: String },
    rejectionReason:   { type: String },
    submittedAt:       { type: Date },
    reviewedAt:        { type: Date },
    reviewedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },

  limits: {
    maxOrdersPerDay: { type: Number, default: 100 },
    codLimit:        { type: Number, default: 50000 }
  },

  whatsappNotifications: { type: Boolean, default: false },
  whatsappNumber:        { type: String },

  // Integration secrets stored encrypted — encrypt/decrypt in route layer
  integrations: {
    shopify: {
      connected:   { type: Boolean, default: false },
      storeUrl:    { type: String },
      apiKey:      { type: String },
      apiSecret:   { type: String },  // encrypt before saving
      accessToken: { type: String }
    },
    woocommerce: {
      connected:      { type: Boolean, default: false },
      storeUrl:       { type: String },
      consumerKey:    { type: String },
      consumerSecret: { type: String }  // encrypt before saving
    }
  },

  lockedCouriers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Courier' }],

  orderPrefix: { type: String, unique: true, sparse: true, uppercase: true, trim: true },

  // [FIX-API] External API key (SHA-256 hashed) for X-API-Key authentication
  apiKey: { type: String, unique: true, sparse: true },

  tempLoginToken:  { type: String },
  tempLoginExpiry: { type: Date },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', async function (next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  this.updatedAt = new Date();
  next();
});

UserSchema.methods.comparePassword = function (pwd) {
  return bcrypt.compare(pwd, this.password);
};

// FIX #3: guard against OverwriteModelError on double-require
module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
