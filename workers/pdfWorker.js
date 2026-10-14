const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const { performLocalOCR, cleanHindiText, cleanHouseNo } = require('../lib/ocrService');
const { isKrutiDevText, convertKrutiDevToUnicode, autoConvertText, isPUAText } = require('../lib/krutiDevConverter');
const { needsAiRepair, repairVoterCardJs } = require('../lib/openrouterFallback');
const { repairVoterCardGroq, reverifyVotersListGroq } = require('../lib/groqFallback');

function levenshtein(s1, s2) {
  if (s1.length < s2.length) return levenshtein(s2, s1);
  if (s2.length === 0) return s1.length;
  let prev = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 0; i < s1.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < s2.length; j++) {
      const ins = prev[j + 1] + 1;
      const del = curr[j] + 1;
      const sub = prev[j] + (s1[i] === s2[j] ? 0 : 1);
      curr.push(Math.min(ins, del, sub));
    }
    prev = curr;
  }
  return prev[s2.length];
}

function stripNameFromRelative(voterName, relName) {
  if (!voterName || !relName) return relName || '';
  let vn = String(voterName).trim();
  let rn = String(relName).trim();
  if (!rn || !vn) return rn;

  if (rn.startsWith(vn)) {
    rn = rn.slice(vn.length).trim();
  }

  const vnTokens = vn.split(/\s+/).filter(Boolean);
  for (const tok of vnTokens) {
    if (tok.length >= 2 && rn.startsWith(tok)) {
      rn = rn.slice(tok.length).trim();
    }
  }

  const rnTokens = rn.split(/\s+/).filter(Boolean);
  if (rnTokens.length > 1 && vnTokens.length > 0) {
    const firstR = rnTokens[0];
    const firstV = vnTokens[0];
    if (firstR.length >= 2) {
      if (firstR.includes(firstV) || firstV.includes(firstR) || levenshtein(firstR, firstV) <= 2) {
        rn = rnTokens.slice(1).join(' ').trim();
      }
    }
  }

  return rn;
}

async function processPdf() {
  const { filePath, useOcr, organizationId, wardNo, boothNo, uploadedBy } = workerData;
  let text = "";

  const updateProgress = (prog, stageMsg = 'प्रोसेसिंग जारी है...') => {
    if (parentPort) {
      parentPort.postMessage({ type: 'progress', data: prog, stage: stageMsg });
    }
  };

  try {
    updateProgress(5, '📄 PDF फ़ाइल लोड और सत्यापन प्रारंभ...');
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    text = pdfData.text || "";
    updateProgress(15, '🔍 हेडर और फॉन्ट संरचना का विश्लेषण...');

const { runPythonPdfToExcel, isPythonAvailable } = require('../lib/pythonBridge');
const ExcelJS = require('exceljs');

    // Extract metadata from header, SEC encoded text, or filename
    const partMatch = text.match(/(?:भाग|Part|भरग)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i) ||
                      text.match(/(?:मतदरन\s*बबस|मतदान\s*केंद्र|मतदान\s*स्थल).*?(\d+)\s*[-–]/s);
    const wardMatch = text.match(/(?:वार्ड|Ward|रररर|ररडर)\s*(?:संख्या|No|क्रं|No\.|कमरपक|कमररक)?\s*[:\-]?\s*(\d+)/i) ||
                      filePath.match(/Ward\s*(?:No)?[_\-\s]*0*(\d+)/i);
    const defaultPartNo = boothNo || (partMatch ? partMatch[1] : "1");
    const defaultWardNo = wardNo || (wardMatch ? wardMatch[1] : "1");

    // Extract all vector EPICs from digital PDF text stream (strictly requires numbers)
    const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7}/gi;
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
    let usedPythonEngine = false;
    let targetExcelPath = null;
    let excelFilename = null;

    // 1. High-Performance Native Python Engine (if available)
    const pythonOk = await isPythonAvailable();
    console.log(`[pdfWorker] Python availability check: ${pythonOk}`);
    if (pythonOk) {
      console.log(`[pdfWorker] Using native multi-threaded Python engine for PDF extraction: ${filePath}`);
      updateProgress(20, '⚙️ पायथन 7-पिलर इंजन द्वारा PDF से उच्च-सटीक Excel तालिका जनरेट की जा रही है...');
      const path = require('path');
      excelFilename = `${path.basename(filePath, path.extname(filePath))}_converted.xlsx`;
      const excelDir = path.join(__dirname, '../uploads/excels');
      if (!fs.existsSync(excelDir)) fs.mkdirSync(excelDir, { recursive: true });
      targetExcelPath = path.join(excelDir, excelFilename);

      try {
        const pyResult = await runPythonPdfToExcel(filePath, targetExcelPath, wardNo || defaultWardNo, boothNo || defaultPartNo);
        console.log(`[pdfWorker] Python engine finished successfully:`, pyResult);
        updateProgress(65, '📊 जनरेट की गई Excel तालिका से सत्यापित मतदाता डेटा लोड हो रहा है...');
        
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(targetExcelPath);
        const worksheet = workbook.getWorksheet('Voters') || workbook.getWorksheet('मतदाता सूची') || workbook.worksheets[0];
        
        // Dynamically map column headers for robust universal parsing (supports Sheet 1 'Voters' & Sheet 2 'मतदाता सूची')
        const headerRow = worksheet.getRow(1);
        const colMap = {};
        const isHi = (str) => str.includes('hindi') || str.includes('hin') || str.includes('हिंदी') || str.includes('हिन्दी');
        const isEn = (str) => str.includes('english') || str.includes('eng') || str.includes('(en)') || str.endsWith('en');

        headerRow.eachCell((cell, colNumber) => {
          const rawVal = String(cell.value || '').trim();
          const h = rawVal.toLowerCase().replace(/[\s\-_()\/.,]/g, '');
          if (!h) return;

          if (/^(क्रमांक|serial|srno|sno|serialno|अनुक्रमांक|slno)$/i.test(h) || h.startsWith('serial') || h.startsWith('क्रमांक')) {
            if (!colMap.serialNo) colMap.serialNo = colNumber;
          } else if (/^(पहचान|पहचानपत्र|epic|epicno|voterid|पहचानपत्रepicno)$/i.test(h) || h.includes('epic') || h.startsWith('पहचान')) {
            if (!colMap.epic) colMap.epic = colNumber;
          } else if (h.includes('नाम') || h.includes('name')) {
            if (h.includes('संबंधी') || h.includes('पिता') || h.includes('पति') || h.includes('relative') || h.includes('father') || h.includes('husband')) {
              if (isEn(h)) colMap.relativeNameEn = colNumber;
              else colMap.relativeNameHi = colNumber;
            } else if (isEn(h)) {
              colMap.nameEn = colNumber;
            } else {
              colMap.nameHi = colNumber;
            }
          } else if (/^(संबंध|सम्बन्ध|संबंधप्रकार|relation|relationtype|रिश्ता)$/i.test(h) || h.startsWith('संबंध') || h.startsWith('relation')) {
            colMap.relationType = colNumber;
          } else if (/^(मकान|मकानसंख्या|गृहसंख्या|houseno|house|मकाननं)$/i.test(h) || h.startsWith('house') || h.startsWith('मकान')) {
            if (isHi(h)) colMap.houseNoHi = colNumber;
            else if (!colMap.houseNo) colMap.houseNo = colNumber;
          } else if (/^(आयु|age|उम्र|voterage)$/i.test(h)) {
            colMap.age = colNumber;
          } else if (/^(लिंग|gender|sex|जेंडर)$/i.test(h)) {
            colMap.gender = colNumber;
          } else if (/^(स्थिति|status)$/i.test(h)) {
            colMap.status = colNumber;
          } else if (/^(वार्ड|ward|wardno|वार्डसंख्या)$/i.test(h) || h.startsWith('ward') || h.startsWith('वार्ड')) {
            colMap.wardNo = colNumber;
          } else if (/^(बूथ|भाग|part|booth|partno|boothno|भागसंख्या|बूथसंख्या)$/i.test(h) || h.startsWith('part') || h.startsWith('booth') || h.includes('भागसंख्या')) {
            colMap.partNo = colNumber;
          } else if (/^(गाँव|गांव|village|villagename|ग्राम|मोहल्ला)$/i.test(h) || h.startsWith('village') || h.startsWith('गांव') || h.startsWith('गाँव')) {
            if (isHi(h)) colMap.villageNameHi = colNumber;
            else if (!colMap.villageName) colMap.villageName = colNumber;
          }
        });

        const cellVal = (row, key, fallbackIdx) => {
          const idx = colMap[key] || fallbackIdx;
          if (!idx) return '';
          const cell = row.getCell(idx);
          if (cell && cell.value !== undefined && cell.value !== null) {
            if (typeof cell.value === 'object' && cell.value.result !== undefined) return String(cell.value.result).trim();
            if (typeof cell.value === 'object' && cell.value.text !== undefined) return String(cell.value.text).trim();
            return String(cell.value).trim();
          }
          return '';
        };
        
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return; // header
          const rawSerial = cellVal(row, 'serialNo', 4);
          const serialVal = rawSerial ? parseInt(rawSerial, 10) : null;
          const epic = cellVal(row, 'epic', 1);
          const rawName = cellVal(row, 'nameHi', 6);
          const cleanName = cleanHindiText(rawName);

          // STRICT VALIDATION: Require authentic voter name
          if (cleanName && cleanName !== 'मतदाता' && cleanName.length >= 2) {
            const rawNameEn = cellVal(row, 'nameEn', 5);
            const rawRel = cellVal(row, 'relativeNameHi', 11);
            let cleanRel = cleanHindiText(rawRel);
            cleanRel = stripNameFromRelative(cleanName, cleanRel);
            const rawRelEn = cellVal(row, 'relativeNameEn', 10);
            const cleanH = cleanHouseNo(cellVal(row, 'houseNo', 12));
            
            const rawAge = cellVal(row, 'age', 7);
            let ageVal = rawAge ? parseInt(rawAge, 10) : null;
            if (!ageVal || ageVal < 18 || ageVal > 125) ageVal = null;
            
            let relType = cellVal(row, 'relationType', 9);
            if (!['पिता', 'पति', 'माता', 'अन्य'].includes(relType)) {
              relType = 'पिता';
            }
            
            let genderVal = cellVal(row, 'gender', 8);
            if (relType === 'पति') {
              genderVal = 'स्त्री';
            } else if (['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती'].some(fem => cleanName.includes(fem))) {
              genderVal = 'स्त्री';
            } else if (!['पुरुष', 'स्त्री'].includes(genderVal)) {
              genderVal = 'पुरुष';
            }

            const villageEn = cellVal(row, 'villageName', 17);
            const villageHi = cellVal(row, 'villageNameHi', 18);
            const statusVal = cellVal(row, 'status') || 'Active';
            const rowWard = cellVal(row, 'wardNo', 2) || wardNo || defaultWardNo || '1';
            const rowBooth = cellVal(row, 'partNo', 3) || boothNo || defaultPartNo || '1';

            finalVoterList.push({
              serialNo: serialVal || (finalVoterList.length + 1),
              epic: (epic && !epic.startsWith('VOTER_')) ? epic : (epic || `VOTER_${finalVoterList.length + 1}`),
              nameHi: cleanName || rawName,
              nameEn: rawNameEn || cleanName || rawName,
              relativeNameHi: cleanRel.length >= 2 ? cleanRel : rawRel,
              relativeNameEn: rawRelEn || '',
              relationType: relType,
              houseNo: cleanH || cellVal(row, 'houseNo', 12),
              age: ageVal,
              gender: genderVal,
              status: statusVal,
              wardNo: String(rowWard).trim(),
              partNo: String(rowBooth).trim(),
              villageName: villageEn,
              villageNameHi: villageHi
            });
          }
        });
        if (finalVoterList.length > 0) {
          usedPythonEngine = true;
          console.log(`[pdfWorker] Python engine extracted ${finalVoterList.length} authentic voters with high precision from Excel: ${targetExcelPath}`);
          updateProgress(75, `📊 Excel तालिका से ${finalVoterList.length} मतदाताओं का सत्यापन संपन्न!`);
        }
      } catch (pyErr) {
        console.error("[pdfWorker] Python extraction FAILED:", pyErr.message, pyErr.stack);
        finalVoterList = [];
      }
    }

    if (finalVoterList.length === 0 && useOcr) {

      // 2. Fallback to Local JS OCR if Python engine was not executed
      if (finalVoterList.length === 0) {
        console.log(`Running visual JS OCR pipeline on ${filePath}...`);
        const { fullText, extractedVoters } = await performLocalOCR(filePath, updateProgress);
        
        console.log(`OCR returned ${extractedVoters.length} parsed cards. Vector EPICs count: ${vectorEpics.length}`);

        finalVoterList = extractedVoters
          .filter(card => card.nameHi && card.nameHi !== 'मतदाता' && card.nameHi.length >= 2)
          .map((card, idx) => {
            let matchedEpic = card.epic;
            if ((!matchedEpic || matchedEpic.length < 5) && vectorEpics[idx]) {
              matchedEpic = vectorEpics[idx];
            } else if (matchedEpic && !vectorEpics.includes(matchedEpic)) {
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
      }

    } else if (finalVoterList.length === 0) {
      // FAST TEXT-BASED EXTRACTION
      updateProgress(30);

      // Check if text uses legacy encoding (KrutiDev, PUA, etc.)
      if (isKrutiDevText(text)) {
        console.log("Detected KrutiDev font encoding. Converting to Unicode Devanagari...");
        text = convertKrutiDevToUnicode(text);
      } else if (isPUAText(text)) {
        console.log("Detected PUA (Private Use Area) font encoding. Converting to Unicode Devanagari...");
        text = autoConvertText(text);
      }

      // Universal Age/Gender block splitter (including SEC variants)
      const blocks = text.split(/((?:(?:आयु|आयू|आय|आजच)[:ः\s]*\d+[\s.,]*(?:लिंग|सलग|Sex)[:ः\s]*\S+|(?:लिंग|सलग|Sex)[:ः\s]*\S+))/i);
      
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
          if (/(?:मतदाता\s*(?:का)?\s*)?(?:नाम|नरम)\s*[:ः\-]\s*(.+)/i.test(line) && !/क्षेत्र|संख्या एवं|विधानसभा/i.test(line)) {
            const m = line.match(/(?:मतदाता\s*(?:का)?\s*)?(?:नाम|नरम)\s*[:ः\-]\s*(.+)/i);
            if (m && !nameHi) {
              nameHi = m[1].replace(/[a-zA-Z\d\u0966-\u096F]/g, '').replace(/[^\u0900-\u097F\s]/g, '').replace(/\s+/g, ' ').trim();
            }
          }
          if (/(?:(पिता|पति|माता|अन्य|नपतर|पनत|मरतर)\s*(?:का|कर)?\s*(?:नाम|नरम|नरक))\s*[:ः\-]\s*(.+)/i.test(line)) {
            const m = line.match(/(?:(पिता|पति|माता|अन्य|नपतर|पनत|मरतर)\s*(?:का|कर)?\s*(?:नाम|नरम|नरक))\s*[:ः\-]\s*(.+)/i);
            if (m && !relativeNameHi) {
              const r = m[1];
              relationType = r === 'नपतर' ? 'पिता' : r === 'पनत' ? 'पति' : r === 'मरतर' ? 'माता' : r;
              relativeNameHi = m[2].replace(/[a-zA-Z\d\u0966-\u096F]/g, '').replace(/[^\u0900-\u097F\s]/g, '').replace(/\s+/g, ' ').trim();
            }
          }
          if (/^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i.test(line)) {
            const m = line.match(/^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i);
            if (m && !houseNo) {
              houseNo = m[1].replace(/(?:मकान|संख्या|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति)+/gi, '').replace(/[^\w\d\/\-]/g, '').trim();
            }
          }
          if (/आयु\s*[:ः\-]?\s*(\d+)/i.test(line)) {
            const m = line.match(/आयु\s*[:ः\-]?\s*(\d+)/i);
            if (m && age === null) {
              const parsedAge = parseInt(m[1], 10);
              if (!isNaN(parsedAge) && parsedAge >= 18 && parsedAge <= 125) {
                age = parsedAge;
              }
            }
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

        const cleanName = cleanHindiText(nameHi);
        if (cleanName && cleanName !== 'मतदाता' && cleanName.length >= 2) {
          if (relationType === 'पति' || ['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती'].some(fem => cleanName.includes(fem))) {
            genderVal = 'स्त्री';
          }

          const cleanRel = stripNameFromRelative(cleanName, relativeNameHi);

          finalVoterList.push({
            epic: cardEpic || `VOTER_${finalVoterList.length + 1}`,
            nameHi: cleanName,
            relativeNameHi: cleanRel.length >= 2 ? cleanRel : '',
            relationType,
            houseNo,
            age,
            gender: genderVal,
            status: /DELETED|ELETED|विलोपित/i.test(fullBlock) ? "Deleted" : "Active"
          });
        }
      }
    }

    if (!usedPythonEngine) {
      updateProgress(55);

      // Pillar 8: Groq / OpenRouter AI Fallback ONLY if fallback text parser was used
      const needyCards = finalVoterList.filter(v => needsAiRepair(v)).slice(0, 60);
      if (needyCards.length > 0) {
        await Promise.allSettled(needyCards.map(async (v) => {
          try {
            const cardHint = `नाम: ${v.nameHi || ''}, मकान: ${v.houseNo || ''}, आयु: ${v.age || ''}, लिंग: ${v.gender || ''}`;
            await Promise.race([
              repairVoterCardGroq(cardHint, v),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            if (needsAiRepair(v)) {
              await Promise.race([
                repairVoterCardJs(cardHint, v),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
              ]);
            }
          } catch {}
        }));
      }

      if (finalVoterList.length > 0) {
        updateProgress(78, '🤖 Groq AI द्वारा सभी नामों और डेटा का पुनर्सत्यापन...');
        try {
          finalVoterList = await reverifyVotersListGroq(finalVoterList, (pct, msg) => {
            const currentP = 78 + Math.round(pct * 0.08);
            updateProgress(Math.min(currentP, 85), msg);
          });
        } catch (revErr) {
          console.warn('[pdfWorker] Groq reverification notice:', revErr.message);
        }
      }
    }

    // Assign generated Excel path (Python engine output is the primary source of truth)
    let generatedExcelPath = targetExcelPath;
    if (!generatedExcelPath || !fs.existsSync(generatedExcelPath)) {
      const path = require('path');
      const { generateVoterExcel } = require('../lib/excelExporter');
      if (!excelFilename) excelFilename = `${path.basename(filePath, path.extname(filePath))}_converted.xlsx`;
      const excelPath = path.join(__dirname, '../uploads/excels', excelFilename);
      try {
        generatedExcelPath = await generateVoterExcel(finalVoterList, excelPath, { 
          wardNo: wardNo || defaultWardNo, 
          boothNo: boothNo || defaultPartNo 
        });
      } catch (excelErr) {
        console.warn("Could not generate Excel file:", excelErr.message);
        if (fs.existsSync(excelPath)) generatedExcelPath = excelPath;
      }
    }

    updateProgress(88, '💾 डेटाबेस में सुरक्षित करने के लिए सत्यापित ऑपरेशन्स तैयार...');

    // Build MongoDB bulkWrite operations
    const operations = finalVoterList
      .filter(v => {
        if (!v) return false;
        const cleanN = (v.nameHi || '').trim();
        if (!cleanN || cleanN === 'मतदाता' || cleanN.length < 2) return false;
        if (/^(?:विधानसभा|निर्वाचक|नामावली|वार्ड|अनुभाग|प्रारूप|मतदान|हस्ताक्षर|कलेण्डर|भाग|संख्या|ओसियाँ|ग्रामपंचायत|पंचायत|समिति|राजस्थान|आयोग)/i.test(cleanN)) return false;
        return true;
      })
      .map((voter, i) => {
        const serialNumber = voter.serialNo || (i + 1);
        const voterStatus = voter.status || 'Active';

        const updateFields = {
          serialNo: serialNumber,
          nameHi: voter.nameHi,
          nameEn: voter.nameEn || voter.nameHi,
          relativeNameHi: voter.relativeNameHi,
          relativeNameEn: voter.relativeNameEn || '',
          relationType: voter.relationType,
          houseNo: voter.houseNo,
          age: voter.age,
          gender: voter.gender,
          status: voterStatus,
          villageName: voter.villageName || '',
          villageNameHi: voter.villageNameHi || ''
        };

        if (wardNo || voter.wardNo) updateFields.wardNo = voter.wardNo || wardNo || defaultWardNo;
        if (boothNo || voter.partNo) updateFields.partNo = voter.partNo || boothNo || defaultPartNo;
        if (uploadedBy) updateFields.assignedWorker = uploadedBy;

        const setOnInsertFields = {
          _id: `voter_${crypto.randomUUID()}`,
          epic: voter.epic,
          serialNo: serialNumber,
          status: voterStatus,
          organizationId: organizationId,
          villageName: voter.villageName || '',
          villageNameHi: voter.villageNameHi || ''
        };

        if (!wardNo && !voter.wardNo) setOnInsertFields.wardNo = defaultWardNo;
        if (!boothNo && !voter.partNo) setOnInsertFields.partNo = defaultPartNo;
        if (!uploadedBy) setOnInsertFields.assignedWorker = "";

        // Defensive guard: remove any key from $setOnInsert that is already in $set
        for (const key of Object.keys(setOnInsertFields)) {
          if (key in updateFields) {
            delete setOnInsertFields[key];
          }
        }

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

    if (parentPort) {
      parentPort.postMessage({ 
        type: 'done', 
        data: operations, 
        epicsCount: operations.length,
        excelPath: generatedExcelPath,
        excelFilename 
      });
    }

  } catch (err) {
    console.error("PDF extraction error in worker:", err);
    if (parentPort) {
      parentPort.postMessage({ type: 'error', data: err.message });
    }
  }
}

processPdf();
