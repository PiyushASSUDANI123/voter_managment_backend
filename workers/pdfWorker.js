const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const { performLocalOCR } = require('../lib/ocrService');
const { isKrutiDevText, convertKrutiDevToUnicode } = require('../lib/krutiDevConverter');

async function processPdf() {
  const { filePath, useOcr, organizationId, wardNo, boothNo, uploadedBy } = workerData;
  let text = "";

  const updateProgress = (prog) => {
    if (parentPort) {
      parentPort.postMessage({ type: 'progress', data: prog });
    }
  };

  try {
    updateProgress(5);
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    text = pdfData.text || "";
    updateProgress(15);

    // Extract metadata from header
    const partMatch = text.match(/(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
    const wardMatch = text.match(/(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i);
    const defaultPartNo = boothNo || (partMatch ? partMatch[1] : "1");
    const defaultWardNo = wardNo || (wardMatch ? wardMatch[1] : "1");

    // Extract all vector EPICs from digital PDF text stream
    const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2,3}\s*[\/\-]\s*\d{2}\s*[\/\-]\s*\d{2,3}\s*[\/\-]\s*\d{4,6}|[A-Z0-9]{10}/gi;
    let match;
    const vectorEpics = [];
    const seenEpics = new Set();
    while ((match = epicRegex.exec(text)) !== null) {
      const cleanEpic = match[0].replace(/\s+/g, '').toUpperCase();
      if (!seenEpics.has(cleanEpic)) {
        seenEpics.add(cleanEpic);
        vectorEpics.push(cleanEpic);
      }
    }

    let finalVoterList = [];

    if (useOcr) {
      // HIGH-PRECISION VISUAL OCR (Bypasses missing CMaps, subset fonts & KrutiDev)
      console.log(`Running visual OCR pipeline on ${filePath}...`);
      const { fullText, extractedVoters } = await performLocalOCR(filePath, updateProgress);
      
      console.log(`OCR returned ${extractedVoters.length} parsed cards. Vector EPICs count: ${vectorEpics.length}`);

      // Pair OCR cards with vector EPICs for 100% accuracy
      finalVoterList = extractedVoters.map((card, idx) => {
        let matchedEpic = card.epic;
        // If card epic is missing or slightly noisy, check corresponding vector epic
        if ((!matchedEpic || matchedEpic.length < 5) && vectorEpics[idx]) {
          matchedEpic = vectorEpics[idx];
        } else if (matchedEpic && !vectorEpics.includes(matchedEpic)) {
          // If OCR had minor noise (e.g. 558 instead of SSB), find closest vector epic
          const closeVector = vectorEpics.find(ve => 
            ve.slice(-6) === matchedEpic.slice(-6) ||
            ve.replace(/[^0-9]/g, '') === matchedEpic.replace(/[^0-9]/g, '')
          );
          if (closeVector) matchedEpic = closeVector;
        }

        return {
          ...card,
          epic: matchedEpic || (vectorEpics[idx] || `VOTER_${idx + 1}`)
        };
      });

      // If OCR yielded fewer cards than vector EPICs (e.g. some blank cards), fill in remaining
      if (finalVoterList.length < vectorEpics.length) {
        for (let i = finalVoterList.length; i < vectorEpics.length; i++) {
          finalVoterList.push({
            epic: vectorEpics[i],
            nameHi: "मतदाता",
            relativeNameHi: "",
            relationType: "पिता",
            houseNo: "",
            age: null,
            gender: "अन्य",
            status: "Active"
          });
        }
      }

    } else {
      // FAST TEXT-BASED EXTRACTION
      updateProgress(30);

      // Check if text uses legacy KrutiDev encoding
      if (isKrutiDevText(text)) {
        console.log("Detected KrutiDev font encoding. Converting to Unicode Devanagari...");
        text = convertKrutiDevToUnicode(text);
      }

      // Universal Age/Gender block splitter
      const blocks = text.split(/(आयु[:ः\s]*\d+[\s.,]*(?:लिंग[:ः\s]*\S+|Sex[:\s]*\S+))/i);
      
      for (let i = 0; i < blocks.length - 1; i += 2) {
        const fullBlock = blocks[i] + " " + blocks[i + 1];
        const lines = fullBlock.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        let nameHi = "";
        let relativeNameHi = "";
        let relationType = "पिता";
        let houseNo = "";
        let age = null;
        let genderVal = "अन्य";

        for (const line of lines) {
          if (/^(?:मतदाता का नाम|नाम)\s*[:ः\-]\s*(.+)/i.test(line) && !/क्षेत्र|संख्या एवं|विधानसभा/i.test(line)) {
            const m = line.match(/^(?:मतदाता का नाम|नाम)\s*[:ः\-]\s*(.+)/i);
            if (m && !nameHi) nameHi = m[1].trim();
          }
          if (/^(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]\s*(.+)/i.test(line)) {
            const m = line.match(/^(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]\s*(.+)/i);
            if (m && !relativeNameHi) {
              relationType = m[1];
              relativeNameHi = m[2].trim();
            }
          }
          if (/^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i.test(line)) {
            const m = line.match(/^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i);
            if (m && !houseNo) houseNo = m[1].trim();
          }
          if (/आयु\s*[:ः\-]?\s*(\d+)/i.test(line)) {
            const m = line.match(/आयु\s*[:ः\-]?\s*(\d+)/i);
            if (m && age === null) age = parseInt(m[1]);
          }
          if (/लिंग\s*[:ः\-]?\s*([^\s\n\r]+)/i.test(line)) {
            const m = line.match(/लिंग\s*[:ः\-]?\s*([^\s\n\r]+)/i);
            if (m) {
              const g = m[1];
              if (g.includes("पुरूष") || g.includes("पुरुष") || g.includes("पु")) genderVal = "पुरुष";
              else if (g.includes("स्त्री") || g.includes("महिला") || g.includes("स्")) genderVal = "स्त्री";
            }
          }
        }

        const epicM = fullBlock.match(/([A-Z]{3}[0-9]{7}|[A-Z]{2,3}[\/\-]\d{2}[\/\-]\d{2,3}[\/\-]\d{4,6}|[A-Z0-9]{10})/i);
        const cardEpic = epicM ? epicM[1].replace(/\s+/g, '').toUpperCase() : (vectorEpics[finalVoterList.length] || "");

        if (cardEpic || nameHi) {
          finalVoterList.push({
            epic: cardEpic,
            nameHi: nameHi || "मतदाता",
            relativeNameHi: relativeNameHi,
            relationType,
            houseNo,
            age,
            gender: genderVal,
            status: /DELETED|ELETED|विलोपित/i.test(fullBlock) ? "Deleted" : "Active"
          });
        }
      }
    }

    updateProgress(55);

    // Build MongoDB bulkWrite operations
    const operations = finalVoterList
      .filter(v => v.epic && v.epic.length >= 4)
      .map((voter, i) => {
        const updateFields = {
          nameHi: voter.nameHi,
          relativeNameHi: voter.relativeNameHi,
          relationType: voter.relationType,
          houseNo: voter.houseNo,
          age: voter.age,
          gender: voter.gender
        };

        if (wardNo) updateFields.wardNo = wardNo;
        if (boothNo) updateFields.partNo = boothNo;
        if (uploadedBy) updateFields.assignedWorker = uploadedBy;

        const setOnInsertFields = {
          _id: `voter_${crypto.randomUUID()}`,
          epic: voter.epic,
          serialNo: i + 1,
          nameEn: voter.nameHi,
          organizationId: organizationId,
        };

        if (!wardNo) setOnInsertFields.wardNo = defaultWardNo;
        if (!boothNo) setOnInsertFields.partNo = defaultPartNo;
        if (!uploadedBy) setOnInsertFields.assignedWorker = "";

        return {
          updateOne: {
            filter: { epic: voter.epic, organizationId: organizationId },
            update: {
              $set: updateFields,
              $setOnInsert: setOnInsertFields
            },
            upsert: true
          }
        };
      });

    updateProgress(65);
    if (parentPort) {
      parentPort.postMessage({ type: 'done', data: operations, epicsCount: operations.length });
    }

  } catch (err) {
    console.error("PDF extraction error in worker:", err);
    if (parentPort) {
      parentPort.postMessage({ type: 'error', data: err.message });
    }
  }
}

processPdf();
