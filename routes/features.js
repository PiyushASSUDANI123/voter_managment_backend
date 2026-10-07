const express = require('express');
const db = require('../db');
const { verifyToken, requireModule } = require('../middleware/authMiddleware');
const { addVoterAccess } = require('../lib/access');
const { createWorkbook, addSheet, sendWorkbook } = require('../lib/xlsx');

const router = express.Router();

const formatVoter = (row) => ({
  _id: row.id,
  epic: row.epic,
  nameEn: row.name_en,
  nameHi: row.name_hi,
  relativeNameEn: row.relative_name_en,
  relativeNameHi: row.relative_name_hi,
  relationType: row.relation_type,
  age: row.age,
  gender: row.gender,
  houseNo: row.house_no,
  wardNo: row.ward_no,
  partNo: row.part_no,
  serialNo: row.serial_no,
  phone: row.phone,
  caste: row.caste,
  surety: row.surety,
  supportStatus: row.support_status,
  isMigrant: row.is_migrant,
  migrantLocation: row.migrant_location,
  assignedWorker: row.assigned_worker,
  familyId: row.family_id,
  voted: row.voted,
});

const boundedNumber = (value, fallback, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

router.use(verifyToken);

router.get('/war-room', requireModule('warroom'), async (req, res) => {
  try {
    const [support, booths] = await Promise.all([
      (() => {
        const params = [];
        const access = addVoterAccess(req, params, 'v.');
        return db.query(`
        SELECT support_status, COUNT(*)::integer AS count
        FROM voters v
        WHERE ${access}
        GROUP BY support_status
      `, params);
      })(),
      (() => {
        const params = [];
        const access = addVoterAccess(req, params, 'v.');
        return db.query(`
        SELECT ward_no, part_no, COUNT(*)::integer AS total,
          COUNT(*) FILTER (WHERE voted)::integer AS voted,
          COUNT(*) FILTER (WHERE support_status = 'core')::integer AS core,
          COUNT(*) FILTER (WHERE support_status = 'swing')::integer AS swing,
          COUNT(*) FILTER (WHERE support_status = 'opposition')::integer AS opposition,
          COUNT(*) FILTER (WHERE support_status = 'unmarked')::integer AS unmarked
        FROM voters v
        WHERE ${access}
        GROUP BY ward_no, part_no
        ORDER BY ward_no, part_no
      `, params);
      })(),
    ]);

    res.json({
      support: support.rows.map((row) => ({ status: row.support_status, count: row.count })),
      booths: booths.rows.map((row) => ({
        ward: row.ward_no,
        part: row.part_no,
        total: row.total,
        voted: row.voted,
        core: row.core,
        swing: row.swing,
        opposition: row.opposition,
        unmarked: row.unmarked,
      })),
    });
  } catch (err) {
    console.error('War-room summary failed:', err.message);
    res.status(500).json({ message: 'War-room summary could not be loaded.' });
  }
});

router.get('/communities', requireModule('community'), async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const ward = typeof req.query.ward === 'string' ? req.query.ward.trim() : '';
  if (!query) return res.status(400).json({ message: 'Enter a community or surname to search.' });

  try {
    const params = [];
    const access = addVoterAccess(req, params, 'v.');
    params.push(`%${query}%`);
    const queryParam = params.length;
    params.push(ward ? `%${ward}%` : '');
    const wardParam = params.length;
    params.push(boundedNumber(req.query.limit, 100, 250));
    const limitParam = params.length;
    const result = await db.query(`
      SELECT v.*,
        COUNT(*) OVER (PARTITION BY v.ward_no, v.part_no, v.house_no)::integer AS household_count
      FROM voters v
      WHERE ${access}
        AND (COALESCE(v.caste, '') ILIKE $${queryParam}
          OR COALESCE(v.name_en, '') ILIKE $${queryParam}
          OR COALESCE(v.name_hi, '') ILIKE $${queryParam}
          OR COALESCE(v.relative_name_en, '') ILIKE $${queryParam}
          OR COALESCE(v.relative_name_hi, '') ILIKE $${queryParam})
        AND ($${wardParam} = '' OR v.ward_no ILIKE $${wardParam})
      ORDER BY v.ward_no, v.part_no, v.serial_no
      LIMIT $${limitParam}
    `, params);

    res.json(result.rows.map((row) => ({ ...formatVoter(row), householdCount: row.household_count })));
  } catch (err) {
    console.error('Community search failed:', err.message);
    res.status(500).json({ message: 'Community search could not be completed.' });
  }
});

router.get('/migrants', requireModule('migrants'), async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const ward = typeof req.query.ward === 'string' ? req.query.ward.trim() : '';

  try {
    const params = [];
    const access = addVoterAccess(req, params, 'v.');
    params.push(ward ? `%${ward}%` : '');
    const wardParam = params.length;
    params.push(search ? `%${search}%` : '');
    const searchParam = params.length;
    params.push(boundedNumber(req.query.limit, 250, 500));
    const limitParam = params.length;
    const result = await db.query(`
      SELECT v.*,
        COUNT(*) OVER (PARTITION BY v.ward_no, v.part_no, v.house_no)::integer AS household_count
      FROM voters v
      WHERE ${access} AND v.is_migrant = true
        AND ($${wardParam} = '' OR v.ward_no ILIKE $${wardParam})
        AND ($${searchParam} = '' OR COALESCE(v.name_en, '') ILIKE $${searchParam}
          OR COALESCE(v.name_hi, '') ILIKE $${searchParam}
          OR COALESCE(v.epic, '') ILIKE $${searchParam}
          OR COALESCE(v.phone, '') ILIKE $${searchParam}
          OR COALESCE(v.migrant_location, '') ILIKE $${searchParam})
      ORDER BY v.ward_no, v.part_no, v.serial_no
      LIMIT $${limitParam}
    `, params);

    res.json(result.rows.map((row) => ({ ...formatVoter(row), householdCount: row.household_count })));
  } catch (err) {
    console.error('Migrant voter list failed:', err.message);
    res.status(500).json({ message: 'Migrant voter list could not be loaded.' });
  }
});

router.get('/dispatches', requireModule('history'), async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const limit = boundedNumber(req.query.limit, 100, 500);

  try {
    const params = [];
    const dispatchAccess = addVoterAccess(req, params, 'd.');
    const voterAccess = addVoterAccess(req, params, 'v.');
    const predicates = [dispatchAccess, voterAccess];
    if (search) {
      params.push(`%${search}%`);
      predicates.push(`(d.voter_name ILIKE $${params.length} OR d.voter_epic ILIKE $${params.length} OR d.recipient_phone ILIKE $${params.length})`);
    }
    if (['sent', 'failed', 'sending'].includes(status)) {
      params.push(status);
      predicates.push(`d.status = $${params.length}`);
    }
    const where = `WHERE ${predicates.join(' AND ')}`;
    const summary = await db.query(`
      SELECT COUNT(d.id)::integer AS total,
        COUNT(d.id) FILTER (WHERE d.status = 'sent')::integer AS sent,
        COUNT(d.id) FILTER (WHERE d.status = 'failed')::integer AS failed,
        COUNT(d.id) FILTER (WHERE d.status = 'sending')::integer AS sending
      FROM slip_dispatches d
      LEFT JOIN voters v ON v.id = d.voter_id
      ${where}
    `, params);
    params.push(limit);
    const result = await db.query(`
      SELECT d.id, d.voter_id, d.voter_epic, d.voter_name, d.recipient_phone, d.slip_type,
        d.status, d.provider_message_id, d.error_message, d.created_at
      FROM slip_dispatches d
      LEFT JOIN voters v ON v.id = d.voter_id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT $${params.length}
    `, params);

    res.json({
      summary: summary.rows[0],
      dispatches: result.rows.map((row) => ({
        id: row.id,
        voterId: row.voter_id,
        epic: row.voter_epic,
        voterName: row.voter_name,
        phone: row.recipient_phone,
        slipType: row.slip_type,
        status: row.status,
        providerMessageId: row.provider_message_id,
        errorMessage: row.error_message,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error('Dispatch history failed:', err.message);
    res.status(500).json({ message: 'Dispatch history could not be loaded.' });
  }
});

router.get('/export.xlsx', async (req, res) => {
  const dataset = typeof req.query.dataset === 'string' ? req.query.dataset : '';
  const permissions = {
    voters: 'voters',
    turnout: 'turnout',
    migrants: 'migrants',
    community: 'community',
    dispatches: 'history',
    workers: 'workers',
    accounts: 'accounts',
    warroom: 'warroom',
  };
  const permission = permissions[dataset];
  if (!permission) return res.status(400).json({ message: 'Choose a supported Excel export dataset.' });
  if (req.user?.role !== 'admin'
    && (!req.user?.modules?.includes(permission)
      || (dataset === 'accounts' && req.user?.role !== 'tenant_admin'))) {
    return res.status(403).json({ message: 'Your account does not have access to export this dataset.' });
  }

  try {
    const params = [];
    const voterAccess = addVoterAccess(req, params, 'v.');
    let result;
    if (['voters', 'turnout', 'migrants', 'community'].includes(dataset)) {
      const predicates = [voterAccess];
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const ward = typeof req.query.ward === 'string' ? req.query.ward.trim() : '';
      if (dataset === 'turnout') predicates.push('v.voted = false');
      if (dataset === 'migrants') predicates.push('v.is_migrant = true');
      if (search) {
        params.push(`%${search}%`);
        const searchParam = `$${params.length}`;
        predicates.push(`(COALESCE(v.name_en, '') ILIKE ${searchParam} OR COALESCE(v.name_hi, '') ILIKE ${searchParam}
          OR COALESCE(v.epic, '') ILIKE ${searchParam} OR COALESCE(v.phone, '') ILIKE ${searchParam}
          OR COALESCE(v.migrant_location, '') ILIKE ${searchParam})`);
      }
      if (ward) {
        params.push(ward);
        predicates.push(`v.ward_no = $${params.length}`);
      }
      result = await db.query(`
        SELECT v.* FROM voters v WHERE ${predicates.join(' AND ')}
        ORDER BY v.ward_no, v.part_no, v.serial_no
      `, params);
    } else if (dataset === 'dispatches') {
      const dispatchAccess = addVoterAccess(req, params, 'd.');
      const predicates = [dispatchAccess, voterAccess];
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
      if (search) {
        params.push(`%${search}%`);
        predicates.push(`(d.voter_name ILIKE $${params.length} OR d.voter_epic ILIKE $${params.length} OR d.recipient_phone ILIKE $${params.length})`);
      }
      if (['sent', 'failed', 'sending'].includes(status)) {
        params.push(status);
        predicates.push(`d.status = $${params.length}`);
      }
      result = await db.query(`
        SELECT d.id, d.voter_id, d.voter_name, d.voter_epic, d.recipient_phone, d.slip_type,
          d.status, d.provider_message_id, d.error_message, d.created_at, d.organization_id
        FROM slip_dispatches d LEFT JOIN voters v ON v.id = d.voter_id
        WHERE ${predicates.join(' AND ')}
        ORDER BY d.created_at DESC
      `, params);
    } else if (dataset === 'warroom') {
      result = await db.query(`
        SELECT v.ward_no, v.part_no, COUNT(*)::integer AS total,
          COUNT(*) FILTER (WHERE v.voted)::integer AS voted,
          COUNT(*) FILTER (WHERE v.support_status = 'core')::integer AS core,
          COUNT(*) FILTER (WHERE v.support_status = 'swing')::integer AS swing,
          COUNT(*) FILTER (WHERE v.support_status = 'opposition')::integer AS opposition,
          COUNT(*) FILTER (WHERE v.support_status = 'unmarked')::integer AS unmarked
        FROM voters v WHERE ${voterAccess}
        GROUP BY v.ward_no, v.part_no ORDER BY v.ward_no, v.part_no
      `, params);
    } else {
      const userParams = [];
      const organizationFilter = req.user?.role === 'admin' && typeof req.query.organizationId === 'string'
        ? (userParams.push(req.query.organizationId), `organization_id = $${userParams.length}`)
        : (userParams.push(req.user?.organizationId || 'org_default'), `organization_id = $${userParams.length}`);
      const roleFilter = dataset === 'workers' ? " AND role = 'worker'" : " AND role IN ('worker', 'tenant_admin')";
      result = await db.query(`
        SELECT id, email, full_name, phone, role, sub_role, scope_type, scope_value,
          modules, is_active, organization_id, created_at
        FROM users WHERE ${organizationFilter}${roleFilter} ORDER BY organization_id, created_at
      `, userParams);
    }
    const workbook = createWorkbook();
    const tabNames = {
      voters: 'Voters', turnout: 'Pending voters', migrants: 'Migrant voters',
      community: 'Community search', dispatches: 'Dispatch history',
      workers: 'Workers', accounts: 'Accounts', warroom: 'Booth summary',
    };
    addSheet(workbook, tabNames[dataset], result.rows);
    await sendWorkbook(res, workbook, `${dataset}.xlsx`);
  } catch (err) {
    console.error('Excel export failed:', err.message);
    res.status(500).json({ message: 'Excel export could not be created.' });
  }
});

module.exports = { router, formatVoter };
