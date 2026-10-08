// Heuristic mapping for corrupted ECI Rajasthan PDFs
const HINDI_MAP = {
  // Common Surnames / Titles
  "कचमरर": "कुमार",
  "दलरल": "देवी",
  "मरलशरल": "माहेश्वरी",
  "तरपनरजर": "तापड़िया",
  "मलरतर": "मीना",
  "शमरा": "शर्मा",
  "जजन": "जैन",
  "सनह": "सिंह",
  "कवर": "कंवर",
  "बरई": "बाई",
  "दसरन": "दास",
  
  // Common Names
  "पनकज": "पंकज",
  "कजलरश": "कैलाश",
  "ओमपकरश": "ओमप्रकाश",
  "सनगलतर": "संगीता",
  "अशयक": "अशोक",
  "चनदर": "चंदा",
  "मनजप": "मनदीप",
  "आजचषल": "आयुषी",
  "सयरनलरलन": "सोहनलाल",
  "मलठरलरल": "मीठालाल",
  "लरलनर": "ललिता",
  "तनरल": "तनीषा",
  "नरमरनशच": "नर्मदा", // Guess
  "जरनशकर": "जानकी",
  "कयशनलजर": "कौशल्या",
  "गचरर": "गौरी",
  "नजनर": "नीना",
  "ररम": "राम",
  "शरमर": "श्याम",
  "मयहन": "मोहन",
  "सरलर": "सरला",
  "कमलर": "कमला",
  "सचनलर": "सुनीला"
};

function fixCorruptedHindi(text) {
  if (!text) return text;
  
  let fixedText = text;
  
  // Replace whole words based on dictionary
  const words = fixedText.split(' ');
  const correctedWords = words.map(word => {
    return HINDI_MAP[word] || word;
  });
  
  fixedText = correctedWords.join(' ');
  
  // Apply partial fixes for common patterns
  fixedText = fixedText.replace(/कचमरर/g, "कुमार");
  fixedText = fixedText.replace(/दलरल/g, "देवी");
  fixedText = fixedText.replace(/मरलशरल/g, "माहेश्वरी");
  fixedText = fixedText.replace(/पकरश/g, "प्रकाश");
  fixedText = fixedText.replace(/तरपनरजर/g, "तापड़िया");
  
  return fixedText.trim();
}

module.exports = { fixCorruptedHindi, HINDI_MAP };
