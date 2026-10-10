const Tesseract = require('tesseract.js');
const { pdfToPng } = require('pdf-to-png-converter');

/**
 * Clean unwanted artifacts from extracted Hindi text strings
 */
function cleanHindiText(str) {
  if (!str) return "";
  let n = str.trim();
  
  // Remove leading OCR noise or label prefixes (e.g. 'ava:', 'ara:', 'नाम:', 'मतदाता का नाम:')
  n = n.replace(/^(?:ava|ara|name|no|sl|s)?[:\-]?\s*/gi, '');
  n = n.replace(/^(?:[\|\[\(\\\/]*\s*(?:मतदाता\s*का\s*)?(?:नाम|नाम्|नाभ))\s*[:ः\-\. ]\s*/gi, '');

  // Strictly remove English / Latin characters (English not permitted in Hindi name)
  n = n.replace(/[a-zA-Z]+/g, ' ');

  // Strictly remove digits (numbers not permitted in name)
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

function cleanHouseNo(str) {
  if (!str) return "";
  let h = str.trim();
  h = h.replace(/(?:मकान|संख्या|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति|माता|ward|house|no|room|flat|ft|at|et|Fy|Ik|iad|है|हे|मिका|पु|Nha|AY)+/gi, '');
  h = h.replace(/[%*~_!?:;\'"‘’।॥«»°+={}\[\]()|<>^$&#@,¥]+/g, '').trim();
  const m = h.match(/(\d+[\/\-]?\d*\s*[क-हA-Za-z]?)/);
  if (m) return m[1].replace(/\s+/g, '');
  return h.replace(/[^\w\d\/\-]/g, '').trim();
}

/**
 * Parse a voter block text into a structured voter object
 */
function parseVoterBlock(block) {
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let name = "";
  let relativeName = "";
  let relationType = "पिता";
  let houseNo = "";
  let age = null;
  let gender = "पुरुष";

  for (const line of lines) {
    if (/क्षेत्र की संख्या|विधानसभा|निर्वाचक नामावली|कलेण्डर|वार्ड संख्या|भाग संख्या|मतदान केंद्र/i.test(line)) {
      continue;
    }

    // Relative Name & Relation Type
    const mRel = line.match(/(?:(पिता|पति|माता|अन्य)\s*(?:का)?\s*नाम)\s*[:ः\-]?\s*(.+)/i);
    if (mRel && !relativeName) {
      relationType = mRel[1];
      const relCand = cleanHindiText(mRel[2]);
      if (relCand && relCand.length >= 2 && !['है', 'हे', 'की', 'का', 'के'].includes(relCand)) {
        relativeName = relCand;
      }
      continue;
    }

    // Voter Name (unanchored)
    if (!/(?:(पिता|पति|माता|अन्य)\s*(?:का)?\s*नाम|मकान\s*संख्या|गृह\s*संख्या|आयु\s*[:ः\-]?\s*\d+|लिंग\s*[:ः\-])/i.test(line)) {
      const mName = line.match(/(?:[\|\[\(\\\/]*\s*(?:मतदाता\s*का\s*)?(?:नाम|नाम्|नाभ))\s*[:ः\-\. ]\s*([^\n\r]+)/i);
      if (mName && !name) {
        const cand = mName[1];
        if (!/क्षेत्र|संख्या|विधानसभा|निर्वाचक|नामावली|वार्ड|पिता|पति|माता/i.test(cand)) {
          const nameCand = cleanHindiText(cand);
          if (nameCand && nameCand.length >= 2 && !['है', 'हे', 'की', 'का'].includes(nameCand)) {
            name = nameCand;
          }
        }
      }
    }

    // House Number
    const mH = line.match(/(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i);
    if (mH && !houseNo) {
      const hCand = cleanHouseNo(mH[1]);
      if (hCand) houseNo = hCand;
    }

    // Age
    const mA = line.match(/(?:आयु|आयू|आय|उम्र|age)\s*[:ः\-]?\s*(\d+)/i);
    if (mA && age === null) {
      try {
        const aVal = parseInt(mA[1], 10);
        if (aVal >= 18 && aVal <= 125) age = aVal;
      } catch {}
    }

    // Gender
    const mG = line.match(/(?:लिंग|Sex)\s*[:ः\-]?\s*([^\s\n\r]+)/i);
    if (mG) {
      const g = mG[1].toLowerCase();
      if (/पुरूष|पुरुष|पु|male|man/i.test(g)) gender = "पुरुष";
      else if (/स्त्री|महिला|eft|at|aft|ett|eff|fem/i.test(g)) gender = "स्त्री";
    }
  }

  // Fallback for name: first valid devanagari line
  if (!name) {
    for (const line of lines) {
      if (!/पिता|पति|माता|मकान|आयु|लिंग|क्षेत्र|संख्या|विधानसभा|वार्ड|SSB|RJ\/|GKV/i.test(line)) {
        const devMatch = line.match(/[\u0900-\u097F]/g);
        if (devMatch && devMatch.length >= 3) {
          name = cleanHindiText(line);
          break;
        }
      }
    }
  }

  // Voter EPIC ID (strictly requires digits)
  const epicMatch = block.match(/(?:[A-Z]{3}[0-9]{7}|[A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7})/i);

  // Check if voter is marked deleted
  const isDeleted = /DELETED|ELETED|विलोपित/i.test(block);

  return {
    epic: epicMatch ? epicMatch[0].replace(/\s+/g, '').toUpperCase() : "",
    nameHi: name,
    relativeNameHi: relativeName,
    relationType,
    houseNo,
    age,
    gender,
    status: isDeleted ? "Deleted" : "Active"
  };
}

/**
 * Perform local high-precision 3-column OCR on a given PDF file
 * 
 * @param {string} pdfPath - Path to the PDF file
 * @param {function} onProgress - Callback for reporting progress (0-100)
 * @returns {Promise<{ fullText: string, extractedVoters: Array }>}
 */
async function performLocalOCR(pdfPath, onProgress = () => {}) {
  let fullText = "";
  const extractedVoters = [];

  onProgress(10);
  console.log(`Starting high-resolution PDF rendering for OCR: ${pdfPath}`);
  
  // Render pages at 2.0x scale (optimal accuracy vs speed)
  const pngPages = await pdfToPng(pdfPath, {
    viewportScale: 2.0,
    disableFontFace: true,
    useSystemFonts: false,
  });

  const totalPages = pngPages.length;
  console.log(`Rendered ${totalPages} pages to images.`);
  onProgress(20);

  // Initialize Tesseract worker with Hindi + English models
  const worker = await Tesseract.createWorker('hin+eng');
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
  });

  onProgress(25);

  // Process each page
  for (let p = 0; p < totalPages; p++) {
    console.log(`OCR processing page ${p + 1} of ${totalPages}...`);
    const imgBuf = pngPages[p].content;
    const width = pngPages[p].width;
    const height = pngPages[p].height;

    // Standard Electoral Roll Layout:
    // Header (Top 9%), Footer (Bottom 5%), Voter Card Grid (Middle 86%)
    const top = Math.floor(height * 0.09);
    const contentHeight = Math.floor(height * 0.86);

    // 3 Columns with generous bounding box coverage
    const colWidth = Math.floor(width * 0.34);
    const cols = [
      { left: Math.floor(width * 0.02), width: colWidth },
      { left: Math.floor(width * 0.33), width: colWidth },
      { left: Math.floor(width * 0.64), width: Math.floor(width * 0.35) }
    ];

    const columnVoterBoxes = [[], [], []];

    for (let c = 0; c < 3; c++) {
      try {
        const { data: { text: colText } } = await worker.recognize(imgBuf, {
          rectangle: {
            left: cols[c].left,
            top,
            width: cols[c].width,
            height: contentHeight
          }
        });

        fullText += `\n--- PAGE ${p + 1} COL ${c + 1} ---\n` + colText;

        // Split column text into voter cards using universal age/gender block boundary
        const blocks = colText.split(/((?:(?:आयु|आयू|आय|jag|iag|ay|age)[:ः\s]*\d+[\s\S]{0,10}?(?:लिंग|Sex)[:ः\s]*\S+|(?:लिंग|Sex)[:ः\s]*\S+))/i);
        for (let b = 0; b < blocks.length - 1; b += 2) {
          const fullBlock = blocks[b] + " " + blocks[b + 1];
          const parsed = parseVoterBlock(fullBlock);
          if (parsed.nameHi || parsed.relativeNameHi || parsed.age) {
            columnVoterBoxes[c].push(parsed);
          }
        }
      } catch (colErr) {
        console.warn(`OCR error on page ${p + 1} col ${c + 1}:`, colErr.message);
      }
    }

    // Interleave columns in standard electoral roll reading order:
    // Row 1 (Col 1, Col 2, Col 3), Row 2 (Col 1, Col 2, Col 3)...
    const maxRows = Math.max(
      columnVoterBoxes[0].length,
      columnVoterBoxes[1].length,
      columnVoterBoxes[2].length
    );

    for (let r = 0; r < maxRows; r++) {
      for (let c = 0; c < 3; c++) {
        if (columnVoterBoxes[c][r]) {
          extractedVoters.push(columnVoterBoxes[c][r]);
        }
      }
    }

    // Progress updates from 25% to 85%
    const currentProgress = 25 + Math.floor(((p + 1) / totalPages) * 60);
    onProgress(currentProgress);
  }

  await worker.terminate();
  console.log(`OCR complete. Extracted ${extractedVoters.length} voter cards across ${totalPages} pages.`);
  onProgress(88);

  return { fullText, extractedVoters };
}

module.exports = {
  performLocalOCR,
  cleanHindiText,
  parseVoterBlock
};
