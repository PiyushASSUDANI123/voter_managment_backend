const jwt = require('jsonwebtoken');
const { User, Organization } = require('../models/index');

exports.verifyToken = async (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).json({ message: 'Invalid Token' });
  }

  try {
    const user = await User.findById(claims.user?.id).lean();
    if (!user || user.isActive === false) {
      return res.status(401).json({ message: 'This account is unavailable or has been disabled.' });
    }
    const organization = await Organization.findById(user.organizationId).lean();
    if (!organization || organization.isActive === false) {
      return res.status(403).json({ message: 'This account or organization has been disabled.' });
    }

    const enabledModules = user.role === 'admin'
      ? []
      : user.role === 'tenant_admin'
        ? (organization.enabledModules || [])
        : (user.modules || []).filter((module) => (organization.enabledModules || []).includes(module));
    req.user = {
      id: user._id,
      role: user.role,
      organizationId: user.organizationId,
      subRole: user.subRole || user.role,
      scopeType: user.scopeType || 'All',
      scopeValue: user.scopeValue || '',
      modules: enabledModules,
      allowedWards: organization.allowedWards || [],
    };
    next();
  } catch (err) {
    console.error('Authenticated account lookup failed:', err.message);
    return res.status(503).json({ message: 'Account permissions could not be verified.' });
  }
};

exports.isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Access Denied: Admins Only' });
  }
};

exports.isOrganizationAdmin = (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.role === 'tenant_admin') return next();
  return res.status(403).json({ message: 'Organization administrators only.' });
};

exports.requireModule = (...allowed) => (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  const granted = Array.isArray(req.user?.modules) ? req.user.modules : [];
  if (!allowed.some((module) => granted.includes(module))) {
    return res.status(403).json({ message: 'Your account does not have access to this module.' });
  }
  if (req.method !== 'GET' && req.user?.subRole === 'Viewer') {
    return res.status(403).json({ message: 'Viewer accounts cannot change records.' });
  }
  next();
};
