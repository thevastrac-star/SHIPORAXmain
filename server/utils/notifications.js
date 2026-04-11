const { Notification } = require('../models/index');

/**
 * Create an in-app (+ optionally WhatsApp placeholder) notification
 */
exports.createNotification = async (userId, type, title, message, reference, whatsappEnabled = false) => {
  try {
    // In-app
    await Notification.create({ user: userId, type, channel: 'in_app', title, message, reference });

    // WhatsApp placeholder – no real API call
    if (whatsappEnabled) {
      await Notification.create({
        user: userId, type, channel: 'whatsapp', title, message, reference,
        isSent: false  // would be set to true by actual integration
      });
      // TODO: Integrate actual WhatsApp API (e.g. Twilio/WATI/Interakt)
      console.log(`[WhatsApp PLACEHOLDER] To ${userId}: ${title} – ${message}`);
    }
  } catch (e) {
    console.error('Notification error:', e.message);
  }
};
