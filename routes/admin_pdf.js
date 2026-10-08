const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { Voter } = require('../models');

const uploadDir = path.join(__dirname, '../uploads');
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
    
    const organizationId = req.body.organizationId || "org_default";

    // Extract Voter IDs (EPIC Numbers) using Regex
    const text = data.text;
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

    // Extract common metadata (part no, ward no) if available
    const partMatch = text.match(/(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
    const wardMatch = text.match(/(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
    const defaultPartNo = partMatch ? partMatch[1] : "1";
    const defaultWardNo = wardMatch ? wardMatch[1] : "1";

    const operations = epics.map((current, i) => {
      // Voter block is typically the text before the EPIC, up to the previous EPIC
      const startIndex = i === 0 ? 0 : epics[i-1].index + epics[i-1].epic.length;
      const block = text.substring(startIndex, current.index);
      
      const nameMatch = block.match(/(?:निर्वाचक का नाम|नाम|Name)\s*[:\-]?\s*([^\n\r]+)/i);
      const fatherMatch = block.match(/(?:पिता|पति|माता|अन्य)\s*का\s*नाम\s*[:\-]?\s*([^\n\r]+)/i);
      const relationTypeMatch = block.match(/(पिता|पति|माता|अन्य)/);
      const houseMatch = block.match(/(?:मकान\s*संख्या|House\s*No)\s*[:\-]?\s*([^\n\r]+)/i);
      const ageMatch = block.match(/(?:आयु|Age)\s*[:\-]?\s*(\d+)/i);
      const genderMatch = block.match(/(?:लिंग|Gender)\s*[:\-]?\s*(पुरुष|महिला|स्त्री|अन्य|Male|Female)/i);
      
      let genderVal = "";
      if (genderMatch) {
        const g = genderMatch[1].trim().toLowerCase();
        genderVal = (g === 'male' || g === 'पुरुष') ? 'पुरुष' : (g === 'female' || g === 'महिला' || g === 'स्त्री') ? 'स्त्री' : 'अन्य';
      }

      return {
        updateOne: {
          filter: { epic: current.epic, organizationId: organizationId },
          update: {
            $set: {
              nameHi: nameMatch ? nameMatch[1].trim() : "PDF Extracted",
              relativeNameHi: fatherMatch ? fatherMatch[1].trim() : "",
              relationType: relationTypeMatch ? relationTypeMatch[1].trim() : "",
              houseNo: houseMatch ? houseMatch[1].trim() : "",
              age: ageMatch ? parseInt(ageMatch[1], 10) : null,
              gender: genderVal
            },
            $setOnInsert: {
              _id: `voter_${crypto.randomUUID()}`,
              epic: current.epic,
              wardNo: defaultWardNo,
              partNo: defaultPartNo,
              serialNo: i + 1,
              nameEn: nameMatch ? nameMatch[1].trim() : "PDF Extracted",
              organizationId: organizationId
            }
          },
          upsert: true
        }
      };
    });

    if (operations.length > 0) {
      await Voter.bulkWrite(operations, { ordered: false });
    }

    res.json({ message: 'Upload successful', extractedCount: epics.length });
  } catch (error) {
    console.error('PDF processing error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
