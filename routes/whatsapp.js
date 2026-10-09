const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyToken, requireModule } = require('../middleware/authMiddleware');
const { addVoterAccess } = require('../lib/access');
const { Voter, SlipDispatch, Organization } = require('../models/index');

/**
 * Standardize recipient phone number for WhatsApp Meta API (E.164 without '+')
 * Auto-handles Indian 10-digit numbers by prefixing 91
 */
function normalizePhoneNumber(input) {
  if (!input) return "";
  let digits = input.replace(/[^\d]/g, '');
  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  // Standard 10-digit Indian mobile number
  if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}

/**
 * Helper to check and deduct 1 credit atomically from organization
 */
async function verifyAndDeductCredit(orgId) {
  let org = await Organization.findById(orgId);
  if (!org && orgId === 'org_default') {
    org = await Organization.create({
      _id: 'org_default',
      name: 'Default Organization',
      whatsappEnabled: true,
      whatsappCredits: 500,
      whatsappUsed: 0
    });
  }
  if (!org) {
    return { ok: false, error: 'संगठन रिकॉर्ड नहीं मिला।' };
  }
  if (org.whatsappEnabled === false) {
    return {
      ok: false,
      error: 'एडमिन द्वारा आपके संगठन के लिए WhatsApp मैसेजिंग बंद (Disabled) की गई है।'
    };
  }
  const credits = typeof org.whatsappCredits === 'number' ? org.whatsappCredits : 0;
  if (credits <= 0) {
    return {
      ok: false,
      error: 'आपके संगठन के WhatsApp क्रेडिट समाप्त हो चुके हैं (0 क्रेडिट शेष)। कृपया एडमिन से और क्रेडिट प्राप्त करें।'
    };
  }

  const updated = await Organization.findOneAndUpdate(
    { _id: org._id, whatsappCredits: { $gt: 0 } },
    { $inc: { whatsappCredits: -1, whatsappUsed: 1 } },
    { new: true }
  );

  if (!updated) {
    return {
      ok: false,
      error: 'WhatsApp क्रेडिट समाप्त हो चुके हैं। कृपया एडमिन से क्रेडिट बढ़वाएं।'
    };
  }

  return { ok: true, remainingCredits: updated.whatsappCredits };
}

async function refundCredit(orgId) {
  try {
    await Organization.updateOne(
      { _id: orgId },
      { $inc: { whatsappCredits: 1, whatsappUsed: -1 } }
    );
  } catch (err) {
    console.error('Error refunding credit:', err.message);
  }
}

/**
 * GET /api/whatsapp/quota - Check current organization's WhatsApp credits and status
 */
router.get('/quota', verifyToken, async (req, res) => {
  try {
    const orgId = req.user.organizationId || 'org_default';
    let org = await Organization.findById(orgId).lean();
    if (!org && orgId === 'org_default') {
      org = { whatsappEnabled: true, whatsappCredits: 500, whatsappUsed: 0 };
    }
    const token = process.env.META_WHATSAPP_TOKEN?.trim();
    const phoneNumberId = process.env.META_PHONE_ID?.trim();
    const metaConfigured = Boolean(token && phoneNumberId);

    const credits = typeof org?.whatsappCredits === 'number' ? org.whatsappCredits : 100;
    const enabled = org ? org.whatsappEnabled !== false : true;
    const used = typeof org?.whatsappUsed === 'number' ? org.whatsappUsed : 0;

    res.json({
      organizationId: orgId,
      organizationName: org?.name || 'Default Organization',
      whatsappEnabled: enabled,
      whatsappCredits: credits,
      whatsappUsed: used,
      canSend: enabled && credits > 0,
      metaConfigured
    });
  } catch (err) {
    console.error('Error fetching WhatsApp quota:', err.message);
    res.status(500).json({ message: 'Quota could not be retrieved.' });
  }
});

/**
 * GET /api/whatsapp/status - Check Meta API configuration status
 */
router.get('/status', (req, res) => {
  const token = process.env.META_WHATSAPP_TOKEN?.trim();
  const phoneNumberId = process.env.META_PHONE_ID?.trim();
  const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';
  const hasWebhookSecret = Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN);

  const isConfigured = Boolean(token && phoneNumberId);

  res.json({
    configured: isConfigured,
    graphApiVersion,
    phoneNumberId: phoneNumberId ? `...${phoneNumberId.slice(-4)}` : null,
    hasToken: Boolean(token),
    hasWebhookSecret,
    metaDocumentation: "https://developers.facebook.com/docs/whatsapp/cloud-api"
  });
});

/**
 * GET /api/whatsapp/webhook - Meta Webhook Verification
 * Used by Meta Developers Console to verify the webhook URL
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'vijaysetu_webhook_verify_token';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('✅ Meta WhatsApp Webhook verified successfully!');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Meta WhatsApp Webhook verification mismatch:', { mode, token });
  return res.status(403).json({ error: 'Webhook verification token mismatch' });
});

/**
 * POST /api/whatsapp/webhook - Meta Status Updates & Incoming Messages
 * Receives real-time delivery receipts (sent, delivered, read, failed)
 */
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;
          if (value && value.statuses) {
            for (const statusObj of value.statuses) {
              const messageId = statusObj.id; // wamid.HBg...
              const status = statusObj.status; // sent | delivered | read | failed
              const timestamp = statusObj.timestamp ? new Date(parseInt(statusObj.timestamp) * 1000) : new Date();

              const updateData = { status };
              if (status === 'delivered') updateData.deliveredAt = timestamp;
              if (status === 'read') updateData.readAt = timestamp;

              if (status === 'failed' && statusObj.errors) {
                updateData.errorMessage = JSON.stringify(statusObj.errors);
              }

              await SlipDispatch.updateOne(
                { providerMessageId: messageId },
                { $set: updateData }
              ).catch(() => {});
              
              console.log(`WhatsApp Status for [${messageId}]: ${status}`);
            }
          }
        }
      }
    }

    // Acknowledge receipt to Meta within 3 seconds
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(200).send('EVENT_RECEIVED');
  }
});

/**
 * POST /api/whatsapp/send-slip - Send digital voter slip via Meta Cloud API
 */
router.post('/send-slip', verifyToken, requireModule('voters'), async (req, res) => {
  let dispatchId = null;
  let metaAccepted = false;
  const orgId = req.user.organizationId || 'org_default';

  try {
    const { voterId, phoneNumber, templateName } = req.body;
    const token = process.env.META_WHATSAPP_TOKEN?.trim();
    const phoneNumberId = process.env.META_PHONE_ID?.trim();
    const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';

    if (!token || !phoneNumberId) {
      return res.status(503).json({
        message: 'Meta Cloud API कॉन्फ़िगर नहीं है। कृपया "WhatsApp पर सीधे भेजें (मैनुअल)" विकल्प का उपयोग करें।'
      });
    }

    if (!voterId || typeof phoneNumber !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
      return res.status(400).json({ message: 'वैध मतदाता ID और मोबाइल नंबर आवश्यक है।' });
    }

    // Verify credits and deduct 1 credit
    const creditCheck = await verifyAndDeductCredit(orgId);
    if (!creditCheck.ok) {
      return res.status(403).json({ message: creditCheck.error });
    }

    const recipientPhone = normalizePhoneNumber(phoneNumber);
    if (recipientPhone.length < 10) {
      await refundCredit(orgId);
      return res.status(400).json({ message: 'कृपया 10 अंकों का वैध मोबाइल नंबर दर्ज करें।' });
    }

    const query = addVoterAccess(req);
    if (!isNaN(voterId)) {
      query.sqlId = Number.parseInt(voterId, 10);
    } else {
      query._id = voterId;
    }

    const dbVoter = await Voter.findOne(query).lean();
    if (!dbVoter) {
      await refundCredit(orgId);
      return res.status(404).json({ message: 'मतदाता रिकॉर्ड नहीं मिला।' });
    }

    const voterName = dbVoter.nameHi || dbVoter.nameEn || 'मतदाता';
    const ward = (dbVoter.wardNo || '').replace(/^(वार्ड|Ward)\s*/i, '') || '—';
    const part = (dbVoter.partNo || '').replace(/^(भाग|Part)\s*/i, '') || '—';
    const boothName = dbVoter.boothName || `भाग संख्या ${part}`;

    // Create Dispatch record in DB (strictly bound to user's organization)
    const dispatch = await SlipDispatch.create({
      _id: `disp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      voterId: dbVoter._id,
      voterEpic: dbVoter.epic,
      voterName,
      recipientPhone,
      status: 'sending',
      organizationId: req.user.organizationId || 'org_default',
      sentBy: req.user.fullName || req.user.email || 'Client'
    });
    dispatchId = dispatch._id;

    // Compose payload: Template vs Text
    let messagePayload;

    if (templateName) {
      // Approved Meta WhatsApp Template Message (Required for business-initiated chats)
      messagePayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'hi' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: voterName },
                { type: 'text', text: dbVoter.epic || '—' },
                { type: 'text', text: ward },
                { type: 'text', text: part },
                { type: 'text', text: String(dbVoter.serialNo || '—') },
                { type: 'text', text: boothName }
              ]
            }
          ]
        }
      };
    } else {
      // Free-form Hindi message
      const messageText = `नमस्कार,

*${voterName}*
• पहचान पत्र (EPIC): *${dbVoter.epic || '—'}*
• वार्ड: *${ward}* · क्रमांक: *#${dbVoter.serialNo || '—'}*
• मतदान केंद्र: *${boothName}*

आपकी डिजिटल मतदाता सूचना पर्ची (Voter Slip) संलग्न है। 🗳️
मतदान हमारा अधिकार एवं कर्तव्य है। कृपया मतदान दिवस पर अपना पहचान पत्र (Voter ID / आधार कार्ड) साथ लाएं।

धन्यवाद! 🙏`;

      messagePayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'text',
        text: { preview_url: false, body: messageText }
      };
    }

    const response = await axios.post(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      messagePayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    metaAccepted = true;
    const providerMessageId = response.data?.messages?.[0]?.id;

    await SlipDispatch.updateOne(
      { _id: dispatchId },
      { $set: { status: 'sent', providerMessageId } }
    );

    res.json({
      success: true,
      message: 'WhatsApp पर्ची सफलतापूर्वक भेज दी गई है।',
      dispatchId,
      providerMessageId
    });

  } catch (err) {
    let errorDetail = err.response?.data?.error?.message || err.message;
    const errorCode = err.response?.data?.error?.code;

    // Helpful error messages for common Meta codes
    if (errorCode === 131047) {
      errorDetail = 'Meta 24-घंटे नीति: मतदाता ने पहले मैसेज नहीं किया है। इस नंबर पर संदेश भेजने के लिए Meta Approved Template आवश्यक है।';
    } else if (errorCode === 131026) {
      errorDetail = 'मोबाइल नंबर Meta WhatsApp पर मौजूद नहीं है या अमान्य है।';
    } else if (errorCode === 190) {
      errorDetail = 'Meta Access Token एक्सपायर हो गया है। कृपया नया Access Token दर्ज करें।';
    }

    if (dispatchId) {
      await SlipDispatch.updateOne(
        { _id: dispatchId },
        { $set: { status: 'failed', errorMessage: errorDetail } }
      ).catch(() => {});
    }

    if (!metaAccepted) {
      await refundCredit(orgId);
    }

    console.error('WhatsApp send error:', err.response?.data || err.message);
    res.status(metaAccepted ? 207 : 500).json({
      message: errorDetail || 'Meta Graph API से WhatsApp संदेश भेजने में त्रुटि हुई।'
    });
  }
});

/**
 * POST /api/whatsapp/send-manual - Deduct 1 credit, record manual dispatch, and generate direct WhatsApp link
 */
router.post('/send-manual', verifyToken, requireModule('voters'), async (req, res) => {
  const orgId = req.user.organizationId || 'org_default';
  try {
    const { voterId, phoneNumber } = req.body;
    if (!voterId || typeof phoneNumber !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
      return res.status(400).json({ message: 'वैध मतदाता ID और मोबाइल नंबर आवश्यक है।' });
    }

    const creditCheck = await verifyAndDeductCredit(orgId);
    if (!creditCheck.ok) {
      return res.status(403).json({ message: creditCheck.error });
    }

    const recipientPhone = normalizePhoneNumber(phoneNumber);
    if (recipientPhone.length < 10) {
      await refundCredit(orgId);
      return res.status(400).json({ message: 'कृपया 10 अंकों का वैध मोबाइल नंबर दर्ज करें।' });
    }

    const query = addVoterAccess(req);
    if (!isNaN(voterId)) {
      query.sqlId = Number.parseInt(voterId, 10);
    } else {
      query._id = voterId;
    }

    const dbVoter = await Voter.findOne(query).lean();
    if (!dbVoter) {
      await refundCredit(orgId);
      return res.status(404).json({ message: 'मतदाता रिकॉर्ड नहीं मिला।' });
    }

    const voterName = dbVoter.nameHi || dbVoter.nameEn || 'मतदाता';
    const ward = (dbVoter.wardNo || '').replace(/^(वार्ड|Ward)\s*/i, '') || '—';
    const part = (dbVoter.partNo || '').replace(/^(भाग|Part)\s*/i, '') || '—';
    const serial = dbVoter.serialNo ? `#${dbVoter.serialNo}` : '—';
    const boothName = dbVoter.boothName || `भाग संख्या ${part}`;
    const relativeName = dbVoter.relativeNameHi || dbVoter.relativeNameEn || '';
    const relationType = dbVoter.relationType || 'पिता/पति';
    const ageGender = `${dbVoter.age || '—'} वर्ष / ${dbVoter.gender || '—'}`;

    const messageText = `🗳️ *आधिकारिक मतदाता सूचना पर्ची* 🗳️

नमस्कार *${voterName}* जी,
आगामी चुनाव हेतु आपकी मतदाता पर्ची का विवरण:

• *पहचान पत्र क्रमांक (EPIC):* ${dbVoter.epic || '—'}
• *नाम:* ${voterName}
${relativeName ? `• *${relationType}:* ${relativeName}\n` : ''}• *वार्ड क्रमांक:* ${ward}
• *भाग संख्या:* ${part}
• *मतदाता सूची क्रमांक:* ${serial}
• *मतदान केंद्र:* ${boothName}
• *आयु / लिंग:* ${ageGender}

🇮🇳 _मतदान हमारा अधिकार एवं कर्तव्य है। कृपया पहचान पत्र (Voter ID/आधार कार्ड) साथ लाएं।_
*— विजयसेतु (VijaySetu) चुनाव वॉर रूम*`;

    const dispatch = await SlipDispatch.create({
      _id: `disp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      voterId: dbVoter._id,
      voterEpic: dbVoter.epic,
      voterName,
      recipientPhone,
      status: 'sent',
      dispatchType: 'manual_whatsapp',
      organizationId: orgId,
      sentBy: req.user.fullName || req.user.email || 'Client'
    });

    const waLink = `https://wa.me/${recipientPhone}?text=${encodeURIComponent(messageText)}`;

    res.json({
      success: true,
      message: '1 WhatsApp क्रेडिट काटा गया। WhatsApp चैट खोली जा रही है...',
      dispatchId: dispatch._id,
      remainingCredits: creditCheck.remainingCredits,
      waLink,
      messageText
    });
  } catch (err) {
    console.error('Manual WhatsApp dispatch error:', err.message);
    res.status(500).json({ message: 'मैनुअल WhatsApp संदेश तैयार करने में त्रुटि हुई।' });
  }
});

/**
 * GET /api/whatsapp/history - List recent voter slip dispatch records
 */
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
      deliveredAt: d.deliveredAt,
      readAt: d.readAt,
      errorMessage: d.errorMessage
    })));
  } catch (err) {
    console.error('Dispatch history failed:', err.message);
    res.status(500).json({ message: 'पर्ची इतिहास लोड नहीं हुआ।' });
  }
});

module.exports = router;
