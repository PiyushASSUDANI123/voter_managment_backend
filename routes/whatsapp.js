const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyToken, requireModule } = require('../middleware/authMiddleware');
const { addVoterAccess } = require('../lib/access');
const { Voter, SlipDispatch } = require('../models/index');

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
    
    if (!voterId || typeof phoneNumber !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
      return res.status(400).json({ message: 'A valid voter ID and phone number are required.' });
    }

    const query = addVoterAccess(req);
    // Support string ID or sqlId
    if (!isNaN(voterId)) {
      query.sqlId = Number.parseInt(voterId, 10);
    } else {
      query._id = voterId;
    }

    const dbVoter = await Voter.findOne(query).lean();
    if (!dbVoter) {
      return res.status(404).json({ message: 'Voter not found' });
    }

    const dispatch = await SlipDispatch.create({
      voterId: dbVoter._id,
      voterEpic: dbVoter.epic,
      voterName: dbVoter.nameHi || dbVoter.nameEn || '',
      recipientPhone: phoneNumber.trim(),
      status: 'sending',
      organizationId: req.user.organizationId || 'org_default'
    });
    dispatchId = dispatch._id;

    const voterName = dbVoter.nameHi || dbVoter.nameEn || '';
    const ward = (dbVoter.wardNo || '').replace('वार्ड ', '');
    const part = (dbVoter.partNo || '').replace('भाग ', '');
    
    const messageText = `नमस्कार,

${voterName} (वार्ड ${ward} · क्रम #${dbVoter.serialNo})

मतदान केंद्र: ${part} - राजकीय उच्च माध्यमिक विधालय कमरा नंबर 1 जैलातरा

आपकी डिजिटल मतदाता सूचना पर्ची (Voter Slip) संलग्न है।

ग्राम पंचायत जेलातरा चुनाव 2026 — आपकी डिजिटल मतदाता सूचना पर्ची संलग्न है। 🗳️ मतदान हमारा अधिकार एवं कर्तव्य है। कृपया मतदान दिवस पर अपना पहचान पत्र (Voter ID / आधार कार्ड) साथ लाएं।

Regards,

ग्राम पंचायत जेलातरा

Thank you for your valuable time and attention. 🙏`;

    const response = await axios.post(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber.replace(/[^\d]/g, ''),
        type: 'text',
        text: { preview_url: false, body: messageText },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    metaAccepted = true;
    
    await SlipDispatch.updateOne(
      { _id: dispatchId }, 
      { $set: { status: 'sent', providerMessageId: response.data?.messages?.[0]?.id } }
    );
    
    res.json({ success: true, message: 'Message queued for delivery successfully.', dispatchId });
  } catch (err) {
    if (dispatchId) {
      const errorMessage = err.response ? JSON.stringify(err.response.data) : err.message;
      await SlipDispatch.updateOne(
        { _id: dispatchId },
        { $set: { status: 'failed', errorMessage } }
      ).catch(() => {});
    }
    console.error('WhatsApp send failed:', err.response?.data || err.message);
    res.status(metaAccepted ? 207 : 500).json({
      message: metaAccepted
        ? 'Message sent, but an error occurred saving the dispatch record.'
        : 'Failed to send WhatsApp message via Meta Graph API.',
    });
  }
});

router.get('/history', verifyToken, requireModule('voters'), async (req, res) => {
  try {
    const query = {};
    if (req.user.role !== 'admin') {
      query.organizationId = req.user.organizationId || 'org_default';
    }
    
    const dispatches = await SlipDispatch.find(query).sort({ createdAt: -1 }).limit(100).lean();
    
    res.json(dispatches.map(d => ({
      id: d._id,
      voterId: d.voterId,
      epic: d.voterEpic,
      voterName: d.voterName,
      recipient: d.recipientPhone,
      status: d.status,
      timestamp: d.createdAt,
    })));
  } catch (err) {
    console.error('Dispatch history failed:', err.message);
    res.status(500).json({ message: 'History could not be loaded.' });
  }
});

module.exports = router;
