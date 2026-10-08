const fs = require('fs');
const pdfParse = require('pdf-parse');

async function test() {
  const dataBuffer = fs.readFileSync('/Users/piyush/Documents/moxrathore_projects/vijaysetu/01.pdf');
  const data = await pdfParse(dataBuffer);
  const text = data.text;
  
  const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2}\/\d{2}\/\d{3}\/\d{6}/gi;
  let match;
  const epics = [];
  while ((match = epicRegex.exec(text)) !== null) {
    epics.push({ epic: match[0], index: match.index });
  }

  const voters = [];
  for (let i = 0; i < epics.length; i++) {
    const current = epics[i];
    // Find the text before the current epic, up to the previous epic's end
    const startIndex = i === 0 ? 0 : epics[i-1].index + epics[i-1].epic.length;
    let beforeText = text.substring(startIndex, current.index).trimEnd();
    
    // Split by newline and get the last 5 lines
    const lines = beforeText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    
    // Some lines might be labels, we only want the values.
    // The values are at the very end of the lines array.
    if (lines.length >= 5) {
      const relativeNameHi = lines[lines.length - 1];
      const nameHi = lines[lines.length - 2];
      const houseNo = lines[lines.length - 3];
      const genderRaw = lines[lines.length - 4];
      const age = lines[lines.length - 5];
      
      let genderVal = "अन्य";
      if (genderRaw.includes("पचरष") || genderRaw.includes("प")) genderVal = "पुरुष";
      if (genderRaw.includes("सल") || genderRaw.includes("स")) genderVal = "स्त्री";
      
      // Relation type: We can look further back to see if it was `पनत कर नरम:` or `नपतर कर नरम:`
      // But it's easier to just default or check the string.
      // Usually if gender is female, relative is husband or father.
      
      voters.push({
        epic: current.epic,
        nameHi,
        relativeNameHi,
        houseNo,
        age: parseInt(age) || null,
        gender: genderVal
      });
    }
  }
  console.log(voters.slice(0, 5));
}
test();
