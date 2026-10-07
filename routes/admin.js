const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');
const { createWorkbook, addSheet, sendWorkbook } = require('../lib/xlsx');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const availableModules = ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants'];
const allModules = [...availableModules, 'accounts'];
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

router.get('/organizations', verifyToken, isAdmin, async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT o.id, o.name, o.enabled_modules, o.allowed_wards, o.is_active, o.created_at,
        (SELECT COUNT(*)::integer FROM users u WHERE u.organization_id = o.id AND u.role = 'tenant_admin') AS admin_count,
        (SELECT COUNT(*)::integer FROM users u WHERE u.organization_id = o.id AND u.role = 'worker' AND u.is_active = true) AS active_workers,
        (SELECT COUNT(*)::integer FROM voters v WHERE v.organization_id = o.id) AS voter_count
      FROM organizations o
      WHERE o.id <> 'org_default'
      ORDER BY o.created_at DESC
    `);
    res.json(result.rows.map((row) => ({
      id: row.id, name: row.name, modules: row.enabled_modules || [],
      wards: row.allowed_wards || [], isActive: row.is_active, createdAt: row.created_at,
      adminCount: row.admin_count, activeWorkers: row.active_workers, voterCount: row.voter_count,
    })));
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
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.transaction(async (client) => {
      await client.query(
        'INSERT INTO organizations (id, name, enabled_modules, allowed_wards) VALUES ($1, $2, $3::jsonb, $4::jsonb)',
        [id, name.trim(), JSON.stringify(enabledModules), JSON.stringify(allowedWards)],
      );
      await client.query(`
        INSERT INTO users (email, password, role, organization_id, full_name, sub_role, modules)
        VALUES ($1, $2, 'tenant_admin', $3, $4, 'Admin', $5::jsonb)
      `, [email.trim().toLowerCase(), passwordHash, id, name.trim(), JSON.stringify(enabledModules)]);
    });
    res.status(201).json({ id, name: name.trim(), modules: enabledModules, wards: allowedWards, activeWorkers: 0, voterCount: 0, isActive: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'An account with this email already exists.' });
    console.error('Organization creation failed:', err.message);
    res.status(500).json({ message: 'Organization could not be created.' });
  }
});

router.put('/organizations/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, modules: moduleList, wards, isActive } = req.body;
  if (!id || id === 'org_default') return res.status(400).json({ message: 'A valid tenant is required.' });
  if (moduleList !== undefined && (!Array.isArray(moduleList) || !moduleList.every((module) => availableModules.includes(module)))) {
    return res.status(400).json({ message: 'One or more modules are invalid.' });
  }
  if (wards !== undefined && (!Array.isArray(wards) || !wards.every((ward) => typeof ward === 'string' && ward.trim()))) {
    return res.status(400).json({ message: 'Ward values must be non-empty text.' });
  }
  if (isActive !== undefined && typeof isActive !== 'boolean') return res.status(400).json({ message: 'Tenant status must be enabled or disabled.' });

  const setters = [];
  const values = [];
  const add = (column, value, json = false) => {
    values.push(value);
    setters.push(`${column} = $${values.length}${json ? '::jsonb' : ''}`);
  };
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ message: 'Tenant name cannot be empty.' });
    add('name', name.trim());
  }
  if (moduleList !== undefined) add('enabled_modules', JSON.stringify([...new Set([...moduleList, 'accounts'])]), true);
  if (wards !== undefined) add('allowed_wards', JSON.stringify([...new Set(wards.map((ward) => ward.trim()))]), true);
  if (isActive !== undefined) add('is_active', isActive);
  if (!setters.length) return res.status(400).json({ message: 'No tenant changes were provided.' });

  try {
    values.push(id);
    const result = await db.query(
      `UPDATE organizations SET ${setters.join(', ')} WHERE id = $${values.length} AND id <> 'org_default' RETURNING id`,
      values,
    );
    if (!result.rowCount) return res.status(404).json({ message: 'Tenant not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Organization update failed:', err.message);
    res.status(500).json({ message: 'Organization could not be updated.' });
  }
});

router.get('/master-data', verifyToken, isAdmin, async (req, res) => {
  const params = [];
  const filter = typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
    ? (params.push(req.query.organizationId.trim()), `WHERE organization_id = $${params.length}`)
    : '';
  try {
    const result = await db.query(
      `SELECT * FROM voters ${filter} ORDER BY ward_no ASC, part_no ASC, serial_no ASC LIMIT 1000`,
      params,
    );
    res.json(result.rows.map((row) => ({
      _id: row.id, epic: row.epic, nameEn: row.name_en, nameHi: row.name_hi,
      relativeNameEn: row.relative_name_en, relativeNameHi: row.relative_name_hi,
      relationType: row.relation_type, age: row.age, gender: row.gender,
      houseNo: row.house_no, wardNo: row.ward_no, partNo: row.part_no,
      serialNo: row.serial_no, phone: row.phone, caste: row.caste,
      surety: row.surety, supportStatus: row.support_status, voted: row.voted,
      organizationId: row.organization_id,
    })));
  } catch (err) {
    console.error('Master data query failed:', err.message);
    res.status(500).json({ message: 'Master data could not be loaded.' });
  }
});

router.get('/system-health', verifyToken, isAdmin, async (_req, res) => {
  let database = 'unavailable';
  try {
    await db.query('SELECT 1');
    database = 'connected';
  } catch (err) {
    console.error('Admin database health check failed:', err.message);
  }
  const metaReady = Boolean(process.env.META_WHATSAPP_TOKEN?.trim()
    && process.env.META_PHONE_ID?.trim()
    && process.env.META_GRAPH_API_VERSION?.trim());
  res.json({
    database: db.isConfigured() ? database : 'not_configured',
    whatsapp: metaReady ? 'configured' : 'not_configured',
    platform: 'operational',
    checkedAt: new Date().toISOString(),
  });
});

router.get('/export.xlsx', verifyToken, isAdmin, async (req, res) => {
  const organizationId = typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
    ? req.query.organizationId.trim()
    : '';
  const params = [];
  const where = organizationId ? (params.push(organizationId), `WHERE organization_id = $${params.length}`) : '';
  try {
    const [voters, organizations, users, dispatches] = await Promise.all([
      db.query(`SELECT * FROM voters ${where} ORDER BY organization_id, ward_no, part_no, serial_no`, params),
      db.query(`
        SELECT o.id, o.name, o.enabled_modules, o.allowed_wards, o.is_active, o.created_at,
          (SELECT COUNT(*)::integer FROM users u WHERE u.organization_id = o.id AND u.role = 'tenant_admin') AS admin_count,
          (SELECT COUNT(*)::integer FROM users u WHERE u.organization_id = o.id AND u.role = 'worker' AND u.is_active) AS active_workers,
          (SELECT COUNT(*)::integer FROM voters v WHERE v.organization_id = o.id) AS voter_count
        FROM organizations o ${organizationId ? 'WHERE o.id = $1' : ''}
        ORDER BY o.created_at DESC
      `, organizationId ? [organizationId] : []),
      db.query(`
        SELECT id, email, full_name, phone, role, sub_role, scope_type, scope_value,
          modules, is_active, organization_id, created_at
        FROM users ${where} ORDER BY organization_id, created_at
      `, params),
      db.query(`
        SELECT id, voter_id, voter_epic, voter_name, recipient_phone, slip_type,
          status, provider_message_id, error_message, organization_id, created_at
        FROM slip_dispatches ${where} ORDER BY organization_id, created_at DESC
      `, params),
    ]);
    const workbook = createWorkbook();
    addSheet(workbook, 'Voters', voters.rows);
    addSheet(workbook, 'Organizations', organizations.rows);
    addSheet(workbook, 'Accounts', users.rows);
    addSheet(workbook, 'Dispatches', dispatches.rows);
    await sendWorkbook(res, workbook, 'platform-data.xlsx');
  } catch (err) {
    console.error('Platform export failed:', err.message);
    res.status(500).json({ message: 'Excel export could not be created.' });
  }
});

const voterColumns = [
  'epic', 'name_en', 'name_hi', 'relative_name_en', 'relative_name_hi', 'relation_type',
  'age', 'gender', 'house_no', 'ward_no', 'part_no', 'serial_no', 'phone', 'caste',
  'surety', 'support_status', 'is_migrant', 'migrant_location', 'assigned_worker',
  'village_name', 'family_id', 'notes', 'voted',
];

router.get('/import-template.xlsx', verifyToken, isAdmin, async (_req, res) => {
  const workbook = createWorkbook();
  addSheet(workbook, 'Voters', [Object.fromEntries(voterColumns.map((column) => [column, '']))]);
  await sendWorkbook(res, workbook, 'voter-import-template.xlsx');
});

router.post('/import.xlsx', verifyToken, isAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose an Excel workbook to import.' });
  const organizationId = typeof req.body.organizationId === 'string' ? req.body.organizationId.trim() : '';
  if (!organizationId) return res.status(400).json({ message: 'Choose the organization for these voter records.' });

  try {
    const organization = await db.query('SELECT id FROM organizations WHERE id = $1 AND is_active = true', [organizationId]);
    if (!organization.rowCount) return res.status(404).json({ message: 'Organization not found or disabled.' });
    const workbook = createWorkbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) return res.status(400).json({ message: 'Workbook must contain a header row and voter records.' });
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, index) => { headers[index] = String(cell.value ?? '').trim().toLowerCase(); });
    const epicIndex = headers.indexOf('epic');
    if (epicIndex < 0) return res.status(400).json({ message: 'Workbook is missing the required "epic" column. Download the template for the supported format.' });
    const rows = [];
    sheet.eachRow((sheetRow, rowNumber) => {
      if (rowNumber === 1) return;
      const row = Object.fromEntries(voterColumns.map((key) => [key, null]));
      headers.forEach((key, index) => {
        if (!voterColumns.includes(key)) return;
        const value = sheetRow.getCell(index).value;
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
          throw new Error(`Unsupported cell value at worksheet row ${rowNumber}.`);
        }
        row[key] = value;
      });
      row.epic = String(row.epic ?? '').trim().toUpperCase();
      if (!row.epic) return;
      if (row.epic.length > 50) throw new Error(`EPIC value exceeds 50 characters at worksheet row ${rowNumber}.`);
      if (row.age !== null && row.age !== '') {
        const age = Number(row.age);
        if (!Number.isInteger(age) || age < 0 || age > 130) throw new Error(`Invalid age at worksheet row ${rowNumber}.`);
        row.age = age;
      } else row.age = null;
      if (row.serial_no !== null && row.serial_no !== '') {
        const serial = Number(row.serial_no);
        if (!Number.isInteger(serial) || serial < 0) throw new Error(`Invalid serial number at worksheet row ${rowNumber}.`);
        row.serial_no = serial;
      } else row.serial_no = null;
      row.is_migrant = row.is_migrant === true || ['true', 'yes', '1'].includes(String(row.is_migrant ?? '').trim().toLowerCase());
      row.voted = row.voted === true || ['true', 'yes', '1'].includes(String(row.voted ?? '').trim().toLowerCase());
      rows.push(row);
    });
    if (!rows.length) return res.status(400).json({ message: 'No voter rows with an EPIC value were found.' });
    if (rows.length > 50000) return res.status(413).json({ message: 'A workbook may contain at most 50,000 voter rows per import.' });

    let inserted = 0;
    let updated = 0;
    await db.transaction(async (client) => {
      for (const row of rows) {
        const values = voterColumns.map((column) => row[column]);
        values.push(organizationId);
        const updates = voterColumns.slice(1).map((column) => `${column} = EXCLUDED.${column}`).join(', ');
        const result = await client.query(`
          INSERT INTO voters (${voterColumns.join(', ')}, organization_id)
          VALUES (${voterColumns.map((_, index) => `$${index + 1}`).join(', ')}, $${values.length})
          ON CONFLICT (organization_id, epic) DO UPDATE SET ${updates}
          RETURNING (xmax = 0) AS inserted
        `, values);
        if (result.rows[0].inserted) inserted += 1;
        else updated += 1;
      }
    });
    res.json({ inserted, updated, total: rows.length });
  } catch (err) {
    if (err instanceof Error && /worksheet row/.test(err.message)) return res.status(400).json({ message: err.message });
    console.error('Voter workbook import failed:', err.message);
    res.status(500).json({ message: 'Voter workbook import failed; no rows were saved.' });
  }
});

module.exports = router;
