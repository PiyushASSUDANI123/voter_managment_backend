const text = `
निर्वाचक का नाम : राम कुमार
पिता का नाम : श्याम कुमार
मकान संख्या : 45
आयु : 35 लिंग : पुरुष
ABC1234567

नाम : सीता देवी
पति का नाम : राम कुमार
मकान संख्या : 45-A
आयु : 30 लिंग : महिला
XYZ9876543
`;

const parseVoters = (text) => {
  const voters = [];
  const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2}\/\d{2}\/\d{3}\/\d{6}/gi;
  
  // Find all epics and their indices
  let match;
  const epics = [];
  while ((match = epicRegex.exec(text)) !== null) {
    epics.push({ epic: match[0], index: match.index });
  }

  for (let i = 0; i < epics.length; i++) {
    const current = epics[i];
    // A voter's block is usually the text BEFORE the EPIC, up to the previous EPIC
    const startIndex = i === 0 ? 0 : epics[i-1].index + epics[i-1].epic.length;
    const block = text.substring(startIndex, current.index);
    
    // Extract details
    const nameMatch = block.match(/(?:निर्वाचक का नाम|नाम)\s*[:\-]?\s*([^\n]+)/i);
    const fatherMatch = block.match(/(?:पिता|पति|माता|अन्य)\s*का\s*नाम\s*[:\-]?\s*([^\n]+)/i);
    const relationTypeMatch = block.match(/(पिता|पति|माता|अन्य)/);
    const houseMatch = block.match(/मकान\s*संख्या\s*[:\-]?\s*([^\n]+)/i);
    const ageMatch = block.match(/आयु\s*[:\-]?\s*(\d+)/i);
    const genderMatch = block.match(/लिंग\s*[:\-]?\s*(पुरुष|महिला|स्त्री|अन्य)/i);
    
    voters.push({
      epic: current.epic.toUpperCase(),
      nameHi: nameMatch ? nameMatch[1].trim() : "PDF Extracted",
      relativeNameHi: fatherMatch ? fatherMatch[1].trim() : "",
      relationType: relationTypeMatch ? relationTypeMatch[1].trim() : "",
      houseNo: houseMatch ? houseMatch[1].trim() : "",
      age: ageMatch ? parseInt(ageMatch[1], 10) : null,
      gender: genderMatch ? genderMatch[1].trim() : ""
    });
  }
  return voters;
};

console.log(parseVoters(text));
