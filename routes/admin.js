const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Organization, User, Voter } = require('../models/index');
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
  
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    await Organization.create([{
      _id: id,
      name: name.trim(),
      enabledModules: enabledModules,
      allowedWards: allowedWards
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
    
    const org = await Organization.findByIdAndUpdate(req.params.id, {
      name: name.trim(),
      enabledModules,
      allowedWards,
      isActive: typeof isActive === 'boolean' ? isActive : true
    });
    
    if (!org) return res.status(404).json({ message: 'Organization not found.' });
    res.json({ success: true, message: 'Organization updated.' });
  } catch (err) {
    console.error('Organization update failed:', err.message);
    res.status(500).json({ message: 'Could not update organization.' });
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
  const query = orgId ? { organizationId: orgId } : {};
    
  const cacheKey = `master_data_${orgId || 'all'}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return res.json(cachedData);

  try {
    const voters = await Voter.find(query).sort({ wardNo: 1, partNo: 1, serialNo: 1 }).limit(1000).lean();
    cache.set(cacheKey, voters);
    res.json(voters);
  } catch (err) {
    console.error('Master data query failed:', err.message);
    res.status(500).json({ message: 'Master data could not be loaded.' });
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
  res.json({ database, metaReady, platform: 'MongoDB' });
});

router.post('/upload-voters', verifyToken, isAdmin, upload.single('file'), async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'No valid file uploaded.' });
  const organizationId = typeof req.body.organizationId === 'string' && req.body.organizationId.trim()
    ? req.body.organizationId.trim()
    : 'org_default';

  const parseRow = (row) => {
    const rowValues = row.values;
    if (!rowValues || rowValues.length < 5) return null; // Minimum expected columns
    return {
      epic: String(rowValues[1] || '').trim().toUpperCase(),
      wardNo: String(rowValues[2] || '').trim(),
      partNo: String(rowValues[3] || '').trim(),
      serialNo: parseInt(rowValues[4], 10),
      nameEn: String(rowValues[5] || '').trim(),
      nameHi: String(rowValues[6] || '').trim(),
      age: parseInt(rowValues[7], 10) || null,
      gender: String(rowValues[8] || '').trim(),
      relationType: String(rowValues[9] || '').trim(),
      relativeNameEn: String(rowValues[10] || '').trim(),
      relativeNameHi: String(rowValues[11] || '').trim(),
      houseNo: String(rowValues[12] || '').trim(),
      houseNoHi: String(rowValues[13] || '').trim(),
      mobileNo: String(rowValues[14] || '').trim(),
      caste: String(rowValues[15] || '').trim(),
      familyId: String(rowValues[16] || '').trim(),
      villageName: String(rowValues[17] || '').trim(),
      organizationId,
    };
  };

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return res.status(400).json({ message: 'The uploaded Excel file has no worksheets.' });

    let rowsProcessed = 0;
    const batchSize = 1000;
    let batch = [];
    
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const voter = parseRow(row);
      if (voter && voter.epic && voter.wardNo && voter.partNo && !isNaN(voter.serialNo)) {
        batch.push(voter);
      }
    });

    if (batch.length === 0) return res.status(400).json({ message: 'No valid voter records found in file.' });
    
    // Clear old records for this org to simulate SQL UPSERT or fresh start
    // If we are appending, we could use upsert. Here we insert fresh if asked.
    // We'll use insertMany with ordered: false to skip duplicates
    
    try {
      await Voter.insertMany(batch, { ordered: false });
      rowsProcessed = batch.length;
    } catch (e) {
      // If there are duplicate epics, it throws but still inserts valid ones
      if (e.code === 11000) {
        rowsProcessed = e.insertedDocs?.length || 0;
      } else {
        throw e;
      }
    }
    
    // Clear cache
    const keys = cache.keys();
    keys.forEach(k => cache.del(k));

    res.json({
      success: true,
      message: `File uploaded successfully. Processed ${rowsProcessed} valid rows.`,
      count: rowsProcessed
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
      'Mobile': v.mobileNo,
      'Caste': v.caste,
      'Status': v.supportStatus,
      'Voted': v.voted ? 'Yes' : 'No'
    })));
    await sendWorkbook(res, workbook, 'Voters_Export');
  } catch (err) {
    console.error('Export failed:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Export failed' });
  }
});

module.exports = router;
