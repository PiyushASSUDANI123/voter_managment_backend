const express = require('express');
const router = express.Router();
const db = require('../db');
const cache = require('../lib/cache');
const { formatVoter } = require('./features');
const { verifyToken, requireModule } = require('../middleware/authMiddleware');
const { addVoterAccess } = require('../lib/access');

const boundedInteger = (value, fallback, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

// Get ALL voters (for Turnout / Analytics)
router.get('/all', verifyToken, requireModule('voters', 'poll-desk', 'turnout', 'warroom'), async (req, res) => {
  try {
    const { ward } = req.query;
    const cacheKey = `voters_all_${req.user.organizationId}_${req.user.id}_${ward || 'all'}`;
    
    // Check Cache
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const params = [];
    let access = addVoterAccess(req, params);
    
    if (typeof ward === 'string' && ward.trim()) {
      params.push(`%${ward.trim()}%`);
      access += ` AND ward_no ILIKE $${params.length}`;
    }
    
    const result = await db.query(`SELECT * FROM voters WHERE ${access} ORDER BY ward_no, part_no, serial_no`, params);
    const data = result.rows.map(formatVoter);
    
    // Set Cache
    cache.set(cacheKey, data);
    
    res.json(data);
  } catch (err) {
    console.error('Voter analytics query failed:', err.message);
    res.status(500).json({ message: 'Voter analytics could not be loaded.' });
  }
});

// Get all voters (with search & pagination)
router.get('/', verifyToken, requireModule('voters', 'community', 'workers', 'migrants'), async (req, res) => {
  try {
    const { search, relative, ward, house, isMigrant, supportStatus, caste, assignedWorker } = req.query;
    const params = [];
    const access = addVoterAccess(req, params);
    const clauses = [access];
    const add = (expression, value) => {
      params.push(value);
      clauses.push(expression.replace('?', `$${params.length}`));
    };

    if (typeof search === 'string' && search.trim()) {
      params.push(`%${search.trim()}%`);
      const placeholder = `$${params.length}`;
      clauses.push(`(name_hi ILIKE ${placeholder} OR name_en ILIKE ${placeholder} OR epic ILIKE ${placeholder} OR relative_name_hi ILIKE ${placeholder} OR relative_name_en ILIKE ${placeholder})`);
    }
    if (typeof relative === 'string' && relative.trim()) {
      params.push(`%${relative.trim()}%`);
      const placeholder = `$${params.length}`;
      clauses.push(`(relative_name_hi ILIKE ${placeholder} OR relative_name_en ILIKE ${placeholder})`);
    }
    if (typeof ward === 'string' && ward.trim()) add('ward_no ILIKE ?', `%${ward.trim()}%`);
    if (typeof house === 'string' && house.trim()) add('house_no ILIKE ?', `%${house.trim()}%`);
    if (isMigrant === 'true' || isMigrant === 'false') add('is_migrant = ?', isMigrant === 'true');
    if (typeof supportStatus === 'string' && ['core', 'swing', 'opposition', 'unmarked'].includes(supportStatus)) {
      add('support_status = ?', supportStatus);
    }
    if (typeof caste === 'string' && caste.trim()) add('caste ILIKE ?', `%${caste.trim()}%`);
    if (typeof assignedWorker === 'string' && assignedWorker.trim()) add('assigned_worker ILIKE ?', `%${assignedWorker.trim()}%`);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const page = boundedInteger(req.query.page, 1, 100000);
    const pageSize = boundedInteger(req.query.pageSize, 100, 250);
    const count = await db.query(`SELECT COUNT(*)::integer AS total FROM voters ${where}`, params);
    const result = await db.query(
      `SELECT * FROM voters ${where} ORDER BY ward_no, part_no, serial_no LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const voters = result.rows.map(formatVoter);
    res.json(req.query.page || req.query.pageSize
      ? { data: voters, page, pageSize, total: count.rows[0].total }
      : voters);
  } catch (err) {
    console.error('Voter search failed:', err.message);
    res.status(500).json({ message: 'Voter records could not be loaded.' });
  }
});

// Get family members by houseNo
router.get('/family/:houseNo', verifyToken, requireModule('voters', 'community'), async (req, res) => {
  try {
    const params = [];
    const access = addVoterAccess(req, params);
    params.push(req.params.houseNo);
    const houseParam = params.length;
    if (typeof req.query.ward === 'string' && req.query.ward.trim()) {
      params.push(req.query.ward.trim());
    } else {
      params.push('');
    }
    const wardParam = params.length;
    if (typeof req.query.part === 'string' && req.query.part.trim()) {
      params.push(req.query.part.trim());
    } else {
      params.push('');
    }
    const partParam = params.length;
    const result = await db.query(
      `SELECT * FROM voters WHERE ${access} AND house_no = $${houseParam}
        AND ($${wardParam} = '' OR ward_no = $${wardParam})
        AND ($${partParam} = '' OR part_no = $${partParam})
       ORDER BY serial_no ASC`,
      params
    );
    res.json(result.rows.map(formatVoter));
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
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid voter ID is required.' });

    const columns = {
      phone: 'phone',
      caste: 'caste',
      surety: 'surety',
      isMigrant: 'is_migrant',
      assignedWorker: 'assigned_worker',
      supportStatus: 'support_status',
      notes: 'notes',
      migrantLocation: 'migrant_location',
    };
    const updates = Object.entries(columns).filter(([key]) => Object.hasOwn(req.body, key));
    if (!updates.length) return res.status(400).json({ message: 'No supported voter fields were provided.' });
    if (updates.some(([key]) => key === 'isMigrant' ? typeof req.body[key] !== 'boolean' : typeof req.body[key] !== 'string')) {
      return res.status(400).json({ message: 'Voter fields contain invalid values.' });
    }
    if (Object.hasOwn(req.body, 'supportStatus') && !['core', 'swing', 'opposition', 'unmarked'].includes(req.body.supportStatus)) {
      return res.status(400).json({ message: 'Choose a valid support status.' });
    }

    const values = updates.map(([key]) => req.body[key]);
    const accessParams = [];
    const placeholderOffset = values.length;
    const access = addVoterAccess(req, accessParams).replace(/\$(\d+)/g, (_match, number) => `$${Number(number) + placeholderOffset}`);
    values.push(...accessParams, id);
    const set = updates.map(([, column], index) => `${column} = $${index + 1}`).join(', ');
    const idParam = values.length;
    const result = await db.query(`UPDATE voters SET ${set} WHERE ${access} AND id = $${idParam} RETURNING *`, values);
    if (!result.rowCount) return res.status(404).json({ message: 'Voter not found.' });
    res.json(formatVoter(result.rows[0]));
  } catch (err) {
    console.error('Voter update failed:', err.message);
    res.status(500).json({ message: 'Voter details could not be updated.' });
  }
});

// Toggle Vote Status
router.put('/:id/vote', verifyToken, requireModule('poll-desk', 'turnout'), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { voted } = req.body;
    if (!Number.isInteger(id) || id <= 0 || typeof voted !== 'boolean') {
      return res.status(400).json({ message: 'A valid voter ID and boolean vote status are required.' });
    }
    const params = [voted];
    const access = addVoterAccess(req, params);
    params.push(id);
    const result = await db.query(`UPDATE voters SET voted = $1 WHERE ${access} AND id = $${params.length} RETURNING id`, params);
    if (!result.rowCount) return res.status(404).json({ message: 'Voter not found.' });
    
    // Invalidate Cache for this organization
    const prefix = `voters_all_${req.user.organizationId}_`;
    const keys = cache.keys();
    keys.forEach(k => { if (k.startsWith(prefix)) cache.del(k); });
    
    res.json({ success: true, message: 'Vote status updated.' });
  } catch (err) {
    console.error('Vote status update failed:', err.message);
    res.status(500).json({ message: 'Vote status could not be updated.' });
  }
});

module.exports = router;
