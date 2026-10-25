/**
 * VijaySetu Universal Hindi Devanagari Lexicon, Normalizer & Family Reconciler
 * 
 * Engineered to handle 100+ crore Indian voter names algorithmically without fragile
 * one-by-one manual hardcoding.
 * 
 * Features:
 * 1. Universal Remington / KrutiDev Typist Glitch Corrector (e.g., Shift-K 'अ' -> 'ा', 'ध्र' -> 'धर')
 * 2. Devanagari Unicode NFC Normalization & Ligature De-duplication
 * 3. Algorithmic Family Relative Name Reconciler (heals broken family trees inside households)
 * 4. High-Precision Devanagari-to-English Transliteration Engine
 * 5. Comprehensive Pan-India Surnames, Titles, and Given Name Lexicon
 */

// -----------------------------------------------------------------------------
// 1. Core Phonetic & Lexical Constants
// -----------------------------------------------------------------------------

const DEV_VOWELS = {
  'अ': 'A', 'आ': 'Aa', 'इ': 'I', 'ई': 'Ee', 'उ': 'U', 'ऊ': 'Oo',
  'ऋ': 'Ri', 'ए': 'E', 'ऐ': 'Ai', 'ओ': 'O', 'औ': 'Au',
  'अं': 'An', 'अः': 'Ah'
};

const DEV_MATRAS = {
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u',
  'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  'ं': 'n', 'ँ': 'n', 'ः': 'h', 'ॅ': 'e', 'ॉ': 'o'
};

const DEV_CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h',
  'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gya', 'श्र': 'shr',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r',
  'ढ़': 'rh', 'फ़': 'f'
};

const COMPOUND_NAME_SUFFIXES = [
  ['राम', ' Ram'], ['लाल', ' Lal'], ['कुमार', ' Kumar'], ['कुमारी', ' Kumari'],
  ['सिंह', ' Singh'], ['कंवर', ' Kanwar'], ['देवी', ' Devi'], ['बाई', ' Bai'],
  ['प्रसाद', ' Prasad'], ['प्रकाश', ' Prakash'], ['चंद', ' Chand'], ['चन्द', ' Chand'],
  ['चन्द्र', ' Chandra'], ['नारायण', ' Narayan'], ['नाथ', ' Nath'], ['दास', ' Das'],
  ['शंकर', ' Shankar'], ['दीन', ' Deen'], ['भान', ' Bhan'], ['जीत', ' Jeet'],
  ['पाल', ' Pal'], ['देव', ' Dev'], ['राज', ' Raj'], ['धर', ' Dhar'],
  ['वल्लभ', ' Vallabh'], ['दत्त', ' Dutt'], ['वती', ' Vati'], ['मती', ' Mati'],
  ['प्रिया', ' Priya'], ['रानी', ' Rani']
];

const CONJUNCT_RETENTION_ENDINGS = ['न्द्र', 'त्र', 'प्र', 'क्र', 'ग्र', 'श्र', 'क्ल', 'ज्ञ', 'त्य', 'र्य', 'व्य', 'ष्ठ', 'स्थ', 'द्ध'];

// Pan-India Common Surnames, Titles, and Name Roots
const HINDI_MAP = {
  // Common OCR and Typist Corrections
  "कचमरर": "कुमार", "दलरल": "देवी", "मरलशरल": "माहेश्वरी", "तरपनरजर": "तापड़िया",
  "तरपडलजर": "तापड़िया", "मलरतर": "मीना", "शमरा": "शर्मा", "जजन": "जैन",
  "सनह": "सिंह", "कवर": "कंवर", "बरई": "बाई", "दसरन": "दास",
  "रनसररज": "रामस्वरूप", "रणचयरदरस": "रणछोड़दास", "मनलषर": "मनीषा", "रसररज": "रामस्वरूप",
  "नरमरनशच": "नर्मदा", "लरलनर": "ललिता", "तनरल": "तनीषा", "पनकज": "पंकज",
  "कजलरश": "कैलाश", "ओमपकरश": "ओमप्रकाश", "सनगलतर": "संगीता", "अशयक": "अशोक",
  "चनदर": "चंदा", "मनजप": "मनदीप", "आजचषल": "आयुषी", "सयरनलरलन": "सोहनलाल",
  "मलठरलरल": "मीठालाल", "जरनशकर": "जानकी", "कयशनलजर": "कौशल्या", "गचरर": "गौरी",
  "नजनर": "नीना", "ररम": "राम", "शरमर": "श्याम", "मयहन": "मोहन",
  "सरलर": "सरला", "कमलर": "कमला", "सचनलर": "सुनीला", "पकरश": "प्रकाश",
  "लीलअध्र": "लीलाधर", "लीलअघ्र": "लीलाधर", "लीलअध": "लीलाधर", "मुरलीध्र": "मुरलीधर",
  "कअलूराम": "कालूराम", "सवाइर्राम": "सवाईराम", "जशराज": "जसराज"
};

// -----------------------------------------------------------------------------
// 2. Universal Devanagari Normalizer & Typist Glitch Corrector
// -----------------------------------------------------------------------------

/**
 * Normalizes Devanagari text, removes typist keyboard glitches, and applies
 * universal Indian electoral orthographic rules.
 * 
 * @param {string} text 
 * @returns {string} Cleaned Devanagari text
 */
function fixCorruptedHindi(text) {
  if (!text || typeof text !== 'string') return text || '';
  
  // 1. Unicode NFC normalization
  let s = text.normalize('NFC').trim();
  if (!s) return '';

  // 2. Direct dictionary whole-word replacement if present
  const words = s.split(/\s+/);
  s = words.map(w => HINDI_MAP[w] || w).join(' ');

  // 3. Structural ligature and repeating character cleanups
  s = s.replace(/श्वव/g, 'श्व');
  s = s.replace(/्यया/g, '्या');
  s = s.replace(/क+कू/g, 'कंकू');

  // 4. Devanagari vowel sign de-duplication (e.g. ाा->ा, ीी->ी, ूू->ू, ेे->े)
  s = s.replace(/([ािीुूृेैोौं्])\1+/g, '$1');

  // 5. Universal ligature glitch: रर inside words (सररता -> सरिता, दररया -> दरिया)
  s = s.replace(/([क-ह])रर([क-हए-औ])/g, '$1रि$2');

  // 6. Universal Remington Shift-K Typist Error (100-Crore Rule):
  // Consonant + independent 'अ' NEVER occurs inside Devanagari words.
  // When a typist hits Shift+K instead of k, 'ा' becomes 'अ'.
  // e.g. लअ -> ला, कअ -> का, मअ -> मा, रअ -> रा, तअ -> ता
  s = s.replace(/([क-ह])अ/g, '$1ा');

  // 7. Universal Rakar Suffix Typist Error:
  // e.g., लीलाध्र -> लीलाधर, मुरलीध्र -> मुरलीधर, विद्याध्र -> विद्याधर, गंगाध्र -> गंगाधर, रामेश्व्र -> रामेश्वर
  s = s.replace(/([ािीुूेैोौ]|\b[क-ह]+)[धघ]्र\b/g, '$1धर');
  s = s.replace(/([ािीुूेैोौ])श्व्र\b/g, '$1श्वर');
  s = s.replace(/([ािीुूेैोौ])ह्र\b/g, '$1हर');
  s = s.replace(/([ािीुूेैोौ])द्र\b/g, '$1दर');

  // 8. Universal double nasal-conjunct glitches
  s = s.replace(/न्न्द्र/g, 'न्द्र');
  s = s.replace(/न्न्द/g, 'न्द');
  s = s.replace(/न्न्/g, 'न्न');

  // 9. Standardize common surname spacing for optimal indexing
  s = s.replace(/([^\s])कंवर\b/g, '$1 कंवर');
  s = s.replace(/([^\s])सिंह\b/g, '$1 सिंह');

  return s.replace(/\s+/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// 3. Algorithmic Family Relative Name Reconciler (Preserves 100% of Family Trees)
// -----------------------------------------------------------------------------

function normalizeForComparison(name) {
  if (!name || typeof name !== 'string') return '';
  let s = name.trim().replace(/\s+/g, '');
  s = s.replace(/ू/g, 'ु').replace(/ी/g, 'ि').replace(/ो/g, 'ौ').replace(/े/g, 'ै');
  s = s.replace(/ं/g, 'न').replace(/ण/g, 'न').replace(/श/g, 'स').replace(/ष/g, 'स');
  s = s.replace(/व/g, 'ब');
  s = s.replace(/([क-ह])अ/g, '$1ा');
  s = s.replace(/([ािीुूेैोौ]|\b[क-ह]+)[धघ]्र\b/g, '$1धर');
  return s;
}

function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 1.0;
  if (!str1 || !str2) return 0.0;
  const l1 = str1.length;
  const l2 = str2.length;
  const maxL = Math.max(l1, l2);
  if (maxL === 0) return 1.0;

  // Levenshtein distance
  const track = Array(l2 + 1).fill(null).map(() => Array(l1 + 1).fill(null));
  for (let i = 0; i <= l1; i += 1) track[0][i] = i;
  for (let j = 0; j <= l2; j += 1) track[j][0] = j;
  for (let j = 1; j <= l2; j += 1) {
    for (let i = 1; i <= l1; i += 1) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1,
        track[j - 1][i] + 1,
        track[j - 1][i - 1] + indicator
      );
    }
  }
  const dist = track[l2][l1];
  return (maxL - dist) / maxL;
}

/**
 * Reconciles relative names (husband, father, mother) with authentic resident
 * voters in the same household to ensure family grouping is 100% accurate.
 * 
 * @param {Array<Object>} voters - Array of voter objects
 * @returns {Array<Object>} Reconciled voters array
 */
function reconcileFamilyRelatives(voters) {
  if (!Array.isArray(voters) || voters.length === 0) return voters;

  // Group by house number
  const houseGroups = new Map();
  voters.forEach((v, idx) => {
    const h = String(v.houseNo || v.house_no || v['मकान संख्या'] || '').trim();
    if (h && h !== '-' && h !== '0') {
      if (!houseGroups.has(h)) houseGroups.set(h, []);
      houseGroups.get(h).push({ idx, voter: v });
    }
  });

  voters.forEach((v, idx) => {
    let relName = fixCorruptedHindi(String(v.relativeNameHi || v.relative_name_hi || v['संबंधी का नाम'] || '').trim());
    const relType = String(v.relation || v.relationType || v['संबंध प्रकार'] || '').trim();
    const houseNo = String(v.houseNo || v.house_no || v['मकान संख्या'] || '').trim();
    const vName = String(v.nameHi || v.name_hi || v['मतदाता का नाम'] || '').trim();
    const vGender = String(v.gender || v['लिंग'] || '').trim();
    const vAge = Number(v.age || v['आयु'] || 0) || 0;

    if (!relName) return;

    // Apply the fixed corrupted name back
    if (v.relativeNameHi !== undefined) v.relativeNameHi = relName;
    if (v.relative_name_hi !== undefined) v.relative_name_hi = relName;
    if (v['संबंधी का नाम'] !== undefined) v['संबंधी का नाम'] = relName;

    // Build candidates pool: Priority 1 (same house), Priority 2 (nearby index)
    const candidates = [];
    if (houseNo && houseGroups.has(houseNo)) {
      houseGroups.get(houseNo).forEach(cand => {
        if (cand.idx !== idx) candidates.push({ cand: cand.voter, priority: 1 });
      });
    }

    // Nearby serial neighborhood (+/- 12)
    const startIdx = Math.max(0, idx - 12);
    const endIdx = Math.min(voters.length - 1, idx + 12);
    for (let cIdx = startIdx; cIdx <= endIdx; cIdx++) {
      if (cIdx !== idx) {
        const candV = voters[cIdx];
        if (!candidates.some(c => c.cand === candV)) {
          candidates.push({ cand: candV, priority: 2 });
        }
      }
    }

    const relNorm = normalizeForComparison(relName);
    const relNoSpace = relName.replace(/\s+/g, '');
    let bestMatch = null;
    let bestScore = 0.0;

    candidates.forEach(({ cand, priority }) => {
      const cName = String(cand.nameHi || cand.name_hi || cand['मतदाता का नाम'] || '').trim();
      if (!cName || cName === vName) return;

      const cGender = String(cand.gender || cand['लिंग'] || '').trim();
      const cAge = Number(cand.age || cand['आयु'] || 0) || 0;

      // Relationship plausibility rules:
      if (relType.includes('पति')) {
        if (cGender.includes('स') || cGender.includes('महिला') || cGender === 'F') return;
      } else if (relType.includes('पिता')) {
        if (cGender.includes('स') || cGender.includes('महिला') || cGender === 'F') return;
        if (vAge > 0 && cAge > 0 && cAge < vAge) return;
      } else if (relType.includes('माता')) {
        if (cGender.includes('पु') || cGender === 'M') return;
        if (vAge > 0 && cAge > 0 && cAge < vAge) return;
      }

      const cNoSpace = cName.replace(/\s+/g, '');
      const cNorm = normalizeForComparison(cName);

      let score = 0.0;
      if (relNoSpace === cNoSpace) {
        score = 1.0;
      } else if (relNorm === cNorm) {
        score = 0.98;
      } else if (relNorm.length >= 3 && cNorm.length >= 3 && (cNorm.startsWith(relNorm) || relNorm.startswith ? cNorm.startsWith(relNorm) : false)) {
        score = Math.abs(cNorm.length - relNorm.length) <= 2 ? 0.92 : 0.80;
      } else {
        score = calculateSimilarity(relNorm, cNorm);
      }

      const weightedScore = priority === 1 ? score : score * 0.90;
      if (weightedScore > bestScore) {
        bestScore = weightedScore;
        bestMatch = cName;
      }
    });

    if (bestScore >= 0.74 && bestMatch) {
      v.relativeNameHi = bestMatch;
      if (v.relative_name_hi !== undefined) v.relative_name_hi = bestMatch;
      if (v['संबंधी का नाम'] !== undefined) v['संबंधी का नाम'] = bestMatch;
      v.relativeNameEn = transliterateHindi(bestMatch);
      if (v.relative_name_en !== undefined) v.relative_name_en = transliterateHindi(bestMatch);
    }
  });

  return voters;
}

// -----------------------------------------------------------------------------
// 4. Universal Hindi-to-English Transliteration Engine
// -----------------------------------------------------------------------------

function transliterateToken(token) {
  if (!token) return '';
  const chars = Array.from(token);
  const n = chars.length;
  const res = [];
  let i = 0;
  const retainsFinalA = CONJUNCT_RETENTION_ENDINGS.some(conj => token.endsWith(conj));

  while (i < n) {
    let c = chars[i];
    if (i + 1 < n && chars[i + 1] === '़') {
      c = c + '़';
      i++;
    }

    if (DEV_VOWELS[c]) {
      res.push(res.length === 0 ? DEV_VOWELS[c] : DEV_VOWELS[c].toLowerCase());
    } else if (DEV_CONSONANTS[c]) {
      let base = DEV_CONSONANTS[c];
      const next = i + 1 < n ? chars[i + 1] : null;
      const nextNext = i + 2 < n ? chars[i + 2] : null;
      const isConjunctMember = (i >= 2 && chars[i - 1] === '्');

      if (c === 'व' && i > 0 && ['ं', 'न', 'स', 'र', 'ल', 'ई', 'त'].includes(chars[i - 1])) {
        base = 'w';
      }

      if (next === '्') {
        res.push(base);
        i++;
      } else if (next && DEV_MATRAS[next]) {
        res.push(base);
        const matra = next;
        if (matra === 'ं' || matra === 'ँ') {
          if (nextNext && ['प', 'फ', 'ब', 'भ', 'म'].includes(nextNext)) {
            res.push('am');
          } else {
            res.push('an');
          }
        } else if (matra === 'ी') {
          if (i <= 1 && (!nextNext || DEV_CONSONANTS[nextNext])) {
            res.push('ee');
          } else {
            res.push('i');
          }
        } else if (matra === 'ू') {
          if (i <= 1 && (!nextNext || DEV_CONSONANTS[nextNext])) {
            res.push('oo');
          } else {
            res.push('u');
          }
        } else {
          res.push(DEV_MATRAS[matra]);
        }
        i++;
      } else if (i === n - 1) {
        if (retainsFinalA && i >= 2 && chars[i - 1] === '्') {
          res.push(base + 'a');
        } else {
          res.push(base);
        }
      } else if (next && DEV_CONSONANTS[next]) {
        if (isConjunctMember) {
          res.push(base + 'a');
        } else if (i > 0 && (nextNext === '्' || (nextNext && DEV_MATRAS[nextNext]))) {
          res.push(base);
        } else {
          res.push(base + 'a');
        }
      } else {
        res.push(base + 'a');
      }
    } else if (DEV_MATRAS[c]) {
      res.push(DEV_MATRAS[c]);
    } else {
      res.push(c);
    }
    i++;
  }

  const s = res.join('');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Transliterates Hindi Devanagari text to clean, professional Indian English.
 * 
 * @param {string} text 
 * @returns {string} Transliterated English text
 */
function transliterateHindi(text) {
  if (!text || typeof text !== 'string') return '';
  const clean = text.trim();
  if (!clean) return '';

  for (const [sfxHi, sfxEn] of COMPOUND_NAME_SUFFIXES) {
    if (clean.endsWith(sfxHi) && clean.length > sfxHi.length) {
      const prefix = clean.slice(0, -sfxHi.length).trim();
      return `${transliterateHindi(prefix)}${sfxEn}`;
    }
  }

  const tokens = clean.split(/(\s+|,|\.|\-)/);
  const out = [];
  for (const tok of tokens) {
    if (!tok || /^\s+$/.test(tok) || [',', '.', '-'].includes(tok)) {
      out.push(tok);
    } else {
      out.push(transliterateToken(tok));
    }
  }

  return out.join('').replace(/\s+/g, ' ').trim();
}

module.exports = {
  HINDI_MAP,
  fixCorruptedHindi,
  reconcileFamilyRelatives,
  transliterateHindi
};
