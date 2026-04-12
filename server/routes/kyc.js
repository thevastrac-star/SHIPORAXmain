const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const User    = require('../models/User');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { createNotification }              = require('../utils/notifications');

// ─── MULTER ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/kyc/'),
  filename:    (req, file, cb) => cb(null,
    `${req.user._id}-${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only images (JPG/PNG/WEBP) and PDF allowed'), ok);
  }
});

const kycFields = upload.fields([
  { name: 'panDocument',      maxCount: 1 },
  { name: 'aadhaarDocument',  maxCount: 1 },
  { name: 'bankDocument',     maxCount: 1 }
]);

// ─── SUBMIT KYC (client) ──────────────────────────────────────────────────────
// Rules: can submit if not_submitted OR rejected. Cannot re-submit if pending/approved.
router.post('/submit', protect, kycFields, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    // Submit-once lock
    if (['pending', 'approved'].includes(user.kyc.status)) {
      return res.status(400).json({
        success: false,
        message: user.kyc.status === 'approved'
          ? 'Your KYC is already approved. No changes needed.'
          : 'Your KYC is already under review. Please wait for admin decision.'
      });
    }

    const {
      panNumber, aadhaarNumber,
      bankAccountName, bankAccountNumber, bankIFSC, bankName,
      gstNumber
    } = req.body;

    // Required field validation
    if (!panNumber)          return res.status(400).json({ success: false, message: 'PAN number is required' });
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber.toUpperCase()))
      return res.status(400).json({ success: false, message: 'Invalid PAN format (e.g. ABCDE1234F)' });
    if (!aadhaarNumber)      return res.status(400).json({ success: false, message: 'Aadhaar number is required' });
    if (!/^\d{12}$/.test(aadhaarNumber.replace(/\s/g,'')))
      return res.status(400).json({ success: false, message: 'Aadhaar must be 12 digits' });
    if (!bankAccountName)    return res.status(400).json({ success: false, message: 'Bank account name is required' });
    if (!bankAccountNumber)  return res.status(400).json({ success: false, message: 'Bank account number is required' });
    if (!bankIFSC)           return res.status(400).json({ success: false, message: 'IFSC code is required' });
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIFSC.toUpperCase()))
      return res.status(400).json({ success: false, message: 'Invalid IFSC format (e.g. SBIN0001234)' });

    // GST optional validation
    if (gstNumber && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{3}$/.test(gstNumber.toUpperCase()))
      return res.status(400).json({ success: false, message: 'Invalid GST number format' });

    // Update KYC fields
    user.kyc.panNumber          = panNumber.toUpperCase();
    user.kyc.aadhaarNumber      = aadhaarNumber.replace(/\s/g,'');
    user.kyc.bankAccountName    = bankAccountName;
    user.kyc.bankAccountNumber  = bankAccountNumber;
    user.kyc.bankIFSC           = bankIFSC.toUpperCase();
    user.kyc.bankName           = bankName || '';
    user.kyc.gstNumber          = gstNumber ? gstNumber.toUpperCase() : '';

    // File uploads
    const f = req.files || {};
    if (f.panDocument?.[0])     user.kyc.panDocument     = f.panDocument[0].path;
    if (f.aadhaarDocument?.[0]) user.kyc.aadhaarDocument = f.aadhaarDocument[0].path;
    if (f.bankDocument?.[0])    user.kyc.bankDocument    = f.bankDocument[0].path;

    user.kyc.status      = 'pending';
    user.kyc.submittedAt = new Date();
    user.kyc.rejectionReason = '';

    await user.save();

    await logActivity(req.user._id, 'client', 'KYC_SUBMIT', 'User', user._id, {}, req.ip);

    res.json({ success: true, message: 'KYC submitted successfully. Under review.', kyc: user.kyc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET OWN KYC STATUS (client) ─────────────────────────────────────────────
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('kyc');
    res.json({ success: true, kyc: user.kyc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: LIST ALL KYC ─────────────────────────────────────────────────────
router.get('/admin/list', protect, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter['kyc.status'] = req.query.status;
    const users = await User.find(filter)
      .select('name email phone kyc createdAt')
      .sort({ 'kyc.submittedAt': -1 });
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: GET ONE USER KYC ──────────────────────────────────────────────────
router.get('/admin/:userId', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('name email phone kyc');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: APPROVE / REJECT ──────────────────────────────────────────────────
router.post('/admin/review/:userId', protect, adminOnly, async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!['approved', 'rejected'].includes(status))
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.kyc.status     = status;
    user.kyc.reviewedAt = new Date();
    user.kyc.reviewedBy = req.user._id;
    if (status === 'rejected') user.kyc.rejectionReason = reason || 'No reason given';

    await user.save();

    await logActivity(req.user._id, 'admin', `KYC_${status.toUpperCase()}`, 'User', user._id, { reason }, req.ip);

    await createNotification(
      user._id, 'kyc_update', `KYC ${status}`,
      status === 'approved' ? 'Your KYC has been approved!' : `KYC rejected: ${reason}`,
      user._id, user.whatsappNotifications
    );

    res.json({ success: true, message: `KYC ${status}`, kyc: user.kyc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
