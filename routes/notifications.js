const express = require('express');
const router = express.Router();
const { Notification } = require('../models/index');
const { protect } = require('../middleware/auth');

// GET /api/notifications
router.get('/', protect, async (req, res) => {
  const notifs = await Notification.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50);
  const unread = notifs.filter(n => !n.isRead).length;
  res.json({ success: true, notifications: notifs, unread });
});

// PATCH /api/notifications/mark-read
router.patch('/mark-read', protect, async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  res.json({ success: true });
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', protect, async (req, res) => {
  await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { isRead: true });
  res.json({ success: true });
});

module.exports = router;
