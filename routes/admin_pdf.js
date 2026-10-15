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
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');

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
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
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

// GET /jobs - to fetch recent upload jobs (SuperAdmin Only)
router.get('/jobs', verifyToken, isAdmin, (req, res) => {
  const orgId = req.query.organizationId;
  
  // Deduplicate identical duplicate jobs in memory (same file, same org, within 20s)
  const seenJobKeys = new Set();
  for (const [id, job] of uploadJobs.entries()) {
    const timeBucket = Math.floor(new Date(job.uploadedAt).getTime() / 20000);
    const key = `${job.organizationId}_${job.filename}_${job.wardNo || ''}_${timeBucket}`;
    if (seenJobKeys.has(key)) {
      uploadJobs.delete(id);
    } else {
      seenJobKeys.add(key);
    }
  }

  let jobs = Array.from(uploadJobs.values());
  if (orgId) {
    jobs = jobs.filter(j => j.organizationId === orgId);
  }
  jobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  res.json(jobs);
});

// DELETE /jobs/:id - remove single job from history (SuperAdmin Only)
router.delete('/jobs/:id', verifyToken, isAdmin, (req, res) => {
  const { id } = req.params;
  if (uploadJobs.has(id)) {
    uploadJobs.delete(id);
    return res.json({ success: true, message: 'जॉब हटा दी गई।' });
  }
  res.status(404).json({ error: 'Job not found' });
});

// DELETE /jobs - clear upload jobs (SuperAdmin Only)
router.delete('/jobs', verifyToken, isAdmin, (req, res) => {
  uploadJobs.clear();
  res.json({ success: true, message: 'Upload history cleared.' });
});

// GET /download-excel/:id - Download generated Excel file for a PDF job
router.get('/download-excel/:id', verifyToken, isAdmin, (req, res) => {
  const job = uploadJobs.get(req.params.id);
  if (!job || !job.excelPath || !fs.existsSync(job.excelPath)) {
    return res.status(404).json({ error: 'Excel फाइल उपलब्ध नहीं है या अभी प्रोसेस हो रही है।' });
  }
  const downloadName = job.excelFilename || 'voter_list.xlsx';
  res.download(job.excelPath, downloadName);
});

// GET /dictionary-stats - Get real-time status of the self-learning dictionary
router.get('/dictionary-stats', verifyToken, isAdmin, async (req, res) => {
  try {
    const { getDictionaryStats } = require('../lib/dictionaryService');
    const stats = await getDictionaryStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch dictionary stats' });
  }
});

// Task 3: Admin PDF Upload & Voter ID Extraction (SuperAdmin Only) - Supports Single & Multiple PDFs
router.post('/upload', verifyToken, isAdmin, (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'फाइल का आकार 100MB से बड़ा है। कृपया 100MB से छोटी PDF फाइल अपलोड करें।' });
      }
      return res.status(400).json({ error: `फ़ाइल अपलोड त्रुटि: ${err.message}` });
    } else if (err) {
      return res.status(500).json({ error: `सर्वर अपलोड त्रुटि: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  try {
    const rawFiles = req.files && req.files.length ? req.files : (req.file ? [req.file] : []);
    const seenFiles = new Set();
    const pdfFiles = [];
    for (const f of rawFiles) {
      const isPdf = f.originalname.toLowerCase().endsWith('.pdf') || f.mimetype === 'application/pdf';
      if (isPdf) {
        const key = `${f.originalname.toLowerCase().trim()}_${f.size}`;
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          pdfFiles.push(f);
        } else {
          try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
        }
      }
    }
    if (!pdfFiles.length) {
      return res.status(400).json({ error: 'कृपया कम से कम एक वैध PDF फाइल (.pdf) चुनें।' });
    }
    
    const organizationId = req.body.organizationId || "org_default";
    const uploadedBy = (req.body.uploadedBy || "").trim();
    const useOcr = req.body.useOcr === 'true' || req.body.useOcr === 'on' || req.body.useOcr === true;
    const globalWard = (req.body.wardNo || "").trim();
    const globalBooth = (req.body.boothNo || "").trim();
    const globalDesc = (req.body.listDescription || "").trim();

    const createdJobs = [];
    const { Organization } = require('../models');
    const { Worker } = require('worker_threads');

    for (const file of pdfFiles) {
      const filePath = file.path;
      // Auto-detect ward from filename if not explicitly provided
      let wardNo = globalWard;
      if (!wardNo) {
        const wardMatch = file.originalname.match(/(?:Ward|वार्ड|ward)[\s_\-]*0*(\d+)/i);
        if (wardMatch) {
          wardNo = wardMatch[1];
        }
      }

      let boothNo = globalBooth;
      if (!boothNo) {
        const boothMatch = file.originalname.match(/(?:Booth|बूथ|Part|भाग)[\s_\-]*0*(\d+)/i);
        if (boothMatch) {
          boothNo = boothMatch[1];
        }
      }

      // Auto-register ward in Organization if new
      if (wardNo && organizationId) {
        try {
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

      const jobId = crypto.randomUUID();
      const listDescription = globalDesc || (pdfFiles.length > 1 ? file.originalname : (wardNo ? `वार्ड ${wardNo} मतदाता सूची` : ''));

      uploadJobs.set(jobId, {
        id: jobId,
        filename: file.originalname,
        organizationId: organizationId,
        wardNo: wardNo,
        boothNo: boothNo,
        uploadedBy: uploadedBy,
        listDescription: listDescription,
        status: 'processing',
        progress: 5,
        stageMessage: '📄 PDF फ़ाइल प्राप्त हुई, प्रक्रिया शुरू...',
        extractedCount: 0,
        uploadedAt: new Date().toISOString()
      });

      createdJobs.push({ jobId, filename: file.originalname, wardNo });

      // Start worker thread
      const worker = new Worker(path.join(__dirname, '../workers/pdfWorker.js'), {
        workerData: {
          filePath,
          organizationId,
          useOcr,
          wardNo,
          boothNo,
          uploadedBy
        }
      });

      worker.on('message', async (msg) => {
        if (msg.type === 'progress') {
          uploadJobs.set(jobId, { 
            ...uploadJobs.get(jobId), 
            progress: typeof msg.data === 'number' ? msg.data : (msg.progress || 0),
            stageMessage: msg.stage || uploadJobs.get(jobId)?.stageMessage || 'प्रोसेसिंग चालू है...'
          });
        } else if (msg.type === 'done') {
          const operations = msg.data;
          const epicsCount = msg.epicsCount;
          
          try {
            if (operations && operations.length > 0) {
              const CHUNK_SIZE = 2500;
              let processed = 0;
              for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
                const chunk = operations.slice(i, i + CHUNK_SIZE);
                await Voter.bulkWrite(chunk, { ordered: false });
                processed += chunk.length;
                const dbProgress = Math.floor((processed / operations.length) * 11);
                uploadJobs.set(jobId, { 
                  ...uploadJobs.get(jobId), 
                  progress: 88 + dbProgress,
                  stageMessage: `💾 सत्यापित डेटा डेटाबेस में सुरक्षित हो रहा है (${processed}/${operations.length})...`
                });
              }
            }

            // Sync any newly learned dictionary entries to MongoDB
            try {
              const { syncFromDiskToDb } = require('../lib/dictionaryService');
              await syncFromDiskToDb();
            } catch {}
            
            uploadJobs.set(jobId, {
              ...uploadJobs.get(jobId),
              status: 'completed',
              progress: 100,
              stageMessage: '✅ सत्यापन व डिक्शनरी विस्तार पूर्ण! सभी मतदाता रिकॉर्ड्स सुरक्षित हो गए हैं।',
              extractedCount: epicsCount,
              excelPath: msg.excelPath,
              excelFilename: msg.excelFilename,
              hasExcel: Boolean(msg.excelPath)
            });

            // Invalidate cache
            try {
              const cache = require('../lib/cache');
              if (cache) {
                const keys = cache.keys ? cache.keys() : [];
                keys.forEach(k => {
                  if (k.includes(organizationId)) cache.del(k);
                });
              }
            } catch {}

            console.log(`Background PDF processing complete for ${filePath}. Extracted ${epicsCount} voters. Excel: ${msg.excelFilename}`);
          } catch (dbError) {
            uploadJobs.set(jobId, { 
              ...uploadJobs.get(jobId), 
              status: 'failed', 
              progress: 0, 
              errorMessage: `डेटाबेस में सुरक्षित करने में त्रुटि: ${dbError.message}` 
            });
            console.error(`Database write failed for ${filePath}:`, dbError);
          }
        } else if (msg.type === 'error') {
          uploadJobs.set(jobId, { 
            ...uploadJobs.get(jobId), 
            status: 'failed', 
            progress: 0, 
            errorMessage: msg.data || 'PDF पार्सिंग में समस्या आई।' 
          });
          console.error(`Worker PDF processing failed for ${filePath}:`, msg.data);
        }
      });

      worker.on('error', (err) => {
        uploadJobs.set(jobId, { 
          ...uploadJobs.get(jobId), 
          status: 'failed', 
          progress: 0, 
          errorMessage: err.message || 'Worker thread execution error' 
        });
        console.error(`Worker error for ${filePath}:`, err);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && uploadJobs.get(jobId)?.status !== 'completed') {
          uploadJobs.set(jobId, { 
            ...uploadJobs.get(jobId), 
            status: 'failed', 
            progress: 0, 
            errorMessage: `Worker process exited with code ${code}` 
          });
        }
      });
    }

    res.json({
      message: `${pdfFiles.length} PDF फाइल(ें) प्राप्त हुईं और बैकग्राउंड में प्रोसेस हो रही हैं।`,
      backgroundProcessing: true,
      jobId: createdJobs[0]?.jobId,
      jobs: createdJobs,
      totalFiles: pdfFiles.length
    });

  } catch (error) {
    console.error('PDF processing error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.uploadJobs = uploadJobs;
module.exports = router;
