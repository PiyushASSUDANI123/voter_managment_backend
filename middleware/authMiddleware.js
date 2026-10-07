const jwt = require('jsonwebtoken');

exports.verifyToken = (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified.user;
    next();
  } catch (err) {
    res.status(400).json({ message: 'Invalid Token' });
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
