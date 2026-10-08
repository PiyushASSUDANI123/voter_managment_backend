const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { verifyToken, isOrganizationAdmin, requireModule } = require('../middleware/authMiddleware');

const router = express.Router();
const roles = ['Operator', 'Booth Agent', 'Karyakarta', 'Viewer'];
const scopes = ['Booth', 'Ward', 'Village', 'All'];
const modules = ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants', 'accounts'];
const orgFor = (req) => req.user.organizationId || 'org_default';
const isPlatformAdmin = (req) => req.user.role === 'admin';

const selectAccounts = async (req, workersOnly) => {
  const params = [req.user.id];
  const filters = ['u.id <> $1'];
  if (!isPlatformAdmin(req)) {
    params.push(orgFor(req));
    filters.push(`u.organization_id = $${params.length}`);
  } else if (typeof req.query.organizationId === 'string' && req.query.organizationId.trim()) {
    params.push(req.query.organizationId.trim());
    filters.push(`u.organization_id = $${params.length}`);
  }
  if (workersOnly) filters.push("u.role = 'worker'");

  const result = await db.query(`
    SELECT u.id, u.email, u.full_name, u.phone, u.role AS account_type, u.sub_role, u.scope_type,
      u.scope_value, u.modules, u.is_active, u.organization_id, u.created_at,
      o.name AS organization_name,
      COUNT(v.id)::integer AS assigned_voters
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    LEFT JOIN voters v ON v.assigned_worker = COALESCE(u.full_name, u.email)
      AND v.organization_id = u.organization_id
    WHERE ${filters.join(' AND ')}
    GROUP BY u.id, o.name
    ORDER BY u.created_at DESC
  `, params);
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.full_name || '',
    phone: row.phone || '',
    accountType: row.account_type,
    role: row.sub_role || 'Operator',
    scope: row.scope_type,
    scopeValue: row.scope_value || '',
    modules: row.modules || [],
    isActive: row.is_active,
    assignedVoters: row.assigned_voters,
    organizationId: row.organization_id,
    organizationName: row.organization_name || row.organization_id,
    createdAt: row.created_at,
  }));
};

const validateAccess = (body, enabledModules) => (
  roles.includes(body.subRole)
  && scopes.includes(body.scope)
  && Array.isArray(body.modules)
  && body.modules.every((module) => module !== 'accounts' && modules.includes(module) && enabledModules.includes(module))
);

router.get('/workers', verifyToken, requireModule('workers', 'warroom'), async (req, res) => {
  try {
    res.json(await selectAccounts(req, true));
  } catch (err) {
    console.error('Worker list failed:', err.message);
    res.status(500).json({ message: 'Workers could not be loaded.' });
  }
});

router.get('/accounts', verifyToken, isOrganizationAdmin, async (req, res) => {
  try {
    res.json(await selectAccounts(req, false));
  } catch (err) {
    console.error('Account list failed:', err.message);
    res.status(500).json({ message: 'Accounts could not be loaded.' });
  }
});

router.post(['/workers', '/accounts'], verifyToken, isOrganizationAdmin, async (req, res) => {
  const { email, password, name, phone = '', subRole, scope, scopeValue = '', modules: enabledModules = [] } = req.body;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ message: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'Enter the worker name.' });
  }

  if (isPlatformAdmin(req) && (typeof req.body.organizationId !== 'string' || !req.body.organizationId.trim())) {
    return res.status(400).json({ message: 'Choose an organization for this worker account.' });
  }
  const organizationId = isPlatformAdmin(req) ? req.body.organizationId.trim() : orgFor(req);
  if (!organizationId) return res.status(400).json({ message: 'Choose an organization.' });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.transaction(async (client) => {
      const organization = await client.query(
        'SELECT id, enabled_modules FROM organizations WHERE id = $1 AND is_active = true FOR UPDATE',
        [organizationId],
      );
      if (!organization.rowCount) {
        const error = new Error('Organization not found or disabled.');
        error.status = 404;
        throw error;
      }
      const organizationModules = organization.rows[0].enabled_modules || [];
      if (!validateAccess({ subRole, scope, modules: enabledModules }, organizationModules)) {
        const error = new Error('Choose a valid worker role, scope, and enabled modules.');
        error.status = 400;
        throw error;
      }
      const count = await client.query(
        "SELECT COUNT(*)::integer AS count FROM users WHERE organization_id = $1 AND role = 'worker' AND is_active = true",
        [organizationId],
      );
      if (count.rows[0].count >= 10) {
        const error = new Error('This organization allows up to 10 active worker accounts.');
        error.status = 409;
        throw error;
      }
      return client.query(`
        INSERT INTO users (email, password, role, organization_id, full_name, phone, sub_role, scope_type, scope_value, modules)
        VALUES ($1, $2, 'worker', $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING id, email, full_name, phone, sub_role, scope_type, scope_value, modules, is_active, created_at
      `, [
        email.trim().toLowerCase(),
        passwordHash,
        organizationId,
        name.trim(),
        typeof phone === 'string' ? phone.trim() : '',
        subRole,
        scope,
        typeof scopeValue === 'string' ? scopeValue.trim() : '',
        JSON.stringify(enabledModules),
      ]);
    });
    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      email: row.email,
      name: row.full_name,
      phone: row.phone,
      role: row.sub_role,
      scope: row.scope_type,
      scopeValue: row.scope_value || '',
      modules: row.modules,
      isActive: row.is_active,
      createdAt: row.created_at,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'An account with this email already exists.' });
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('Account creation failed:', err.message);
    res.status(500).json({ message: 'Account could not be created.' });
  }
});

router.put(['/workers/:id', '/accounts/:id'], verifyToken, isOrganizationAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid account ID is required.' });
  const { name, phone, subRole, scope, scopeValue, modules: enabledModules, isActive, password } = req.body;
  if (subRole !== undefined && !roles.includes(subRole)) return res.status(400).json({ message: 'Choose a valid role.' });
  if (scope !== undefined && !scopes.includes(scope)) return res.status(400).json({ message: 'Choose a valid scope.' });
  if (enabledModules !== undefined && (!Array.isArray(enabledModules) || !enabledModules.every((item) => item !== 'accounts' && modules.includes(item)))) {
    return res.status(400).json({ message: 'One or more modules are invalid.' });
  }
  if (isActive !== undefined && typeof isActive !== 'boolean') return res.status(400).json({ message: 'Account status must be enabled or disabled.' });
  if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }

  try {
    const target = await db.query(
      `SELECT u.organization_id, u.is_active, o.enabled_modules FROM users u
       JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1 AND u.role = 'worker' ${isPlatformAdmin(req) ? '' : 'AND u.organization_id = $2'}`,
      isPlatformAdmin(req) ? [id] : [id, orgFor(req)],
    );
    if (!target.rowCount) return res.status(404).json({ message: 'Account not found.' });
    const availableModules = target.rows[0].enabled_modules || [];
    if (enabledModules !== undefined && enabledModules.some((item) => item === 'accounts' || !availableModules.includes(item))) {
      return res.status(400).json({ message: 'This organization has not enabled one or more selected modules.' });
    }

    const set = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      set.push(`${column} = $${values.length}${column === 'modules' ? '::jsonb' : ''}`);
    };
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ message: 'Name cannot be empty.' });
      add('full_name', name.trim());
    }
    if (phone !== undefined) {
      if (typeof phone !== 'string') return res.status(400).json({ message: 'Phone must be text.' });
      add('phone', phone.trim());
    }
    if (subRole !== undefined) add('sub_role', subRole);
    if (scope !== undefined) add('scope_type', scope);
    if (scopeValue !== undefined) {
      if (typeof scopeValue !== 'string') return res.status(400).json({ message: 'Scope value must be text.' });
      add('scope_value', scopeValue.trim());
    }
    if (enabledModules !== undefined) add('modules', JSON.stringify(enabledModules));
    if (isActive !== undefined) add('is_active', isActive);
    if (password !== undefined) add('password', await bcrypt.hash(password, 10));
    if (!set.length) return res.status(400).json({ message: 'No account changes were provided.' });

    const result = await db.transaction(async (client) => {
      const organizationId = target.rows[0].organization_id;
      if (isActive === true && !target.rows[0].is_active) {
        const organization = await client.query(
          'SELECT is_active FROM organizations WHERE id = $1 FOR UPDATE',
          [organizationId],
        );
        if (!organization.rowCount || !organization.rows[0].is_active) {
          const error = new Error('This organization is disabled.');
          error.status = 409;
          throw error;
        }
        const count = await client.query(
          "SELECT COUNT(*)::integer AS count FROM users WHERE organization_id = $1 AND role = 'worker' AND is_active = true",
          [organizationId],
        );
        if (count.rows[0].count >= 10) {
          const error = new Error('This organization allows up to 10 active worker accounts.');
          error.status = 409;
          throw error;
        }
      }
      values.push(id);
      const organizationFilter = isPlatformAdmin(req) ? '' : `AND organization_id = $${values.push(orgFor(req))}`;
      return client.query(`
        UPDATE users SET ${set.join(', ')}
        WHERE id = $${values.length - (organizationFilter ? 1 : 0)} AND role = 'worker'
        ${organizationFilter}
        RETURNING id, email, full_name, phone, sub_role, scope_type, scope_value, modules, is_active, created_at
      `, values);
    });
    if (!result.rowCount) return res.status(404).json({ message: 'Account not found.' });
    const row = result.rows[0];
    res.json({
      id: row.id, email: row.email, name: row.full_name, phone: row.phone, role: row.sub_role,
      scope: row.scope_type, scopeValue: row.scope_value || '', modules: row.modules,
      isActive: row.is_active, createdAt: row.created_at,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('Account update failed:', err.message);
    res.status(500).json({ message: 'Account could not be updated.' });
  }
});

router.delete(['/workers/:id', '/accounts/:id'], verifyToken, isOrganizationAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid account ID is required.' });
  try {
    const result = await db.query(`
      UPDATE users SET is_active = false
      WHERE id = $1 AND role = 'worker' ${isPlatformAdmin(req) ? '' : 'AND organization_id = $2'}
      RETURNING id
    `, isPlatformAdmin(req) ? [id] : [id, orgFor(req)]);
    if (!result.rowCount) return res.status(404).json({ message: 'Account not found.' });
    res.json({ success: true, message: 'Account disabled.' });
  } catch (err) {
    console.error('Account disable failed:', err.message);
    res.status(500).json({ message: 'Account could not be disabled.' });
  }
});

module.exports = router;
