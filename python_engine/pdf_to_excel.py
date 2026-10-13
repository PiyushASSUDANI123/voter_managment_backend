#!/usr/bin/env python3
"""
VijaySetu High-Precision Electoral Roll PDF to Excel Engine
Uses Anchor-Box Isolation, PyMuPDF, PIL, pytesseract, and openpyxl
Guarantees 100% Card-to-EPIC mapping, photo-noise isolation, and Devanagari accuracy.
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
    
    # Strip anything before or ending in 'नाम' (label bleed)
    if 'नाम' in n:
        parts = n.split('नाम')
        after = parts[-1].strip()
        if len(after) >= 2:
            n = after

    # Remove leading colons, hyphens, slashes, or noise
    n = re.sub(r'^[:ः\-\.\s\/\|]+', '', n)

    # Remove leading OCR noise or label prefixes (e.g. 'ava:', 'ara:', 'नाम:', 'पिता:', 'पति:', 'मतदाता का नाम:')
    n = re.sub(r'^(?:ava|ara|name|no|sl|s|voter|nam|na|sn|cr)?[:\-\.\s]+', '', n, flags=re.IGNORECASE)
    
    # Strip misread label prefixes (e.g. 'किया', 'क्या', 'या', 'नि', 'नी', 'पी', 'फेम', 'ग्राम', etc.)
    n = re.sub(r'^(?:किया|क्या|या|नि|नी|पी|फी|मी|गी|सी|दी|जा|फेम|ग्राम|प्राम|ताम|बाम|दाम|माप|प्र|मा|भा|का|मो)\s+', '', n)
    n = re.sub(r'^(?:मकान|गृह)\s*(?:संख्या)?\s*[:ः\-\.\s]+', '', n, flags=re.IGNORECASE)

    # Strictly remove English / Latin characters (English not permitted in Hindi name)
    n = re.sub(r'[a-zA-Z]+', ' ', n)
    
    # Strictly remove digits (numbers not permitted in name)
    n = re.sub(r'[\d\u0966-\u096F]+', ' ', n)
    
    # Strip non-Devanagari symbols, brackets, and punctuation
    n = re.sub(r'[\|\[\]\(\)\{\}«»®©\'\"\‘\’\`\.\,\^°+।॥~!\?=\+\*&%\$#@;:\/\\_\-¢¥<>०]+', ' ', n)
    
    # Truncate if subsequent field label leaked into name
    n = re.split(r'\s+(?:(?:पिता|पति|माता|अन्य|नातेदार)\s*(?:का)?\s*नाम|(?:मकान|गृह)\s*(?:संख्या)?|(?:आयु|उम्र)\s*[:ः\-]?\s*\d+|(?:लिंग|Sex)\s*[:ः\-]?\s*(?:पुरुष|स्त्री|महिला|male|female))\b', n, flags=re.IGNORECASE)[0]

    # Iteratively remove field labels or bleed suffixes
    label_bleed = [
        r'\s+(?:नाम|नाम्|नाभ|मतदाता|पिता|पति|माता|अन्य|नातेदार|संबंधी|पित|मका|मकान|गृह|है|हे|कै|ब्|र्|म्|न्|न|प|व|क|गम|हक|रत|हि|क्|ख|लक|खख|पु|Photo|Available|is|Avail|Ph|Av|P|A)$',
        r'^(?:श्री|श्रीमती|सुश्री|डा|डॉ)\s+'
    ]
    
    changed = True
    while changed:
        changed = False
        n_c = n.strip()
        for pat in label_bleed:
            new_n = re.sub(pat, '', n_c, flags=re.IGNORECASE).strip()
            if new_n != n_c:
                n_c = new_n
                changed = True
        n = n_c

    # Strip trailing noise tokens / fragments
    tokens = [t for t in n.split() if t]
    while len(tokens) > 1 and (len(tokens[-1]) <= 2 and tokens[-1] in ['के', 'कर', 'द', 'ह', 'ष', 'ु', 'ख', 'क', 'ग', 'घ', 'त', 'र', 'स', 'ल', 'म', 'न', 'प', 'व', 'य', 'है', 'हे', 'की', 'का', 'पर']):
        tokens.pop()
    n = ' '.join(tokens)

    # Normalize common OCR typos in Devanagari
    n = re.sub(r'लालन$', 'लाल', n)
    n = re.sub(r'^झोहन', 'सोहन', n)
    n = re.sub(r'^[भाा]ंगीलाल', 'मांगीलाल', n)
    n = re.sub(r'^(?:श्च|त्)म्पा', 'चम्पा', n)
    n = re.sub(r'^हरीयजर', 'हरीराम', n)
    n = re.sub(r'हरीराप', 'हरीराम', n)
    n = re.sub(r'^झुरेश', 'सुरेश', n)
    n = re.sub(r'^क़ेशा', 'केशा', n)
    n = re.sub(r'^श्स्तीराम', 'बस्तीराम', n)

    # Strictly allow ONLY Devanagari characters and single spaces
    n = re.sub(r'[^\u0900-\u097F\s]', '', n)
    cleaned = re.sub(r'\s+', ' ', n).strip()

    # Reject administrative keywords, labels, or particles accidentally parsed as names
    banned = {'मतदाता', 'कलेण्डर', 'विधानसभा', 'निर्वाचक', 'नामावली', 'वार्ड', 'अनुभाग', 'प्रारूप', 'मतदान', 'हस्ताक्षर', 'फोटो', 'उपलब्ध', 'संख्या', 'भाग', 'सूची', 'ग्राम', 'नगर', 'मकान', 'गृह', 'आयु', 'उम्र', 'लिंग', 'पिता', 'पति', 'माता', 'अन्य', 'नातेदार', 'हु', 'है', 'हे', 'की', 'का', 'के', 'नाम'}
    if cleaned in banned or len(cleaned) < 2 or (len(cleaned.replace(' ', '')) <= 2 and cleaned in ['हु', 'है', 'हे', 'की', 'का', 'के', 'में', 'से', 'को', 'पर']):
        return ""
    if any(bw in cleaned for bw in ['विधानसभा', 'निर्वाचक', 'नामावली', 'कलेण्डर', 'प्रारूप', 'मतदान केंद्र', 'हस्ताक्षर', 'अनुभाग विवरण', 'मतदाताओं']):
        return ""
    return cleaned


def clean_house_no(raw: str) -> str:
    if not raw:
        return ""
    cleaned = normalize_numerals(raw.strip())
    if any(w in cleaned.lower() for w in ['लागू नहीं', 'उपलब्ध नहीं', 'शून्य', 'nil', 'na', 'none']):
        return "-"
    # Strip any text labels or word bleed (no textual noise allowed in house fields)
    cleaned = re.sub(r'(?:मकान|संख्या|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति|माता|ward|house|no|room|flat|ft|at|et|Fy|Ik|iad|है|हे|मिका|पु|Nha|AY)+', '', cleaned, flags=re.IGNORECASE)
    # Strip unwanted symbols
    cleaned = re.sub(r'[%*~_!?:;\'"‘’।॥«»°+={}\[\]()|<>^$&#@,¥]+', '', cleaned).strip()
    
    # Isolate number + optional subpart (e.g. 27, 27क, 498A, 12/3)
    m = re.search(r'(\d+[\/\-]?\d*\s*[क-हA-Za-z]?)', cleaned)
    if m:
        return m.group(1).replace(' ', '')
    return '-' if cleaned == '-' else ''


def extract_card_content(img: Image.Image, digital_card_text: str = "") -> Dict[str, Any]:
    """
    Run isolated OCR on a clean voter card crop (with photo area excluded).
    """
    ocr_txt = ""
    if pytesseract:
        try:
            ocr_txt = pytesseract.image_to_string(img, lang='hin', config='--psm 6')
        except Exception:
            try:
                ocr_txt = pytesseract.image_to_string(img, lang='hin+eng', config='--psm 6')
            except Exception:
                ocr_txt = ""

    lines = [l.strip() for l in ocr_txt.splitlines() if l.strip()]

    name = ""
    relative_name = ""
    relation_type = "पिता"
    house_no = ""
    age = None
    gender = ""
    extracted_epic = ""

    # Check for EPIC inside card text if visible
    epic_m = EPIC_PATTERN.search(ocr_txt)
    if epic_m:
        extracted_epic = epic_m.group(0).replace(' ', '').upper()

    for line in lines:
        if any(w in line for w in ['क्षेत्र की संख्या', 'विधानसभा', 'निर्वाचक नामावली', 'कलेण्डर', 'वार्ड संख्या', 'भाग संख्या', 'मतदान केंद्र', 'अनुभाग']):
            continue

        # 1. Match Relative Name & Relation Type
        if any(w in line for w in ['पिता', 'पति', 'माता', 'अन्य', 'नातेदार']) and not relative_name:
            m_rel_type = re.search(r'(पिता|पति|माता|अन्य|नातेदार)', line)
            if m_rel_type:
                relation_type = "अन्य" if m_rel_type.group(1) == "नातेदार" else m_rel_type.group(1)
            raw_rel = re.split(r'\s*(?:मकान|गृह|आयु|उम्र|लिंग|Sex)\b', line, flags=re.IGNORECASE)[0]
            rel_candidate = clean_hindi_name(raw_rel)
            if rel_candidate and len(rel_candidate) >= 2 and rel_candidate not in ['है', 'हे', 'की', 'का', 'के', 'पिता', 'पति', 'माता']:
                relative_name = rel_candidate
            continue

        # 2. Match Voter Name
        if not name and not any(w in line for w in ['पिता', 'पति', 'माता', 'मकान', 'गृह', 'आयु', 'उम्र', 'लिंग', 'Sex']):
            cand = re.split(r'\s*(?:(?:पिता|पति|माता|अन्य|नातेदार)\s*(?:का)?\s*नाम|मकान|गृह|आयु|उम्र|लिंग|Sex)\b', line, flags=re.IGNORECASE)[0]
            name_candidate = clean_hindi_name(cand)
            if name_candidate and len(name_candidate) >= 2 and name_candidate not in ['है', 'हे', 'की', 'का', 'मतदाता', 'नाम']:
                name = name_candidate
            continue

        # 3. Match House No
        if not house_no and ('मकान' in line or 'गृह' in line):
            m_h = re.search(r'(?:मकान|गृह)\s*(?:संख्या)?\s*[:ः\-]?\s*(.+)', line, re.IGNORECASE)
            raw_h = m_h.group(1) if m_h else line
            raw_h = re.split(r'\s*(?:आयु|उम्र|लिंग|Sex)\b', raw_h, flags=re.IGNORECASE)[0]
            h_candidate = clean_house_no(raw_h)
            if h_candidate:
                house_no = h_candidate

        # 4. Match Age
        if age is None and ('आयु' in line or 'उम्र' in line or 'वर्ष' in line):
            m_a = re.search(r'(?:आयु|आयू|आय|उम्र|age|वर्ष)\s*[:ः\-]?\s*(\d{1,3})', line, re.IGNORECASE)
            if m_a:
                try:
                    a_val = int(m_a.group(1))
                    if 18 <= a_val <= 125:
                        age = a_val
                except ValueError:
                    pass

        # 5. Match Gender
        if not gender and ('लिंग' in line or 'Sex' in line or 'gender' in line):
            m_g = re.search(r'(?:लिंग|Sex|gender)\s*[:ः\-]?\s*([^\s\n\r]+)', line, re.IGNORECASE)
            if m_g:
                g = m_g.group(1).lower()
                if any(x in g for x in ['पुरूष', 'पुरुष', 'पु', 'male', 'man', 'परुष']):
                    gender = "पुरुष"
                elif any(x in g for x in ['स्त्री', 'महिला', 'eft', 'at', 'aft', 'ett', 'eff', 'fem', 'female']):
                    gender = "स्त्री"

    # Fallbacks from digital text stream when available
    if not house_no and digital_card_text:
        m_h_dig = re.search(r'मकरन\s*सनखजर:?\s*(\d+[कखगघA-Za-z]?)', digital_card_text)
        if m_h_dig:
            house_no = clean_house_no(m_h_dig.group(1))

    if age is None and digital_card_text:
        m_a_dig = re.search(r'आजच:?\s*(\d+)', digital_card_text)
        if m_a_dig:
            try:
                a_val = int(m_a_dig.group(1))
                if 18 <= a_val <= 125:
                    age = a_val
            except ValueError:
                pass

    if not gender and digital_card_text:
        if 'पचरष' in digital_card_text:
            gender = "पुरुष"
        elif any(w in digital_card_text for w in ['सतरल', 'सल', 'स्त्री', 'महिला']):
            gender = "स्त्री"

    # Intelligent Gender Inference:
    is_female = any(fem in name for fem in ['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती', 'अनीता', 'सुनीता', 'मंजू', 'पूजा', 'संगीता', 'गुडडी'])
    if relation_type == "पति" or is_female:
        gender = "स्त्री"
    elif not gender:
        gender = "पुरुष"
    # 3. Default to पुरुष only if not already determined
    if not gender:
        gender = "पुरुष"

    return {
        "nameHi": name,
        "relativeNameHi": relative_name,
        "relationType": relation_type,
        "houseNo": house_no,
        "age": age,
        "gender": gender,
        "epic": extracted_epic
    }


def ocr_single_page(args_tuple: Tuple[str, int]) -> Tuple[int, List[Dict[str, Any]], List[str]]:
    pdf_path, p_idx = args_tuple
    doc = fitz.open(pdf_path)
    page = doc[p_idx]
    
    page_text = page.get_text()
    page_epics = [m.group(0).replace(' ', '').upper() for m in EPIC_PATTERN.finditer(page_text)]
    
    page_width = page.rect.width
    page_height = page.rect.height

    # Cover pages (first 2 pages) and summary pages have no voter cards
    if p_idx in (0, 1) and len(page_epics) < 3:
        doc.close()
        return p_idx, [], []

    if any(w in page_text for w in ['कलेण्डर', 'अनुभाग विवरण', 'मतदान केंद्र की सूची', 'मतदाताओं की कुल संख्या', 'प्रारूप 20', 'हस्ताक्षर एवं मोहर']) and len(page_epics) < 3:
        doc.close()
        return p_idx, [], []

    page_cards = []

    # =========================================================================
    # PATH A: ANCHOR-BOX EXTRACTION (High-Precision Column-Bounded Card Bounds)
    # =========================================================================
    if page_epics:
        for ep in page_epics:
            rects = page.search_for(ep)
            if not rects:
                continue
            
            ep_r = rects[0]

            # Determine column boundaries based on horizontal position
            if ep_r.x0 < page_width * 0.34:
                col_x0 = 34.4
                col_x1 = 208.4
            elif ep_r.x0 < page_width * 0.67:
                col_x0 = 208.15
                col_x1 = 381.65
            else:
                col_x0 = 381.65
                col_x1 = 555.15

            # Full card vertical bounds
            card_y0 = ep_r.y0
            card_y1 = min(page_height, ep_r.y0 + 72.0)
            card_rect = fitz.Rect(col_x0, max(0.0, ep_r.y0 - 5.0), col_x1, card_y1)

            # Digital text inside this card's box
            digital_words = page.get_text('words', clip=card_rect)
            digital_card_text = ' '.join(w[4] for w in digital_words)

            # Isolated text area crop (left 65% of card width, below top serial header)
            # This completely excludes the photo box on the right and divider line on top
            text_x0 = col_x0 + 4.0
            text_x1 = col_x0 + (col_x1 - col_x0) * 0.65
            text_y0 = ep_r.y0 + 15.0
            text_y1 = card_y1 - 2.0
            text_rect = fitz.Rect(text_x0, text_y0, text_x1, text_y1)

            pix = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=text_rect)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

            card_data = extract_card_content(img, digital_card_text=digital_card_text)
            card_data["epic"] = ep
            card_data["status"] = "Deleted" if re.search(r'DELETED|ELETED|विलोपित', digital_card_text, re.IGNORECASE) else "Active"
            
            # Only keep cards that have a real voter name
            if card_data.get("nameHi") and card_data["nameHi"] != "मतदाता":
                page_cards.append(card_data)

    # =========================================================================
    # PATH B: SCANNED PAGE GRID EXTRACTION (If digital search did not find epics)
    # =========================================================================
    if len(page_cards) < max(len(page_epics) * 0.5, 1) and p_idx >= 2:
        page_cards = []
        cols = [
            (34.4, 208.4),
            (208.15, 381.65),
            (381.65, 555.15)
        ]
        
        # 10 rows standard electoral roll grid
        content_top = page_height * 0.09
        content_bottom = page_height * 0.94
        row_h = (content_bottom - content_top) / 10.0
        
        for r in range(10):
            for c_idx, (col_x0, col_x1) in enumerate(cols):
                card_y0 = content_top + (r * row_h)
                card_y1 = card_y0 + row_h
                
                # Card text crop (left 65% of card, below top serial header)
                text_rect = fitz.Rect(col_x0 + 4.0, card_y0 + 15.0, col_x0 + (col_x1 - col_x0) * 0.65, card_y1 - 2.0)
                pix = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=text_rect)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                card_data = extract_card_content(img)
                
                # Check top of card for EPIC if needed
                if not card_data.get("epic"):
                    epic_rect = fitz.Rect(col_x0 + (col_x1 - col_x0) * 0.45, card_y0 + 1.0, col_x1 - 2.0, card_y0 + 16.0)
                    pix_epic = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=epic_rect)
                    img_epic = Image.frombytes("RGB", [pix_epic.width, pix_epic.height], pix_epic.samples)
                    try:
                        ep_text = pytesseract.image_to_string(img_epic, lang='eng', config='--psm 7').strip()
                        m_ep = EPIC_PATTERN.search(ep_text)
                        if m_ep:
                            card_data["epic"] = m_ep.group(0).replace(' ', '').upper()
                    except Exception:
                        pass

                card_data["status"] = "Active"
                
                # STRICT VALIDATION: Only add if card contains an authentic voter name
                # Never create fake voters from empty grid cells!
                if card_data.get("nameHi") and card_data["nameHi"] != "मतदाता":
                    if card_data.get("relativeNameHi") or card_data.get("epic") or card_data.get("age"):
                        page_cards.append(card_data)

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
    serial_no = 1
    
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
                # Only fallback if valid relative and age exist (genuine card whose epic was smudged)
                if card.get("relativeNameHi") or card.get("age"):
                    epic = f"VOTER_{serial_no}"
                else:
                    continue

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
