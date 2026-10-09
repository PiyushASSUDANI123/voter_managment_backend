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
const upload = multer({ storage });

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
  if (!orgId) return res.status(400).json({ error: 'Organization ID is required' });
  
  const jobs = Array.from(uploadJobs.values())
    .filter(j => j.organizationId === orgId)
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  
  res.json(jobs);
});

// Task 3: Admin PDF Upload & Voter ID Extraction
router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF provided.' });
    
    const filePath = req.file.path;
    const organizationId = req.body.organizationId || "org_default";
    const jobId = crypto.randomUUID();

    uploadJobs.set(jobId, {
      id: jobId,
      filename: req.file.originalname,
      organizationId: organizationId,
      status: 'processing',
      progress: 0,
      extractedCount: 0,
      uploadedAt: new Date().toISOString()
    });

    // Respond immediately to avoid browser timeout for large PDFs
    res.json({ message: 'Upload started', backgroundProcessing: true, jobId });

    // Process asynchronously
    (async () => {
      try {
        const updateJobProgress = (prog) => {
          uploadJobs.set(jobId, { ...uploadJobs.get(jobId), progress: prog });
        };
        
        let text = "";
        
        if (req.body.useOcr === 'true') {
          console.log(`Using Local OCR for ${filePath}`);
          const { performLocalOCR } = require('../lib/ocrService');
          text = await performLocalOCR(filePath, updateJobProgress);
        } else {
          updateJobProgress(10); // Start parsing PDF
          const dataBuffer = fs.readFileSync(filePath);
          const data = await pdfParse(dataBuffer);
          updateJobProgress(40); // Parsing complete, starting extraction
          text = data.text;
        }
        
        const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2}\/\d{2}\/\d{3}\/\d{6}/gi;
        
        let match;
        const allEpics = [];
        while ((match = epicRegex.exec(text)) !== null) {
          allEpics.push({ epic: match[0].toUpperCase(), index: match.index });
        }
        
        const epics = [];
        const seen = new Set();
        for (const e of allEpics) {
          if (!seen.has(e.epic)) {
            seen.add(e.epic);
            epics.push(e);
          }
        }

        updateJobProgress(50); // Regex search complete, building bulk operations

        // Extract common metadata (part no, ward no) if available
        const partMatch = text.match(/(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
        const wardMatch = text.match(/(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
        const defaultPartNo = partMatch ? partMatch[1] : "1";
        const defaultWardNo = wardMatch ? wardMatch[1] : "1";

        const operations = epics.map((current, i) => {
          const startIndex = i === 0 ? 0 : epics[i-1].index + epics[i-1].epic.length;
          let block = text.substring(startIndex, current.index).trimEnd();
          
          const lines = block.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
          
          let nameHi = "PDF Extracted";
          let relativeNameHi = "";
          let relationType = "";
          let houseNo = "";
          let age = null;
          let genderVal = "अन्य";

          if (lines.length >= 5) {
            relativeNameHi = fixCorruptedHindi(lines[lines.length - 1]);
            nameHi = fixCorruptedHindi(lines[lines.length - 2]);
            houseNo = lines[lines.length - 3];
            const genderRaw = lines[lines.length - 4];
            const ageRaw = lines[lines.length - 5];
            
            age = parseInt(ageRaw) || null;
            if (genderRaw.includes("पचरष") || genderRaw.includes("प")) genderVal = "पुरुष";
            else if (genderRaw.includes("सल") || genderRaw.includes("स")) genderVal = "स्त्री";
            
            relationType = genderVal === "स्त्री" ? "पति" : "पिता";
          }

          return {
            updateOne: {
              filter: { epic: current.epic, organizationId: organizationId },
              update: {
                $set: {
                  nameHi: nameHi,
                  relativeNameHi: relativeNameHi,
                  relationType: relationType,
                  houseNo: houseNo,
                  age: age,
                  gender: genderVal
                },
                $setOnInsert: {
                  _id: `voter_${crypto.randomUUID()}`,
                  epic: current.epic,
                  wardNo: defaultWardNo,
                  partNo: defaultPartNo,
                  serialNo: i + 1,
                  nameEn: nameHi,
                  organizationId: organizationId
                }
              },
              upsert: true
            }
          };
        });

        updateJobProgress(60); // Operations built, saving to database

        if (operations.length > 0) {
          const CHUNK_SIZE = 500;
          let processed = 0;
          for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
            const chunk = operations.slice(i, i + CHUNK_SIZE);
            await Voter.bulkWrite(chunk, { ordered: false });
            processed += chunk.length;
            const dbProgress = Math.floor((processed / operations.length) * 40); // up to 40%
            updateJobProgress(60 + dbProgress);
          }
        }
        
        uploadJobs.set(jobId, {
          ...uploadJobs.get(jobId),
          status: 'completed',
          progress: 100,
          extractedCount: epics.length
        });
        console.log(`Background PDF processing complete for ${filePath}. Extracted ${epics.length} voters.`);
      } catch (bgError) {
        uploadJobs.set(jobId, {
          ...uploadJobs.get(jobId),
          status: 'failed',
          progress: 0
        });
        console.error(`Background PDF processing failed for ${filePath}:`, bgError);
      }
    })();

  } catch (error) {
    console.error('PDF processing error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
