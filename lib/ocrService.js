const Tesseract = require('tesseract.js');
const { pdfToPng } = require('pdf-to-png-converter');

/**
 * Clean unwanted artifacts from extracted Hindi text strings
 */
function cleanHindiText(str) {
  if (!str) return "";
  return str
    .replace(/^[^\w\u0900-\u097F]+/, "") // remove leading non-word / non-devanagari characters
    .replace(/[^\w\u0900-\u097F\s\.\/]+$/, "") // remove trailing punctuation/scratches
    .replace(/\s+/g, " ")
    .trim();
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
  let gender = "अन्य";

  for (const line of lines) {
    // Voter Name
    if (/^(?:मतदाता का नाम|नाम)\s*[:ः\-]\s*(.+)/i.test(line) && !/क्षेत्र|संख्या एवं|विधानसभा|निर्वाचक|नामावली|वार्ड/i.test(line)) {
      const m = line.match(/^(?:मतदाता का नाम|नाम)\s*[:ः\-]\s*(.+)/i);
      if (m && !name) {
        name = cleanHindiText(m[1]);
      }
    }
    // Relative Name & Relation Type
    if (/^(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]\s*(.+)/i.test(line)) {
      const m = line.match(/^(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]\s*(.+)/i);
      if (m && !relativeName) {
        relationType = m[1];
        relativeName = cleanHindiText(m[2]);
      }
    }
    // House Number
    if (/^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i.test(line)) {
      const m = line.match(/^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)/i);
      if (m && !houseNo) {
        houseNo = cleanHindiText(m[1]);
      }
    }
    // Age
    if (/आयु\s*[:ः\-]?\s*(\d+)/i.test(line)) {
      const m = line.match(/आयु\s*[:ः\-]?\s*(\d+)/i);
      if (m && age === null) {
        age = parseInt(m[1]);
      }
    }
    // Gender
    if (/लिंग\s*[:ः\-]?\s*([^\s\n\r]+)/i.test(line)) {
      const m = line.match(/लिंग\s*[:ः\-]?\s*([^\s\n\r]+)/i);
      if (m) {
        const g = m[1];
        if (g.includes("पुरूष") || g.includes("पुरुष") || g.includes("पु")) gender = "पुरुष";
        else if (g.includes("स्त्री") || g.includes("महिला") || g.includes("स्")) gender = "स्त्री";
      }
    }
  }

  // Voter EPIC ID
  const epicMatch = block.match(/([A-Z]{3}[0-9]{7}|[A-Z]{2,3}\s*[\/\-]\s*\d{2}\s*[\/\-]\s*\d{2,3}\s*[\/\-]\s*\d{4,6}|[A-Z0-9]{10})/i);

  // Check if voter is marked deleted
  const isDeleted = /DELETED|ELETED|विलोपित/i.test(block);

  return {
    epic: epicMatch ? epicMatch[1].replace(/\s+/g, '').toUpperCase() : "",
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

        // Split column text into voter cards using the universal age/gender block boundary
        const blocks = colText.split(/(आयु[:ः\s]*\d+[\s.,]*(?:लिंग[:ः\s]*\S+|Sex[:\s]*\S+))/i);
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
