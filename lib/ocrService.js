const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const { pdfToPng } = require('pdf-to-png-converter');

/**
 * Perform local OCR on a given PDF file using tesseract.js and pdf-to-png-converter
 * 
 * @param {string} pdfPath - Path to the PDF file
 * @param {function} onProgress - Callback for reporting progress
 * @returns {Promise<string>} - Extracted text across all pages
 */
async function performLocalOCR(pdfPath, onProgress) {
  let fullText = "";

  onProgress(15);
  console.log(`Starting PDF to PNG conversion for ${pdfPath}`);
  
  // Convert PDF to images
  // We use viewportScale: 2.0 to ensure good OCR resolution
  const pngPages = await pdfToPng(pdfPath, {
    viewportScale: 2.0, 
    disableFontFace: true,
    useSystemFonts: false,
  });

  const totalPages = pngPages.length;
  console.log(`Converted ${totalPages} pages to images.`);
  onProgress(25);

  // Initialize Tesseract worker
  const worker = await Tesseract.createWorker('hin+eng');
  
  onProgress(30);

  // Process each page
  for (let i = 0; i < totalPages; i++) {
    console.log(`OCR processing page ${i + 1} of ${totalPages}...`);
    
    // pngPages[i].content is the Buffer of the PNG
    const { data: { text } } = await worker.recognize(pngPages[i].content);
    
    fullText += `\n--- PAGE ${i + 1} ---\n`;
    fullText += text;

    // Calculate progress between 30 and 90%
    const ocrProgress = 30 + Math.floor(((i + 1) / totalPages) * 60);
    onProgress(ocrProgress);
  }

  await worker.terminate();
  console.log(`OCR processing complete for ${totalPages} pages.`);
  
  onProgress(90);
  return fullText;
}

module.exports = { performLocalOCR };
