function addVoterAccess(req) {
  const query = {};
  const isPlatformAdmin = req.user?.role === 'admin';
  
  if (!isPlatformAdmin) {
    query.organizationId = req.user?.organizationId || 'org_default';
  } else if (typeof req.query?.organizationId === 'string' && req.query.organizationId.trim()) {
    query.organizationId = req.query.organizationId.trim();
  }

  if (!isPlatformAdmin) {
    const allowedWards = req.user?.allowedWards;
    if (Array.isArray(allowedWards) && allowedWards.length) {
      query.wardNo = { $in: allowedWards };
    }
    const scopeField = {
      Booth: 'partNo',
      Ward: 'wardNo',
      Village: 'villageName',
    }[req.user?.scopeType];
    
    if (scopeField) {
      const scopeValue = req.user?.scopeValue;
      if (typeof scopeValue !== 'string' || !scopeValue.trim()) {
        // Impossible condition to force no results if scope is invalid
        query._id = null;
      } else {
        query[scopeField] = scopeValue.trim();
      }
    } else if (req.user?.scopeType !== 'All') {
      query._id = null;
    }
  }
  
  return query;
}

module.exports = { addVoterAccess };
