const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const { fixCorruptedHindi } = require('../lib/hindiDictionary');
const { performLocalOCR } = require('../lib/ocrService');

async function processPdf() {
  const { filePath, useOcr, organizationId, wardNo, boothNo, uploadedBy } = workerData;
  let text = "";

  const updateProgress = (prog) => {
    parentPort.postMessage({ type: 'progress', data: prog });
  };

  try {
    if (useOcr) {
      text = await performLocalOCR(filePath, updateProgress);
    } else {
      updateProgress(10);
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      updateProgress(40);
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

    updateProgress(50);

    const partMatch = text.match(/(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
    const wardMatch = text.match(/(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
    const defaultPartNo = boothNo || (partMatch ? partMatch[1] : "1");
    const defaultWardNo = wardNo || (wardMatch ? wardMatch[1] : "1");

    const operations = epics.map((current, i) => {
      const startIndex = i === 0 ? 0 : epics[i - 1].index + epics[i - 1].epic.length;
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

      const updateFields = {
        nameHi: nameHi,
        relativeNameHi: relativeNameHi,
        relationType: relationType,
        houseNo: houseNo,
        age: age,
        gender: genderVal
      };

      if (wardNo) updateFields.wardNo = wardNo;
      if (boothNo) updateFields.partNo = boothNo;
      if (uploadedBy) updateFields.assignedWorker = uploadedBy;

      const setOnInsertFields = {
        _id: `voter_${crypto.randomUUID()}`,
        epic: current.epic,
        serialNo: i + 1,
        nameEn: nameHi,
        organizationId: organizationId,
      };

      if (!wardNo) setOnInsertFields.wardNo = defaultWardNo;
      if (!boothNo) setOnInsertFields.partNo = defaultPartNo;
      if (!uploadedBy) setOnInsertFields.assignedWorker = "";

      return {
        updateOne: {
          filter: { epic: current.epic, organizationId: organizationId },
          update: {
            $set: updateFields,
            $setOnInsert: setOnInsertFields
          },
          upsert: true
        }
      };
    });

    updateProgress(60);
    parentPort.postMessage({ type: 'done', data: operations, epicsCount: epics.length });

  } catch (err) {
    parentPort.postMessage({ type: 'error', data: err.message });
  }
}

processPdf();
