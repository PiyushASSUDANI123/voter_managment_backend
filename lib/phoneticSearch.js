/**
 * Universal Indian Name & Devanagari Phonetic Search Engine
 * Converts Latin / Roman transliterated English names into high-precision
 * Devanagari regex patterns matching Hindi voter records without modifying the database.
 */

const COMMON_SEARCH_MAPPINGS = {
  'bu': ['बु', 'बू', 'ब'],
  'bud': ['बुध', 'बुद', 'बूध'],
  'budh': ['बुध', 'बूध'],
  'budha': ['बुधा'],
  'budhar': ['बुधार'],
  'budharam': ['बुधाराम', 'बुधा राम'],
  'ra': ['रा', 'र'],
  'ram': ['राम'],
  'ramesh': ['रमेश'],
  'kam': ['कम', 'काम'],
  'kamal': ['कमल'],
  'kamlesh': ['कमलेश'],
  'su': ['सु', 'सू'],
  'sur': ['सुर', 'सूर'],
  'suresh': ['सुरेश'],
  'vi': ['वि', 'वी'],
  'vik': ['विक', 'वीक'],
  'vikas': ['विकास'],
  'mu': ['मु', 'मू'],
  'muk': ['मुक'],
  'mukesh': ['मुकेश'],
  'ma': ['म', 'मा'],
  'man': ['मन', 'मान'],
  'manv': ['मानव', 'मनव'],
  'manve': ['मानवे', 'मनवे'],
  'manven': ['मानवेन', 'मनवेन'],
  'manvend': ['मानवेन्द', 'मानवेनद'],
  'manvendr': ['मानवेन्द्र', 'मानवेन्द्र'],
  'manvendra': ['मानवेन्द्र', 'मानवेन्द्र'],
  'om': ['ओम'],
  'omprakash': ['ओमप्रकाश', 'ओम प्रकाश'],
  'si': ['सी', 'सि'],
  'singh': ['सिंह'],
  'sita': ['सीता'],
  'geeta': ['गीता'],
  'pooja': ['पूजा'],
  'puja': ['पूजा'],
  'kalu': ['कालू', 'कलु'],
  'kaluram': ['कालूराम', 'कालू राम'],
  'ashok': ['अशोक'],
  'sunil': ['सुनील'],
  'anil': ['अनिल'],
  'manoj': ['मनोज'],
  'sanjay': ['संजय'],
  'santosh': ['संतोष'],
  'vijay': ['विजय'],
  'ajay': ['अजय'],
  'devi': ['देवी'],
  'bai': ['बाई'],
  'kanwar': ['कंवर'],
  'lal': ['लाल'],
  'kumar': ['कुमार'],
  'kumari': ['कुमारी'],
  'chaudhary': ['चौधरी'],
  'choudhary': ['चौधरी'],
  'shyam': ['श्याम'],
  'shanti': ['शान्ति', 'शांति'],
  'sohan': ['सोहन'],
  'mohan': ['मोहन'],
  'bhanwar': ['भंवर'],
  'tejaram': ['तेजाराम', 'तेजा राम'],
  'jetharam': ['जेठाराम', 'जेठा राम'],
  'radha': ['राधा'],
  'priyanka': ['प्रियंका', 'प्रियङ्का'],
  'tulsa': ['तुलसा'],
  'tulsaram': ['तुलसा राम', 'तुलसाराम']
};

/**
 * Builds an advanced, fault-tolerant Devanagari regex from English transliterated text.
 * Accurately matches modern Hindi schwa, halants, conjunct clusters (e.g. -न्द्र, -प्र, -त्र),
 * vowels (e.g. a -> optional matra, ee/i, oo/u), and compound word spaces.
 */
function buildDevanagariSearchRegex(englishQuery) {
  if (!englishQuery || typeof englishQuery !== 'string') return null;
  const clean = englishQuery.trim().slice(0, 100).toLowerCase().replace(/\s+/g, ' ');
  if (!clean || /[\u0900-\u097F]/.test(clean)) return null; // already Hindi
  if (/^[a-z]{2,4}\d{4,8}$/i.test(clean) || /^\d+$/.test(clean)) return null; // EPIC or digits

  // Insert optional space boundary before common compound name suffixes
  const s = clean.replace(/([a-z])(ram|lal|kumari|kumar|singh|devi|bai|prakash|prasad|chand|deen|pal|nath|das|dev|raj)\b/g, '$1 $2');

  let pattern = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') {
      pattern += '\\s*';
      i++;
      continue;
    }
    // Discard any raw regex metacharacters entered by user
    if (/[()\[\]{}*+?^$\\.|#@!%&]/.test(s[i])) {
      i++;
      continue;
    }

    // 4-char sequences
    if (s.startsWith('shth', i)) { pattern += '[षस]्?[ठथ]'; i += 4; continue; }

    // 3-char sequences
    if (s.startsWith('ndr', i)) { pattern += '[नंण]?्?[दधड]्?[र]'; i += 3; continue; }
    if (s.startsWith('chh', i)) { pattern += '[छच]'; i += 3; continue; }
    if (s.startsWith('ksh', i)) { pattern += '[क्ष]'; i += 3; continue; }
    if (s.startsWith('shr', i)) { pattern += '[श्रश]'; i += 3; continue; }
    if (s.startsWith('shw', i) || s.startsWith('shv', i)) { pattern += '[शस]्?[वब]'; i += 3; continue; }

    // 2-char sequences
    if (s.startsWith('kh', i)) { pattern += '[खक]'; i += 2; continue; }
    if (s.startsWith('gh', i)) { pattern += '[घग]'; i += 2; continue; }
    if (s.startsWith('ch', i)) { pattern += '[चछ]'; i += 2; continue; }
    if (s.startsWith('jh', i)) { pattern += '[झज]'; i += 2; continue; }
    if (s.startsWith('th', i)) { pattern += '[थठ]'; i += 2; continue; }
    if (s.startsWith('dh', i)) { pattern += '[धढ]'; i += 2; continue; }
    if (s.startsWith('ph', i)) { pattern += '[फफ़]'; i += 2; continue; }
    if (s.startsWith('bh', i)) { pattern += '[भब]'; i += 2; continue; }
    if (s.startsWith('sh', i)) { pattern += '[शषस]'; i += 2; continue; }
    if (s.startsWith('tr', i)) { pattern += '[त्रत]'; i += 2; continue; }
    if (s.startsWith('gy', i)) { pattern += '[ज्ञग]'; i += 2; continue; }
    if (s.startsWith('st', i)) { pattern += '[सष]्?[तट]'; i += 2; continue; }
    if (s.startsWith('pr', i)) { pattern += '[प]्?[र]?'; i += 2; continue; }
    if (s.startsWith('kr', i)) { pattern += '[क]्?[र]?'; i += 2; continue; }
    if (s.startsWith('gr', i)) { pattern += '[ग]्?[र]?'; i += 2; continue; }
    if (s.startsWith('br', i)) { pattern += '[ब]्?[र]?'; i += 2; continue; }
    if (s.startsWith('mr', i)) { pattern += '[म]्?[र]?'; i += 2; continue; }
    if (s.startsWith('dr', i)) { pattern += '[दध]्?[र]?'; i += 2; continue; }
    if (s.startsWith('nd', i)) { pattern += '[नंण]?्?[दधड]'; i += 2; continue; }
    if (s.startsWith('nt', i)) { pattern += '[नंण]?्?[तट]'; i += 2; continue; }
    if (s.startsWith('nk', i)) { pattern += '[नंणङ्]?्?[क]'; i += 2; continue; }
    if (s.startsWith('ng', i)) { pattern += '[नंणङ्ग]?्?[ग]'; i += 2; continue; }
    if (s.startsWith('aa', i)) { pattern += '(?:[ा]|आ)?'; i += 2; continue; }
    if (s.startsWith('ee', i)) { pattern += '(?:[िी]|ई|इ)?'; i += 2; continue; }
    if (s.startsWith('oo', i)) { pattern += '(?:[ुू]|ऊ|उ)?'; i += 2; continue; }
    if (s.startsWith('ai', i)) { pattern += '(?:[ैे]|ऐ|ए)?'; i += 2; continue; }
    if (s.startsWith('au', i) || s.startsWith('ou', i)) { pattern += '(?:[ौो]|औ|ओ)?'; i += 2; continue; }

    // 1-char consonants
    const c = s[i];
    if (c === 'k' || c === 'c') pattern += '[कक़]';
    else if (c === 'g') pattern += '[गग़]';
    else if (c === 'j' || c === 'z') pattern += '[जज़]';
    else if (c === 't') pattern += '[तट]';
    else if (c === 'd') pattern += '[दधडड़]';
    else if (c === 'n') pattern += '[नंण]';
    else if (c === 'p') pattern += '[प]';
    else if (c === 'f') pattern += '[फफ़]';
    else if (c === 'b') pattern += '[बव]';
    else if (c === 'm') pattern += '[मं]';
    else if (c === 'y') pattern += '[य]';
    else if (c === 'r') pattern += '[रड़ढ़]्?';
    else if (c === 'l') pattern += '[ल]';
    else if (c === 'v' || c === 'w') pattern += '[वब]';
    else if (c === 's') pattern += '[सशष]';
    else if (c === 'h') pattern += '[ह]';
    else if (c === 'q') pattern += '[कक़]';
    else if (c === 'x') pattern += '[क्सक्ष]';
    // Vowels
    else if (c === 'a') pattern += '(?:[ा]|अ|आ)?';
    else if (c === 'i') pattern += '(?:[िी]|इ|ई)?';
    else if (c === 'u') pattern += '(?:[ुू]|उ|ऊ)?';
    else if (c === 'e') pattern += '(?:[ेै]|ए|ऐ)?';
    else if (c === 'o') pattern += '(?:[ोौ]|ओ|औ)?';
    else pattern += c;
    i++;
  }
  return pattern ? new RegExp(pattern, 'i') : null;
}

function getHindiPhoneticCandidates(query) {
  if (!query || typeof query !== 'string') return [];
  const clean = query.trim().slice(0, 100).toLowerCase();
  if (!clean || /[\u0900-\u097F]/.test(clean)) return [];
  if (/^[a-z]{2,4}\d{4,8}$/i.test(clean) || /^\d+$/.test(clean)) return [];

  if (COMMON_SEARCH_MAPPINGS[clean]) return COMMON_SEARCH_MAPPINGS[clean];

  const candidates = [];
  if (clean === 'm') candidates.push('म', 'मा');
  else if (clean === 'b') candidates.push('ब', 'बा');
  else if (clean === 'r') candidates.push('र', 'रा');
  else if (clean === 'k') candidates.push('क', 'का');
  else if (clean === 's') candidates.push('स', 'श', 'सा');
  else if (clean === 'p') candidates.push('प', 'पा');
  else if (clean === 'v' || clean === 'w') candidates.push('व', 'वा');
  else if (clean === 'd') candidates.push('द', 'दा');
  else if (clean === 't') candidates.push('त', 'ता');
  else if (clean === 'j') candidates.push('ज', 'जा');
  else if (clean === 'n') candidates.push('न', 'ना');
  else if (clean === 'g') candidates.push('ग', 'गा');
  else if (clean === 'h') candidates.push('ह', 'हा');

  return candidates;
}

module.exports = {
  buildDevanagariSearchRegex,
  getHindiPhoneticCandidates,
  COMMON_SEARCH_MAPPINGS,
};
