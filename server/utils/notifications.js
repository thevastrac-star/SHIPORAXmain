const { Notification, Settings } = require('../models/index');

/**
 * Create in-app notification + optionally send WhatsApp.
 * FIX #23: no longer creates ghost Notification records for unimplemented WhatsApp.
 *          When WhatsApp IS integrated, call real API and mark isSent:true.
 */
exports.createNotification = async (userId, type, title, message, reference, whatsappEnabled = false) => {
  try {
    // In-app notification — always created
    await Notification.create({ user: userId, type, channel: 'in_app', title, message, reference, isSent: true });

    // WhatsApp — only attempt if enabled and API URL is configured
    if (whatsappEnabled) {
      const [urlSetting, keySetting] = await Promise.all([
        Settings.findOne({ key: 'whatsapp_url' }),
        Settings.findOne({ key: 'whatsapp_key' })
      ]);
      const apiUrl = urlSetting?.value;
      const apiKey = keySetting?.value;

      if (apiUrl && apiKey) {
        try {
          // TODO: replace with actual WhatsApp provider (WATI / Interakt / Twilio)
          const axios = require('axios');
          await axios.post(apiUrl, { userId, title, message }, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 5000
          });
          await Notification.create({ user: userId, type, channel: 'whatsapp', title, message, reference, isSent: true });
        } catch (e) {
          console.error('[WhatsApp send error]', e.message);
          // Do NOT create a DB record with isSent:false — it's just noise
        }
      } else {
        // API not configured — skip silently (don't create ghost records)
        console.log(`[WhatsApp UNCONFIGURED] skipping notification for user ${userId}: ${title}`);
      }
    }
  } catch (e) {
    console.error('Notification error:', e.message);
  }
};
