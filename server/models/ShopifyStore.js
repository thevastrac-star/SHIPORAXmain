const mongoose = require('mongoose');

// ─── SHOPIFY STORE ────────────────────────────────────────────────────────────
// One document per connected merchant store.
// Supports multi-tenant — each user can connect one store; admin can see all.
const ShopifyStoreSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  shop:        { type: String, required: true, unique: true },   // e.g. mystore.myshopify.com
  accessToken: { type: String, required: true },
  scopes:      { type: String },
  isActive:    { type: Boolean, default: true },
  installedAt: { type: Date, default: Date.now },
  uninstalledAt:{ type: Date },

  // Webhook IDs registered with Shopify — stored so we can deregister on uninstall
  webhooks: [{
    topic:     String,
    webhookId: String
  }],

  // Sync state
  lastOrderSync:  { type: Date },
  totalSynced:    { type: Number, default: 0 },
  syncErrors:     [{ message: String, at: { type: Date, default: Date.now } }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
ShopifyStoreSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });
ShopifyStoreSchema.index({ user: 1 });
ShopifyStoreSchema.index({ shop: 1 }, { unique: true });

module.exports = mongoose.models.ShopifyStore ||
  mongoose.model('ShopifyStore', ShopifyStoreSchema);
