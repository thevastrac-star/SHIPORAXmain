const express = require('express');
const router = express.Router();
const { SupportTicket } = require('../models/index');
const { protect, adminOnly, logActivity } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const User = require('../models/User');

// POST /api/tickets  – client creates ticket
router.post('/', protect, async (req, res) => {
  try {
    const { subject, category, priority, message, relatedOrder } = req.body;
    const ticket = await SupportTicket.create({
      user: req.user._id, subject, category, priority,
      relatedOrder: relatedOrder || undefined,
      replies: [{ author: req.user._id, authorRole: req.user.role, message }]
    });
    res.status(201).json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/tickets  – list (client = own, admin = all)
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') filter.user = req.user._id;
    else if (req.query.userId) filter.user = req.query.userId;
    if (req.query.status) filter.status = req.query.status;

    const tickets = await SupportTicket.find(filter)
      .populate('user', 'name email')
      .populate('relatedOrder', 'orderId')
      .sort({ updatedAt: -1 });

    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/tickets/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id)
      .populate('user', 'name email')
      .populate('replies.author', 'name role');
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (req.user.role !== 'admin' && String(ticket.user._id) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/tickets/:id/reply  – both client and admin
router.post('/:id/reply', protect, async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    if (req.user.role !== 'admin' && String(ticket.user) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    ticket.replies.push({ author: req.user._id, authorRole: req.user.role, message: req.body.message });
    if (req.user.role === 'admin') ticket.status = 'in_progress';
    ticket.updatedAt = new Date();
    await ticket.save();

    // Notify the other party
    const notifyUserId = req.user.role === 'admin' ? ticket.user : null;
    if (notifyUserId) {
      const owner = await User.findById(notifyUserId);
      await createNotification(notifyUserId, 'ticket_reply', `Ticket Reply: ${ticket.ticketId}`,
        'Admin replied to your support ticket', ticket._id, owner?.whatsappNotifications);
    }

    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/tickets/:id/status  – admin changes status
router.patch('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['open', 'in_progress', 'resolved', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id, { status, updatedAt: new Date() }, { new: true }
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    await logActivity(req.user._id, 'admin', 'TICKET_STATUS', 'SupportTicket', ticket._id, { status }, req.ip);
    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
