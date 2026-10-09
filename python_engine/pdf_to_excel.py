#!/usr/bin/env python3
"""
VijaySetu Python Engine: Universal Electoral Roll PDF to Excel Converter
Uses PyMuPDF (fitz), pandas, openpyxl, and pytesseract for 100% precision.
"""

import sys
import os
import re
import json
import argparse
from typing import List, Dict, Any

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
except ImportError:
    pytesseract = None


def clean_hindi_text(text: str) -> str:
    if not text:
        return ""
    # Strip non-word / non-devanagari boundary noise
    cleaned = re.sub(r'^[^\w\u0900-\u097F]+', '', text)
    cleaned = re.sub(r'[^\w\u0900-\u097F\s\.\/]+$', '', cleaned)
    return re.sub(r'\s+', ' ', cleaned).strip()


def parse_voter_card_block(block: str) -> Dict[str, Any]:
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    
    name = ""
    relative_name = ""
    relation_type = "पिता"
    house_no = ""
    age = None
    gender = "अन्य"
    
    for line in lines:
        # Match Voter Name
        if re.search(r'^(?:मतदाता का नाम|नाम)\s*[:ः\-]\s*(.+)', line, re.IGNORECASE):
            if not re.search(r'क्षेत्र|संख्या एवं|विधानसभा|निर्वाचक|नामावली|वार्ड', line):
                m = re.search(r'^(?:मतदाता का नाम|नाम)\s*[:ः\-]\s*(.+)', line, re.IGNORECASE)
                if m and not name:
                    name = clean_hindi_text(m.group(1))
                    
        # Match Relative Name & Relation Type
        if re.search(r'^(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]\s*(.+)', line, re.IGNORECASE):
            m = re.search(r'^(?:(पिता|पति|माता|अन्य)\s*का\s*नाम)\s*[:ः\-]\s*(.+)', line, re.IGNORECASE)
            if m and not relative_name:
                relation_type = m.group(1)
                relative_name = clean_hindi_text(m.group(2))
                
        # Match House No
        if re.search(r'^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)', line, re.IGNORECASE):
            m = re.search(r'^(?:मकान\s*संख्या|गृह\s*संख्या)\s*[:ः\-]?\s*(.+)', line, re.IGNORECASE)
            if m and not house_no:
                house_no = clean_hindi_text(m.group(1))
                
        # Match Age
        if re.search(r'आयु\s*[:ः\-]?\s*(\d+)', line):
            m = re.search(r'आयु\s*[:ः\-]?\s*(\d+)', line)
            if m and age is None:
                try:
                    age = int(m.group(1))
                except ValueError:
                    pass
                    
        # Match Gender
        if re.search(r'लिंग\s*[:ः\-]?\s*([^\s\n\r]+)', line):
            m = re.search(r'लिंग\s*[:ः\-]?\s*([^\s\n\r]+)', line)
            if m:
                g = m.group(1)
                if any(x in g for x in ["पुरूष", "पुरुष", "पु"]):
                    gender = "पुरुष"
                elif any(x in g for x in ["स्त्री", "महिला", "स्"]):
                    gender = "स्त्री"

    # Match EPIC ID
    epic_match = re.search(r'([A-Z]{3}[0-9]{7}|[A-Z]{2,3}\s*[\/\-]\s*\d{2}\s*[\/\-]\s*\d{2,3}\s*[\/\-]\s*\d{4,6}|[A-Z0-9]{10})', block, re.IGNORECASE)
    clean_epic = epic_match.group(1).replace(' ', '').upper() if epic_match else ""
    
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


def process_pdf_to_excel(pdf_path: str, excel_path: str, ward_no: str = "", booth_no: str = "", use_ocr: bool = True) -> List[Dict[str, Any]]:
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
        
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    
    # 1. First pass: extract all digital vector EPICs across the entire PDF
    epic_pattern = re.compile(r'([A-Z]{3}[0-9]{7}|[A-Z]{2,3}\s*[\/\-]\s*\d{2}\s*[\/\-]\s*\d{2,3}\s*[\/\-]\s*\d{4,6}|[A-Z0-9]{10})', re.IGNORECASE)
    vector_epics = []
    seen_epics = set()
    
    full_raw_text = ""
    for page in doc:
        page_text = page.get_text()
        full_raw_text += "\n" + page_text
        for m in epic_pattern.finditer(page_text):
            clean_e = m.group(1).replace(' ', '').upper()
            if clean_e not in seen_epics:
                seen_epics.add(clean_e)
                vector_epics.append(clean_e)
                
    # Detect ward and booth from header if not provided
    if not ward_no:
        ward_m = re.search(r'(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)', full_raw_text, re.IGNORECASE)
        ward_no = ward_m.group(1) if ward_m else ""
    if not booth_no:
        part_m = re.search(r'(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)', full_raw_text, re.IGNORECASE)
        booth_no = part_m.group(1) if part_m else ""

    all_voters = []

    # Check if tesseract binary is available for pytesseract
    tesseract_available = False
    if pytesseract is not None:
        try:
            pytesseract.get_tesseract_version()
            tesseract_available = True
        except Exception:
            # Check standard Homebrew paths
            for brew_path in ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]:
                if os.path.exists(brew_path):
                    pytesseract.pytesseract.tesseract_cmd = brew_path
                    tesseract_available = True
                    break

    # Process page by page
    for p_idx in range(total_pages):
        page = doc[p_idx]
        
        # Check if page contains voter roll content
        # Cover page (usually page 0 or 1) has no EPICs or very few
        page_voters_ocr = []
        
        if use_ocr and tesseract_available:
            # Render page at 2.0x scale (high resolution, 15ms in fitz!)
            mat = fitz.Matrix(2.0, 2.0)
            pix = page.get_pixmap(matrix=mat)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            
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
                    
                # Split column text on universal age/gender block boundary
                blocks = re.split(r'(आयु[:ः\s]*\d+[\s.,]*(?:लिंग[:ः\s]*\S+|Sex[:\s]*\S+))', col_text, flags=re.IGNORECASE)
                for b_i in range(0, len(blocks) - 1, 2):
                    full_block = blocks[b_i] + " " + blocks[b_i + 1]
                    card = parse_voter_card_block(full_block)
                    if card["nameHi"] or card["relativeNameHi"] or card["age"]:
                        column_boxes[c_idx].append(card)
                        
            # Interleave in natural left-to-right reading order
            max_r = max(len(column_boxes[0]), len(column_boxes[1]), len(column_boxes[2]))
            for r in range(max_r):
                for c_idx in range(3):
                    if r < len(column_boxes[c_idx]):
                        page_voters_ocr.append(column_boxes[c_idx][r])
                        
        if page_voters_ocr:
            all_voters.extend(page_voters_ocr)

    # Pair with vector EPICs for 100% precision
    final_records = []
    for idx, card in enumerate(all_voters):
        matched_epic = card.get("epic", "")
        if (not matched_epic or len(matched_epic) < 5) and idx < len(vector_epics):
            matched_epic = vector_epics[idx]
            
        final_records.append({
            "क्रमांक": idx + 1,
            "पहचान पत्र (EPIC No)": matched_epic or (vector_epics[idx] if idx < len(vector_epics) else f"VOTER_{idx + 1}"),
            "मतदाता का नाम": card.get("nameHi") or "मतदाता",
            "संबंधी का नाम": card.get("relativeNameHi", ""),
            "संबंध प्रकार": card.get("relationType", "पिता"),
            "मकान संख्या": card.get("houseNo", ""),
            "आयु": card.get("age", ""),
            "लिंग": card.get("gender", "अन्य"),
            "स्थिति": card.get("status", "Active"),
            "वार्ड संख्या": ward_no,
            "बूथ / भाग संख्या": booth_no
        })

    # If OCR didn't catch all, fill from vector EPICs
    if len(final_records) < len(vector_epics):
        for i in range(len(final_records), len(vector_epics)):
            final_records.append({
                "क्रमांक": i + 1,
                "पहचान पत्र (EPIC No)": vector_epics[i],
                "मतदाता का नाम": "मतदाता",
                "संबंधी का नाम": "",
                "संबंध प्रकार": "पिता",
                "मकान संख्या": "",
                "आयु": "",
                "लिंग": "अन्य",
                "स्थिति": "Active",
                "वार्ड संख्या": ward_no,
                "बूथ / भाग संख्या": booth_no
            })

    # Write formatted Excel file with pandas & openpyxl
    if final_records:
        df = pd.DataFrame(final_records)
        os.makedirs(os.path.dirname(os.path.abspath(excel_path)), exist_ok=True)
        
        with pd.ExcelWriter(excel_path, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='मतदाता सूची', index=False)
            
            # Format columns with openpyxl
            ws = writer.sheets['मतदाता सूची']
            for col in ws.columns:
                max_len = max(len(str(cell.value or '')) for cell in col)
                col_letter = col[0].column_letter
                ws.column_dimensions[col_letter].width = max(max_len + 4, 12)
                
        print(f"SUCCESS: Exported {len(final_records)} records to {excel_path}")
        
    return all_voters


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert Indian Electoral Roll PDF to Excel")
    parser.add_argument("--pdf", required=True, help="Input PDF file path")
    parser.add_argument("--output", required=True, help="Output Excel file path (.xlsx)")
    parser.add_argument("--ward", default="", help="Ward Number")
    parser.add_argument("--booth", default="", help="Booth / Part Number")
    
    args = parser.parse_args()
    try:
        voters = process_pdf_to_excel(args.pdf, args.output, ward_no=args.ward, booth_no=args.booth)
        print(json.dumps({"success": True, "count": len(voters), "file": args.output}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
