const fs = require('fs');
const pdfParse = require('pdf-parse');

async function test() {
  const dataBuffer = fs.readFileSync('/Users/piyush/Documents/moxrathore_projects/vijaysetu/01.pdf');
  const data = await pdfParse(dataBuffer);
  console.log(data.text.substring(2000, 4000));
}
test();
