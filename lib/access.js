function addVoterAccess(req, params, alias = '') {
  const clauses = [];
  const isPlatformAdmin = req.user?.role === 'admin';
  if (!isPlatformAdmin) {
    const organizationId = req.user?.organizationId || 'org_default';
    params.push(organizationId);
    clauses.push(`${alias}organization_id = $${params.length}`);
  } else if (typeof req.query?.organizationId === 'string' && req.query.organizationId.trim()) {
    params.push(req.query.organizationId.trim());
    clauses.push(`${alias}organization_id = $${params.length}`);
  }

  if (!isPlatformAdmin) {
    const allowedWards = req.user?.allowedWards;
    if (Array.isArray(allowedWards) && allowedWards.length) {
      params.push(allowedWards);
      clauses.push(`${alias}ward_no = ANY($${params.length}::text[])`);
    }
    const scopeField = {
      Booth: 'part_no',
      Ward: 'ward_no',
      Village: 'village_name',
    }[req.user?.scopeType];
    if (scopeField) {
      const scopeValue = req.user?.scopeValue;
      if (typeof scopeValue !== 'string' || !scopeValue.trim()) {
        clauses.push('FALSE');
      } else {
        params.push(scopeValue.trim());
        clauses.push(`${alias}${scopeField} = $${params.length}`);
      }
    } else if (req.user?.scopeType !== 'All') {
      clauses.push('FALSE');
    }
  }
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

module.exports = { addVoterAccess };
