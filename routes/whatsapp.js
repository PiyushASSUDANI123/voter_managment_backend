const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db');
const { verifyToken, requireModule } = require('../middleware/authMiddleware');
const { addVoterAccess } = require('../lib/access');

router.post('/send-slip', verifyToken, requireModule('voters'), async (req, res) => {
  let dispatchId = null;
  let metaAccepted = false;
  try {
    const { voterId, phoneNumber } = req.body;
    const token = process.env.META_WHATSAPP_TOKEN?.trim();
    const phoneNumberId = process.env.META_PHONE_ID?.trim();
    const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim();

    if (!token || !phoneNumberId || !graphApiVersion) {
      return res.status(503).json({ message: 'WhatsApp sending is unavailable until Meta API credentials are configured.' });
    }
    const numericVoterId = Number.parseInt(voterId, 10);
    if (!Number.isInteger(numericVoterId) || numericVoterId <= 0 || typeof phoneNumber !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
      return res.status(400).json({ message: 'A valid voter ID and phone number are required.' });
    }

    const accessParams = [];
    const access = addVoterAccess(req, accessParams);
    accessParams.push(numericVoterId);
    const result = await db.query(`SELECT * FROM voters WHERE ${access} AND id = $${accessParams.length}`, accessParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Voter not found' });
    }

    const dbVoter = result.rows[0];
    const dispatch = await db.query(`
      INSERT INTO slip_dispatches (voter_id, voter_epic, voter_name, recipient_phone, status, organization_id)
      VALUES ($1, $2, $3, $4, 'sending', $5)
      RETURNING id
    `, [dbVoter.id, dbVoter.epic, dbVoter.name_hi || dbVoter.name_en || '', phoneNumber.trim(), req.user.organizationId || 'org_default']);
    dispatchId = dispatch.rows[0].id;

    const messageText = `ग्राम पंचायत जेलातरा चुनाव 2026 — आपकी डिजिटल मतदाता सूचना पर्ची संलग्न है।

🗳️ मतदान हमारा अधिकार एवं कर्तव्य है। कृपया मतदान दिवस पर अपना पहचान पत्र (Voter ID / आधार कार्ड) साथ लाएं।

📜 *मतदाता सूचना पर्ची · ग्राम पंचायत जेलातरा (जालोर)*

📌 *वार्ड संख्या (Ward):* ${(dbVoter.ward_no || '').replace('वार्ड ', '')} | *भाग संख्या (Part):* ${(dbVoter.part_no || '').replace('भाग ', '')}
📌 *क्रम संख्या (Serial No):* ${dbVoter.serial_no}
👤 *नाम:* ${dbVoter.name_en || ''} / ${dbVoter.name_hi || ''}
👨‍👩‍👧 *${dbVoter.relation_type || 'परिजन'}:* ${dbVoter.relative_name_en || ''} / ${dbVoter.relative_name_hi || ''}
🏠 *मकान नं.:* ${dbVoter.house_no || ''} | 📅 *आयु:* ${dbVoter.age || ''} वर्ष, ${dbVoter.gender || ''}
🆔 *पहचान पत्र (EPIC):* ${dbVoter.epic || ''}

🏫 *मतदान केंद्र:*
${(dbVoter.part_no || '').replace('भाग ', '')} - राजकीय उच्च माध्यमिक विद्यालय, जैलातरा`;

    const response = await axios.post(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber.replace(/\D/g, ''),
        type: 'text',
        text: { body: messageText },
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    metaAccepted = true;
    const messageId = response.data.messages?.[0]?.id || null;
    await db.query(
      "UPDATE slip_dispatches SET status = 'sent', provider_message_id = $1 WHERE id = $2",
      [messageId, dispatchId]
    );

    res.json({
      success: true,
      message: 'WhatsApp message sent.',
      messageId,
    });
  } catch (err) {
    console.error('WhatsApp message failed:', err.message);
    if (dispatchId && !metaAccepted) {
      try {
        await db.query(
          "UPDATE slip_dispatches SET status = 'failed', error_message = $1 WHERE id = $2",
          [err.response?.data?.error?.message || err.message, dispatchId]
        );
      } catch (auditErr) {
        console.error('Failed to record WhatsApp dispatch failure:', auditErr.message);
      }
    }
    if (metaAccepted) {
      return res.status(500).json({
        message: 'Meta accepted the message, but the dispatch record could not be updated. Check history before retrying.',
      });
    }
    res.status(502).json({
      message: 'Meta WhatsApp could not send the message. Check the integration configuration and try again.',
    });
  }
});

module.exports = router;
