// ─── ADD THESE FIELDS TO YOUR WAREHOUSE SCHEMA in server/models/index.js ─────
// After: isDefault: { type: Boolean, default: false },
// Add:
//   warehouseCode: { type: String, unique: true, sparse: true },
//   gstNumber: { type: String },
//   landmark: { type: String },

// ─── ADD THESE FIELDS TO YOUR USER SCHEMA in server/models/User.js ──────────
// After orderPrefix field, add:
//   labelSettings: {
//     showLogo:         { type: Boolean, default: false },
//     customLogoUrl:    { type: String },
//     showSupportEmail: { type: Boolean, default: false },
//     supportEmail:     { type: String },
//     supportPhone:     { type: String },
//     hideCustomerPhone:{ type: Boolean, default: false },
//     hidePickupAddress:{ type: Boolean, default: false },
//     hidePickupPhone:  { type: Boolean, default: false },
//     hideRtoAddress:   { type: Boolean, default: false },
//     hideRtoPhone:     { type: Boolean, default: false },
//     hideGst:          { type: Boolean, default: false },
//     showItemTable:    { type: Boolean, default: false },
//     labelNote:        { type: String },
//     labelFooter:      { type: String },
//     brandColor:       { type: String, default: '#0D1B3E' },
//     labelSize:        { type: String, default: 'a4' }
//   },

// ─── IN server/routes/orders.js — ADD THESE NEW ROUTES ───────────────────────
// Copy the full orders_enhanced.js and replace your existing orders.js
// Key additions:
// 1. POST /api/orders/bulk-upload  — now uses parallel chunked processing (50 at a time)
//    + resolves warehouse_id column from warehouseCode
// 2. POST /api/orders/bulk-ship   — parallel chunks of 20, returns shipped/failed counts
// 3. GET  /api/orders/label-settings  — fetch user's label settings
// 4. POST /api/orders/label-settings  — save label settings
// 5. POST /api/orders/bulk-labels     — generate bulk label HTML for printing

// ─── IN server/routes/warehouses.js ─────────────────────────────────────────
// Copy warehouses_enhanced.js — auto-generates warehouseCode on creation
// Format: WH-{3LETTERS}-{3DIGITS}  e.g. WH-KWL-001

// ─── CLIENT PANEL (index.html) ───────────────────────────────────────────────
// Replace server/public/client/index.html with the provided index.html
// New features:
// - Label Settings page with live preview (matching reference image)
// - Bulk Upload: drag-drop, progress bar, warehouse_id column support
// - Bulk Ship: parallel progress modal showing live shipped/failed count
// - Bulk Label Download: generates printable HTML labels
// - Warehouse Cards: show unique WH codes with copy button
