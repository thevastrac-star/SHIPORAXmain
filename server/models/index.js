const mongoose = require('mongoose');

// ─── WALLET TRANSACTION ──────────────────────────────────────────────────────
const WalletTransactionSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['credit', 'debit'], required: true },
  amount:      { type: Number, required: true },
  balance:     { type: Number },
  description: { type: String },
  reference:   { type: String },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:   { type: Date, default: Date.now }
});
const WalletTransaction = mongoose.models.WalletTransaction ||
  mongoose.model('WalletTransaction', WalletTransactionSchema);

// ─── WALLET RECHARGE ─────────────────────────────────────────────────────────
const WalletRechargeSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:         { type: Number, required: true },
  status:         { type: String, enum: ['pending','completed','failed'], default: 'pending' },
  paymentGateway: { type: String, default: 'manual' },
  transactionId:  { type: String },
  createdAt:      { type: Date, default: Date.now }
});
const WalletRecharge = mongoose.models.WalletRecharge ||
  mongoose.model('WalletRecharge', WalletRechargeSchema);

// ─── COURIER ─────────────────────────────────────────────────────────────────
const CourierSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  code:        { type: String, unique: true },
  isActive:    { type: Boolean, default: true },
  logoUrl:     { type: String },
  apiConfig: {
    baseUrl:     { type: String },
    apiKey:      { type: String },
    apiSecret:   { type: String },
    username:    { type: String },
    password:    { type: String },
    extraConfig: { type: mongoose.Schema.Types.Mixed }
  },
  supportsCOD: { type: Boolean, default: true },
  createdAt:   { type: Date, default: Date.now }
});
const Courier = mongoose.models.Courier ||
  mongoose.model('Courier', CourierSchema);

// ─── SHIPPING RATE ────────────────────────────────────────────────────────────
const ShippingRateSchema = new mongoose.Schema({
  courier:   { type: mongoose.Schema.Types.ObjectId, ref: 'Courier', required: true },
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = global
  slabName:  { type: String, default: 'Standard' },
  zones: {
    a: { type: Number, default: 0 }, // within city
    b: { type: Number, default: 0 }, // metro to metro
    c: { type: Number, default: 0 }, // metro to non-metro
    d: { type: Number, default: 0 }, // national standard
    e: { type: Number, default: 0 }  // remote / special
  },
  minWeight:            { type: Number, default: 0 },
  maxWeight:            { type: Number, default: 0.5 },
  additionalWeightRate: { type: Number, default: 0 },
  cod: {
    type:            { type: String, enum: ['flat','percent'], default: 'flat' },
    flat:            { type: Number, default: 30 },
    percent:         { type: Number, default: 1.5 },
    thresholdAmount: { type: Number, default: 1500 },
    mode:            { type: String, enum: ['flat_always','percent_always','threshold'], default: 'threshold' }
  },
  fuelSurcharge: { type: Number, default: 0 },
  isActive:      { type: Boolean, default: true },
  history: [{
    changedAt: { type: Date },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    snapshot:  { type: mongoose.Schema.Types.Mixed }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const ShippingRate = mongoose.models.ShippingRate ||
  mongoose.model('ShippingRate', ShippingRateSchema);

// ─── COURIER PREFERENCE ──────────────────────────────────────────────────────
const CourierPreferenceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  priorities: [{
    priority: { type: Number },
    courier:  { type: mongoose.Schema.Types.ObjectId, ref: 'Courier' }
  }],
  updatedAt: { type: Date, default: Date.now }
});
const CourierPreference = mongoose.models.CourierPreference ||
  mongoose.model('CourierPreference', CourierPreferenceSchema);

// ─── WAREHOUSE ────────────────────────────────────────────────────────────────
// FIX #13 + #14: add warehouseCode, gstNumber, landmark to schema
const WarehouseSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:          { type: String, required: true },
  warehouseCode: { type: String },   // FIX #13
  contactName:   { type: String },
  phone:         { type: String },
  email:         { type: String },
  address:       { type: String },
  landmark:      { type: String },   // FIX #14
  city:          { type: String },
  state:         { type: String },
  pincode:       { type: String },
  gstNumber:     { type: String },   // FIX #14
  isDefault:     { type: Boolean, default: false },
  createdAt:     { type: Date, default: Date.now }
});
const Warehouse = mongoose.models.Warehouse ||
  mongoose.model('Warehouse', WarehouseSchema);

// ─── SUPPORT TICKET ───────────────────────────────────────────────────────────
const TicketReplySchema = new mongoose.Schema({
  author:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorRole: { type: String, enum: ['admin','client'] },
  message:    { type: String },
  createdAt:  { type: Date, default: Date.now }
});
const SupportTicketSchema = new mongoose.Schema({
  ticketId:     { type: String, unique: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:      { type: String, required: true },
  category:     { type: String, enum: ['billing','shipment','technical','other'], default: 'other' },
  priority:     { type: String, enum: ['low','medium','high'], default: 'medium' },
  status:       { type: String, enum: ['open','in_progress','resolved','closed'], default: 'open' },
  replies:      [TicketReplySchema],
  relatedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now }
});
SupportTicketSchema.pre('save', async function (next) {
  if (!this.ticketId) {
    const count = await mongoose.model('SupportTicket').countDocuments();
    this.ticketId = 'TKT' + String(count + 1).padStart(5, '0');
  }
  this.updatedAt = new Date();
  next();
});
const SupportTicket = mongoose.models.SupportTicket ||
  mongoose.model('SupportTicket', SupportTicketSchema);

// ─── NDR ──────────────────────────────────────────────────────────────────────
const NDRSchema = new mongoose.Schema({
  order:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  awbNumber: { type: String },
  reason:    { type: String },
  attempts:  { type: Number, default: 1 },
  status:    { type: String, enum: ['pending','reattempt_requested','reattempt_scheduled','rto_initiated','resolved'], default: 'pending' },
  clientNote:{ type: String },
  adminNote: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const NDR = mongoose.models.NDR || mongoose.model('NDR', NDRSchema);

// ─── COD RECONCILIATION ───────────────────────────────────────────────────────
const CodReconciliationSchema = new mongoose.Schema({
  order:          { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  awbNumber:      { type: String },
  expectedAmount: { type: Number },
  receivedAmount: { type: Number, default: 0 },
  status:         { type: String, enum: ['pending','partial','settled','disputed'], default: 'pending' },
  settlementDate: { type: Date },
  remarks:        { type: String },
  history: [{
    action:      String,
    amount:      Number,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at:          { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const CodReconciliation = mongoose.models.CodReconciliation ||
  mongoose.model('CodReconciliation', CodReconciliationSchema);

// ─── NOTIFICATION ─────────────────────────────────────────────────────────────
const NotificationSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type:      { type: String },
  channel:   { type: String, enum: ['whatsapp','email','in_app'], default: 'in_app' },
  title:     { type: String },
  message:   { type: String },
  reference: { type: String },
  isRead:    { type: Boolean, default: false },
  isSent:    { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.models.Notification ||
  mongoose.model('Notification', NotificationSchema);

// ─── ACTIVITY LOG ─────────────────────────────────────────────────────────────
const ActivityLogSchema = new mongoose.Schema({
  actor:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorRole: { type: String },
  action:    { type: String },
  entity:    { type: String },
  entityId:  { type: String },
  details:   { type: mongoose.Schema.Types.Mixed },
  ip:        { type: String },
  createdAt: { type: Date, default: Date.now }
});
const ActivityLog = mongoose.models.ActivityLog ||
  mongoose.model('ActivityLog', ActivityLogSchema);

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
const SettingsSchema = new mongoose.Schema({
  key:       { type: String, unique: true, required: true },
  value:     { type: mongoose.Schema.Types.Mixed },
  category:  { type: String, enum: ['payment_gateway','courier_api','general','notifications'], default: 'general' },
  label:     { type: String },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now }
});
const Settings = mongoose.models.Settings ||
  mongoose.model('Settings', SettingsSchema);

// ─── BULK UPLOAD ──────────────────────────────────────────────────────────────
const BulkUploadSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fileName:    { type: String },
  totalRows:   { type: Number, default: 0 },
  successRows: { type: Number, default: 0 },
  failedRows:  { type: Number, default: 0 },
  status:      { type: String, enum: ['processing','completed','failed'], default: 'processing' },
  errors:      [{ row: Number, error: String }],
  createdAt:   { type: Date, default: Date.now }
});
const BulkUpload = mongoose.models.BulkUpload ||
  mongoose.model('BulkUpload', BulkUploadSchema);

// ─── ORDER COUNTER (atomic sequence, fixes #2) ────────────────────────────────
const OrderCounterSchema = new mongoose.Schema({
  prefix: { type: String, unique: true, required: true },
  seq:    { type: Number, default: 0 }
});
const OrderCounter = mongoose.models.OrderCounter ||
  mongoose.model('OrderCounter', OrderCounterSchema);

// ─── COURIER → SELLOSHIP MAPPING ─────────────────────────────────────────────
// Admin maps each internal Courier doc to a Selloship courierId + courierName.
// When client ships with courier X, we look up this mapping and pass the
// correct selloship courierId/courierName in the waybill payload.
//
// selloshipCourierId: the numeric/string ID Selloship returns in serviceability
// selloshipCourierName: the display name (e.g. "Delhivery", "Bluedart")
// isAutoRoute: if true, Selloship picks best courier automatically (no override)
const CourierSelloshipMappingSchema = new mongoose.Schema({
  courier:             { type: mongoose.Schema.Types.ObjectId, ref: 'Courier', required: true, unique: true },
  selloshipCourierId:  { type: String, default: '' },   // pass as courierId in payload
  selloshipCourierName:{ type: String, default: '' },   // pass as courierName in payload
  isAutoRoute:         { type: Boolean, default: false },// true → let Selloship auto-select
  isActive:            { type: Boolean, default: true }, // false → block this courier on Selloship
  notes:               { type: String, default: '' },
  updatedBy:           { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt:           { type: Date, default: Date.now }
});
const CourierSelloshipMapping = mongoose.models.CourierSelloshipMapping ||
  mongoose.model('CourierSelloshipMapping', CourierSelloshipMappingSchema);

module.exports = {
  WalletTransaction, WalletRecharge, Courier, ShippingRate,
  CourierPreference, Warehouse, SupportTicket, NDR,
  CodReconciliation, Notification, ActivityLog, Settings,
  BulkUpload, OrderCounter, CourierSelloshipMapping
};
