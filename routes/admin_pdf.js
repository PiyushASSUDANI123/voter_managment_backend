const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { Voter } = require('../../models');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Task 4: STRICT AUTOMATED CLEANUP (2-Hour Deletion)
cron.schedule('0 * * * *', () => {
  console.log('Running PDF cleanup cron job...');
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

// Task 3: Admin PDF Upload & Voter ID Extraction
router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF provided.' });
    
    const filePath = req.file.path;
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    
    // Extract Voter IDs (EPIC Numbers) using Regex
    const text = data.text;
    const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2}\/\d{2}\/\d{3}\/\d{6}/gi;
    const matches = text.match(epicRegex) || [];
    const uniqueEpics = [...new Set(matches)];

    // Save extracted Voter IDs
    const operations = uniqueEpics.map((epic, index) => {
      return {
        updateOne: {
          filter: { epic: epic.toUpperCase() },
          update: {
            $setOnInsert: {
              _id: `voter_${crypto.randomUUID()}`,
              epic: epic.toUpperCase(),
              wardNo: "1",
              partNo: "1",
              serialNo: index + 1,
              nameEn: "PDF Extracted",
              nameHi: "PDF Extracted",
              organizationId: "org_default"
            }
          },
          upsert: true
        }
      };
    });

    if (operations.length > 0) {
      await Voter.bulkWrite(operations);
    }

    res.json({ message: 'Upload successful', extractedCount: uniqueEpics.length, epics: uniqueEpics });
  } catch (error) {
    console.error('PDF processing error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
