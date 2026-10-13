const express = require('express');
const router = express.Router();
const cache = require('../lib/cache');
const { formatVoter } = require('./features');
const { verifyToken, requireModule } = require('../middleware/authMiddleware');
const { addVoterAccess } = require('../lib/access');
const { Voter } = require('../models/index');

const boundedInteger = (value, fallback, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

// Get ALL voters (for Turnout / Analytics)
router.get('/all', verifyToken, requireModule('voters', 'poll-desk', 'turnout', 'warroom'), async (req, res) => {
  try {
    const { ward } = req.query;
    const query = addVoterAccess(req);
    const orgId = query.organizationId || req.user.organizationId || 'org_default';
    const cacheKey = `voters_all_${orgId}_${req.user.id}_${ward || 'all'}`;
    
    // Check Cache
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }
    
    if (typeof ward === 'string' && ward.trim()) {
      query.wardNo = new RegExp(ward.trim(), 'i');
    }
    
    const voters = await Voter.find(query).sort({ wardNo: 1, partNo: 1, serialNo: 1 }).lean();
    
    // Set Cache
    cache.set(cacheKey, voters);
    
    res.json(voters);
  } catch (err) {
    console.error('Voter analytics query failed:', err.message);
    res.status(500).json({ message: 'Voter analytics could not be loaded.' });
  }
});

// Get unique wards list with counts for current organization (Cached 5m)
router.get('/wards-summary', verifyToken, requireModule('voters', 'community', 'poll-desk'), async (req, res) => {
  try {
    const query = addVoterAccess(req);
    const orgId = query.organizationId || req.user.organizationId || 'org_default';
    const cacheKey = `wards_summary_${orgId}_${req.user.id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    const rawWards = await Voter.aggregate([
      { $match: query },
      { $group: { _id: '$wardNo', count: { $sum: 1 } } }
    ]);
    const wards = rawWards
      .filter((w) => w._id !== null && w._id !== undefined && String(w._id).trim() !== '')
      .sort((a, b) => {
        const numA = parseInt(a._id, 10);
        const numB = parseInt(b._id, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return String(a._id).localeCompare(String(b._id));
      });
    const total = await Voter.countDocuments(query);
    const result = { wards, total };
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    console.error('Wards summary failed:', err.message);
    res.status(500).json({ message: 'Wards could not be loaded.' });
  }
});

// Get all voters (with search & pagination)
router.get('/', verifyToken, requireModule('voters', 'community', 'workers', 'migrants'), async (req, res) => {
  try {
    const { search, relative, ward, house, isMigrant, supportStatus, caste, assignedWorker } = req.query;
    const query = addVoterAccess(req);

    if (typeof search === 'string' && search.trim()) {
      const trimmed = search.trim();
      const searchRegex = new RegExp(trimmed, 'i');
      query.$or = [
        { nameHi: searchRegex },
        { nameEn: searchRegex },
        { epic: searchRegex },
        { relativeNameHi: searchRegex },
        { relativeNameEn: searchRegex },
        { houseNo: trimmed },
        { mobileNo: searchRegex }
      ];

      const parsedSerial = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(parsedSerial) && String(parsedSerial) === trimmed) {
        query.$or.push({ serialNo: parsedSerial });
      }
    }
    
    if (typeof relative === 'string' && relative.trim()) {
      const relativeRegex = new RegExp(relative.trim(), 'i');
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: [{ relativeNameHi: relativeRegex }, { relativeNameEn: relativeRegex }] }];
        delete query.$or;
      } else {
        query.$or = [{ relativeNameHi: relativeRegex }, { relativeNameEn: relativeRegex }];
      }
    }
    
    if (typeof ward === 'string' && ward.trim()) query.wardNo = new RegExp(ward.trim(), 'i');
    if (typeof house === 'string' && house.trim()) query.houseNo = new RegExp(house.trim(), 'i');
    if (isMigrant === 'true' || isMigrant === 'false') query.isMigrant = isMigrant === 'true';
    if (typeof supportStatus === 'string' && ['core', 'swing', 'opposition', 'unmarked'].includes(supportStatus)) {
      query.supportStatus = supportStatus;
    }
    if (typeof caste === 'string' && caste.trim()) query.caste = new RegExp(caste.trim(), 'i');
    if (typeof assignedWorker === 'string' && assignedWorker.trim()) query.assignedWorker = new RegExp(assignedWorker.trim(), 'i');

    const isAll = req.query.all === 'true' || req.query.all === '1';
    const page = boundedInteger(req.query.page, 1, 100000);
    const pageSize = boundedInteger(req.query.pageSize, 100, 10000);
    
    // Execute count and paginated query in parallel for 2x faster responses
    const voterQuery = Voter.find(query).sort({ wardNo: 1, partNo: 1, serialNo: 1 }).lean();
    if (!isAll) {
      voterQuery.skip((page - 1) * pageSize).limit(pageSize);
    } else {
      voterQuery.limit(10000);
    }

    const [count, voters] = await Promise.all([
      Voter.countDocuments(query),
      voterQuery,
    ]);

    const formattedVoters = voters.map((v) => ({
      ...v,
      phone: v.mobileNo || v.phone || '',
      mobileNo: v.mobileNo || v.phone || '',
    }));
      
    res.json(req.query.page || req.query.pageSize || isAll
      ? { data: formattedVoters, page: isAll ? 1 : page, pageSize: isAll ? count : pageSize, total: count }
      : formattedVoters);
  } catch (err) {
    console.error('Voter search failed:', err.message);
    res.status(500).json({ message: 'Voter records could not be loaded.' });
  }
});

// Get family members by houseNo
router.get('/family/:houseNo', verifyToken, requireModule('voters', 'community'), async (req, res) => {
  try {
    const query = addVoterAccess(req);
    query.houseNo = req.params.houseNo;
    
    if (typeof req.query.ward === 'string' && req.query.ward.trim()) {
      query.wardNo = req.query.ward.trim();
    }
    if (typeof req.query.part === 'string' && req.query.part.trim()) {
      query.partNo = req.query.part.trim();
    }
    
    const voters = await Voter.find(query).sort({ serialNo: 1 }).lean();
    const formattedVoters = voters.map((v) => ({
      ...v,
      phone: v.mobileNo || v.phone || '',
      mobileNo: v.mobileNo || v.phone || '',
    }));
    res.json(formattedVoters);
  } catch (err) {
    console.error('Household voter query failed:', err.message);
    res.status(500).json({ message: 'Household records could not be loaded.' });
  }
});

// Update Voter Info
router.put('/:id', verifyToken, (req, res, next) => {
  const keys = Object.keys(req.body || {});
  const migrantOnly = keys.length > 0 && keys.every((key) => ['isMigrant', 'migrantLocation'].includes(key));
  return requireModule(migrantOnly ? 'migrants' : 'voters')(req, res, next);
}, async (req, res) => {
  try {
    const id = req.params.id; // MongoDB _id is string/ObjectId, but frontend might send number if it thinks it's SQL
    
    const columns = {
      phone: 'mobileNo',
      mobileNo: 'mobileNo',
      caste: 'caste',
      surety: 'surety',
      isMigrant: 'isMigrant',
      assignedWorker: 'assignedWorker',
      supportStatus: 'supportStatus',
      notes: 'notes',
      familyId: 'familyId',
      migrantLocation: 'migrantLocation',
      nameEn: 'nameEn',
      nameHi: 'nameHi',
      relativeNameEn: 'relativeNameEn',
      relativeNameHi: 'relativeNameHi',
      relationType: 'relationType',
      age: 'age',
      gender: 'gender',
      epic: 'epic',
      houseNo: 'houseNo',
      wardNo: 'wardNo',
      partNo: 'partNo',
      serialNo: 'serialNo',
      boothName: 'boothName',
      villageName: 'villageName',
      villageNameHi: 'villageNameHi',
      occupation: 'occupation',
    };
    
    const updates = {};
    for (const [key, dbColumn] of Object.entries(columns)) {
      if (Object.hasOwn(req.body, key)) {
        if (key === 'age') {
          const numAge = Number.parseInt(req.body[key], 10);
          updates[dbColumn] = !isNaN(numAge) && numAge >= 18 && numAge <= 125 ? numAge : null;
        } else if (key === 'serialNo') {
          const numSerial = Number.parseInt(req.body[key], 10);
          updates[dbColumn] = !isNaN(numSerial) && numSerial > 0 ? numSerial : null;
        } else if (key === 'nameHi' && typeof req.body[key] === 'string') {
          updates[dbColumn] = req.body[key].replace(/[a-zA-Z\d\u0966-\u096F]/g, '').replace(/[^\u0900-\u097F\s]/g, '').replace(/\s+/g, ' ').trim();
        } else if (key === 'relativeNameHi' && typeof req.body[key] === 'string') {
          updates[dbColumn] = req.body[key].replace(/[a-zA-Z\d\u0966-\u096F]/g, '').replace(/[^\u0900-\u097F\s]/g, '').replace(/\s+/g, ' ').trim();
        } else {
          updates[dbColumn] = req.body[key];
        }
      }
    }
    
    if (Object.keys(updates).length === 0) return res.status(400).json({ message: 'No supported voter fields were provided.' });
    if (Object.hasOwn(req.body, 'isMigrant') && typeof req.body.isMigrant !== 'boolean') {
      return res.status(400).json({ message: 'Voter fields contain invalid values.' });
    }
    if (Object.hasOwn(req.body, 'supportStatus') && !['core', 'swing', 'opposition', 'unmarked'].includes(req.body.supportStatus)) {
      return res.status(400).json({ message: 'Choose a valid support status.' });
    }

    const query = addVoterAccess(req);
    // Handle both SQL ID (number) and MongoDB ID (string) gracefully during migration
    if (!isNaN(id)) {
      query.sqlId = Number.parseInt(id, 10);
    } else {
      query._id = id;
    }
    
    const voter = await Voter.findOneAndUpdate(query, { $set: updates }, { returnDocument: 'after' }).lean();
    
    if (!voter) return res.status(404).json({ message: 'Voter not found or access denied.' });

    // Invalidate Cache for this organization
    const orgKey = query.organizationId || req.user.organizationId || 'org_default';
    cache.delPrefix(`voters_all_${orgKey}_`);
    cache.delPrefix(`wards_summary_${orgKey}_`);

    res.json(voter);
  } catch (err) {
    console.error('Voter update failed:', err.message);
    res.status(500).json({ message: 'Voter details could not be updated.' });
  }
});

// Toggle Vote Status
router.put('/:id/vote', verifyToken, requireModule('poll-desk', 'turnout'), async (req, res) => {
  try {
    const id = req.params.id;
    const { voted } = req.body;
    
    if (typeof voted !== 'boolean') {
      return res.status(400).json({ message: 'A valid voter ID and boolean vote status are required.' });
    }
    
    const query = addVoterAccess(req);
    if (!isNaN(id)) {
      query.sqlId = Number.parseInt(id, 10);
    } else {
      query._id = id;
    }
    
    const voter = await Voter.findOneAndUpdate(query, { $set: { voted } }, { returnDocument: 'after' });
    
    if (!voter) return res.status(404).json({ message: 'Voter not found or access denied.' });
    
    // Invalidate Cache for this organization
    const orgKey = query.organizationId || req.user.organizationId || 'org_default';
    cache.delPrefix(`voters_all_${orgKey}_`);
    
    res.json({ success: true, message: 'Vote status updated.' });
  } catch (err) {
    console.error('Vote status update failed:', err.message);
    res.status(500).json({ message: 'Vote status could not be updated.' });
  }
});
// DELETE single voter (Admin Only)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({
        message: 'क्लाइंट्स को डेटा डिलीट करने की अनुमति नहीं है। यह अधिकार केवल सुपर एडमिन के पास है।'
      });
    }

    const { id } = req.params;
    const query = addVoterAccess(req);
    if (!isNaN(id)) {
      query.sqlId = Number.parseInt(id, 10);
    } else {
      query._id = id;
    }

    const deleted = await Voter.findOneAndDelete(query);
    if (!deleted) {
      return res.status(404).json({ message: 'मतदाता नहीं मिला या पहले ही डिलीट हो चुका है।' });
    }

    // Invalidate Cache for this organization
    const orgKey = query.organizationId || req.user.organizationId || 'org_default';
    cache.delPrefix(`voters_all_${orgKey}_`);
    cache.delPrefix(`wards_summary_${orgKey}_`);

    res.json({ success: true, message: 'मतदाता सफलतापूर्वक डिलीट कर दिया गया।' });
  } catch (err) {
    console.error('Voter deletion failed:', err.message);
    res.status(500).json({ message: 'डेटा डिलीट करने में त्रुटि आई।' });
  }
});

// BULK DELETE voters (Admin Only)
router.post('/bulk-delete', verifyToken, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({
        message: 'क्लाइंट्स को डेटा डिलीट करने की अनुमति नहीं है। यह अधिकार केवल सुपर एडमिन के पास है।'
      });
    }

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'डिलीट करने के लिए मतदाता IDs आवश्यक हैं।' });
    }

    const query = addVoterAccess(req);
    query._id = { $in: ids };

    const result = await Voter.deleteMany(query);

    // Invalidate Cache for this organization
    const orgKey = query.organizationId || req.user.organizationId || 'org_default';
    cache.delPrefix(`voters_all_${orgKey}_`);
    cache.delPrefix(`wards_summary_${orgKey}_`);

    res.json({ success: true, message: `${result.deletedCount} मतदाता सफलतापूर्वक डिलीट कर दिए गए।`, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('Bulk voter deletion failed:', err.message);
    res.status(500).json({ message: 'डेटा डिलीट करने में त्रुटि आई।' });
  }
});

// EXPLICIT CLIENT PROTECTION: Catch-all for clients trying to delete or post
router.use((req, res, next) => {
  if (req.method === 'DELETE') {
    return res.status(403).json({
      message: 'क्लाइंट्स को डेटा डिलीट करने की अनुमति नहीं है। आप केवल डेटा देख व एडिट कर सकते हैं।'
    });
  }
  if (req.method === 'POST') {
    return res.status(403).json({
      message: 'क्लाइंट्स को नया डेटा अपलोड करने की अनुमति नहीं है। नया डेटा केवल सुपर एडमिन द्वारा अपलोड किया जा सकता है। आप केवल डेटा देख व एडिट कर सकते हैं।'
    });
  }
  next();
});

module.exports = router;
