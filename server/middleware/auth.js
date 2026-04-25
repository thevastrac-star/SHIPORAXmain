const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const { ActivityLog } = require('../models/index');

// Verify JWT
exports.protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Not authorized' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id).select('-password');
    if (!user)           return res.status(401).json({ success: false, message: 'User not found' });
    if (user.isBlocked)  return res.status(403).json({ success: false, message: 'Account blocked' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

exports.adminOnly = (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ success: false, message: 'Admin access required' });
};

exports.clientOnly = (req, res, next) => {
  if (req.user?.role === 'client') return next();
  return res.status(403).json({ success: false, message: 'Client access required' });
};

exports.logActivity = async (actor, actorRole, action, entity, entityId, details, ip) => {
  try {
    await ActivityLog.create({ actor, actorRole, action, entity, entityId, details, ip });
  } catch (_) { /* silent */ }
};
