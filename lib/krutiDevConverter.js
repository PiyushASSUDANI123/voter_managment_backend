/**
 * Kruti Dev 010 / DevLys 010 to Unicode Devanagari Converter
 * Universal converter for legacy Indian Government Electoral Roll PDFs
 */

const modified_substring = [
  'ñ', 'Q+', 'w', '}', 'R', '>', 'kS', 'ks', 'k', 'A', 'i', 'I', 'u', 'U',
  'a', 'A', 'c', 'C', 'd', 'D', 'e', 'E', 'f', 'F', 'g', 'G', 'h', 'H',
  'j', 'J', 'l', 'L', 'm', 'M', 'n', 'N', 'o', 'O', 'p', 'P', 'q', 'r',
  's', 'S', 't', 'T', 'v', 'V', 'x', 'X', 'y', 'Y', 'z', 'Z', ';', ':',
  '|', '?', '`', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
  '_', '+', '[', ']', '{', '}', '<', '>', '/', '?', '\\', '`', '\'', '"'
];

function isKrutiDevText(text) {
  if (!text || typeof text !== 'string') return false;
  // KrutiDev text commonly contains specific ASCII combinations for common Hindi words
  // e.g. "dk" (का), "dh" (की), "ds" (के), "esa" (में), "gS" (है), "vksj" (और), "uk" (ना)
  const krutiPatterns = /\b(dk|dh|ds|esa|gS|vksj|gks|Fkk|Fks|Fkh|rk|rs|rh|gqvk|gqbZ)\b/g;
  const matches = text.match(krutiPatterns);
  return matches !== null && matches.length >= 3;
}

function convertKrutiDevToUnicode(text) {
  if (!text) return "";

  let converted = text;

  // Replacements for multi-character sequences
  const array_one = [
    "kS", "ks", "k", "f", "h", "q", "w", "`", "s", "S", "a", "A", "W", "x",
    "dks", "dh", "ds", "dk", "gS", "esa"
  ];

  // Standard character substitution table
  const krutiToUnicodeMap = [
    // Complex conjuncts & specials
    { k: "‘", u: "‘" }, { k: "’", u: "’" }, { k: "“", u: "“" }, { k: "”", u: "”" },
    { k: "ñ", u: "ऋ" }, { k: "Q+", u: "फ़" }, { k: "w+", u: "ज़" }, { k: "x+", u: "ग़" },
    { k: "y+", u: "ख़" }, { k: "d+", u: "क़" }, { k: "j+", u: "ड़" }, { k: "T+", u: "ढ़" },
    
    // Half consonants
    { k: "D", u: "क्" }, { k: "X", u: "ग्" }, { k: "P", u: "च्" }, { k: "T", u: "ज्" },
    { k: "U", u: "न्" }, { k: "I", u: "प्" }, { k: "C", u: "ब्" }, { k: "H", u: "भ्" },
    { k: "E", u: "म्" }, { k: "Y", u: "ल्" }, { k: "o", u: "व्" }, { k: "L", u: "स्" },
    { k: "R", u: "त्" }, { k: "F", u: "थ्" }, { k: "O", u: "ध्" }, { k: "S", u: "ै" },
    { k: "W", u: "ँ" }, { k: "Z", u: "र्" }, { k: "z", u: "्र" },
    
    // Full consonants
    { k: "d", u: "क" }, { k: "[k", u: "ख" }, { k: "x", u: "ग" }, { k: "?k", u: "घ" }, { k: "M", u: "ङ" },
    { k: "p", u: "च" }, { k: "N", u: "छ" }, { k: "t", u: "ज" }, { k: "T", u: "ज्" }, { k: "÷", u: "झ" },
    { k: "V", u: "ट" }, { k: "B", u: "ठ" }, { k: "M+", u: "ड" }, { k: "<", u: "ढ" }, { k: ".k", u: "ण" },
    { k: "r", u: "त" }, { k: "Fk", u: "थ" }, { k: "n", u: "द" }, { k: "/k", u: "ध" }, { k: "u", u: "न" },
    { k: "i", u: "प" }, { k: "Q", u: "फ" }, { k: "c", u: "ब" }, { k: "Hk", u: "भ" }, { k: "e", u: "म" },
    { k: "य", u: "य" }, { k: "j", u: "र" }, { k: "y", u: "ल" }, { k: "o", u: "व" },
    { k: "\"", u: "ष्" }, { k: "'", u: "श" }, { k: "l", u: "स" }, { k: "g", u: "ह" },
    { k: "K", u: "ज्ञ" }, { k: "=\"", u: "त्र" }, { k: "{k", u: "क्ष" }, { k: "J", u: "श्र" },

    // Vowels
    { k: "vksS", u: "औ" }, { k: "vks", u: "ओ" }, { k: "vk", u: "आ" }, { k: "v", u: "अ" },
    { k: "bZ", u: "ई" }, { k: "b", u: "इ" }, { k: "m", u: "उ" }, { k: "Å", u: "ऊ" },
    { k: ",", u: "ए" }, { k: "S", u: "ऐ" },

    // Matras & diacritics
    { k: "ks", u: "ो" }, { k: "kS", u: "ौ" }, { k: "k", u: "ा" }, { k: "h", u: "ी" },
    { k: "q", u: "ु" }, { k: "w", u: "ू" }, { k: "s", u: "े" }, { k: "S", u: "ै" },
    { k: "a", u: "ं" }, { k: ":", u: "ः" }, { k: "्", u: "्" },

    // Numbers
    { k: "0", u: "०" }, { k: "1", u: "१" }, { k: "2", u: "२" }, { k: "3", u: "३" }, { k: "4", u: "४" },
    { k: "5", u: "५" }, { k: "6", u: "६" }, { k: "7", u: "७" }, { k: "8", u: "८" }, { k: "9", u: "९" }
  ];

  // Chhoti 'i' matra reordering: In KrutiDev 'f' is placed before the character/cluster
  // e.g. "fd" -> "कि", "fD+" -> "क्लि"
  converted = converted.replace(/f([\u0900-\u097F\w])/g, "$1ि");
  
  // Reph 'Z' reordering: placed after consonant
  converted = converted.replace(/([\u0900-\u097F\w])Z/g, "र्$1");

  return converted;
}

module.exports = {
  isKrutiDevText,
  convertKrutiDevToUnicode
};
