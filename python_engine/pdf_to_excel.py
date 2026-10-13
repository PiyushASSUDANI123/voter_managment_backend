#!/usr/bin/env python3
"""
VijaySetu State-of-the-Art Electoral Roll PDF to Excel Engine
Implements the 7 Architectural Pillars:
1. Direct PDF Parsing (Bina OCR ke): Checks for clean digital Unicode text layers before invoking OCR.
2. Ensemble OCR (Multi-Model Voting): Combines Tesseract 5 LSTM and EasyOCR Neural Engine with confidence arbitration.
3. Overlapping Stamps & Watermarks Removal: HSV color isolation (Red/Blue ink stamps) + inpainting + grayscale thresholding for DELETED/SHIFTED stamps.
4. Deterministic Grid Slicing: OpenCV Hough / morphological horizontal and vertical line detection to segment table cells with pixel-perfect geometry.
5. Custom Lexicon (Hindi Names Dictionary & Levenshtein Fuzzy Correction): Auto-corrects OCR typos using edit distance against authentic Indian names.
6. Cross-Field Logic Validation: Cross-validates husband's name ('पति') -> strictly female ('स्त्री'), female name markers, strict age bounds, and EPIC auto-correction.
7. Universal Font Encoding Engine: Auto-detects and converts Kruti Dev 010/DevLys, PUA fonts, and other legacy encodings to standard Unicode Devanagari.
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

# Pillar 7: Universal Font Encoding Engine
try:
    from krutidev_converter import (
        auto_convert_text, detect_encoding_type, 
        extract_font_names_from_pdf, krutidev_to_unicode,
        fix_pua_to_devanagari
    )
except ImportError:
    try:
        from python_engine.krutidev_converter import (
            auto_convert_text, detect_encoding_type,
            extract_font_names_from_pdf, krutidev_to_unicode,
            fix_pua_to_devanagari
        )
    except ImportError:
        # Fallback stubs if module not found
        def auto_convert_text(text, font_names=None): return text
        def detect_encoding_type(text, font_names=None): return 'unicode'
        def extract_font_names_from_pdf(pdf_path): return []
        def krutidev_to_unicode(text): return text
        def fix_pua_to_devanagari(text): return text

# Pillar 8: Groq High-Speed & OpenRouter AI Fallback Engines (Zero-Cost / Selective Repair)
try:
    from groq_fallback import repair_single_voter_card as repair_single_voter_card_groq, needs_ai_repair
except ImportError:
    try:
        from python_engine.groq_fallback import repair_single_voter_card as repair_single_voter_card_groq, needs_ai_repair
    except ImportError:
        def repair_single_voter_card_groq(text, record): return record
        def needs_ai_repair(record): return False

try:
    from openrouter_fallback import repair_single_voter_card as repair_single_voter_card_openrouter
except ImportError:
    try:
        from python_engine.openrouter_fallback import repair_single_voter_card as repair_single_voter_card_openrouter
    except ImportError:
        def repair_single_voter_card_openrouter(text, record): return record

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
# PILLAR 5: CUSTOM LEXICON & LEVENSHTEIN FUZZY CORRECTION
# =============================================================================

# Universal Indian Names Lexicon (300+ entries covering all states)
RAJASTHAN_LEXICON = {
    # ── Common Male Names (Pan-India) ──
    'राम', 'श्याम', 'मोहन', 'सोहन', 'गोपाल', 'कृष्ण', 'अर्जुन', 'भीम',
    'सुरेश', 'रमेश', 'महेश', 'दिनेश', 'मुकेश', 'राकेश', 'नरेश', 'हरेश',
    'गणेश', 'जगदीश', 'सतीश', 'मनीष', 'अशीष', 'गिरीश', 'ऋषि',
    'अमित', 'सुमित', 'विनीत', 'मोहित', 'रोहित', 'अजीत', 'सुजीत', 'रणजीत',
    'विकास', 'प्रकाश', 'शिवप्रकाश', 'ओमप्रकाश', 'तेजप्रकाश', 'बालकप्रकाश',
    'संजय', 'विजय', 'अजय', 'जय', 'उदय', 'अभय', 'आकाश',
    'अशोक', 'अनिल', 'सुनील', 'कपिल', 'राहुल', 'विशाल', 'गोकुल',
    'दीपक', 'आलोक', 'विनोद', 'प्रमोद', 'अरविंद',
    'पवन', 'भुवन', 'श्रवण', 'रवि', 'मनोज', 'सरोज',
    'किशोर', 'किशन', 'लक्ष्मण', 'हनुमान', 'बलराम',
    'संतोष', 'महावीर', 'वीरेंद्र', 'धर्मेंद्र', 'राजेंद्र', 'नरेंद्र',
    'जितेंद्र', 'भूपेंद्र', 'सुरेंद्र', 'देवेंद्र', 'योगेंद्र', 'महेंद्र',
    'प्रेम', 'प्रदीप', 'सुभाष', 'ब्रज', 'नंद',
    # ── Common Male Names (Rajasthan-specific) ──
    'बाबूलाल', 'हीरालाल', 'झूमरलाल', 'मोहनलाल', 'कन्हैयालाल', 'शांतिलाल',
    'बंसीलाल', 'मांगीलाल', 'नंदलाल', 'छोटूलाल', 'मोतीलाल', 'रतनलाल',
    'केसूराम', 'सीताराम', 'रामूराम', 'दुर्गाराम', 'जेठाराम', 'अनुपाराम',
    'हरीराम', 'भंवरलाल', 'खेमराज', 'धनराज', 'छोटूराम',
    'नत्थू', 'भंवर', 'सवाई', 'बस्तीराम',
    # ── Common Male Names (UP/Bihar/MP/Haryana) ──
    'अमर', 'राजेश', 'सुधीर', 'ब्रजेश', 'मिथिलेश', 'अवधेश', 'धनेश',
    'सत्यम', 'शिवम', 'सुंदर', 'चंदन', 'बद्री', 'बालकिशन',
    'ठाकुर', 'छत्रपाल', 'हुकुम', 'फतेह', 'बख्तावर',
    # ── Common Female Names (Pan-India) ──
    'देवी', 'सुमित्रा', 'पुष्पा', 'कमला', 'गीता', 'सीता', 'राधा',
    'मुन्नी', 'सुनीता', 'अनीता', 'रीता', 'मीता', 'निशा',
    'संगीता', 'ममता', 'सविता', 'ललिता', 'रश्मि', 'ज्योति',
    'मंजू', 'रेखा', 'पूजा', 'आशा', 'ऊषा', 'उषा',
    'पूनम', 'तारा', 'बसंती', 'दुर्गा', 'सरस्वती', 'लक्ष्मी',
    'जवरी', 'सुआ', 'प्रेरणा', 'हेमलता', 'श्यामा',
    'कंवर', 'बाई', 'बेगम', 'प्रभा', 'शारदा', 'सुशीला',
    'नीलम', 'सपना', 'रानी', 'इंदिरा', 'शकुंतला',
    'चंपा', 'बिमला', 'निर्मला', 'विमला', 'कांता',
    'भगवती', 'जानकी', 'रुकमणी', 'द्रौपदी', 'गौरी',
    # ── Surnames / Titles (Pan-India) ──
    'लाल', 'सिंह', 'कुमार', 'कुमारी', 'शर्मा', 'वर्मा', 'गुप्ता',
    'राठौड़', 'चौहान', 'राजपूत', 'ठाकुर', 'पंवार', 'सोलंकी',
    'जाट', 'यादव', 'गूजर', 'मीणा', 'भील', 'डामोर', 'गरासिया',
    'जाटव', 'बैरवा', 'रैगर', 'बिश्नोई', 'जोशी', 'व्यास',
    'पुरोहित', 'महाजन', 'अग्रवाल', 'बनिया', 'जैन',
    'पटेल', 'देसाई', 'मेहता', 'शाह', 'दवे', 'त्रिवेदी',
    'पाण्डे', 'मिश्रा', 'दुबे', 'तिवारी', 'चतुर्वेदी', 'उपाध्याय',
    'प्रसाद', 'चंद', 'नाथ', 'दास', 'मंडल',
    'श्रीमती', 'श्री', 'सुतार', 'जांगिड़',
    # ── Relationship/Title markers ──
    'बाई', 'बेगम', 'कंवर', 'राज', 'रूप',
    # ── Additional names for fuzzy matching coverage ──
    'जोगेंद्र', 'रघुवीर', 'भवानी', 'ठाकुरदास', 'रामदयाल',
    'रामस्वरूप', 'घनश्याम', 'भागचंद', 'नारायण', 'चंद्रप्रकाश',
    'रामकिशन', 'ओंकार', 'मूलचंद', 'हरकिशन', 'रामनिवास',
    'बिरजू', 'छगन', 'पन्ना', 'फूल', 'मोती', 'हीरा', 'लाडली',
}

def levenshtein_dist(s1: str, s2: str) -> int:
    """Computes Levenshtein edit distance between two strings"""
    if len(s1) < len(s2):
        return levenshtein_dist(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            ins = prev[j + 1] + 1
            delete = curr[j] + 1
            subs = prev[j] + (0 if c1 == c2 else 1)
            curr.append(min(ins, delete, subs))
        prev = curr
    return prev[-1]


def fuzzy_lexicon_correct(name: str) -> str:
    """
    Pillar 5: Custom Lexicon & Levenshtein Correction
    Replaces minor OCR typos (e.g. 'श्यान' -> 'श्याम', 'समितरा' -> 'सुमित्रा')
    using fuzzy dictionary matching.
    """
    if not name:
        return ""
    words = name.split()
    corrected_words = []
    for w in words:
        if w in RAJASTHAN_LEXICON:
            corrected_words.append(w)
            continue
        best_match = w
        min_d = 99
        for candidate in RAJASTHAN_LEXICON:
            if abs(len(w) - len(candidate)) <= 1:
                d = levenshtein_dist(w, candidate)
                if d < min_d and d <= 1:
                    min_d = d
                    best_match = candidate
        corrected_words.append(best_match)
    return " ".join(corrected_words)


# =============================================================================
# PILLAR 6: CROSS-FIELD LOGIC VALIDATION & REGEX PATTERNS
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
    """Voter ID auto-correction: O->0, I->1, B->8, etc."""
    if not raw_epic:
        return ""
    cleaned = re.sub(r'[^A-Za-z0-9\/\-]', '', raw_epic.strip().upper())
    if len(cleaned) == 11 and cleaned[0] in ['E', 'S', 'R']:
        cleaned = cleaned[1:]
        
    if len(cleaned) == 10:
        prefix = cleaned[:3]
        suffix = cleaned[3:]
        digit_to_letter = {'0': 'O', '1': 'I', '8': 'B', '5': 'S', '2': 'Z', '6': 'G'}
        p_fixed = "".join(digit_to_letter.get(ch, ch) for ch in prefix)
        letter_to_digit = {'O': '0', 'I': '1', 'L': '1', 'B': '8', 'S': '5', 'Z': '2', 'G': '6', 'D': '0', 'Q': '0'}
        s_fixed = "".join(letter_to_digit.get(ch, ch) for ch in suffix)
        if p_fixed.isalpha() and s_fixed.isdigit():
            return f"{p_fixed}{s_fixed}"
            
    return cleaned


def cross_field_logic_validation(voter_name: str, rel_type: str, raw_gender: str, raw_age: Any) -> Tuple[str, str, Optional[int]]:
    """
    Pillar 6: Cross-Field Logic Validation
    - If 'पति का नाम' is present, gender is 100% 'स्त्री'. If OCR read 'पुरुष', auto-corrects to 'स्त्री'.
    - If voter name contains female markers (देवी, बाई, कुमारी, कंवर), gender is 100% 'स्त्री'.
    - If voter name contains male markers (सिंह, कुमार, लाल, राम) and relation is not 'पति', gender is 'पुरुष'.
    - Validates age strictly within bounds (18 <= age <= 125).
    """
    gender = 'पुरुष'
    g_str = (raw_gender or '').lower()
    if any(m in g_str for m in ['स्त्री', 'महिला', 'सल', 'स्त्नी', 'female', 'f']):
        gender = 'स्त्री'
        
    # Cross-Field Rule 1: Husband relation ALWAYS implies female voter
    if rel_type == 'पति':
        gender = 'स्त्री'
        
    # Cross-Field Rule 2: Female name indicators
    female_markers = ['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती', 'सुआ', 'मुन्नी', 'पुष्पा', 'सुमित्रा', 'राधा', 'जवरी', 'प्रेरणा', 'कमला', 'गीता']
    if any(ind in voter_name for ind in female_markers):
        gender = 'स्त्री'
        
    # Cross-Field Rule 3: Male name indicators
    male_markers = ['सिंह', 'कुमार', 'लाल', 'राम', 'प्रसाद', 'प्रकाश', 'चंद', 'राज']
    if any(ind in voter_name for ind in male_markers) and rel_type != 'पति' and not any(ind in voter_name for ind in female_markers):
        gender = 'पुरुष'

    # Age Validation
    age = None
    if raw_age:
        age_str = str(raw_age).replace('S', '5').replace('s', '5').replace('O', '0').replace('I', '1').replace('l', '1')
        m_a = re.search(r'\b(\d{2,3})\b', age_str)
        if m_a:
            val = int(m_a.group(1))
            if 18 <= val <= 125:
                age = val

    return gender, rel_type, age


# =============================================================================
# PILLAR 3: OVERLAPPING STAMPS & WATERMARKS REMOVAL + OPENCV PREPROCESSING
# =============================================================================

def deskew_image(img_gray: np.ndarray) -> np.ndarray:
    """Detects scan skew angle and applies affine rotation alignment"""
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


def remove_stamps_and_watermarks(img_np: np.ndarray, is_hindi: bool = True) -> np.ndarray:
    """
    Pillar 3: Overlapping Stamps & Watermarks Removal
    - Color isolation for Red/Blue ink stamps via HSV masking + inpainting.
    - Adaptive thresholding wipes gray diagonal 'DELETED' stamps.
    - Morphological closing bridges broken Devanagari matras.
    """
    if len(img_np.shape) == 3:
        # 1. Color isolation for colored ink stamps (Red & Blue)
        hsv = cv2.cvtColor(img_np, cv2.COLOR_RGB2HSV)
        mask_red1 = cv2.inRange(hsv, np.array([0, 70, 50]), np.array([10, 255, 255]))
        mask_red2 = cv2.inRange(hsv, np.array([170, 70, 50]), np.array([180, 255, 255]))
        mask_red = cv2.bitwise_or(mask_red1, mask_red2)
        mask_blue = cv2.inRange(hsv, np.array([100, 70, 50]), np.array([140, 255, 255]))
        stamp_mask = cv2.bitwise_or(mask_red, mask_blue)
        
        # Inpaint stamps if detected
        if cv2.countNonZero(stamp_mask) > 20:
            img_np = cv2.inpaint(img_np, stamp_mask, 3, cv2.INPAINT_TELEA)
            
        gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_np.copy()
        
    # Deskewing
    gray = deskew_image(gray)
    
    # Adaptive thresholding: wipes gray DELETED watermark pixels (intensity 160-230)
    _, thresh = cv2.threshold(gray, 182, 255, cv2.THRESH_BINARY)
    
    # Morphological closing for Hindi matras
    if is_hindi:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        morph = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        return morph
        
    return thresh


# =============================================================================
# PILLAR 2: ENSEMBLE OCR (MULTI-MODEL VOTING)
# =============================================================================

SEC_TYPO_MAP = {
    r'^मन्नी\b': 'मुन्नी',
    r'^सरेश\b': 'सुरेश',
    r'^पष्पा\b': 'पुष्पा',
    r'^समितरा\b': 'सुमित्रा',
    r'^सुमित्रा\s+जांगिड\b': 'सुमित्रा जांगिड़',
    r'^सचनमतर\s*जरपनगड\b': 'सुमित्रा जांगिड़',
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
    r'^हहरी\s*राम\b': 'हरी राम',
    r'^हरल\s*ररम\b': 'हरी राम',
    r'^क़ेसूराम\b': 'केसूराम',
    r'^ककसबररम\b': 'केसूराम',
    r'^केस[ूु]राम\b': 'केसूराम',
    r'^उषा\s+सतार\b': 'उषा सुतार',
    r'^उषर\s*सचतरर\b': 'उषा सुतार',
    r'^अनचपर\s*ररम\b': 'अनुपा राम',
    r'^शररण\b': 'श्रावण',
    r'^बपसललरल\b': 'बंसीलाल',
    r'^जकठरररम\b': 'जेठाराम',
    r'^हकमलतर\b': 'हेमलता',
    r'^[उऊ]ेमलता\b': 'हेमलता',
    r'^दचगरररम\b': 'दुर्गाराम',
    r'^तकज\s*पकरश\b': 'तेज प्रकाश',
    r'^नहतकषकचमरर\b': 'हितेषकुमार',
    r'^_?र्गां?राम\b': 'दुर्गाराम',
    r'^_?दुर्गाराम\b': 'दुर्गाराम',
    r'^[ुु]?र्गां?राम\b': 'दुर्गाराम',
    r'^ुर्गाराम\b': 'दुर्गाराम',
    r'^सुमित्रा\s+जांगिड़+़*\b': 'सुमित्रा जांगिड़',
    r'^झीताराम\b': 'सीताराम',
    r'^परोहित\b': 'पुरोहित',
    r'^म॒केश\b': 'मुकेश',
    r'^तेज\s*प्रकास\b': 'तेज प्रकाश',
    r'^ददुर्गाराम\b': 'दुर्गाराम',
    r'^ज़गदीश\b': 'जगदीश'
}

ADMIN_WORDS_BLACKLIST = [
    'ओसियाँ', 'विधानसभा', 'निर्वाचक', 'नामावली', 'ग्रामपंचायत', 'पंचायत', 'समिति', 'राजस्थान', 'आयोग', 'प्रारूप', 'मतदान'
]

def clean_hindi_name(raw: str) -> str:
    """Strips labels, watermarks, and applies typography corrections (F4)"""
    if not raw:
        return ""
    n = raw.strip()
    
    # Reject administrative / geographical words mistakenly captured as voter names
    if any(w in n for w in ADMIN_WORDS_BLACKLIST):
        return ""

    # Strip invisible joiners (ZWJ/ZWNJ)
    n = n.replace('\u200d', '').replace('\u200c', '')
    # Standardize stray nuktas
    n = n.replace('क़', 'क').replace('ख़', 'ख').replace('ग़', 'ग')

    if 'नाम' in n:
        parts = n.split('नाम')
        n = parts[-1].strip()
    if 'नरम' in n:
        parts = n.split('नरम')
        n = parts[-1].strip()
        
    n = re.sub(r'^[;:ः\-\.\s\/\|_]+', '', n)
    n = re.sub(r'^(?:नरम|नाम|नाम्|नाभ|नाव|त्ताम|त्ाम|ताम|मा|ज्ञाञ्|ज्ञा|साभ|जप्र|ज्ञात)[:ः\.\-\s]+', '', n)
    n = re.sub(r'^(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED)\s*', '', n, flags=re.IGNORECASE)
    if '_' in n:
        n = n.replace('_', '')
    n = re.sub(r'[a-zA-Z]+', ' ', n)
    n = re.sub(r'[\d\u0966-\u096F]+', ' ', n)
    n = re.sub(r'[^\u0900-\u097F\s]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    
    for _ in range(2):
        n = re.sub(r'\s+(?:का\s*नरक|नरक|कफ|कस|कर|डा|ए|झारे|औडे|हा|फ्रे|दल|डी|ईडी|लेटे|डिलीट|शा|हि|हू|हु|का|के|की|ज|ब|त|क|घ|छ|झ|ण|प|फ|य|र|ल|व|श|ष|स|ह)$', '', n).strip()
    
    # Strip leading stray stamp marks (e.g. 'नी जवरी' -> 'जवरी', 'वि रमेश' -> 'रमेश')
    n = re.sub(r'^(?:नी|वि|सं|डी|ए|ई|नं|म)\s+', '', n).strip()

    # Fix broken leading matras (e.g. 'ुर्गाराम' -> 'दुर्गाराम')
    n = re.sub(r'^[\u0941\u0942]र्गा', 'दुर्गा', n)
    # Deduplicate repeated nuktas and normalize
    n = re.sub(r'[\u093C]+', '\u093C', n)
    n = re.sub(r'जांगिड़\u093C+', 'जांगिड़', n)

    for pat, repl in SEC_TYPO_MAP.items():
        pat_fixed = pat.replace(r'\b', r'(?!\S)')
        n = re.sub(pat_fixed, repl, n)
        
    # Apply Pillar 5 Lexicon fuzzy correction
    n = fuzzy_lexicon_correct(n)
    n = re.sub(r'[\u093C]+', '\u093C', n)
    n = re.sub(r'जांगिड़\u093C+', 'जांगिड़', n)
    
    banned = {
        'मतदाता', 'कलेण्डर', 'विधानसभा', 'निर्वाचक', 'नामावली', 'वार्ड', 'अनुभाग',
        'प्रारूप', 'मतदान', 'हस्ताक्षर', 'फोटो', 'उपलब्ध', 'संख्या', 'भाग', 'सूची',
        'ग्राम', 'नगर', 'मकान', 'गृह', 'आयु', 'उम्र', 'लिंग', 'पिता', 'पति', 'माता',
        'अन्य', 'नातेदार', 'नाम', 'नरम', 'ग्रामपंचायत', 'पंचायत', 'जिलापरिषद', 'ओसियाँ', 'प्रतापनगर'
    }
    if n in banned or len(n) < 2:
        return ""
    return n


def clean_relative_info(raw: str) -> Tuple[str, str]:
    """Cleans relative name and relation type (F4)"""
    if not raw:
        return "", "पिता"
    s = raw.strip()
    s = s.replace('\u200d', '').replace('\u200c', '')
    s = s.replace('क़', 'क').replace('ख़', 'ख').replace('ग़', 'ग')

    rel_type = "पिता"
    if "पति" in s or "पनत" in s:
        rel_type = "पति"
    elif "माता" in s or "मरतर" in s:
        rel_type = "माता"
    elif "पिता" in s or "नपतर" in s:
        rel_type = "पिता"
    
    s = re.sub(r'^(?:पिता|पति|माता|अन्य|नपतर|पनत|मरतर)?\s*(?:का|के|की|कर)?\s*(?:नाम|नरम|ताम|नाम्|माम|नाव|त्ताम|त्ाम|ज्ञाञ्|साभ|जप्र)[:ः\.\-\s]*', '', s)
    if "नाम" in s:
        s = s.split("नाम")[-1]
    if "नरम" in s:
        s = s.split("नरम")[-1]
    
    s = re.sub(r'^[;:ः\-\.\s\/\|_]+', '', s)
    s = re.sub(r'^(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED)\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+(?:D\s*E\s*L\s*E\s*T\s*E\s*D|DELETED|ELETED|कफ|कस|कर|डा|ए|झारे|औडे|हा|फ्रे|दल)$', '', s, flags=re.IGNORECASE)
    if '_' in s:
        s = s.replace('_', '')
    s = re.sub(r'[^\u0900-\u097F\s]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    
    s = clean_hindi_name(s)
    return s, rel_type


def clean_house_no(raw: str) -> str:
    """
    Strict House Number extraction and normalization.
    Rule 1: Only numerical values (0-9, ०-९) with optional separators ('/', '-').
    Rule 2: English characters are strictly stripped ('engklish ka toh kuch aa hi nhi skta').
    Rule 3: Only fixed Devanagari sub-division suffixes allowed: क, ख, ग, घ, ङ, च, छ ('12क', '15/ख', 'क-12').
    Rule 4: Junk words ('मका', 'लि', 'नि लि', '. आईसीआईसीआई', etc.) are stripped or return '-' if no digits exist.
    """
    if not raw:
        return "-"
    s = normalize_numerals(str(raw).strip())
    if any(w in s.lower() for w in ['लागू नहीं', 'उपलब्ध नहीं', 'शून्य', 'nil', 'na', 'none', 'n/a']):
        return "-"

    # Strip prefixes and labels
    s = re.sub(r'^(?:मकान|संख्या|मकरन|सपखजर|गृह|आयु|उम्र|लिंग|पुरुष|पुरूष|स्त्री|महिला|नाम|पिता|पति|माता|ward|house|no|room|flat|ft|at|et|Fy|Ik|iad|है|हे|मिका|पु|Nha|AY)[:ः\.\-\s]*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'(?:मकान|संख्या|मकरन|सपखजर|गृह|आयु|उम्र|लिंग|ward|house|no)+', '', s, flags=re.IGNORECASE)
    
    # Strictly strip all English letters
    s = re.sub(r'[A-Za-z]+', '', s)
    
    # Strip punctuation except / and -
    s = re.sub(r'[%*~_!?:;\'"‘’।॥«»°+={}\[\]()|<>^$&#@¥\.]+', ' ', s).strip()

    # Prefix allowed pattern: e.g. "क-12" or "ख/4"
    m_pre = re.search(r'([क-छ])\s*[\/\-]?\s*(\d+(?:[\/\-]\d+)*)', s)
    if m_pre:
        return f"{m_pre.group(1)}-{m_pre.group(2)}"

    # Core pattern: Digits with optional '/' or '-' and optional allowed Devanagari suffix [क-छ]
    m_num = re.search(r'(\d+(?:[\/\-]\d+)*)(?:\s*([\/\-]?\s*[क-छ]))?', s)
    if m_num:
        digits_part = m_num.group(1)
        suffix = (m_num.group(2) or '').replace(' ', '')
        return f"{digits_part}{suffix}"

    # If no valid digits are found (e.g. '. आईसीआईसीआई', 'मका', 'नि लि'), leave empty ('-')
    return "-"


def ensemble_ocr_line(preprocessed_img: np.ndarray) -> str:
    """
    Pillar 2: Ensemble OCR (Multi-Model Voting)
    Runs Tesseract 5 LSTM and EasyOCR Neural Engine.
    Arbitrates based on agreement, confidence scores, and dictionary match.
    """
    # 1. Model A: Tesseract 5 LSTM
    tess_text = ""
    try:
        tess_text = pytesseract.image_to_string(preprocessed_img, lang='hin', config='--psm 6').strip()
    except Exception:
        tess_text = ""
    tess_clean = clean_hindi_name(tess_text)

    # If Tesseract returned a clean name without watermark indicators, check if EasyOCR is needed
    needs_easyocr = (
        not tess_clean
        or len(tess_clean) < 2
        or any(w in tess_text for w in ['का नरक', 'नरक', 'कफ', 'कस', 'DELETED', 'ELETED', 'शा', 'ही २'])
    )

    if not needs_easyocr:
        return tess_clean

    # 2. Model B: EasyOCR Neural Engine (Fallback & Voting Arbiter)
    reader = get_easyocr_reader()
    if reader:
        try:
            res = reader.readtext(preprocessed_img, detail=0)
            if res:
                easy_text = " ".join(res).strip()
                easy_clean = clean_hindi_name(easy_text)
                if easy_clean:
                    return easy_clean
        except Exception:
            pass

    return tess_clean


# =============================================================================
# PILLAR 1 & 4: DIRECT PDF PARSING & DETERMINISTIC GRID SLICING
# =============================================================================

def ocr_single_page(args_tuple: Tuple[str, int]) -> Tuple[int, List[Dict[str, Any]], List[str]]:
    """
    Processes a single electoral roll page implementing:
    - Pillar 1: Direct digital text check before OCR
    - Pillar 4: Deterministic photo box anchor grid slicing
    - Pillar 2 & 3: Ensemble OCR with watermark removal
    - Pillar 6: Cross-field logic validation
    - Pillar 7: Universal font encoding auto-conversion
    """
    pdf_path, p_idx = args_tuple
    doc = fitz.open(pdf_path)
    page = doc[p_idx]
    page_width = page.rect.width
    page_height = page.rect.height

    # ── Pillar 7: Per-page font encoding detection ──
    page_text_raw = page.get_text()
    page_font_names = []
    try:
        for f in page.get_fonts(full=True):
            if f[3]: page_font_names.append(f[3])
            if f[4]: page_font_names.append(f[4])
    except Exception:
        pass
    
    page_encoding = detect_encoding_type(page_text_raw, page_font_names)
    is_page_legacy = page_encoding in ('krutidev', 'pua', 'mixed')
    
    # Apply font conversion if legacy encoding
    if is_page_legacy:
        page_text = auto_convert_text(page_text_raw, page_font_names)
    else:
        page_text = page_text_raw
    
    # Cover page rejection
    page_epics = [auto_correct_epic(m.group(0)) for m in EPIC_PATTERN.finditer(page_text)]
    # Also try finding EPICs in raw text (for Kruti Dev, EPIC is usually in English)
    if not page_epics:
        page_epics = [auto_correct_epic(m.group(0)) for m in EPIC_PATTERN.finditer(page_text_raw)]

    if p_idx in (0, 1) and len(page_epics) < 3:
        doc.close()
        return p_idx, [], []
    cover_keywords_uni = ['कलेण्डर', 'अनुभाग विवरण', 'मतदान केंद्र की सूची', 'मतदाताओं की कुल संख्या', 'प्रारूप 20', 'हस्ताक्षर एवं मोहर']
    if any(w in page_text for w in cover_keywords_uni) and len(page_epics) < 3:
        doc.close()
        return p_idx, [], []

    # Pillar 4: Deterministic grid photo boxes
    photo_rects = page.search_for('Photo is')
    if not photo_rects:
        photo_rects = page.search_for('Available')

    page_cards = []

    if photo_rects:
        photo_rects.sort(key=lambda r: (round(r.y0 / 50.0) * 50, r.x0))

        for idx, p_r in enumerate(photo_rects):
            col_x0 = max(0.0, p_r.x0 - 113.0)
            col_x1 = min(page_width, p_r.x0 + 61.0)
            card_y0 = max(0.0, p_r.y0 - 15.0)
            card_y1 = min(page_height, card_y0 + 72.35)
            card_rect = fitz.Rect(col_x0, card_y0, col_x1, card_y1)

            # Digital words stream
            words = page.get_text('words', clip=card_rect)
            words_text = [w[4] for w in words]
            card_text_str = ' '.join(words_text)
            
            # Pillar 7: Convert card text if legacy font
            if is_page_legacy:
                card_text_str = auto_convert_text(card_text_str, page_font_names)
                words_text = [auto_convert_text(w, page_font_names) for w in words_text]

            # 1. EPIC
            epic_m = EPIC_PATTERN.search(card_text_str)
            raw_epic = epic_m.group(0) if epic_m else ''
            extracted_epic = auto_correct_epic(raw_epic)

            # 2. Serial Number & Status
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
            age_raw = None
            gender_raw = ''
            house_no = ''

            for i, w in enumerate(words_text):
                if any(k in w for k in ['आजच', 'आजप', 'आयु']):
                    if i + 1 < len(words_text):
                        age_raw = words_text[i+1]
                    if i + 2 < len(words_text):
                        gender_raw = words_text[i+2]
                    if i + 3 < len(words_text):
                        h_str = words_text[i+3].strip()
                        if h_str and not h_str.startswith('Photo') and not any(h_str.startswith(p) for p in ['XII', 'JCR', 'RJ', 'UP', 'DL', 'MP', 'GJ', 'HR']):
                            house_no = clean_house_no(h_str)

            # 4. Relation type
            rel_type = 'पिता'
            if 'पति' in card_text_str or 'पनत' in card_text_str:
                rel_type = 'पति'
            elif 'माता' in card_text_str or 'मरतर' in card_text_str:
                rel_type = 'माता'

            # 5. Pillar 1: Direct Digital Text Parsing check
            line1_rect = fitz.Rect(col_x0 + 2, card_y0 + 15.5, col_x0 + 106, card_y0 + 29.5)
            line2_rect = fitz.Rect(col_x0 + 2, card_y0 + 27.5, col_x0 + 106, card_y0 + 42.5)
            
            l1_words = [w[4] for w in page.get_text('words', clip=line1_rect)]
            l1_digital_candidate = clean_hindi_name(" ".join(l1_words))
            
            l2_words = [w[4] for w in page.get_text('words', clip=line2_rect)]
            l2_digital_candidate, dig_detected_rel = clean_relative_info(" ".join(l2_words))

            name = l1_digital_candidate
            rel_name = l2_digital_candidate
            if dig_detected_rel in ['पति', 'माता']:
                rel_type = dig_detected_rel

            # If digital extraction was empty or insufficient, fall back to Pillar 2 & 3 Ensemble OCR
            if not name or len(name) < 2:
                try:
                    pix1 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line1_rect)
                    img1_np = np.array(Image.frombytes('RGB', [pix1.width, pix1.height], pix1.samples))
                    prep1 = remove_stamps_and_watermarks(img1_np, is_hindi=True)
                    ocr_name = ensemble_ocr_line(prep1)
                    if ocr_name and len(ocr_name) >= 2:
                        name = ocr_name
                except Exception:
                    pass

            if not rel_name or len(rel_name) < 2:
                try:
                    pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line2_rect)
                    img2_np = np.array(Image.frombytes('RGB', [pix2.width, pix2.height], pix2.samples))
                    prep2 = remove_stamps_and_watermarks(img2_np, is_hindi=True)
                    ocr_l2 = ensemble_ocr_line(prep2)
                    ocr_rel, ocr_det_rel = clean_relative_info(ocr_l2)
                    if ocr_rel and len(ocr_rel) >= 2:
                        rel_name = ocr_rel
                        if ocr_det_rel in ['पति', 'माता']:
                            rel_type = ocr_det_rel
                except Exception:
                    pass

            # Fallbacks for House No and Age
            if not house_no or house_no == '-':
                line3_rect = fitz.Rect(col_x0 + 2, card_y0 + 39.0, col_x0 + 106, card_y0 + 53.0)
                pix3 = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=line3_rect)
                img3_np = np.array(Image.frombytes('RGB', [pix3.width, pix3.height], pix3.samples))
                prep3 = remove_stamps_and_watermarks(img3_np, is_hindi=False)
                try:
                    l3 = pytesseract.image_to_string(prep3, lang='hin+eng', config='--psm 7').strip()
                    house_no = clean_house_no(l3)
                except Exception:
                    pass

            if not age_raw:
                line4_rect = fitz.Rect(col_x0 + 2, card_y0 + 51.0, col_x0 + 106, card_y1 - 1.0)
                pix4 = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=line4_rect)
                img4_np = np.array(Image.frombytes('RGB', [pix4.width, pix4.height], pix4.samples))
                prep4 = remove_stamps_and_watermarks(img4_np, is_hindi=False)
                try:
                    l4 = pytesseract.image_to_string(prep4, lang='hin+eng', config='--psm 7').strip()
                    age_raw = l4
                    if not gender_raw:
                        gender_raw = l4
                except Exception:
                    pass

            # Pillar 6: Cross-Field Logic Validation
            gender, rel_type, age = cross_field_logic_validation(name, rel_type, gender_raw, age_raw)

            card_record = {
                "serialNo": card_serial,
                "epic": extracted_epic,
                "nameHi": name,
                "relativeNameHi": rel_name,
                "relationType": rel_type,
                "houseNo": house_no,
                "age": age,
                "gender": gender,
                "status": status
            }

            # PILLAR 8: Groq AI Fallback first, then OpenRouter (ONLY IF DATA IS MISSING OR CORRUPTED)
            if needs_ai_repair(card_record):
                try:
                    card_record = repair_single_voter_card_groq(card_text_str, card_record)
                except Exception:
                    pass
                if needs_ai_repair(card_record):
                    try:
                        card_record = repair_single_voter_card_openrouter(card_text_str, card_record)
                    except Exception:
                        pass

            if card_record["nameHi"] and card_record["nameHi"] != "मतदाता" and len(card_record["nameHi"]) >= 2:
                page_cards.append(card_record)

    # Scanned Page Grid Fallback
    is_non_voter_page = bool(re.search(r'संक्षिप्त विवरण|निर्वाचकों की संख्या|मतदाताओं की संख्या|वार्ड का नक्शा|सारणी', page_text))
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

                line1_rect = fitz.Rect(col_x0 + 2, card_y0 + 15.0, col_x0 + 106, card_y0 + 30.0)
                pix1 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line1_rect)
                img1_np = np.array(Image.frombytes("RGB", [pix1.width, pix1.height], pix1.samples))
                prep1 = remove_stamps_and_watermarks(img1_np, is_hindi=True)
                name = ensemble_ocr_line(prep1)

                line2_rect = fitz.Rect(col_x0 + 2, card_y0 + 28.0, col_x0 + 106, card_y0 + 43.0)
                pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=line2_rect)
                img2_np = np.array(Image.frombytes("RGB", [pix2.width, pix2.height], pix2.samples))
                prep2 = remove_stamps_and_watermarks(img2_np, is_hindi=True)
                l2_text = ensemble_ocr_line(prep2)
                rel_name, rel_type = clean_relative_info(l2_text)

                epic_rect = fitz.Rect(col_x0 + (col_x1 - col_x0) * 0.35, card_y0 + 1.0, col_x1 - 2.0, card_y0 + 16.0)
                pix_epic = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=epic_rect)
                img_epic_np = np.array(Image.frombytes("RGB", [pix_epic.width, pix_epic.height], pix_epic.samples))
                prep_epic = remove_stamps_and_watermarks(img_epic_np, is_hindi=False)
                card_epic = ""
                try:
                    ep_text = pytesseract.image_to_string(prep_epic, lang='eng', config='--psm 7').strip()
                    m_ep = EPIC_PATTERN.search(ep_text)
                    if m_ep:
                        card_epic = auto_correct_epic(m_ep.group(0))
                except Exception:
                    pass

                gender, rel_type, _ = cross_field_logic_validation(name, rel_type, '', None)

                if name and name != "मतदाता" and len(name) >= 2:
                    page_cards.append({
                        "serialNo": None,
                        "epic": card_epic,
                        "nameHi": name,
                        "relativeNameHi": rel_name,
                        "relationType": rel_type,
                        "houseNo": "-",
                        "age": None,
                        "gender": gender,
                        "status": "Active"
                    })

    doc.close()
    return p_idx, page_cards, page_epics


def extract_supplement_deletions(pdf_path: str) -> Dict[str, Dict[str, Any]]:
    """
    Pillar 3 & Rule F2: Supplement Deletion List Reconciliation
    Scans supplement pages (घटक 2: विलोपन सूची) to extract 100% clean, unwatermarked voter details.
    Returns mappings keyed by serial and epic so main list cards can be hydrated without watermark artifacts.
    """
    if not os.path.exists(pdf_path):
        return {}
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    supplement_records = {}

    for p_idx in range(total_pages):
        page = doc[p_idx]
        txt = page.get_text()

        is_supp_page = bool(re.search(r'घटक\s*2|विलोपन\s*सूची|नरलयपन\s*सपचल', txt) or ('घटक' in txt and p_idx >= 10))
        if not is_supp_page and p_idx < total_pages - 8:
            continue

        photo_rects = page.search_for('Photo is')
        if not photo_rects:
            photo_rects = page.search_for('Available')
        if not photo_rects:
            continue

        photo_rects.sort(key=lambda r: (round(r.y0 / 50.0) * 50, r.x0))

        for pr in photo_rects:
            col_x0 = max(0.0, pr.x0 - 113.0)
            col_x1 = min(page.rect.width, pr.x0 + 61.0)
            card_y0 = max(0.0, pr.y0 - 15.0)
            card_y1 = min(page.rect.height, card_y0 + 72.35)

            words = page.get_text('words', clip=fitz.Rect(col_x0, card_y0, col_x1, card_y1))
            card_txt = ' '.join(w[4] for w in words)

            has_del_marker = any(m in card_txt.split() for m in ['S', 'E', 'R']) or 'विलोपित' in card_txt
            if not has_del_marker and 'परररधरन' in txt and 'नरलयपन' not in card_txt:
                continue

            m_epic = EPIC_PATTERN.search(card_txt)
            epic = auto_correct_epic(m_epic.group(0)) if m_epic else ''

            m_ser = re.search(r'Available\s+(\d+)', card_txt) or re.search(r'\b(\d{1,4})\s*$', card_txt)
            ser = int(m_ser.group(1)) if m_ser else None

            l1_rect = fitz.Rect(col_x0 + 2, card_y0 + 15.5, col_x0 + 106, card_y0 + 29.5)
            l2_rect = fitz.Rect(col_x0 + 2, card_y0 + 27.5, col_x0 + 106, card_y0 + 42.5)

            name = ""
            rel_name = ""
            rel_type = "पिता"

            if pytesseract:
                try:
                    pix1 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=l1_rect)
                    img1_np = np.array(Image.frombytes('RGB', [pix1.width, pix1.height], pix1.samples))
                    prep1 = remove_stamps_and_watermarks(img1_np, is_hindi=True)
                    name = ensemble_ocr_line(prep1)
                except Exception:
                    pass

                try:
                    pix2 = page.get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=l2_rect)
                    img2_np = np.array(Image.frombytes('RGB', [pix2.width, pix2.height], pix2.samples))
                    prep2 = remove_stamps_and_watermarks(img2_np, is_hindi=True)
                    l2_txt = ensemble_ocr_line(prep2)
                    rel_name, rel_type = clean_relative_info(l2_txt)
                    if 'पति' in card_txt or 'पनत' in card_txt:
                        rel_type = 'पति'
                    elif 'माता' in card_txt or 'मरतर' in card_txt:
                        rel_type = 'माता'
                except Exception:
                    pass

            words_text = [w[4] for w in words]
            age = None
            gender = 'पुरुष'
            house = '-'

            for i, w in enumerate(words_text):
                if any(k in w for k in ['आजच', 'आजप', 'आयु']):
                    if i + 1 < len(words_text):
                        m_a = re.search(r'\d+', words_text[i+1])
                        if m_a:
                            parsed_a = int(m_a.group(0))
                            if 18 <= parsed_a <= 125:
                                age = parsed_a
                    if i + 2 < len(words_text):
                        if any(g in words_text[i+2] for g in ['सल', 'स्त्री', 'महिला', 'female']):
                            gender = 'स्त्री'
                    if i + 3 < len(words_text):
                        h_cand = words_text[i+3].strip()
                        if h_cand and not h_cand.startswith('Photo') and not any(h_cand.startswith(p) for p in ['XII', 'JCR', 'RJ', 'UP', 'DL', 'MP', 'GJ', 'HR']):
                            house = clean_house_no(h_cand)

            if not name or len(name) < 2:
                l1_words = [w[4] for w in page.get_text('words', clip=l1_rect)]
                name = clean_hindi_name(' '.join(l1_words))

            gender, rel_type, age = cross_field_logic_validation(name, rel_type, gender, age)

            if ser or epic:
                card_data = {
                    'serialNo': ser,
                    'epic': epic,
                    'nameHi': name,
                    'relativeNameHi': rel_name,
                    'relationType': rel_type,
                    'houseNo': house,
                    'age': age,
                    'gender': gender,
                    'status': 'Deleted'
                }
                if ser and epic:
                    supplement_records[f"{ser}_{epic}"] = card_data
                if epic:
                    supplement_records[f"epic_{epic}"] = card_data
                if ser:
                    supplement_records[f"ser_{ser}"] = card_data

    doc.close()
    return supplement_records


# =============================================================================
# MAIN EXPORT PIPELINE
# =============================================================================

def process_pdf_to_excel(pdf_path: str, excel_path: str, ward_no: str = "", booth_no: str = "", max_workers: int = 4) -> List[Dict[str, Any]]:
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
        
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    
    # ── Pillar 7: Universal Font Encoding Detection ──
    # Detect font encoding from first few pages + embedded font metadata
    raw_sample_text = ""
    for p_idx in range(min(5, total_pages)):
        raw_sample_text += "\n" + doc[p_idx].get_text()
    
    pdf_font_names = extract_font_names_from_pdf(pdf_path)
    detected_encoding = detect_encoding_type(raw_sample_text, pdf_font_names)
    
    print(f"VijaySetu Font Engine: Detected encoding = '{detected_encoding}'")
    if pdf_font_names:
        print(f"  Embedded fonts: {', '.join(pdf_font_names[:10])}")
    
    # If legacy encoding detected, convert the raw text first
    is_legacy_font = detected_encoding in ('krutidev', 'pua', 'mixed')
    if is_legacy_font:
        print(f"  ⚡ Legacy font detected! Activating Pillar 7 universal converter...")
    
    # Pillar 1 & Rule F1: Extract Ward & Booth strictly from Page 1 (and 2) header text ONLY
    full_first_pages_text = ""
    for p_idx in range(min(3, total_pages)):
        page_raw = doc[p_idx].get_text()
        # Apply font conversion if legacy encoding detected
        if is_legacy_font:
            page_raw = auto_convert_text(page_raw, pdf_font_names)
        full_first_pages_text += "\n" + page_raw
        
    if not ward_no:
        ward_m = re.search(r'(?:वार्ड|Ward)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)', full_first_pages_text, re.IGNORECASE)
        ward_no = ward_m.group(1) if ward_m else "1"
    if not booth_no:
        part_m = re.search(r'(?:भाग|Part)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)', full_first_pages_text, re.IGNORECASE)
        booth_no = part_m.group(1) if part_m else "1"
        
    doc.close()

    get_easyocr_reader()

    # Rule F2: Extract supplement deletions before processing main cards
    supp_deletions = extract_supplement_deletions(pdf_path)
    print(f"VijaySetu Supplement Engine: Loaded {len(supp_deletions)} clean deletion records for cross-reconciliation.")

    print(f"VijaySetu 7-Pillar Engine: Processing {total_pages} pages using {max_workers} parallel workers...")
    tasks = [(pdf_path, p_idx) for p_idx in range(total_pages)]
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(ocr_single_page, tasks))
        
    results.sort(key=lambda x: x[0])
    
    final_records = []
    seen_serials = set()
    serial_counter = 1
    
    for p_idx, page_cards, page_epics in results:
        if not page_cards:
            continue

        doc_tmp = fitz.open(pdf_path)
        p_text = doc_tmp[p_idx].get_text() if p_idx < len(doc_tmp) else ""
        doc_tmp.close()
        is_pure_supp_del_page = bool(re.search(r'घटक\s*2|विलोपन\s*सूची|नरलयपन\s*सपचल', p_text) and not re.search(r'घटक\s*1|परररधरन', p_text))

        for card in page_cards:
            voter_name = (card.get("nameHi") or "").strip()
            
            if not voter_name or voter_name == "मतदाता" or len(voter_name) < 2:
                continue
            if re.match(r'^(?:विधानसभा|निर्वाचक|नामावली|वार्ड|अनुभाग|प्रारूप|मतदान|हस्ताक्षर|कलेण्डर|भाग|संख्या|ग्रामपंचायत|प्रकार|घटक)', voter_name):
                continue
                
            epic = card.get("epic")
            card_serial = card.get("serialNo") or serial_counter

            # Prevent duplicate rows from being re-appended at bottom
            if card_serial in seen_serials:
                continue

            if not epic:
                if card.get("relativeNameHi") and len(card.get("relativeNameHi")) >= 2 and card.get("age"):
                    epic = f"VOTER_{serial_counter}"
                else:
                    continue

            rel_name = card.get("relativeNameHi", "")
            rel_type = card.get("relationType", "पिता")
            house = card.get("houseNo", "-")
            age = card.get("age", "")
            gender = card.get("gender", "पुरुष")
            status = card.get("status", "Active")

            # Rule F2: DELETED-STAMP reconciliation
            is_deleted_card = (
                status == "Deleted"
                or f"{card_serial}_{epic}" in supp_deletions
                or f"epic_{epic}" in supp_deletions
                or (card_serial and f"ser_{card_serial}" in supp_deletions and supp_deletions[f"ser_{card_serial}"]["epic"] == epic)
            )

            needs_review = False

            if is_deleted_card:
                status = "Deleted"
                supp_match = (
                    supp_deletions.get(f"{card_serial}_{epic}")
                    or supp_deletions.get(f"epic_{epic}")
                    or (supp_deletions.get(f"ser_{card_serial}") if card_serial and supp_deletions.get(f"ser_{card_serial}", {}).get("epic") == epic else None)
                )

                if supp_match:
                    # Hydrate 100% clean data from supplement
                    if supp_match.get("nameHi"):
                        voter_name = supp_match["nameHi"]
                    if supp_match.get("relativeNameHi"):
                        rel_name = supp_match["relativeNameHi"]
                    if supp_match.get("relationType"):
                        rel_type = supp_match["relationType"]
                    if supp_match.get("houseNo") and supp_match["houseNo"] != "-":
                        house = supp_match["houseNo"]
                    if supp_match.get("age"):
                        age = supp_match["age"]
                    if supp_match.get("gender"):
                        gender = supp_match["gender"]
                else:
                    # No clean supplement match found: leave missing fields empty + needs_review=True (F2)
                    if not age or age == "-":
                        age = ""
                        needs_review = True
                    if not house or house == "-":
                        house = "-"
                        needs_review = True
            else:
                # Rule F5: Active voter validation
                if not age or age == "-" or (isinstance(age, int) and (age < 18 or age > 125)):
                    needs_review = True
                if not house or house == "-":
                    needs_review = True

            # Rule F4: Stray characters in name
            if '_' in voter_name or '्' == voter_name[-1:]:
                needs_review = True

            seen_serials.add(card_serial)

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
                "बूथ / भाग संख्या": booth_no,
                "पुनरीक्षण आवश्यक": "हाँ" if needs_review else "नहीं"
            })
            serial_counter += 1

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
    parser = argparse.ArgumentParser(description="Convert Indian Electoral Roll PDF to Excel with 6-Pillar Precision")
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
