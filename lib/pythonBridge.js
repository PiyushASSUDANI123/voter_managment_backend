const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Execute high-speed Python PyMuPDF + pandas engine for PDF to Excel conversion
 * 
 * @param {string} pdfPath - Path to input PDF
 * @param {string} excelPath - Path to destination .xlsx
 * @param {string} wardNo - Optional Ward Number
 * @param {string} boothNo - Optional Booth / Part Number
 * @returns {Promise<{ success: boolean, count?: number, file: string }>}
 */
async function runPythonPdfToExcel(pdfPath, excelPath, wardNo = '', boothNo = '') {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, '../python_engine/pdf_to_excel.py');
    if (!fs.existsSync(pythonScript)) {
      return reject(new Error(`Python script not found: ${pythonScript}`));
    }

    const py = spawn('python3', [
      pythonScript,
      '--pdf', pdfPath,
      '--output', excelPath,
      '--ward', wardNo || '',
      '--booth', boothNo || ''
    ]);

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });

    py.on('close', (code) => {
      if (code === 0) {
        const lines = stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.success) return resolve(parsed);
          } catch {}
        }
        resolve({ success: true, file: excelPath });
      } else {
        reject(new Error(`Python extraction failed (code ${code}): ${stderr || stdout}`));
      }
    });

    py.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Check if Python 3 and required libraries are available in runtime
 */
async function isPythonAvailable() {
  return new Promise((resolve) => {
    const py = spawn('python3', ['-c', 'import fitz, pandas, openpyxl; print("OK")']);
    let out = '';
    py.stdout.on('data', (d) => { out += d.toString(); });
    py.on('close', (code) => {
      resolve(code === 0 && out.includes('OK'));
    });
    py.on('error', () => {
      resolve(false);
    });
  });
}

module.exports = {
  runPythonPdfToExcel,
  isPythonAvailable
};
