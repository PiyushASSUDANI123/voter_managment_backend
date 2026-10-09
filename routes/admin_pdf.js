const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { Voter } = require('../models');
const { fixCorruptedHindi } = require('../lib/hindiDictionary');

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

const uploadJobs = new Map();

// Task 4: STRICT AUTOMATED CLEANUP (2-Hour Deletion)
cron.schedule('0 * * * *', () => {
  console.log('Running PDF cleanup cron job...');
  
  // Cleanup uploadJobs map (older than 2 hours)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const [id, job] of uploadJobs.entries()) {
    if (new Date(job.uploadedAt) < twoHoursAgo) {
      uploadJobs.delete(id);
    }
  }

  fs.readdir(uploadDir, (err, files) => {
    if (err) return console.error('Cleanup error:', err);
    files.forEach(file => {
      if (file.endsWith('.pdf')) {
        const filePath = path.join(uploadDir, file);
        fs.stat(filePath, (err, stats) => {
          if (!err) {
            const now = new Date().getTime();
            // Exactly 2 hours TTL
            const endTime = new Date(stats.birthtime).getTime() + (2 * 60 * 60 * 1000);
            if (now > endTime) {
              fs.unlink(filePath, err => {
                if (!err) console.log(`Deleted expired PDF: ${file}`);
              });
            }
          }
        });
      }
    });
  });
});

// GET /jobs - to fetch recent upload jobs
router.get('/jobs', (req, res) => {
  const orgId = req.query.organizationId;
  let jobs = Array.from(uploadJobs.values());
  if (orgId) {
    jobs = jobs.filter(j => j.organizationId === orgId);
  }
  jobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  res.json(jobs);
});

// Task 3: Admin PDF Upload & Voter ID Extraction
router.post('/upload', (req, res, next) => {
  upload.single('pdf')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'फाइल का आकार 50MB से बड़ा है। कृपया 50MB से छोटी PDF फाइल अपलोड करें।' });
      }
      return res.status(400).json({ error: `फ़ाइल अपलोड त्रुटि: ${err.message}` });
    } else if (err) {
      return res.status(500).json({ error: `सर्वर अपलोड त्रुटि: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'कृपया एक वैध PDF फाइल अपलोड करें।' });
    
    const filePath = req.file.path;
    const organizationId = req.body.organizationId || "org_default";
    const wardNo = (req.body.wardNo || "").trim();
    const boothNo = (req.body.boothNo || "").trim();
    const uploadedBy = (req.body.uploadedBy || "").trim();
    const listDescription = (req.body.listDescription || "").trim();
    const jobId = crypto.randomUUID();

    // Auto-register ward in Organization if new
    if (wardNo && organizationId) {
      try {
        const { Organization } = require('../models');
        if (Organization) {
          await Organization.updateOne(
            { _id: organizationId },
            { $addToSet: { wards: wardNo } }
          );
        }
      } catch (orgErr) {
        console.warn('Could not update organization wards:', orgErr.message);
      }
    }

    uploadJobs.set(jobId, {
      id: jobId,
      filename: req.file.originalname,
      organizationId: organizationId,
      wardNo: wardNo,
      boothNo: boothNo,
      uploadedBy: uploadedBy,
      listDescription: listDescription,
      status: 'processing',
      progress: 0,
      extractedCount: 0,
      uploadedAt: new Date().toISOString()
    });

    // Respond immediately to avoid browser timeout for large PDFs
    res.json({ message: 'Upload started', backgroundProcessing: true, jobId });

    // Process using Worker Thread to avoid blocking the main event loop
    const { Worker } = require('worker_threads');
    const worker = new Worker(path.join(__dirname, '../workers/pdfWorker.js'), {
      workerData: {
        filePath,
        organizationId,
        useOcr: req.body.useOcr === 'true',
        wardNo,
        boothNo,
        uploadedBy
      }
    });

    worker.on('message', async (msg) => {
      if (msg.type === 'progress') {
        uploadJobs.set(jobId, { ...uploadJobs.get(jobId), progress: msg.data });
      } else if (msg.type === 'done') {
        const operations = msg.data;
        const epicsCount = msg.epicsCount;
        
        try {
          if (operations.length > 0) {
            const CHUNK_SIZE = 500;
            let processed = 0;
            for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
              const chunk = operations.slice(i, i + CHUNK_SIZE);
              await Voter.bulkWrite(chunk, { ordered: false });
              processed += chunk.length;
              const dbProgress = Math.floor((processed / operations.length) * 40);
              uploadJobs.set(jobId, { ...uploadJobs.get(jobId), progress: 60 + dbProgress });
            }
          }
          
          uploadJobs.set(jobId, {
            ...uploadJobs.get(jobId),
            status: 'completed',
            progress: 100,
            extractedCount: epicsCount
          });
          console.log(`Background PDF processing complete for ${filePath}. Extracted ${epicsCount} voters.`);
        } catch (dbError) {
          uploadJobs.set(jobId, { ...uploadJobs.get(jobId), status: 'failed', progress: 0 });
          console.error(`Database write failed for ${filePath}:`, dbError);
        }
      } else if (msg.type === 'error') {
        uploadJobs.set(jobId, { ...uploadJobs.get(jobId), status: 'failed', progress: 0 });
        console.error(`Worker PDF processing failed for ${filePath}:`, msg.data);
      }
    });

    worker.on('error', (err) => {
      uploadJobs.set(jobId, { ...uploadJobs.get(jobId), status: 'failed', progress: 0 });
      console.error(`Worker error for ${filePath}:`, err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Worker stopped with exit code ${code}`);
      }
    });

  } catch (error) {
    console.error('PDF processing error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.uploadJobs = uploadJobs;
module.exports = router;
