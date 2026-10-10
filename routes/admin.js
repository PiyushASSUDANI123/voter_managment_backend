const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Organization, User, Voter, Lead } = require('../models/index');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');
const { createWorkbook, addSheet, sendWorkbook } = require('../lib/xlsx');
const cache = require('../lib/cache');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const availableModules = ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants'];
const allModules = [...availableModules, 'accounts'];
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

router.get('/organizations', verifyToken, isAdmin, async (_req, res) => {
  try {
    const orgs = await Organization.find({ _id: { $ne: 'org_default' } }).sort({ createdAt: -1 }).lean();
    
    const result = await Promise.all(orgs.map(async (o) => {
      const adminCount = await User.countDocuments({ organizationId: o._id, role: 'tenant_admin' });
      const activeWorkers = await User.countDocuments({ organizationId: o._id, role: 'worker', isActive: true });
      const voterCount = await Voter.countDocuments({ organizationId: o._id });
      
      return {
        id: o._id, name: o.name, modules: o.enabledModules || [],
        wards: o.allowedWards || [], isActive: o.isActive, createdAt: o.createdAt,
        adminCount, activeWorkers, voterCount,
        whatsappEnabled: o.whatsappEnabled !== false,
        whatsappCredits: typeof o.whatsappCredits === 'number' ? o.whatsappCredits : 100,
        whatsappUsed: typeof o.whatsappUsed === 'number' ? o.whatsappUsed : 0,
        slipConfig: o.slipConfig || {}
      };
    }));
    
    res.json(result);
  } catch (err) {
    console.error('Organization list failed:', err.message);
    res.status(500).json({ message: 'Organizations could not be loaded.' });
  }
});

router.post('/organizations', verifyToken, isAdmin, async (req, res) => {
  const { name, email, password } = req.body;
  const moduleList = req.body.modules;
  const wards = req.body.wards;
  if (typeof name !== 'string' || !name.trim()
    || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'Organization name, valid admin email, and an 8-character password are required.' });
  }
  if (!Array.isArray(moduleList) || !moduleList.every((module) => availableModules.includes(module))
    || !Array.isArray(wards) || !wards.every((ward) => typeof ward === 'string' && ward.trim())) {
    return res.status(400).json({ message: 'Choose valid modules and ward names.' });
  }

  const id = `tenant_${crypto.randomUUID()}`;
  const enabledModules = [...new Set([...moduleList, 'accounts'])];
  const allowedWards = [...new Set(wards.map((ward) => ward.trim()))];
  const initialCredits = Number.isInteger(Number(req.body.whatsappCredits)) ? Math.max(0, Number(req.body.whatsappCredits)) : 100;
  const isWpEnabled = typeof req.body.whatsappEnabled === 'boolean' ? req.body.whatsappEnabled : true;
  const slipConfig = req.body.slipConfig && typeof req.body.slipConfig === 'object' ? req.body.slipConfig : {};
  
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    await Organization.create([{
      _id: id,
      name: name.trim(),
      enabledModules: enabledModules,
      allowedWards: allowedWards,
      whatsappEnabled: isWpEnabled,
      whatsappCredits: initialCredits,
      whatsappUsed: 0,
      slipConfig: slipConfig
    }], { session });
    
    await User.create([{
      _id: `user_${crypto.randomUUID()}`,
      email: email.trim().toLowerCase(),
      passwordHash: passwordHash,
      fullName: 'Tenant Admin',
      phone: '0000000000',
      role: 'tenant_admin',
      organizationId: id
    }], { session });
    
    await session.commitTransaction();
    res.status(201).json({ success: true, message: 'Organization created successfully' });
  } catch (err) {
    await session.abortTransaction();
    if (err.code === 11000) return res.status(409).json({ message: 'Admin email is already registered.' });
    console.error('Organization creation failed:', err.message);
    res.status(500).json({ message: 'Could not create organization.' });
  } finally {
    session.endSession();
  }
});

router.put('/organizations/:id', verifyToken, isAdmin, async (req, res) => {
  const { name, isActive } = req.body;
  const moduleList = req.body.modules;
  const wards = req.body.wards;
  
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ message: 'Organization name is required.' });
  if (!Array.isArray(moduleList) || !moduleList.every((module) => availableModules.includes(module))
    || !Array.isArray(wards) || !wards.every((ward) => typeof ward === 'string' && ward.trim())) {
    return res.status(400).json({ message: 'Choose valid modules and ward names.' });
  }
  
  try {
    const enabledModules = [...new Set([...moduleList, 'accounts'])];
    const allowedWards = [...new Set(wards.map((ward) => ward.trim()))];
    
    const updatePayload = {
      name: name.trim(),
      enabledModules,
      allowedWards,
      isActive: typeof isActive === 'boolean' ? isActive : true
    };

    if (typeof req.body.whatsappEnabled === 'boolean') {
      updatePayload.whatsappEnabled = req.body.whatsappEnabled;
    }
    if (req.body.whatsappCredits !== undefined) {
      updatePayload.whatsappCredits = Math.max(0, Number.parseInt(req.body.whatsappCredits, 10) || 0);
    }
    if (req.body.slipConfig && typeof req.body.slipConfig === 'object') {
      updatePayload.slipConfig = req.body.slipConfig;
    }

    const org = await Organization.findByIdAndUpdate(req.params.id, updatePayload);
    
    if (!org) return res.status(404).json({ message: 'Organization not found.' });
    res.json({ success: true, message: 'Organization updated.' });
  } catch (err) {
    console.error('Organization update failed:', err.message);
    res.status(500).json({ message: 'Could not update organization.' });
  }
});

router.get('/organizations/:id/slip-config', verifyToken, async (req, res) => {
  try {
    const org = await Organization.findById(req.params.id).lean();
    if (!org) return res.status(404).json({ message: 'Organization not found.' });
    res.json(org.slipConfig || {});
  } catch (err) {
    res.status(500).json({ message: 'Could not fetch slip configuration.' });
  }
});

router.put('/organizations/:id/slip-config', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.organizationId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    const incomingConfig = req.body.slipConfig || req.body;
    const updated = await Organization.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          slipConfig: incomingConfig,
          ...(incomingConfig?.candidateName ? { candidateName: incomingConfig.candidateName } : {})
        }
      },
      { new: true, upsert: true }
    );
    res.json({ success: true, slipConfig: updated?.slipConfig || {} });
  } catch (err) {
    res.status(500).json({ message: 'Could not update slip configuration.' });
  }
});

// Dedicated fast endpoint to adjust WhatsApp credits
router.put('/organizations/:id/whatsapp-credits', verifyToken, isAdmin, async (req, res) => {
  try {
    const { credits, addCredits, enabled } = req.body;
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'Organization not found.' });

    const updateOps = {};
    if (typeof enabled === 'boolean') updateOps.whatsappEnabled = enabled;
    if (typeof credits === 'number') updateOps.whatsappCredits = Math.max(0, credits);
    else if (typeof addCredits === 'number') {
      updateOps.whatsappCredits = Math.max(0, (org.whatsappCredits || 0) + addCredits);
    }

    await Organization.updateOne({ _id: req.params.id }, { $set: updateOps });
    const updated = await Organization.findById(req.params.id).lean();
    res.json({
      success: true,
      message: 'WhatsApp credits updated successfully.',
      whatsappCredits: updated.whatsappCredits,
      whatsappEnabled: updated.whatsappEnabled
    });
  } catch (err) {
    console.error('Update WhatsApp credits error:', err.message);
    res.status(500).json({ message: 'Could not update WhatsApp credits.' });
  }
});

router.delete('/organizations/:id', verifyToken, isAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await User.deleteMany({ organizationId: req.params.id }, { session });
    await Voter.deleteMany({ organizationId: req.params.id }, { session });
    const result = await Organization.deleteOne({ _id: req.params.id }, { session });
    await session.commitTransaction();
    
    if (result.deletedCount === 0) return res.status(404).json({ message: 'Organization not found.' });
    res.json({ success: true, message: 'Organization deleted.' });
  } catch (err) {
    await session.abortTransaction();
    console.error('Organization deletion failed:', err.message);
    res.status(500).json({ message: 'Could not delete organization.' });
  } finally {
    session.endSession();
  }
});

// GET all users
router.get('/users', verifyToken, isAdmin, async (req, res) => {
  try {
    const orgId = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
    const query = orgId ? { organizationId: orgId } : {};
    
    const users = await User.find(query).sort({ createdAt: -1 }).lean();
    
    const orgIds = [...new Set(users.map(u => u.organizationId))];
    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();
    const orgMap = orgs.reduce((acc, o) => ({ ...acc, [o._id]: o }), {});
    
    res.json(users.map((u) => ({
      id: u._id, email: u.email, fullName: u.fullName, phone: u.phone,
      role: u.role, subRole: u.subRole, scopeType: u.scopeType, scopeValue: u.scopeValue,
      isActive: u.isActive,
      organizationId: u.organizationId,
      organizationName: orgMap[u.organizationId]?.name || 'Unknown',
    })));
  } catch (err) {
    console.error('User list failed:', err.message);
    res.status(500).json({ message: 'Users could not be loaded.' });
  }
});

router.post('/users', verifyToken, isAdmin, async (req, res) => {
  const { email, password, fullName, phone, role, organizationId, subRole, scopeType, scopeValue, modules } = req.body;
  if (!email || !password || !fullName || !phone || !role || !organizationId) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const existing = await User.findOne({ email: email.trim().toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    
    await User.create({
      _id: `user_${crypto.randomUUID()}`,
      email: email.trim().toLowerCase(),
      passwordHash: passwordHash,
      fullName: fullName.trim(),
      phone: phone.trim(),
      role: role.trim(),
      organizationId: organizationId.trim(),
      subRole: subRole?.trim(),
      scopeType: scopeType?.trim(),
      scopeValue: scopeValue?.trim(),
      modules: Array.isArray(modules) ? modules : [],
    });
    
    res.status(201).json({ message: 'User created successfully.' });
  } catch (err) {
    console.error('User creation failed:', err.message);
    res.status(500).json({ message: 'Could not create user.' });
  }
});

router.delete('/users/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await User.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'User deleted.' });
  } catch (err) {
    console.error('User deletion failed:', err.message);
    res.status(500).json({ message: 'Could not delete user.' });
  }
});

router.put('/users/:id/role', verifyToken, isAdmin, async (req, res) => {
  try {
    const { role, subRole, scopeType, scopeValue, modules } = req.body;
    if (!role) return res.status(400).json({ message: 'Role is required.' });
    
    const update = { role: role.trim() };
    if (subRole !== undefined) update.subRole = subRole;
    if (scopeType !== undefined) update.scopeType = scopeType;
    if (scopeValue !== undefined) update.scopeValue = scopeValue;
    if (Array.isArray(modules)) update.modules = modules;
    
    const result = await User.updateOne({ _id: req.params.id }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'User role updated.' });
  } catch (err) {
    console.error('Role update failed:', err.message);
    res.status(500).json({ message: 'Could not update user role.' });
  }
});

router.put('/users/:id/active', verifyToken, isAdmin, async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') return res.status(400).json({ message: 'Invalid active status.' });
    const result = await User.updateOne({ _id: req.params.id }, { $set: { isActive } });
    if (result.matchedCount === 0) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'User active status updated.' });
  } catch (err) {
    console.error('Active status update failed:', err.message);
    res.status(500).json({ message: 'Could not update user active status.' });
  }
});

router.get('/master-data', verifyToken, isAdmin, async (req, res) => {
  const orgId = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 1000;
  const query = orgId ? { organizationId: orgId } : {};
    
  const cacheKey = `master_data_${orgId || 'all'}_p${page}_l${limit}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return res.json(cachedData);

  try {
    const skip = (page - 1) * limit;
    const voters = await Voter.find(query)
      .sort({ wardNo: 1, partNo: 1, serialNo: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
      
    const totalCount = await Voter.countDocuments(query);
    const result = {
      voters,
      pagination: {
        total: totalCount,
        page,
        limit,
        pages: Math.ceil(totalCount / limit)
      }
    };
    
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Master data query failed:', err.message);
    res.status(500).json({ message: 'Master data could not be loaded.' });
  }
});

router.delete('/master-data', verifyToken, isAdmin, async (req, res) => {
  const orgId = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
  const wardNo = typeof req.query.wardNo === 'string' ? req.query.wardNo.trim() : '';

  if (!orgId) {
    return res.status(400).json({ message: 'Organization ID is required for bulk delete.' });
  }

  const query = { organizationId: orgId };
  if (wardNo) query.wardNo = wardNo;

  try {
    const result = await Voter.deleteMany(query);
    cache.flushAll(); // Clear cache to reflect deletions
    res.json({ message: 'Records deleted successfully.', deletedCount: result.deletedCount });
  } catch (err) {
    console.error('Master data bulk delete failed:', err.message);
    res.status(500).json({ message: 'Bulk delete failed.' });
  }
});

router.get('/system-health', verifyToken, isAdmin, async (_req, res) => {
  let database = 'unavailable';
  try {
    if (mongoose.connection.readyState === 1) database = 'connected';
  } catch (err) {
    console.error('Admin database health check failed:', err.message);
  }
  const metaReady = Boolean(process.env.META_WHATSAPP_TOKEN?.trim()
    && process.env.META_PHONE_ID?.trim()
    && process.env.META_GRAPH_API_VERSION?.trim());
  res.json({ database, metaReady, platform: 'MongoDB', checkedAt: new Date().toISOString() });
});

router.get('/import-template.xlsx', verifyToken, isAdmin, async (_req, res) => {
  try {
    const workbook = createWorkbook();
    addSheet(workbook, 'Voters', [{
      'EPIC No': '',
      Ward: '',
      Part: '',
      'Serial No': '',
      'Name (English)': '',
      'Name (Hindi)': '',
      Age: '',
      Gender: '',
      Relation: '',
      'Relative Name (English)': '',
      'Relative Name (Hindi)': '',
      'House No': '',
      'House No (Hindi)': '',
      Mobile: '',
      Caste: '',
      'Family ID': '',
      Village: '',
      'Village (Hindi)': '',
    }]);
    await sendWorkbook(res, workbook, 'voter-import-template');
  } catch (err) {
    console.error('Voter import template generation failed:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Import template could not be generated.' });
  }
});

router.post('/upload-voters', verifyToken, isAdmin, upload.single('file'), async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'No valid file uploaded.' });
  const organizationId = typeof req.body.organizationId === 'string' && req.body.organizationId.trim()
    ? req.body.organizationId.trim()
    : 'org_default';
  if (!await Organization.exists({ _id: organizationId })) {
    return res.status(404).json({ message: 'Organization not found.' });
  }

  const defaultWardNo = typeof req.body.wardNo === 'string' ? req.body.wardNo.trim() : '';
  const defaultBoothNo = typeof req.body.boothNo === 'string' ? req.body.boothNo.trim() : '';
  const defaultUploadedBy = typeof req.body.uploadedBy === 'string' ? req.body.uploadedBy.trim() : '';
  const defaultDescription = typeof req.body.listDescription === 'string' ? req.body.listDescription.trim() : '';

  // Auto register ward if provided
  if (defaultWardNo) {
    await Organization.updateOne(
      { _id: organizationId },
      { $addToSet: { wards: defaultWardNo } }
    ).catch(err => console.error('Error adding ward to org:', err));
  }

  const parseRow = (row) => {
    const cellText = (column) => {
      const value = row.getCell(column).text || row.getCell(column).value;
      return value == null ? '' : String(value).trim();
    };
    const voter = {
      epic: cellText(1).toUpperCase(),
      wardNo: cellText(2) || defaultWardNo,
      partNo: cellText(3) || defaultBoothNo,
      serialNo: Number(cellText(4)),
      nameEn: cellText(5),
      nameHi: cellText(6),
      age: Number(cellText(7)) || null,
      gender: cellText(8),
      relationType: cellText(9),
      relativeNameEn: cellText(10),
      relativeNameHi: cellText(11),
      houseNo: cellText(12),
      houseNoHi: cellText(13),
      mobileNo: cellText(14),
      caste: cellText(15),
      familyId: cellText(16),
      villageName: cellText(17),
      villageNameHi: cellText(18),
      organizationId,
    };
    if (defaultUploadedBy) {
      voter.assignedWorker = defaultUploadedBy;
    }
    if (!voter.epic || !voter.wardNo || !voter.partNo || !Number.isInteger(voter.serialNo)
      || voter.serialNo < 1 || !voter.nameEn || !voter.nameHi) return null;
    return voter;
  };

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return res.status(400).json({ message: 'The uploaded Excel file has no worksheets.' });

    const batch = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const voter = parseRow(row);
      if (voter) batch.push(voter);
    });

    if (batch.length === 0) return res.status(400).json({ message: 'No valid voter records found in file.' });

    // Track all detected wards in the batch
    const detectedWards = new Set();
    if (defaultWardNo) detectedWards.add(defaultWardNo);
    batch.forEach(v => { if (v.wardNo) detectedWards.add(v.wardNo); });
    if (detectedWards.size > 0) {
      await Organization.updateOne(
        { _id: organizationId },
        { $addToSet: { wards: { $each: Array.from(detectedWards) } } }
      ).catch(() => {});
    }

    const uniqueBatch = [...new Map(batch.map((voter) => [voter.epic, voter])).values()];
    const result = await Voter.bulkWrite(uniqueBatch.map((voter) => ({
      updateOne: {
        filter: { organizationId, epic: voter.epic },
        collation: { locale: 'en', strength: 2 },
        update: {
          $set: voter,
          $setOnInsert: { _id: `voter_${crypto.randomUUID()}` },
        },
        upsert: true,
      },
    })), { ordered: false });
    const inserted = result.upsertedCount || 0;
    const updated = result.matchedCount || 0;

    // Clear cache
    const keys = cache.keys();
    keys.forEach(k => cache.del(k));

    try {
      const adminPdfRouter = require('./admin_pdf');
      if (adminPdfRouter && adminPdfRouter.uploadJobs) {
        const jobId = crypto.randomUUID();
        adminPdfRouter.uploadJobs.set(jobId, {
          id: jobId,
          filename: req.file.originalname,
          fileType: 'excel',
          organizationId,
          wardNo: defaultWardNo,
          boothNo: defaultBoothNo,
          uploadedBy: defaultUploadedBy,
          listDescription: defaultDescription,
          status: 'completed',
          progress: 100,
          extractedCount: inserted + updated,
          uploadedAt: new Date().toISOString()
        });
      }
    } catch (e) {
      console.warn('Could not record excel job:', e.message);
    }

    res.json({
      success: true,
      inserted,
      updated,
      count: inserted + updated,
      wardNo: defaultWardNo,
      boothNo: defaultBoothNo,
      uploadedBy: defaultUploadedBy,
      listDescription: defaultDescription
    });
  } catch (err) {
    console.error('Excel processing error:', err);
    res.status(500).json({ message: 'Error processing the Excel file. Check the format.' });
  }
});

router.get('/export-voters', verifyToken, isAdmin, async (req, res) => {
  try {
    const orgId = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
    const query = orgId ? { organizationId: orgId } : {};
    
    const voters = await Voter.find(query).sort({ wardNo: 1, partNo: 1, serialNo: 1 }).lean();
    
    const workbook = createWorkbook();
    addSheet(workbook, 'Voters', voters.map((v) => ({
      'EPIC No': v.epic,
      'Ward': v.wardNo,
      'Part': v.partNo,
      'Serial No': v.serialNo,
      'Name (English)': v.nameEn,
      'Name (Hindi)': v.nameHi,
      'Age': v.age,
      'Gender': v.gender,
      'Relation': v.relationType,
      'Relative Name (English)': v.relativeNameEn,
      'Relative Name (Hindi)': v.relativeNameHi,
      'House No': v.houseNo,
      'House No (Hindi)': v.houseNoHi,
      'Mobile': v.mobileNo,
      'Caste': v.caste,
      'Family ID': v.familyId,
      'Village': v.villageName,
      'Village (Hindi)': v.villageNameHi,
      'Surety': v.surety,
      'Notes': v.notes,
      'Migrant': v.isMigrant ? 'Yes' : 'No',
      'Migrant Location': v.migrantLocation,
      'Assigned Worker': v.assignedWorker,
      'Support Status': v.supportStatus,
      'Voted': v.voted ? 'Yes' : 'No',
      'Voted At': v.votedAt
    })));
    await sendWorkbook(res, workbook, 'Voters_Export');
  } catch (err) {
    console.error('Export failed:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Export failed' });
  }
});

// ==========================================
// WEBSITE LEADS / INQUIRIES MANAGEMENT
// ==========================================

// Public endpoint for website demo form submissions
router.post('/leads', async (req, res) => {
  try {
    const { name, phone, constituency, electionType, notes } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'नाम आवश्यक है।' });
    }
    if (!phone || typeof phone !== 'string' || !phone.trim()) {
      return res.status(400).json({ message: 'मोबाइल नंबर आवश्यक है।' });
    }

    const lead = await Lead.create({
      _id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: name.trim(),
      phone: phone.trim(),
      constituency: (constituency || '').trim(),
      electionType: (electionType || 'विधानसभा (Assembly)').trim(),
      notes: (notes || '').trim(),
      status: 'new',
      createdAt: new Date()
    });

    res.status(201).json({
      success: true,
      message: 'लीड सफलतापूर्वक दर्ज कर ली गई है।',
      leadId: lead._id
    });
  } catch (err) {
    console.error('Failed to save lead:', err.message);
    res.status(500).json({ message: 'लीड सेव करने में त्रुटि आई।' });
  }
});

// Admin-only: Fetch all website demo leads
router.get('/leads', verifyToken, isAdmin, async (_req, res) => {
  try {
    const leads = await Lead.find({}).sort({ createdAt: -1 }).lean();
    res.json(leads);
  } catch (err) {
    console.error('Failed to fetch leads:', err.message);
    res.status(500).json({ message: 'लीड्स लोड नहीं हो सकीं।' });
  }
});

// Admin-only: Update lead status or notes
router.patch('/leads/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (typeof notes === 'string') updates.notes = notes;

    const updated = await Lead.findByIdAndUpdate(id, { $set: updates }, { returnDocument: 'after' }).lean();
    if (!updated) return res.status(404).json({ message: 'लीड नहीं मिली।' });

    res.json({ success: true, lead: updated });
  } catch (err) {
    console.error('Failed to update lead:', err.message);
    res.status(500).json({ message: 'लीड अपडेट करने में त्रुटि आई।' });
  }
});

// Admin-only: Delete lead
router.delete('/leads/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Lead.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ message: 'लीड नहीं मिली।' });

    res.json({ success: true, message: 'लीड सफलतापूर्वक डिलीट कर दी गई।' });
  } catch (err) {
    console.error('Failed to delete lead:', err.message);
    res.status(500).json({ message: 'लीड डिलीट करने में त्रुटि आई।' });
  }
});

module.exports = router;
