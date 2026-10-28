const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let cachedPythonCmd = null;

/**
 * Determine working Python 3 command in runtime (tries PYTHON_PATH, python3, python)
 */
async function getWorkingPythonCommand() {
  if (cachedPythonCmd) return cachedPythonCmd;
  const candidates = [process.env.PYTHON_PATH, 'python3', 'python'].filter(Boolean);
  for (const cmd of candidates) {
    const ok = await new Promise((resolve) => {
      try {
        const py = spawn(cmd, ['-c', 'import openpyxl; print("OK")']);
        let out = '';
        py.stdout.on('data', (d) => { out += d.toString(); });
        py.on('close', (code) => resolve(code === 0 && out.includes('OK')));
        py.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
    if (ok) {
      cachedPythonCmd = cmd;
      return cmd;
    }
  }
  return null;
}

/**
 * Run Engine 1: extract_voters_perfect.py (ultra-fast binary TTF stream parser)
 */
function runEngineExtractVotersPerfect(pythonCmd, pdfPath, excelPath, wardNo = '', boothNo = '') {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../scripts/extract_voters_perfect.py');
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`Script not found: ${scriptPath}`));
    }

    const templatePath = path.join(__dirname, '../../voter-import-template.xlsx');
    const args = [
      scriptPath,
      '--pdf', pdfPath,
      '--output', excelPath,
      '--ward', wardNo || '',
      '--booth', boothNo || ''
    ];
    if (fs.existsSync(templatePath)) {
      args.push('--template', templatePath);
    }

    const py = spawn(pythonCmd, args);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });

    py.on('close', (code) => {
      if (code === 0 && fs.existsSync(excelPath)) {
        const lines = stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.success && parsed.count > 0) return resolve(parsed);
          } catch {}
        }
        resolve({ success: true, count: 0, file: excelPath });
      } else {
        reject(new Error(`Engine 1 exited with code ${code}: ${stderr || stdout}`));
      }
    });

    py.on('error', (err) => reject(err));
  });
}

/**
 * Run Engine 2: pdf_to_excel.py (PyMuPDF + Kruti Dev Converter + Header-paired Anchor Discovery + Tesseract OCR)
 */
function runEnginePyMuPdf(pythonCmd, pdfPath, excelPath, wardNo = '', boothNo = '') {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../python_engine/pdf_to_excel.py');
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`PyMuPDF engine script not found: ${scriptPath}`));
    }

    const args = [
      scriptPath,
      '--pdf', pdfPath,
      '--output', excelPath,
      '--ward', wardNo || '',
      '--booth', boothNo || '',
      '--workers', '4'
    ];

    const py = spawn(pythonCmd, args);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });

    py.on('close', (code) => {
      if (code === 0 && fs.existsSync(excelPath)) {
        const lines = stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.success) return resolve(parsed);
          } catch {}
        }
        resolve({ success: true, file: excelPath });
      } else {
        reject(new Error(`Engine 2 exited with code ${code}: ${stderr || stdout}`));
      }
    });

    py.on('error', (err) => reject(err));
  });
}

/**
 * Resilient Dual-Engine PDF to Excel Converter
 * 
 * 1. Tries Engine 1 (extract_voters_perfect.py) for lightning-fast 3-5s parsing with 100% EPIC extraction.
 * 2. If Engine 1 returns 0 records, crashes, or encounters unsupported raster/scanned structures,
 *    automatically falls back to Engine 2 (pdf_to_excel.py 10-pillar PyMuPDF / Tesseract OCR engine).
 * 
 * @param {string} pdfPath - Path to input PDF
 * @param {string} excelPath - Path to destination .xlsx
 * @param {string} wardNo - Optional Ward Number
 * @param {string} boothNo - Optional Booth / Part Number
 * @returns {Promise<{ success: boolean, count?: number, file: string, engineUsed: string }>}
 */
async function runPythonPdfToExcel(pdfPath, excelPath, wardNo = '', boothNo = '') {
  const pythonCmd = await getWorkingPythonCommand() || 'python3';

  // Attempt Primary Engine (extract_voters_perfect)
  try {
    console.log(`[pythonBridge] Attempting Engine 1 (extract_voters_perfect)...`);
    const res1 = await runEngineExtractVotersPerfect(pythonCmd, pdfPath, excelPath, wardNo, boothNo);
    if (res1.count && res1.count > 0) {
      console.log(`[pythonBridge] Engine 1 SUCCESS: Extracted ${res1.count} voters.`);
      return { ...res1, engineUsed: 'extract_voters_perfect' };
    }
    console.warn(`[pythonBridge] Engine 1 returned 0 voters. Triggering Engine 2 fallback...`);
  } catch (err1) {
    console.warn(`[pythonBridge] Engine 1 encountered error: ${err1.message}. Triggering Engine 2 fallback...`);
  }

  // Fallback to Engine 2 (pdf_to_excel.py PyMuPDF / Tesseract 10-Pillar Engine)
  console.log(`[pythonBridge] Running Engine 2 (pdf_to_excel.py PyMuPDF / OCR)...`);
  const res2 = await runEnginePyMuPdf(pythonCmd, pdfPath, excelPath, wardNo, boothNo);
  console.log(`[pythonBridge] Engine 2 SUCCESS: Extracted voters to ${excelPath}`);
  return { ...res2, engineUsed: 'pdf_to_excel' };
}

/**
 * Check if Python 3 and required libraries are available in runtime
 */
async function isPythonAvailable() {
  const cmd = await getWorkingPythonCommand();
  return Boolean(cmd);
}

module.exports = {
  runPythonPdfToExcel,
  isPythonAvailable,
  getWorkingPythonCommand
};
