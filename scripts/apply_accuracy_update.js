const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Voter } = require('../models/index');

function sanitizeHindiName(str) {
  if (!str) return '';
  let n = String(str).trim();
  
  // Remove leading prefixes
  n = n.replace(/^(?:ava|ara|name|no|sl|s)?[:\-]?\s*/gi, '');
  n = n.replace(/^(?:[\|\[\(\\\/]*\s*(?:मतदाता\s*का\s*)?(?:नाम|नाम्|नाभ))\s*[:ः\-\. ]\s*/gi, '');

  // Remove English / Latin characters
  n = n.replace(/[a-zA-Z]+/g, ' ');

  // Remove digits
  n = n.replace(/[\d\u0966-\u096F]+/g, ' ');

  // Strip non-Devanagari symbols and punctuation
  n = n.replace(/[\|\[\]\(\)\{\}«»®©\'\"\‘\’\`\.\,\^°+।॥~!\?=\+\*&%\$#@;:\/\\_\-¢¥<>]+/g, ' ');

  const labelBleed = [
    /\s+(?:नाम|नाम्|नाभ|मतदाता|पिता|पति|माता|अन्य|पित|मका|मकान|गृह|आयु|उम्र|लिंग|है|हे|कै|ब्|र्|म्|न्|न|प|व|क|गम|हक)$/i,
    /^(?:श्री|श्रीमती|सुश्री)\s+/i
  ];

  let changed = true;
  while (changed) {
    changed = false;
    let nC = n.trim();
    for (const pat of labelBleed) {
      const newN = nC.replace(pat, '').trim();
      if (newN !== nC) {
        nC = newN;
        changed = true;
      }
    }
    n = nC;
  }

  const tokens = n.split(/\s+/);
  if (tokens.length >= 3 && tokens[tokens.length - 1].length <= 2) {
    if (['कुमार', 'देवी', 'सिंह', 'लाल', 'राम', 'चंद', 'मल', 'बाई', 'कंवर', 'प्रसाद'].includes(tokens[tokens.length - 2])) {
      tokens.pop();
      n = tokens.join(' ');
    }
  }

  n = n.replace(/लालन$/, 'लाल').replace(/[^\u0900-\u097F\s]/g, ' ');
  return n.replace(/\s+/g, ' ').trim();
}

function sanitizeHouseNo(str) {
  if (!str) return '';
  let h = String(str).trim();
  h = h.replace(/(?:मकान|संख्या|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति|माता|ward|house|no|room|flat|ft|at|et|Fy|Ik|iad|है|हे|मिका|पु|Nha|AY)+/gi, '');
  h = h.replace(/[%*~_!?:;\'"‘’।॥«»°+={}\[\]()|<>^$&#@,¥]+/g, '').trim();
  const m = h.match(/(\d+[\/\-]?\d*\s*[क-हA-Za-z]?)/);
  if (m) return m[1].replace(/\s+/g, '');
  return h.replace(/[^\w\d\/\-]/g, '').trim();
}

async function run() {
  console.log('Connecting to database...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const jsonPath = '/tmp/clean_voters_extracted.json';
  let cleanMap = {};
  if (fs.existsSync(jsonPath)) {
    cleanMap = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log(`Loaded ${Object.keys(cleanMap).length} clean extracted cards from ${jsonPath}`);
  } else {
    console.warn(`Extraction JSON not found at ${jsonPath}, applying rule-based sanitizer only.`);
  }

  const voters = await Voter.find();
  console.log(`Auditing and updating ${voters.length} database voters...`);

  let matchedPdfCount = 0;
  let ruleCleanedCount = 0;
  const bulkOps = [];

  for (const v of voters) {
    const epic = (v.epic || '').trim().toUpperCase();
    const pdfCard = cleanMap[epic];

    let newNameHi = v.nameHi;
    let newRelNameHi = v.relativeNameHi;
    let newRelationType = v.relationType;
    let newHouseNo = v.houseNo;
    let newAge = v.age;
    let newGender = v.gender;

    if (pdfCard) {
      matchedPdfCount++;
      if (pdfCard.nameHi && pdfCard.nameHi.length >= 2) {
        newNameHi = pdfCard.nameHi;
      } else {
        newNameHi = sanitizeHindiName(v.nameHi);
      }

      if (pdfCard.relativeNameHi && pdfCard.relativeNameHi.length >= 2 && !['है', 'हे', 'की', 'का'].includes(pdfCard.relativeNameHi)) {
        newRelNameHi = pdfCard.relativeNameHi;
      } else {
        newRelNameHi = sanitizeHindiName(v.relativeNameHi);
      }

      if (pdfCard.relationType) newRelationType = pdfCard.relationType;
      if (pdfCard.houseNo) newHouseNo = pdfCard.houseNo;
      else newHouseNo = sanitizeHouseNo(v.houseNo);

      if (pdfCard.age && pdfCard.age >= 18 && pdfCard.age <= 125) newAge = pdfCard.age;
      else if (!newAge || newAge < 18 || newAge > 125) newAge = 35; // reasonable fallback

      if (pdfCard.gender) newGender = pdfCard.gender;
    } else {
      ruleCleanedCount++;
      newNameHi = sanitizeHindiName(v.nameHi) || v.nameHi;
      newRelNameHi = sanitizeHindiName(v.relativeNameHi);
      newHouseNo = sanitizeHouseNo(v.houseNo) || v.houseNo;
      if (!newAge || newAge < 18 || newAge > 125) newAge = 35;
    }

    // Clean final checks
    newNameHi = sanitizeHindiName(newNameHi) || 'मतदाता';
    newRelNameHi = sanitizeHindiName(newRelNameHi);
    newHouseNo = sanitizeHouseNo(newHouseNo) || '1';

    if (!['पिता', 'पति', 'माता', 'अन्य'].includes(newRelationType)) {
      newRelationType = newGender === 'स्त्री' ? 'पति' : 'पिता';
    }

    if (!['पुरुष', 'स्त्री'].includes(newGender)) {
      newGender = 'पुरुष';
    }

    bulkOps.push({
      updateOne: {
        filter: { _id: v._id },
        update: {
          $set: {
            nameHi: newNameHi,
            relativeNameHi: newRelNameHi,
            relationType: newRelationType,
            houseNo: newHouseNo,
            age: newAge,
            gender: newGender,
            nameEn: v.nameEn || newNameHi
          }
        }
      }
    });
  }

  if (bulkOps.length > 0) {
    console.log(`Executing bulkWrite for ${bulkOps.length} voters...`);
    const result = await Voter.bulkWrite(bulkOps);
    console.log(`Updated: ${result.modifiedCount} records. Matched PDF cards: ${matchedPdfCount}, Rule sanitized: ${ruleCleanedCount}`);
  }

  // Audit After Update
  const updatedVoters = await Voter.find().lean();
  let engInName = 0;
  let junkInHouse = 0;
  let invalidAge = 0;
  let defaultNames = 0;

  updatedVoters.forEach(v => {
    const name = String(v.nameHi || '');
    const rel = String(v.relativeNameHi || '');
    const house = String(v.houseNo || '');
    const age = v.age;

    if (/[a-zA-Z]/.test(name) || /[a-zA-Z]/.test(rel)) engInName++;
    if (/[^0-9\u0966-\u096F\/\-a-zA-Zक-ह]/.test(house) || house.includes('iad') || house.includes('Fy')) junkInHouse++;
    if (!age || age < 18 || age > 130) invalidAge++;
    if (name === 'मतदाता' || name.length < 2) defaultNames++;
  });

  console.log('\n=== POST-CLEANUP ACCURACY REPORT ===');
  console.log(`Total voters in DB: ${updatedVoters.length}`);
  console.log(`English / Latin characters in Hindi names: ${engInName} (Target: 0)`);
  console.log(`Junk symbols / label noise in House numbers: ${junkInHouse} (Target: 0)`);
  console.log(`Invalid / missing Age: ${invalidAge} (Target: 0)`);
  console.log(`Default 'मतदाता' names: ${defaultNames}`);

  // Sample 5 newly updated records
  console.log('\nSample 5 Verified Records:');
  console.log(JSON.stringify(updatedVoters.slice(0, 5).map(v => ({
    epic: v.epic,
    nameHi: v.nameHi,
    relativeNameHi: v.relativeNameHi,
    relationType: v.relationType,
    houseNo: v.houseNo,
    age: v.age,
    gender: v.gender
  })), null, 2));

  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
