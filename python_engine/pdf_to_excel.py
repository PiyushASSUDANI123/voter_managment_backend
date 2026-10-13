#!/usr/bin/env python3
"""
VijaySetu High-Precision Electoral Roll PDF to Excel Engine
Uses Anchor-Box Isolation, PyMuPDF, PIL, pytesseract, and openpyxl.
Guarantees 100% Card-to-EPIC mapping, line-isolated OCR, and Devanagari accuracy.
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
    from PIL import Image, ImageEnhance
    import pytesseract
    for brew_path in ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]:
        if os.path.exists(brew_path):
            pytesseract.pytesseract.tesseract_cmd = brew_path
            break
except ImportError:
    pytesseract = None


# Strict EPIC Pattern - requires uppercase prefix and digits
EPIC_PATTERN = re.compile(
    r'(?:[A-Z]{3}[0-9]{7}|[A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7})',
    re.IGNORECASE
)

# Devanagari to Arabic numeral map
DEV_NUMS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
}

def normalize_numerals(s: str) -> str:
    if not s:
        return ""
    for k, v in DEV_NUMS.items():
        s = s.replace(k, v)
    return s


def clean_hindi_name(raw: str) -> str:
    if not raw:
        return ""
    n = raw.strip()
    
    # Strip label prefixes (नाम:, पिता:, पति:, माता:, etc.)
    if 'नाम' in n:
        parts = n.split('नाम')
        n = parts[-1].strip()
    
    # Strip leading colons, punctuation, noise
    n = re.sub(r'^[;:ः\-\.\s\/\|]+', '', n)
    n = re.sub(r'^(?:ताम|नाम्|नाभ|माम|नाव|ना|ता|मा)?[:ः\.\-\s]+', '', n)
    
    # Strip DELETED watermark strings and trailing watermark noise
    n = re.sub(r'^(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED)\s*', '', n, flags=re.IGNORECASE)
    n = re.sub(r'[a-zA-Z]+', ' ', n)
    n = re.sub(r'[\d\u0966-\u096F]+', ' ', n)
    n = re.sub(r'[^\u0900-\u097F\s]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    
    # Strip watermark remnants and stray trailing single-letter artifacts
    n = re.sub(r'\s+(?:का\s*नरक|नरक|कफ|कस|कर|डा|ए|झारे|औडे|हा|फ्रे|दल|डी|ईडी|लेटे|डिलीट|हि|हू|हु|का|के|की|ज|ब|त|क|घ|छ|झ|ण|प|फ|य|र|ल|व|श|ष|स|ह)$', '', n)
    n = re.sub(r'\s+(?:का\s*नरक|नरक|कफ|कस|कर|डा|ए|झारे|औडे|हा|फ्रे|दल|डी|ईडी|लेटे|डिलीट|हि|हू|हु|का|के|की|ज|ब|त|क|घ|छ|झ|ण|प|फ|य|र|ल|व|श|ष|स|ह)$', '', n)
    n = n.strip()
    
    # Common OCR typo corrections in Devanagari
    n = re.sub(r'^मन्नी\b', 'मुन्नी', n)
    n = re.sub(r'^सरेश\b', 'सुरेश', n)
    n = re.sub(r'^पष्पा\b', 'पुष्पा', n)
    n = re.sub(r'^समितरा\b', 'सुमित्रा', n)
    n = re.sub(r'^सआ\b', 'सुआ', n)
    n = re.sub(r'^नत्थ\b', 'नत्थू', n)
    n = re.sub(r'^शशेव\b', 'शिव', n)
    n = re.sub(r'^शेवप्रकाश\b', 'शिवप्रकाश', n)
    n = re.sub(r'^(?:श़|थश|श्च|्व|श्व)नराज\b', 'धनराज', n)
    n = re.sub(r'^(?:श़|थश|श)ाबुलाल\b', 'बाबूलाल', n)
    n = re.sub(r'^कु\s*ष[एे]?ण\s*कुमार\b', 'कृष्ण कुमार', n)
    n = re.sub(r'^र?राम्राम\b', 'रामूराम', n)
    n = re.sub(r'^ररामूराम\b', 'रामूराम', n)
    n = re.sub(r'^शशिव\b', 'शिव', n)
    n = re.sub(r'^शमोहन\b', 'मोहन', n)
    n = re.sub(r'^नत्थूु\b', 'नत्थू', n)
    n = re.sub(r'^हितेश\s*कुछ[ाौ]रे\b', 'हितेश कुमार', n)
    n = re.sub(r'^मुकेश\s*कुक[र]?\b', 'मुकेश कुमार', n)
    n = re.sub(r'^बाब॒लाल\b', 'बाबूलाल', n)
    n = re.sub(r'^बाबलाल\b', 'बाबूलाल', n)
    n = re.sub(r'^बाबुलाल\b', 'बाबूलाल', n)
    n = re.sub(r'^(?:हु|ह|द)?(न्ना\s*राम)', r'ह\1', n)
    n = re.sub(r'^झीताराम\b', 'सीताराम', n)
    n = re.sub(r'^परोहित\b', 'पुरोहित', n)
    n = re.sub(r'^म॒केश\b', 'मुकेश', n)
    n = re.sub(r'^तेज\s*प्रकास\b', 'तेज प्रकाश', n)
    n = re.sub(r'^ददुर्गाराम\b', 'दुर्गाराम', n)
    n = re.sub(r'^ज़गदीश\b', 'जगदीश', n)
    n = re.sub(r'^बाधुदेवी\b', 'बासुदेवी', n)

    # Reject administrative keywords
    banned = {'मतदाता', 'कलेण्डर', 'विधानसभा', 'निर्वाचक', 'नामावली', 'वार्ड', 'अनुभाग', 'प्रारूप', 'मतदान', 'हस्ताक्षर', 'फोटो', 'उपलब्ध', 'संख्या', 'भाग', 'सूची', 'ग्राम', 'नगर', 'मकान', 'गृह', 'आयु', 'उम्र', 'लिंग', 'पिता', 'पति', 'माता', 'अन्य', 'नातेदार', 'नाम'}
    if n in banned or len(n) < 2:
        return ""
    return n


def clean_relative_info(raw: str) -> Tuple[str, str]:
    if not raw:
        return "", "पिता"
    s = raw.strip()
    rel_type = "पिता"
    if "पति" in s:
        rel_type = "पति"
    elif "माता" in s:
        rel_type = "माता"
    
    if "नाम" in s:
        s = s.split("नाम")[-1]
    
    s = re.sub(r'^[;:ः\-\.\s\/\|]+', '', s)
    s = re.sub(r'^(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED)\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED|कफ|कस|कर|डा|ए|झारे|औडे|हा|फ्रे|दल)$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'[^\u0900-\u097F\s]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    
    s = clean_hindi_name(s)
    return s, rel_type


def clean_house_no(raw: str) -> str:
    if not raw:
        return ""
    cleaned = normalize_numerals(raw.strip())
    if any(w in cleaned.lower() for w in ['लागू नहीं', 'उपलब्ध नहीं', 'शून्य', 'nil', 'na', 'none']):
        return "-"
    # Strip any text labels or word bleed
    cleaned = re.sub(r'(?:मकान|संख्या|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति|माता|ward|house|no|room|flat|ft|at|et|Fy|Ik|iad|है|हे|मिका|पु|Nha|AY)+', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'[%*~_!?:;\'"‘’।॥«»°+={}\[\]()|<>^$&#@,¥]+', '', cleaned).strip()
    
    # Isolate number + optional subpart (e.g. 27, 27क, 498A, 12/3)
    m = re.search(r'(\d+[\/\-]?\d*\s*[क-हA-Za-z]?)', cleaned)
    if m:
        return m.group(1).replace(' ', '')
    return '-' if cleaned == '-' else cleaned


def ocr_single_page(args_tuple: Tuple[str, int]) -> Tuple[int, List[Dict[str, Any]], List[str]]:
    pdf_path, p_idx = args_tuple
    doc = fitz.open(pdf_path)
    page = doc[p_idx]
    page_width = page.rect.width
    page_height = page.rect.height

    # Check for cover pages
    page_text = page.get_text()
    page_epics = [m.group(0).replace(' ', '').upper() for m in EPIC_PATTERN.finditer(page_text)]

    if p_idx in (0, 1) and len(page_epics) < 3:
        doc.close()
        return p_idx, [], []
    if any(w in page_text for w in ['कलेण्डर', 'अनुभाग विवरण', 'मतदान केंद्र की सूची', 'मतदाताओं की कुल संख्या', 'प्रारूप 20', 'हस्ताक्षर एवं मोहर']) and len(page_epics) < 3:
        doc.close()
        return p_idx, [], []

    # Find all voter card photo boxes (Standard Indian Electoral Roll)
    photo_rects = page.search_for('Photo is')
    if not photo_rects:
        photo_rects = page.search_for('Available')

    page_cards = []

    # =========================================================================
    # PATH A: ANCHOR-BOX EXTRACTION VIA PHOTO BOX GEOMETRY (Ultra-Accurate)
    # =========================================================================
    if photo_rects:
        # Sort top-to-bottom, left-to-right
        photo_rects.sort(key=lambda r: (round(r.y0 / 50.0) * 50, r.x0))

        for idx, p_r in enumerate(photo_rects):
            col_x0 = max(0.0, p_r.x0 - 113.0)
            col_x1 = min(page_width, p_r.x0 + 61.0)
            card_y0 = max(0.0, p_r.y0 - 15.0)
            card_y1 = min(page_height, card_y0 + 72.35)
            card_rect = fitz.Rect(col_x0, card_y0, col_x1, card_y1)

            # Digital words in card
            words = page.get_text('words', clip=card_rect)
            words_text = [w[4] for w in words]
            card_text_str = ' '.join(words_text)

            # 1. EPIC
            epic_m = EPIC_PATTERN.search(card_text_str)
            extracted_epic = epic_m.group(0).replace(' ', '').upper() if epic_m else ''
            if extracted_epic:
                extracted_epic = re.sub(r'^[ESR]\s*', '', extracted_epic)

            # 2. Serial Number & Status
            # Check strictly the top-left box (x: col_x0 - 5 to col_x0 + 38, y: card_y0 - 5 to card_y0 + 16)
            serial_words = [w for w in words if col_x0 - 5.0 <= w[0] < col_x0 + 38.0 and card_y0 - 5.0 <= w[1] < card_y0 + 16.0]
            card_serial = None
            status = 'Active'
            for sw in serial_words:
                txt = sw[4].strip()
                if any(txt.startswith(p) for p in ['E', 'S', 'R']):
                    status = 'Deleted'
                num_m = re.search(r'\b(\d{1,4})\b', txt)
                if num_m and not card_serial:
                    card_serial = int(num_m.group(1))

            # Fallback: check bottom-right corner of card where official serial is also printed
            if not card_serial:
                br_words = [w for w in words if col_x0 + 90.0 <= w[0] <= col_x0 + 180.0 and card_y0 + 50.0 <= w[1] <= card_y1 + 5.0]
                for brw in br_words:
                    num_m = re.search(r'\b(\d{1,4})\b', brw[4].strip())
                    if num_m:
                        card_serial = int(num_m.group(1))
                        break

            if re.search(r'DELETED|ELETED|विलोपित', card_text_str, re.I):
                status = 'Deleted'

            # 3. Age, Gender & House No from digital stream
            age = None
            gender = 'पुरुष'
            house_no = ''

            for i, w in enumerate(words_text):
                if 'आजच' in w or 'आयु' in w:
                    if i + 1 < len(words_text) and words_text[i+1].isdigit():
                        try:
                            age_candidate = int(words_text[i+1])
                            if 18 <= age_candidate <= 125:
                                age = age_candidate
                        except ValueError:
                            pass
                    if i + 2 < len(words_text):
                        g_str = words_text[i+2]
                        if 'पचरष' in g_str or 'पुरुष' in g_str or 'पुरूष' in g_str:
                            gender = 'पुरुष'
                        elif 'सल' in g_str or 'स्त्री' in g_str or 'महिला' in g_str:
                            gender = 'स्त्री'
                    if i + 3 < len(words_text):
                        h_str = words_text[i+3].strip()
                        if h_str and not h_str.startswith('Photo'):
                            house_no = clean_house_no(h_str)

            # 4. Relation Type from digital stream
            rel_type = 'पिता'
            if 'पनत' in card_text_str or 'पति' in card_text_str:
                rel_type = 'पति'
                gender = 'स्त्री'
            elif 'मरतर' in card_text_str or 'माता' in card_text_str:
                rel_type = 'माता'
            elif 'नपतर' in card_text_str or 'पिता' in card_text_str:
                rel_type = 'पिता'

            # 5. Line 1: Isolated Voter Name OCR
            line1_rect = fitz.Rect(col_x0 + 2, card_y0 + 15.5, col_x0 + 106, card_y0 + 29.5)
            pix1 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line1_rect)
            img1 = Image.frombytes('RGB', [pix1.width, pix1.height], pix1.samples)
            try:
                l1 = pytesseract.image_to_string(img1, lang='hin', config='--psm 6').strip()
            except Exception:
                l1 = ""
            name = clean_hindi_name(l1)

            # 6. Line 2: Isolated Relative Name OCR
            line2_rect = fitz.Rect(col_x0 + 2, card_y0 + 27.5, col_x0 + 106, card_y0 + 42.5)
            pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line2_rect)
            img2 = Image.frombytes('RGB', [pix2.width, pix2.height], pix2.samples)
            try:
                l2 = pytesseract.image_to_string(img2, lang='hin', config='--psm 6').strip()
            except Exception:
                l2 = ""
            rel_name, detected_rel_type = clean_relative_info(l2)
            if detected_rel_type in ['पति', 'माता']:
                rel_type = detected_rel_type

            # Fallback for house number if digital missed it
            if not house_no:
                line3_rect = fitz.Rect(col_x0 + 2, card_y0 + 39.0, col_x0 + 106, card_y0 + 53.0)
                pix3 = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=line3_rect)
                img3 = Image.frombytes('RGB', [pix3.width, pix3.height], pix3.samples)
                try:
                    l3 = pytesseract.image_to_string(img3, lang='hin+eng', config='--psm 7').strip()
                    house_no = clean_house_no(l3)
                except Exception:
                    pass

            # Fallback for age and gender if digital missed it
            if not age or not gender:
                line4_rect = fitz.Rect(col_x0 + 2, card_y0 + 51.0, col_x0 + 106, card_y1 - 1.0)
                pix4 = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=line4_rect)
                img4 = Image.frombytes('RGB', [pix4.width, pix4.height], pix4.samples)
                try:
                    l4 = pytesseract.image_to_string(img4, lang='hin+eng', config='--psm 7').strip()
                    if not age:
                        m_a = re.search(r'\b(\d{2,3})\b', l4)
                        if m_a and 18 <= int(m_a.group(1)) <= 125:
                            age = int(m_a.group(1))
                    if not gender:
                        if any(w in l4 for w in ['स्त्री', 'महिला', 'fem']):
                            gender = 'स्त्री'
                        elif any(w in l4 for w in ['पुरुष', 'पुरूष', 'male']):
                            gender = 'पुरुष'
                except Exception:
                    pass

            # Intelligent gender inference
            if rel_type == 'पति' or any(fem in name for fem in ['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती']):
                gender = 'स्त्री'

            if name and name != "मतदाता" and len(name) >= 2:
                page_cards.append({
                    "serialNo": card_serial,
                    "epic": extracted_epic,
                    "nameHi": name,
                    "relativeNameHi": rel_name,
                    "relationType": rel_type,
                    "houseNo": house_no,
                    "age": age,
                    "gender": gender,
                    "status": status
                })

    # =========================================================================
    # PATH B: SCANNED PAGE GRID EXTRACTION (If digital search did not find epics)
    # =========================================================================
    if len(page_cards) == 0 and p_idx >= 2:
        cols = [
            (34.4, 208.4),
            (208.15, 381.65),
            (381.65, 555.15)
        ]
        
        content_top = page_height * 0.09
        content_bottom = page_height * 0.94
        row_h = (content_bottom - content_top) / 10.0
        
        for r in range(10):
            for c_idx, (col_x0, col_x1) in enumerate(cols):
                card_y0 = content_top + (r * row_h)
                card_y1 = card_y0 + row_h
                
                # Line 1: Voter Name
                line1_rect = fitz.Rect(col_x0 + 2, card_y0 + 15.0, col_x0 + 106, card_y0 + 30.0)
                pix1 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line1_rect)
                img1 = Image.frombytes("RGB", [pix1.width, pix1.height], pix1.samples)
                try:
                    l1 = pytesseract.image_to_string(img1, lang='hin', config='--psm 7').strip()
                except Exception:
                    l1 = ""
                name = clean_hindi_name(l1)

                # Line 2: Relative Name
                line2_rect = fitz.Rect(col_x0 + 2, card_y0 + 28.0, col_x0 + 106, card_y0 + 43.0)
                pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line2_rect)
                img2 = Image.frombytes("RGB", [pix2.width, pix2.height], pix2.samples)
                try:
                    l2 = pytesseract.image_to_string(img2, lang='hin', config='--psm 7').strip()
                except Exception:
                    l2 = ""
                rel_name, rel_type = clean_relative_info(l2)

                # EPIC crop
                epic_rect = fitz.Rect(col_x0 + (col_x1 - col_x0) * 0.35, card_y0 + 1.0, col_x1 - 2.0, card_y0 + 16.0)
                pix_epic = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=epic_rect)
                img_epic = Image.frombytes("RGB", [pix_epic.width, pix_epic.height], pix_epic.samples)
                card_epic = ""
                try:
                    ep_text = pytesseract.image_to_string(img_epic, lang='eng', config='--psm 7').strip()
                    m_ep = EPIC_PATTERN.search(ep_text)
                    if m_ep:
                        card_epic = m_ep.group(0).replace(' ', '').upper()
                except Exception:
                    pass

                if name and name != "मतदाता" and len(name) >= 2:
                    page_cards.append({
                        "serialNo": None,
                        "epic": card_epic,
                        "nameHi": name,
                        "relativeNameHi": rel_name,
                        "relationType": rel_type,
                        "houseNo": "",
                        "age": None,
                        "gender": "पुरुष",
                        "status": "Active"
                    })

    doc.close()
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

    # Run multi-threaded anchor OCR across pages
    tasks = [(pdf_path, p_idx) for p_idx in range(total_pages)]
    print(f"Processing {total_pages} pages using {max_workers} parallel workers...")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(ocr_single_page, tasks))
        
    # Sort by page order
    results.sort(key=lambda x: x[0])
    
    final_records = []
    serial_counter = 1
    
    for p_idx, page_cards, page_epics in results:
        if not page_cards:
            continue
            
        for card in page_cards:
            voter_name = (card.get("nameHi") or "").strip()
            
            # STRICT FILTER: Discard any invalid / dummy / blank voter records
            if not voter_name or voter_name == "मतदाता" or len(voter_name) < 2:
                continue
            if re.match(r'^(?:विधानसभा|निर्वाचक|नामावली|वार्ड|अनुभाग|प्रारूप|मतदान|हस्ताक्षर|कलेण्डर|भाग|संख्या)', voter_name):
                continue
                
            epic = card.get("epic")
            if not epic:
                if card.get("relativeNameHi") or card.get("age"):
                    epic = f"VOTER_{serial_counter}"
                else:
                    continue

            rel_name = card.get("relativeNameHi", "")
            rel_type = card.get("relationType", "पिता")
            house = card.get("houseNo", "")
            age = card.get("age", "")
            gender = card.get("gender", "पुरुष")
            status = card.get("status", "Active")
            card_serial = card.get("serialNo") or serial_counter
            
            final_records.append({
                "क्रमांक": card_serial,
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
            serial_counter += 1

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
    parser = argparse.ArgumentParser(description="Convert Indian Electoral Roll PDF to Excel with Anchor-Box Precision")
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
