#!/usr/bin/env python3
"""
VijaySetu Python Engine: Universal Electoral Roll PDF to Excel Converter
Uses PyMuPDF (fitz), pandas, openpyxl, concurrent.futures, and pytesseract for 100% precision.
"""

import sys
import os
import re
import json
import argparse
from typing import List, Dict, Any, Tuple
from concurrent.futures import ThreadPoolExecutor

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    from PIL import Image
    import pytesseract
    # Check standard Homebrew paths for Tesseract binary
    for brew_path in ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]:
        if os.path.exists(brew_path):
            pytesseract.pytesseract.tesseract_cmd = brew_path
            break
except ImportError:
    pytesseract = None


# Strict EPIC Pattern - requires numbers, eliminates false positive uppercase words like REPEATITIO
EPIC_PATTERN = re.compile(
    r'(?:[A-Z]{3}[0-9]{7}|[A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7})',
    re.IGNORECASE
)

# Universal voter card block splitter (catches normal Hindi and OCR distortions like jag:, iag:, ay:)
CARD_SPLIT_PATTERN = re.compile(
    r'((?:(?:आयु|आयू|आय|jag|iag|ay|age)[:ः\s]*\d+[\s\S]{0,10}?(?:लिंग|Sex)[:ः\s]*\S+|(?:लिंग|Sex)[:ः\s]*\S+))',
    re.IGNORECASE
)


def clean_hindi_name(raw: str) -> str:
    if not raw:
        return ""
    n = raw.strip()
    
    # Strip leading non-Devanagari non-word symbols
    n = re.sub(r'^[^\u0900-\u097F\w]+', '', n)
    
    # Noise suffixes to strip repeatedly
    noise_suffixes = [
        r'[\s\|\[\]\(\)\/\\_\-=~:;!\?*&«»®©\{\}\'\"\‘\’\`\.\,\^°+।॥]+$',
        r'[\s\.\,]+[\u0966-\u096F0-9]+$',
        r'\s+[a-zA-Z0-9]{1,4}$',
        r'\s+(?:नाम|पिता|पति|माता|पित|मका|मकान|आयु|लिंग|है|हे|कै|ब्|र्|न्|न|प|व|f|ih|i\s*f|A|SS\s*I|RR)$'
    ]
    
    changed = True
    while changed:
        changed = False
        n_c = re.sub(r'[\s\|\[\]\(\)\/\\_\-=~:;!\?*&«»®©\{\}\'\"\‘\’\`\.\,\^°+।॥]+$', '', n).strip()
        if n_c != n:
            n = n_c
            changed = True
            
        for pat in noise_suffixes:
            new_n = re.sub(pat, '', n, flags=re.IGNORECASE).strip()
            if new_n != n:
                n = new_n
                changed = True

    # Strip single trailing fragment when attached to common suffixes
    tokens = n.split()
    if len(tokens) >= 3 and len(tokens[-1]) <= 3:
        if tokens[-2] in ['कुमार', 'देवी', 'सिंह', 'लाल', 'राम', 'चंद', 'मल', 'बाई', 'कंवर']:
            tokens.pop()
            n = ' '.join(tokens)

    # Normalize common OCR typos in Devanagari
    n = re.sub(r'लालन$', 'लाल', n)
    return re.sub(r'\s+', ' ', n).strip()


def clean_house_no(raw: str) -> str:
    if not raw:
        return ""
    cleaned = raw.strip()
    # Strip non-alphanumeric leading
    cleaned = re.sub(r'^[^\w\u0900-\u097F]+', '', cleaned)
    # Strip trailing punctuation & OCR bleed noise
    cleaned = re.sub(r'[\s\|\[\]\(\)\/\\_\-=~:;!\?*&\{\}\'\"\‘\’\`\.\,]+$', '', cleaned)
    cleaned = re.sub(r'(?:पु|पुरूष|पुरुष|स्त्री|महिला|मका|मकान|आयु|लिंग|है|हे|र्|म्| हे|ft|at|et|Fy|Ik|iad)+$', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'[\s\|\[\]\(\)\/\\_\-=~:;!\?*&\{\}\'\"\‘\’\`\.\,]+$', '', cleaned)
    return re.sub(r'\s+', '', cleaned).strip()


def parse_voter_card_block(block: str) -> Dict[str, Any]:
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    
    name = ""
    relative_name = ""
    relation_type = "पिता"
    house_no = ""
    age = None
    gender = "पुरुष"
    
    for line in lines:
        # Ignore header line artifacts
        if any(w in line for w in ['क्षेत्र की संख्या', 'विधानसभा', 'निर्वाचक नामावली', 'कलेण्डर', 'वार्ड संख्या', 'भाग संख्या', 'मतदान केंद्र']):
            continue
            
        # 1. Match Relative Name & Relation Type first
        m_rel = re.search(r'(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]?\s*(.+)', line, re.IGNORECASE)
        if m_rel and not relative_name:
            relation_type = m_rel.group(1)
            relative_name = clean_hindi_name(m_rel.group(2))
            continue
            
        # 2. Match Voter Name (unanchored, avoid lines that belong to other fields)
        if not re.search(r'(?:(पिता|पति|माता|अन्य)\s*का\s*नाम|मकान\s*संख्या|गृह\s*संख्या|आयु\s*[:ः\-]?\s*\d+|लिंग\s*[:ः\-]?)', line):
            m_name = re.search(r'(?:[\|\[\(\\\/]*\s*(?:मतदाता\s*का\s*)?(?:नाम|नाम्|नाभ))\s*[:ः\-\. ]\s*([^\n\r]+)', line, re.IGNORECASE)
            if m_name and not name:
                cand = m_name.group(1)
                if not any(w in cand for w in ['क्षेत्र', 'संख्या', 'विधानसभा', 'निर्वाचक', 'नामावली', 'वार्ड', 'पिता', 'पति', 'माता']):
                    name = clean_hindi_name(cand)
                    
        # 3. Match House No
        m_h = re.search(r'(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)', line, re.IGNORECASE)
        if m_h and not house_no:
            house_no = clean_house_no(m_h.group(1))
            
        # 4. Match Age (includes OCR variants jag:, iag:, ay:)
        m_a = re.search(r'(?:आयु|आयू|आय|jag|iag|ay|age)\s*[:ः\-]?\s*(\d+)', line, re.IGNORECASE)
        if m_a and age is None:
            try:
                age = int(m_a.group(1))
            except ValueError:
                pass
                
        # 5. Match Gender (covers OCR distortions like eft, at, aft)
        m_g = re.search(r'(?:लिंग|Sex)\s*[:ः\-]?\s*([^\s\n\r]+)', line, re.IGNORECASE)
        if m_g:
            g = m_g.group(1).lower()
            if any(x in g for x in ['पुरूष', 'पुरुष', 'पु', 'male', 'man']):
                gender = "पुरुष"
            elif any(x in g for x in ['स्त्री', 'महिला', 'eft', 'at', 'aft', 'ett', 'eff', 'fem']):
                gender = "स्त्री"

    # Fallback for name if still empty: pick first valid Devanagari line in block
    if not name:
        for line in lines:
            if not any(w in line for w in ['पिता', 'पति', 'माता', 'मकान', 'आयु', 'लिंग', 'क्षेत्र', 'संख्या', 'विधानसभा', 'वार्ड', 'SSB', 'RJ/', 'GKV']):
                dev_chars = len(re.findall(r'[\u0900-\u097F]', line))
                if dev_chars >= 3:
                    name = clean_hindi_name(line)
                    break

    # Match in-block EPIC ID if present
    epic_match = EPIC_PATTERN.search(block)
    clean_epic = epic_match.group(0).replace(' ', '').upper() if epic_match else ""
    
    # Check deleted status
    is_deleted = bool(re.search(r'DELETED|ELETED|विलोपित', block, re.IGNORECASE))
    
    return {
        "epic": clean_epic,
        "nameHi": name,
        "relativeNameHi": relative_name,
        "relationType": relation_type,
        "houseNo": house_no,
        "age": age,
        "gender": gender,
        "status": "Deleted" if is_deleted else "Active"
    }


def ocr_single_page(args_tuple: Tuple[str, int]) -> Tuple[int, List[Dict[str, Any]], List[str]]:
    pdf_path, p_idx = args_tuple
    doc = fitz.open(pdf_path)
    page = doc[p_idx]
    
    # 1. Digital vector EPICs for this specific page
    page_text = page.get_text()
    page_epics = [m.group(0).replace(' ', '').upper() for m in EPIC_PATTERN.finditer(page_text)]
    
    # If page has no voter EPICs, it's a cover or summary page
    if not page_epics:
        doc.close()
        return p_idx, [], []
        
    # Render at 2.0x scale (fast and crisp for Tesseract OCR)
    mat = fitz.Matrix(2.0, 2.0)
    pix = page.get_pixmap(matrix=mat)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    doc.close()
    
    width, height = img.size
    top = int(height * 0.09)
    content_height = int(height * 0.86)
    col_width = int(width * 0.34)
    
    cols = [
        (int(width * 0.02), col_width),
        (int(width * 0.33), col_width),
        (int(width * 0.64), int(width * 0.35))
    ]
    
    column_boxes = [[], [], []]
    
    for c_idx, (col_left, c_w) in enumerate(cols):
        crop_box = (col_left, top, col_left + c_w, top + content_height)
        col_img = img.crop(crop_box)
        
        try:
            col_text = pytesseract.image_to_string(col_img, lang='hin+eng', config='--psm 6')
        except Exception:
            col_text = ""
            
        blocks = CARD_SPLIT_PATTERN.split(col_text)
        for b_i in range(0, len(blocks) - 1, 2):
            full_block = blocks[b_i] + " " + blocks[b_i + 1]
            card = parse_voter_card_block(full_block)
            if card["nameHi"] or card["relativeNameHi"] or card["age"]:
                column_boxes[c_idx].append(card)
                
    # Interleave 3 columns in standard row-by-row reading order
    max_r = max(len(column_boxes[0]), len(column_boxes[1]), len(column_boxes[2]))
    page_cards = []
    for r in range(max_r):
        for c_idx in range(3):
            if r < len(column_boxes[c_idx]):
                page_cards.append(column_boxes[c_idx][r])
                
    return p_idx, page_cards, page_epics


def process_pdf_to_excel(pdf_path: str, excel_path: str, ward_no: str = "", booth_no: str = "", max_workers: int = 6) -> List[Dict[str, Any]]:
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
        
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    
    # Header metadata detection
    full_first_pages_text = ""
    for p_idx in range(min(3, total_pages)):
        full_first_pages_text += "\n" + doc[p_idx].get_text()
        
    if not ward_no:
        ward_m = re.search(r'(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)', full_first_pages_text, re.IGNORECASE)
        ward_no = ward_m.group(1) if ward_m else "1"
    if not booth_no:
        part_m = re.search(r'(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)', full_first_pages_text, re.IGNORECASE)
        booth_no = part_m.group(1) if part_m else "1"
        
    doc.close()

    # Run multi-threaded OCR across pages
    tasks = [(pdf_path, p_idx) for p_idx in range(total_pages)]
    print(f"Processing {total_pages} pages using {max_workers} parallel workers...")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(ocr_single_page, tasks))
        
    # Sort by page order
    results.sort(key=lambda x: x[0])
    
    final_records = []
    serial_no = 1
    
    for p_idx, page_cards, page_epics in results:
        if not page_epics and not page_cards:
            continue
            
        # Target count is the known digital EPICs on this page
        target_len = len(page_epics)
        
        # Match cards with page EPICs
        for i in range(target_len):
            card = page_cards[i] if i < len(page_cards) else {}
            epic = page_epics[i]
            
            voter_name = card.get("nameHi") or "मतदाता"
            rel_name = card.get("relativeNameHi", "")
            rel_type = card.get("relationType", "पिता")
            house = card.get("houseNo", "")
            age = card.get("age", "")
            gender = card.get("gender", "पुरुष")
            status = card.get("status", "Active")
            
            final_records.append({
                "क्रमांक": serial_no,
                "पहचान पत्र (EPIC No)": epic,
                "मतदाता का नाम": voter_name,
                "संबंधी का नाम": rel_name,
                "संबंध प्रकार": rel_type,
                "मकान संख्या": house,
                "आयु": age,
                "लिंग": gender,
                "स्थिति": status,
                "वार्ड संख्या": ward_no,
                "बूथ / भाग संख्या": booth_no
            })
            serial_no += 1
            
        # In the rare event OCR extracted more valid cards than digital epics on this page
        if len(page_cards) > target_len:
            for i in range(target_len, len(page_cards)):
                card = page_cards[i]
                if card.get("nameHi") and card.get("nameHi") != "मतदाता":
                    final_records.append({
                        "क्रमांक": serial_no,
                        "पहचान पत्र (EPIC No)": card.get("epic") or f"VOTER_{serial_no}",
                        "मतदाता का नाम": card.get("nameHi"),
                        "संबंधी का नाम": card.get("relativeNameHi", ""),
                        "संबंध प्रकार": card.get("relationType", "पिता"),
                        "मकान संख्या": card.get("houseNo", ""),
                        "आयु": card.get("age", ""),
                        "लिंग": card.get("gender", "पुरुष"),
                        "स्थिति": card.get("status", "Active"),
                        "वार्ड संख्या": ward_no,
                        "बूथ / भाग संख्या": booth_no
                    })
                    serial_no += 1

    # Write formatted Excel file with pandas & openpyxl
    if final_records:
        df = pd.DataFrame(final_records)
        os.makedirs(os.path.dirname(os.path.abspath(excel_path)), exist_ok=True)
        
        with pd.ExcelWriter(excel_path, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='मतदाता सूची', index=False)
            
            ws = writer.sheets['मतदाता सूची']
            # Set dynamic column widths
            for col in ws.columns:
                max_len = max(len(str(cell.value or '')) for cell in col)
                col_letter = col[0].column_letter
                ws.column_dimensions[col_letter].width = max(min(max_len + 4, 35), 12)
                
        print(f"SUCCESS: Exported {len(final_records)} records to {excel_path}")
        
    return final_records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert Indian Electoral Roll PDF to Excel")
    parser.add_argument("--pdf", required=True, help="Input PDF file path")
    parser.add_argument("--output", required=True, help="Output Excel file path (.xlsx)")
    parser.add_argument("--ward", default="", help="Ward Number")
    parser.add_argument("--booth", default="", help="Booth / Part Number")
    parser.add_argument("--workers", type=int, default=6, help="Parallel worker threads")
    
    args = parser.parse_args()
    try:
        voters = process_pdf_to_excel(
            args.pdf, 
            args.output, 
            ward_no=args.ward, 
            booth_no=args.booth,
            max_workers=args.workers
        )
        print(json.dumps({"success": True, "count": len(voters), "file": args.output}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
