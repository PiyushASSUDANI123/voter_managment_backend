const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

exports.register = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'A valid email and a password of at least 8 characters are required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO users (email, password, role, organization_id) VALUES ($1, $2, 'worker', $3)",
      [normalizedEmail, passwordHash, req.user.organizationId || 'org_default']
    );
    res.status(201).json({ message: 'User registered successfully.' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'An account with this email already exists.' });
    console.error('Account registration failed:', err.message);
    res.status(500).json({ message: 'Account could not be registered.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    // Check user
    const userResult = await db.query(`
      SELECT u.*, o.enabled_modules AS organization_modules, o.allowed_wards, o.is_active AS organization_active
      FROM users u LEFT JOIN organizations o ON o.id = u.organization_id
      WHERE u.email = $1
    `, [email.trim().toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(400).json({ message: 'Invalid Credentials' });
    
    const user = userResult.rows[0];
    if (user.is_active === false || user.organization_active === false) {
      return res.status(403).json({ message: 'This account or organization has been disabled.' });
    }

    // Match password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid Credentials' });

    // Generate token
    const enabledModules = user.role === 'admin'
      ? []
      : user.role === 'tenant_admin'
        ? (user.organization_modules || [])
        : (user.modules || []).filter((module) => (user.organization_modules || []).includes(module));
    const payload = {
      user: {
        id: user.id,
        role: user.role,
        organizationId: user.organization_id,
        subRole: user.sub_role || user.role,
        scopeType: user.scope_type || 'All',
        scopeValue: user.scope_value || '',
        modules: enabledModules,
        allowedWards: user.allowed_wards || [],
      }
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '365d' },
      (err, token) => {
        if (err) throw err;
        res.json({
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.full_name || user.email,
            role: user.role,
            subRole: user.sub_role || user.role,
            scope: user.scope_type || 'All',
            scopeValue: user.scope_value || '',
            modules: enabledModules,
            allowedWards: user.allowed_wards || [],
          },
        });
      }
    );
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ message: 'Login could not be completed.' });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: 'A valid old password and a new password of at least 8 characters are required.' });
    }

    const userId = req.user.id;
    const userResult = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    
    if (!isMatch) {
      return res.status(400).json({ message: 'Incorrect old password.' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2', [newPasswordHash, userId]);

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('Change password failed:', err.message);
    res.status(500).json({ message: 'Could not change password.' });
  }
};
