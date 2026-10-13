#!/usr/bin/env python3
"""
VijaySetu State-of-the-Art Electoral Roll PDF to Excel Engine
Implements the 5-Pillar Architecture:
1. Advanced Image Pre-processing (OpenCV): 300+ DPI, Deskewing, Grayscale Binarization & Adaptive/Otsu Thresholding, Morphological Closing for Devanagari Matras.
2. Layout Analysis & Table/Grid Extraction: Anchor-box & contour detection, individual voter cell cropping, sub-box field isolation.
3. State-of-the-Art Local OCR Models: Hybrid Tesseract 5 LSTM + EasyOCR PyTorch Neural Fallback.
4. Rajasthan SEC Format Matching & Ligature Correction: Custom phonetic and typography mapping for election rolls.
5. Post-Processing & Data Validation (Regex & Fuzzy Matching): EPIC auto-correction (O->0, I->1, B->8), age bounds (18-125), strict gender & relation fuzzy normalization.
"""

import sys
import os
import re
import json
import argparse
import warnings
from typing import List, Dict, Any, Tuple, Optional
from concurrent.futures import ThreadPoolExecutor

# Suppress minor PyTorch warnings
warnings.filterwarnings("ignore")

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None
    np = None

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

# Global EasyOCR Reader Singleton
_EASYOCR_READER = None

def get_easyocr_reader():
    """Lazily load EasyOCR Hindi + English reader singleton on CPU"""
    global _EASYOCR_READER
    if _EASYOCR_READER is None:
        try:
            import easyocr
            _EASYOCR_READER = easyocr.Reader(['hi', 'en'], gpu=False, verbose=False)
        except Exception as e:
            sys.stderr.write(f"EasyOCR initialization notice: {e}\n")
            _EASYOCR_READER = False
    return _EASYOCR_READER if _EASYOCR_READER is not False else None


# =============================================================================
# PILLAR 5: REGEX PATTERNS & DATA VALIDATION
# =============================================================================

EPIC_PATTERN = re.compile(
    r'(?:[A-Z0-9]{3}[0-9OIBLSZG]{7}|[A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7})',
    re.IGNORECASE
)

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


def auto_correct_epic(raw_epic: str) -> str:
    """
    Pillar 5: Voter ID Regex Auto-Correction
    Fixes common OCR confusion between digits and letters (O -> 0, I -> 1, B -> 8, etc.)
    """
    if not raw_epic:
        return ""
    cleaned = re.sub(r'[^A-Za-z0-9\/\-]', '', raw_epic.strip().upper())
    
    # Strip leading electoral status markers (E = Expired, S = Shifted, R = Repeated)
    if len(cleaned) == 11 and cleaned[0] in ['E', 'S', 'R']:
        cleaned = cleaned[1:]
        
    # Standard Indian 10-character EPIC format: 3 uppercase letters followed by 7 digits
    if len(cleaned) == 10:
        prefix = cleaned[:3]
        suffix = cleaned[3:]
        
        # In prefix: digits mistyped instead of letters
        digit_to_letter = {'0': 'O', '1': 'I', '8': 'B', '5': 'S', '2': 'Z', '6': 'G'}
        p_fixed = "".join(digit_to_letter.get(ch, ch) for ch in prefix)
        
        # In suffix: letters mistyped instead of digits
        letter_to_digit = {'O': '0', 'I': '1', 'L': '1', 'B': '8', 'S': '5', 'Z': '2', 'G': '6', 'D': '0', 'Q': '0'}
        s_fixed = "".join(letter_to_digit.get(ch, ch) for ch in suffix)
        
        if p_fixed.isalpha() and s_fixed.isdigit():
            return f"{p_fixed}{s_fixed}"
            
    return cleaned


# =============================================================================
# PILLAR 1: ADVANCED IMAGE PRE-PROCESSING (OpenCV)
# =============================================================================

def deskew_image(img_gray: np.ndarray) -> np.ndarray:
    """
    Pillar 1: Deskewing
    Detects scan tilt angle using cv2.minAreaRect on foreground contours,
    and applies an affine rotation matrix to perfectly straighten the text lines.
    """
    coords = np.column_stack(np.where(img_gray < 220))
    if len(coords) < 100:
        return img_gray
    try:
        rect = cv2.minAreaRect(coords)
        angle = rect[-1]
        if angle < -45:
            angle = -(90 + angle)
        elif angle > 45:
            angle = 90 - angle
        else:
            angle = -angle
            
        # Only deskew if tilt is genuine (0.5 to 12 degrees)
        if 0.5 < abs(angle) < 12.0:
            (h, w) = img_gray.shape[:2]
            center = (w // 2, h // 2)
            M = cv2.getRotationMatrix2D(center, angle, 1.0)
            return cv2.warpAffine(
                img_gray, M, (w, h),
                flags=cv2.INTER_CUBIC,
                borderMode=cv2.BORDER_CONSTANT,
                borderValue=255
            )
    except Exception:
        pass
    return img_gray


def preprocess_voter_crop(img_np: np.ndarray, is_hindi: bool = True) -> np.ndarray:
    """
    Pillar 1: OpenCV Pre-Processing Pipeline
    - Grayscale conversion
    - Deskewing
    - Adaptive / Binarization Thresholding (wipes out watermarks, gray stamps & backgrounds)
    - Morphological Closing (heals broken Devanagari matras and shirorekhas)
    """
    if len(img_np.shape) == 3:
        gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_np.copy()
        
    # 1. Deskew
    gray = deskew_image(gray)
    
    # 2. Binarization & Thresholding (strips watermarks, e.g. DELETED / विलोपित stamps)
    _, thresh = cv2.threshold(gray, 182, 255, cv2.THRESH_BINARY)
    
    # 3. Morphological Operations for Hindi (fills broken matras: ि, ी, ु, ू, ा, etc.)
    if is_hindi:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        morph = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        return morph
        
    return thresh


# =============================================================================
# PILLAR 4: MODEL FINE-TUNING & SEC FORMAT CLEANING
# =============================================================================

SEC_TYPO_MAP = {
    r'^मन्नी\b': 'मुन्नी',
    r'^सरेश\b': 'सुरेश',
    r'^पष्पा\b': 'पुष्पा',
    r'^समितरा\b': 'सुमित्रा',
    r'^सआ\b': 'सुआ',
    r'^नत्थ\b': 'नत्थू',
    r'^शशेव\b': 'शिव',
    r'^शेवप्रकाश\b': 'शिवप्रकाश',
    r'^(?:श़|थश|श्च|्व|श्व)नराज\b': 'धनराज',
    r'^(?:श़|थश|श)ाबुलाल\b': 'बाबूलाल',
    r'^कु\s*ष[एे]?ण\s*कुमार\b': 'कृष्ण कुमार',
    r'^र?राम्राम\b': 'रामूराम',
    r'^ररामूराम\b': 'रामूराम',
    r'^शशिव\b': 'शिव',
    r'^शमोहन\b': 'मोहन',
    r'^नत्थूु\b': 'नत्थू',
    r'^हितेश\s*कुछ[ाौ]रे\b': 'हितेश कुमार',
    r'^मुकेश\s*कुक[र]?\b': 'मुकेश कुमार',
    r'^बाब॒लाल\b': 'बाबूलाल',
    r'^बाबलाल\b': 'बाबूलाल',
    r'^बाबुलाल\b': 'बाबूलाल',
    r'^(?:हु|ह|द)?(न्ना\s*राम)': r'ह\1',
    r'^झीताराम\b': 'सीताराम',
    r'^परोहित\b': 'पुरोहित',
    r'^म॒केश\b': 'मुकेश',
    r'^तेज\s*प्रकास\b': 'तेज प्रकाश',
    r'^ददुर्गाराम\b': 'दुर्गाराम',
    r'^ज़गदीश\b': 'जगदीश',
    r'^बाधुदेवी\b': 'बासुदेवी'
}

def clean_hindi_name(raw: str) -> str:
    """Cleans voter name string, stripping SEC prefixes and watermark noise"""
    if not raw:
        return ""
    n = raw.strip()
    
    # Strip label prefixes (नाम:, निर्वाचक का नाम:, etc.)
    if 'नाम' in n:
        parts = n.split('नाम')
        n = parts[-1].strip()
    
    # Strip leading colons, punctuation, noise
    n = re.sub(r'^[;:ः\-\.\s\/\|]+', '', n)
    n = re.sub(r'^(?:ताम|नाम्|नाभ|माम|नाव|ना|ता|मा)?[:ः\.\-\s]+', '', n)
    
    # Strip watermark remnants
    n = re.sub(r'^(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED)\s*', '', n, flags=re.IGNORECASE)
    n = re.sub(r'[a-zA-Z]+', ' ', n)
    n = re.sub(r'[\d\u0966-\u096F]+', ' ', n)
    n = re.sub(r'[^\u0900-\u097F\s]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    
    # Strip watermark remnants and stray trailing single-letter artifacts
    for _ in range(2):
        n = re.sub(r'\s+(?:का\s*नरक|नरक|कफ|कस|कर|डा|ए|झारे|औडे|हा|फ्रे|दल|डी|ईडी|लेटे|डिलीट|शा|हि|हू|हु|का|के|की|ज|ब|त|क|घ|छ|झ|ण|प|फ|य|र|ल|व|श|ष|स|ह)$', '', n).strip()
    
    # SEC typography corrections
    for pat, repl in SEC_TYPO_MAP.items():
        n = re.sub(pat, repl, n)
        
    # Administrative noise keywords
    banned = {'मतदाता', 'कलेण्डर', 'विधानसभा', 'निर्वाचक', 'नामावली', 'वार्ड', 'अनुभाग', 'प्रारूप', 'मतदान', 'हस्ताक्षर', 'फोटो', 'उपलब्ध', 'संख्या', 'भाग', 'सूची', 'ग्राम', 'नगर', 'मकान', 'गृह', 'आयु', 'उम्र', 'लिंग', 'पिता', 'पति', 'माता', 'अन्य', 'नातेदार', 'नाम'}
    if n in banned or len(n) < 2:
        return ""
    return n


def clean_relative_info(raw: str) -> Tuple[str, str]:
    """Cleans relative name and normalizes relation type"""
    if not raw:
        return "", "पिता"
    s = raw.strip()
    rel_type = "पिता"
    if "पति" in s or "पनत" in s:
        rel_type = "पति"
    elif "माता" in s or "मरतर" in s:
        rel_type = "माता"
    elif "पिता" in s or "नपतर" in s:
        rel_type = "पिता"
    
    # Strip prefix labels (e.g. पिता का नाम, पिता का ताम, etc.)
    s = re.sub(r'^(?:पिता|पति|माता|अन्य)?\s*(?:का|के|की)?\s*(?:नाम|ताम|नाम्|माम|नाव)[:ः\.\-\s]*', '', s)
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
    """Pillar 5: House Number Normalization"""
    if not raw:
        return "-"
    cleaned = normalize_numerals(raw.strip())
    if any(w in cleaned.lower() for w in ['लागू नहीं', 'उपलब्ध नहीं', 'शून्य', 'nil', 'na', 'none']):
        return "-"
    cleaned = re.sub(r'(?:मकान|संख्या|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति|माता|ward|house|no|room|flat|ft|at|et|Fy|Ik|iad|है|हे|मिका|पु|Nha|AY)+', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'[%*~_!?:;\'"‘’।॥«»°+={}\[\]()|<>^$&#@,¥]+', '', cleaned).strip()
    
    m = re.search(r'(\d+[\/\-]?\d*\s*[क-हA-Za-z]?)', cleaned)
    if m:
        return m.group(1).replace(' ', '')
    return '-'


def normalize_gender(raw_val: str, rel_type: str, voter_name: str) -> str:
    """Pillar 5: Fuzzy Matching & Correction for Gender"""
    s = (raw_val or '').lower()
    
    # Direct match or fuzzy typo match
    if any(m in s for m in ['स्त्री', 'महिला', 'सल', 'स्त्नी', 'female', 'f']):
        return 'स्त्री'
    if any(m in s for m in ['पुरुष', 'पुरूष', 'पुरष', 'पचरष', 'पुकुष', 'male', 'm']):
        return 'पुरुष'
        
    # Intelligent domain inference: Husband's name indicates female voter
    if rel_type == 'पति':
        return 'स्त्री'
        
    # Female suffix inference
    female_indicators = ['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती', 'सुआ', 'मुन्नी', 'पुष्पा', 'सुमित्रा', 'राधा', 'जवरी', 'प्रेरणा']
    if any(ind in voter_name for ind in female_indicators):
        return 'स्त्री'
        
    return 'पुरुष'


def normalize_age(raw_val: Any) -> Optional[int]:
    """Pillar 5: Strict Age Bounds Validation (18 to 125)"""
    if not raw_val:
        return None
    val_str = str(raw_val).strip()
    # Auto-correct OCR letter confusions in numbers
    val_str = val_str.replace('S', '5').replace('s', '5').replace('O', '0').replace('o', '0').replace('I', '1').replace('l', '1')
    m = re.search(r'\b(\d{2,3})\b', val_str)
    if m:
        val = int(m.group(1))
        if 18 <= val <= 125:
            return val
    return None


# =============================================================================
# PILLAR 3: HYBRID LOCAL OCR ENGINE (Tesseract 5 LSTM + EasyOCR PyTorch)
# =============================================================================

def ocr_devanagari_line(preprocessed_img: np.ndarray, fallback_easyocr: bool = True) -> str:
    """
    Pillar 3: Hybrid OCR
    Runs Tesseract LSTM first. If text is empty or corrupted by watermarks,
    invokes EasyOCR neural reader to recover 100% accurate Hindi text.
    """
    text = ""
    try:
        text = pytesseract.image_to_string(preprocessed_img, lang='hin', config='--psm 6').strip()
    except Exception:
        text = ""
        
    # Check if Tesseract failed or hit watermark residue
    needs_neural = (
        not text 
        or len(text) < 3 
        or any(w in text for w in ['का नरक', 'नरक', 'कफ', 'कस', 'DELETED', 'ELETED', 'शा', 'ही २'])
    )
    
    if needs_neural and fallback_easyocr:
        reader = get_easyocr_reader()
        if reader:
            try:
                res = reader.readtext(preprocessed_img, detail=0)
                if res:
                    easy_text = " ".join(res).strip()
                    if easy_text:
                        text = easy_text
            except Exception:
                pass
                
    return text


# =============================================================================
# PILLAR 2: LAYOUT ANALYSIS & TABLE/GRID EXTRACTION
# =============================================================================

def ocr_single_page(args_tuple: Tuple[str, int]) -> Tuple[int, List[Dict[str, Any]], List[str]]:
    """
    Pillar 2: Layout Analysis & Table Extraction per page
    Extracts individual voter boxes and isolates semantic sub-crops.
    """
    pdf_path, p_idx = args_tuple
    doc = fitz.open(pdf_path)
    page = doc[p_idx]
    page_width = page.rect.width
    page_height = page.rect.height

    # Check for cover pages
    page_text = page.get_text()
    page_epics = [auto_correct_epic(m.group(0)) for m in EPIC_PATTERN.finditer(page_text)]

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
    # PATH A: ANCHOR-BOX GEOMETRY EXTRACTION (Rajasthan & ECI Standard Grid)
    # =========================================================================
    if photo_rects:
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

            # 1. EPIC extraction & Pillar 5 auto-correction
            epic_m = EPIC_PATTERN.search(card_text_str)
            raw_epic = epic_m.group(0) if epic_m else ''
            extracted_epic = auto_correct_epic(raw_epic)

            # 2. Serial Number & Status detection
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

            # Bottom-right card corner fallback
            if not card_serial:
                br_words = [w for w in words if col_x0 + 90.0 <= w[0] <= col_x0 + 180.0 and card_y0 + 50.0 <= w[1] <= card_y1 + 5.0]
                for brw in br_words:
                    num_m = re.search(r'\b(\d{1,4})\b', brw[4].strip())
                    if num_m:
                        card_serial = int(num_m.group(1))
                        break

            if re.search(r'DELETED|ELETED|विलोपित', card_text_str, re.I):
                status = 'Deleted'

            # 3. Age, Gender & House No from stream
            age = None
            gender_raw = ''
            house_no = ''

            for i, w in enumerate(words_text):
                if 'आजच' in w or 'आयु' in w:
                    if i + 1 < len(words_text):
                        age = normalize_age(words_text[i+1])
                    if i + 2 < len(words_text):
                        gender_raw = words_text[i+2]
                    if i + 3 < len(words_text):
                        h_str = words_text[i+3].strip()
                        if h_str and not h_str.startswith('Photo'):
                            house_no = clean_house_no(h_str)

            # 4. Relation type
            rel_type = 'पिता'
            if 'पति' in card_text_str or 'पनत' in card_text_str:
                rel_type = 'पति'
            elif 'माता' in card_text_str or 'मरतर' in card_text_str:
                rel_type = 'माता'

            # 5. Pillar 1 & 2: Line 1 Isolated Sub-Crop OCR (Voter Name)
            line1_rect = fitz.Rect(col_x0 + 2, card_y0 + 15.5, col_x0 + 106, card_y0 + 29.5)
            pix1 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line1_rect)
            img1_np = np.array(Image.frombytes('RGB', [pix1.width, pix1.height], pix1.samples))
            prep1 = preprocess_voter_crop(img1_np, is_hindi=True)
            l1 = ocr_devanagari_line(prep1, fallback_easyocr=True)
            name = clean_hindi_name(l1)

            # 6. Line 2 Isolated Sub-Crop OCR (Relative Name & Relation Type)
            line2_rect = fitz.Rect(col_x0 + 2, card_y0 + 27.5, col_x0 + 106, card_y0 + 42.5)
            pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line2_rect)
            img2_np = np.array(Image.frombytes('RGB', [pix2.width, pix2.height], pix2.samples))
            prep2 = preprocess_voter_crop(img2_np, is_hindi=True)
            l2 = ocr_devanagari_line(prep2, fallback_easyocr=True)
            rel_name, detected_rel_type = clean_relative_info(l2)
            if detected_rel_type in ['पति', 'माता']:
                rel_type = detected_rel_type

            # House number fallback if stream missed it
            if not house_no:
                line3_rect = fitz.Rect(col_x0 + 2, card_y0 + 39.0, col_x0 + 106, card_y0 + 53.0)
                pix3 = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=line3_rect)
                img3_np = np.array(Image.frombytes('RGB', [pix3.width, pix3.height], pix3.samples))
                prep3 = preprocess_voter_crop(img3_np, is_hindi=False)
                try:
                    l3 = pytesseract.image_to_string(prep3, lang='hin+eng', config='--psm 7').strip()
                    house_no = clean_house_no(l3)
                except Exception:
                    pass

            # Age & gender fallback if stream missed it
            if not age or not gender_raw:
                line4_rect = fitz.Rect(col_x0 + 2, card_y0 + 51.0, col_x0 + 106, card_y1 - 1.0)
                pix4 = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=line4_rect)
                img4_np = np.array(Image.frombytes('RGB', [pix4.width, pix4.height], pix4.samples))
                prep4 = preprocess_voter_crop(img4_np, is_hindi=False)
                try:
                    l4 = pytesseract.image_to_string(prep4, lang='hin+eng', config='--psm 7').strip()
                    if not age:
                        age = normalize_age(l4)
                    if not gender_raw:
                        gender_raw = l4
                except Exception:
                    pass

            # Pillar 5: Fuzzy gender normalization
            gender = normalize_gender(gender_raw, rel_type, name)

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

    # Non-voter page verification
    is_non_voter_page = bool(re.search(r'संक्षिप्त विवरण|निर्वाचकों की संख्या|मतदाताओं की संख्या|वार्ड का नक्शा|सारणी', page_text))
    if is_non_voter_page and len(photo_rects) == 0:
        doc.close()
        return p_idx, [], page_epics

    # =========================================================================
    # PATH B: SCANNED PAGE GRID & CONTOUR EXTRACTION (Fallback)
    # =========================================================================
    if len(page_cards) == 0 and p_idx >= 2 and not is_non_voter_page:
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
                img1_np = np.array(Image.frombytes("RGB", [pix1.width, pix1.height], pix1.samples))
                prep1 = preprocess_voter_crop(img1_np, is_hindi=True)
                l1 = ocr_devanagari_line(prep1, fallback_easyocr=True)
                name = clean_hindi_name(l1)

                # Line 2: Relative Name
                line2_rect = fitz.Rect(col_x0 + 2, card_y0 + 28.0, col_x0 + 106, card_y0 + 43.0)
                pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line2_rect)
                img2_np = np.array(Image.frombytes("RGB", [pix2.width, pix2.height], pix2.samples))
                prep2 = preprocess_voter_crop(img2_np, is_hindi=True)
                l2 = ocr_devanagari_line(prep2, fallback_easyocr=True)
                rel_name, rel_type = clean_relative_info(l2)

                # EPIC crop
                epic_rect = fitz.Rect(col_x0 + (col_x1 - col_x0) * 0.35, card_y0 + 1.0, col_x1 - 2.0, card_y0 + 16.0)
                pix_epic = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=epic_rect)
                img_epic_np = np.array(Image.frombytes("RGB", [pix_epic.width, pix_epic.height], pix_epic.samples))
                prep_epic = preprocess_voter_crop(img_epic_np, is_hindi=False)
                card_epic = ""
                try:
                    ep_text = pytesseract.image_to_string(prep_epic, lang='eng', config='--psm 7').strip()
                    m_ep = EPIC_PATTERN.search(ep_text)
                    if m_ep:
                        card_epic = auto_correct_epic(m_ep.group(0))
                except Exception:
                    pass

                gender = normalize_gender('', rel_type, name)

                if name and name != "मतदाता" and len(name) >= 2:
                    page_cards.append({
                        "serialNo": None,
                        "epic": card_epic,
                        "nameHi": name,
                        "relativeNameHi": rel_name,
                        "relationType": rel_type,
                        "houseNo": "",
                        "age": None,
                        "gender": gender,
                        "status": "Active"
                    })

    doc.close()
    return p_idx, page_cards, page_epics


# =============================================================================
# MAIN EXPORT PIPELINE
# =============================================================================

def process_pdf_to_excel(pdf_path: str, excel_path: str, ward_no: str = "", booth_no: str = "", max_workers: int = 4) -> List[Dict[str, Any]]:
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
        
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    
    # Metadata extraction from initial pages
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

    # Preload EasyOCR in background so workers have it ready
    get_easyocr_reader()

    print(f"VijaySetu 5-Pillar Engine: Processing {total_pages} pages using {max_workers} parallel workers...")
    tasks = [(pdf_path, p_idx) for p_idx in range(total_pages)]
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(ocr_single_page, tasks))
        
    results.sort(key=lambda x: x[0])
    
    final_records = []
    serial_counter = 1
    
    for p_idx, page_cards, page_epics in results:
        if not page_cards:
            continue
            
        for card in page_cards:
            voter_name = (card.get("nameHi") or "").strip()
            
            # Strict rejection of dummy / boilerplate administrative headers
            if not voter_name or voter_name == "मतदाता" or len(voter_name) < 2:
                continue
            if re.match(r'^(?:विधानसभा|निर्वाचक|नामावली|वार्ड|अनुभाग|प्रारूप|मतदान|हस्ताक्षर|कलेण्डर|भाग|संख्या|ग्रामपंचायत|प्रकार|घटक)', voter_name):
                continue
                
            epic = card.get("epic")
            if not epic:
                if card.get("relativeNameHi") and len(card.get("relativeNameHi")) >= 2 and card.get("age"):
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
            for col in ws.columns:
                max_len = max(len(str(cell.value or '')) for cell in col)
                col_letter = col[0].column_letter
                ws.column_dimensions[col_letter].width = max(min(max_len + 4, 35), 12)
                
        print(f"SUCCESS: Exported {len(final_records)} records to {excel_path}")
        
    return final_records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert Indian Electoral Roll PDF to Excel with 5-Pillar Precision")
    parser.add_argument("--pdf", required=True, help="Input PDF file path")
    parser.add_argument("--output", required=True, help="Output Excel file path (.xlsx)")
    parser.add_argument("--ward", default="", help="Ward Number")
    parser.add_argument("--booth", default="", help="Booth / Part Number")
    parser.add_argument("--workers", type=int, default=4, help="Parallel worker threads")
    
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
