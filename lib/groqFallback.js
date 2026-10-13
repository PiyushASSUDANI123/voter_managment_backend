const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

/**
 * Checks if a voter record has missing or broken critical data
 */
function needsAiRepair(record) {
  if (!record) return true;
  const name = String(record.nameHi || record.name || '').trim();
  const relName = String(record.relativeNameHi || record.relativeName || '').trim();

  // Reject administrative words mistakenly saved as voter names
  const adminWords = ['ओसियाँ', 'विधानसभा', 'निर्वाचक', 'नामावली', 'ग्रामपंचायत', 'पंचायत', 'समिति', 'राजस्थान', 'आयोग'];
  if (adminWords.some(w => name.includes(w))) return true;

  if (!name || name.length < 2) return true;
  if (!relName || relName.length < 2 || ['-', '—', 'nil', 'na', 'null'].includes(relName.toLowerCase())) return true;

  return false;
}

/**
 * Call Groq API with candidate model fallback
 */
async function callGroq(prompt, timeoutMs = 8000) {
  if (!GROQ_API_KEY) return null;

  for (const model of GROQ_MODELS) {
    try {
      const res = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert Indian Electoral Roll (मतदाता सूची) text parser. Output strictly VALID JSON only. No markdown formatting.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1
        });

        const req = https.request({
          hostname: 'api.groq.com',
          path: '/openai/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: timeoutMs
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                const content = parsed.choices?.[0]?.message?.content || null;
                resolve(content);
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`Groq HTTP ${res.statusCode}: ${body}`));
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Groq timeout'));
        });

        req.write(payload);
        req.end();
      });

      if (res) return res;
    } catch (err) {
      // Try next candidate model
      continue;
    }
  }

  return null;
}

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text.trim());
  } catch {}
  const m = text.match(/(\{[\s\S]*\})/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  return null;
}

/**
 * Repairs a single voter record using Groq
 */
async function repairVoterCardGroq(cardRawText, currentRecord) {
  if (!needsAiRepair(currentRecord)) return currentRecord;

  const prompt = `Extract clean Hindi voter details from this text card:
Card text: "${cardRawText}"
Current extracted: ${JSON.stringify(currentRecord)}

Note:
- In Rajasthan SEC rolls: 'र' may represent 'ा' (aa matra)
- Do NOT use administrative names like 'ओसियाँ', 'विधानसभा', 'वार्ड' as person names.
- Output JSON format:
{
  "name": "मतदाता का शुद्ध हिंदी नाम",
  "relativeName": "पिता/पति का शुद्ध हिंदी नाम",
  "relationType": "पिता" | "पति" | "माता",
  "houseNo": "मकान सं (संख्या केवल, जैसे 1, 2)",
  "age": 30,
  "gender": "पुरुष" | "स्त्री"
}`;

  const res = await callGroq(prompt, 6000);
  const data = extractJson(res);
  if (!data) return currentRecord;

  const adminWords = ['ओसियाँ', 'विधानसभा', 'निर्वाचक', 'नामावली', 'ग्रामपंचायत', 'पंचायत', 'समिति', 'राजस्थान'];
  const name = String(data.name || '').trim();
  const relName = String(data.relativeName || '').trim().replace(/^(?:पिता|पति|माता|वालिद|आत्मज|सुपुत्र|पत्नी)[:\s\-]*/, '');
  const relType = String(data.relationType || '').trim();
  const house = String(data.houseNo || '').trim().replace(/['"]/g, '');
  const age = Number(data.age);
  const gender = String(data.gender || '').trim();

  // If current name was an admin word or missing, replace it
  const curName = String(currentRecord.nameHi || currentRecord.name || '').trim();
  if ((!curName || curName.length < 2 || adminWords.some(w => curName.includes(w))) && name && !adminWords.some(w => name.includes(w))) {
    currentRecord.name = name;
    currentRecord.nameHi = name;
  }

  if ((!currentRecord.relativeNameHi || currentRecord.relativeNameHi.length < 2 || ['-', '—'].includes(currentRecord.relativeNameHi)) && relName && relName.length >= 2) {
    currentRecord.relativeName = relName;
    currentRecord.relativeNameHi = relName;
  }

  if (['पिता', 'पति', 'माता'].includes(relType)) {
    currentRecord.relationType = relType;
  }

  if ((!currentRecord.houseNo || ['-', "'-", '', '0'].includes(currentRecord.houseNo)) && house && !['0', '-'].includes(house)) {
    currentRecord.houseNo = house;
  }

  if ((!currentRecord.age || currentRecord.age < 18) && age >= 18 && age <= 125) {
    currentRecord.age = age;
  }

  if (['पुरुष', 'स्त्री'].includes(gender)) {
    currentRecord.gender = gender;
  }

  return currentRecord;
}

module.exports = {
  callGroq,
  needsAiRepair,
  repairVoterCardGroq
};
