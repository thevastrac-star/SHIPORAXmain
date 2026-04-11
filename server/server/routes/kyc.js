const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const User = require('../models/User');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');

// Multer config for KYC documents
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/kyc/'),
  filename: (req, file, cb) => cb(null, `${req.user._id}-${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/kyc/submit  – client submits KYC
router.post('/submit', protect, upload.fields([
  { name: 'panDocument', maxCount: 1 },
  { name: 'aadhaarDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { panNumber, aadhaarNumber } = req.body;
    const user = await User.findById(req.user._id);

    user.kyc.panNumber = panNumber;
    user.kyc.aadhaarNumber = aadhaarNumber;
    if (req.files.panDocument) user.kyc.panDocument = req.files.panDocument[0].path;
    if (req.files.aadhaarDocument) user.kyc.aadhaarDocument = req.files.aadhaarDocument[0].path;
    user.kyc.status = 'pending';
    user.kyc.submittedAt = new Date();

    await user.save();
    res.json({ success: true, message: 'KYC submitted for review', status: user.kyc.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/kyc/status  – client checks own KYC status
router.get('/status', protect, async (req, res) => {
  const user = await User.findById(req.user._id).select('kyc');
  res.json({ success: true, kyc: user.kyc });
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

// GET /api/kyc/admin/list  – all KYC submissions
router.get('/admin/list', protect, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter['kyc.status'] = req.query.status;
    const users = await User.find(filter).select('name email phone kyc createdAt').sort({ 'kyc.submittedAt': -1 });
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/kyc/admin/:userId  – view one user's KYC
router.get('/admin/:userId', protect, adminOnly, async (req, res) => {
  const user = await User.findById(req.params.userId).select('name email phone kyc');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

// POST /api/kyc/admin/review/:userId  – approve or reject
router.post('/admin/review/:userId', protect, adminOnly, async (req, res) => {
  try {
    const { status, reason } = req.body;  // status: 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.kyc.status = status;
    user.kyc.reviewedAt = new Date();
    user.kyc.reviewedBy = req.user._id;
    if (status === 'rejected') user.kyc.rejectionReason = reason;

    await user.save();

    await logActivity(req.user._id, 'admin', `KYC_${status.toUpperCase()}`, 'User', user._id,
      { reason }, req.ip);

    await createNotification(user._id, 'kyc_update', `KYC ${status}`,
      status === 'approved' ? 'Your KYC has been approved!' : `KYC rejected: ${reason}`,
      user._id, user.whatsappNotifications);

    res.json({ success: true, message: `KYC ${status}`, kyc: user.kyc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
