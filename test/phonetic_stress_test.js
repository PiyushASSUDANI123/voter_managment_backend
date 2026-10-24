const { buildDevanagariSearchRegex, getHindiPhoneticCandidates } = require('../lib/phoneticSearch');

console.log('====================================================');
console.log('🧪 RUNNING DEEP PHONETIC SEARCH STRESS & CRASH TEST');
console.log('====================================================');

const sampleVoters = [
  'मानवेन्द्र',
  'प्रियंका',
  'तुलसा राम',
  'बुधाराम',
  'सुरेश कुमार',
  'जितेन्द्र सिंह',
  'धर्मेन्द्र',
  'नरेन्द्र',
  'सुरेन्द्र',
  'ओम प्रकाश',
  'कमलेश देवी',
  'राधा कुमारी',
  'कालूराम',
  'छगन लाल',
  'लीलाधर',
  'सुभाष चन्द्र',
  'गजानन्द',
  'कैलाश चन्द',
  'भागीरथ',
  'नेमीचन्द',
  'विकास',
  'दीपक',
  'प्रमोद',
  'रोशन लाल',
  'मनीष कुमार',
  'चौधरी हनुमान राम',
  'शर्मा सत्यनारायण',
  'मेघवाल गोरधन',
  'बिश्नोई जगदीश',
  'मुकेश जोशी'
];

let failures = 0;

// Test 1: Typing progression from 1 letter to complete name
console.log('\n[Test 1] Keystroke typing progression for मानवेन्द्र:');
const keystrokes = ['m', 'ma', 'man', 'manv', 'manve', 'manven', 'manvend', 'manvendr', 'manvendra'];
for (const step of keystrokes) {
  const reg = buildDevanagariSearchRegex(step);
  const candidates = getHindiPhoneticCandidates(step);
  const matches = (reg && reg.test('मानवेन्द्र')) || candidates.some(c => 'मानवेन्द्र'.includes(c));
  if (!matches) {
    console.error(`❌ FAILED at keystroke "${step}" for मानवेन्द्र`);
    failures++;
  } else {
    console.log(`  ✓ Keystroke "${step}" matches मानवेन्द्र (Regex: ${reg ? reg.source : 'none'}, Candidates: ${candidates.join(', ') || 'none'})`);
  }
}

// Test 2: Typing progression for बुधाराम
console.log('\n[Test 2] Keystroke typing progression for बुधाराम:');
const budhaKeys = ['b', 'bu', 'bud', 'budh', 'budha', 'budhar', 'budhara', 'budharam', 'budha ram'];
for (const step of budhaKeys) {
  const reg = buildDevanagariSearchRegex(step);
  const candidates = getHindiPhoneticCandidates(step);
  const matches = (reg && reg.test('बुधाराम')) || candidates.some(c => 'बुधाराम'.includes(c));
  if (!matches) {
    console.error(`❌ FAILED at keystroke "${step}" for बुधाराम`);
    failures++;
  } else {
    console.log(`  ✓ Keystroke "${step}" matches बुधाराम`);
  }
}

// Test 3: Robustness against careless/unskilled user input
console.log('\n[Test 3] Careless user input / regex injection / weird characters:');
const badInputs = [
  '(((manvendra)))',
  '[[[suresh]]]',
  '***budharam***',
  '+++kamlesh+++',
  '???manvendr???',
  '$$$tulsaram$$$',
  '^^^priyanka^^^',
  '\\\\\\om\\\\\\',
  '   manvendr   ',
  'm   a   n   v   e   n   d   r',
  '!@#$%^&*()_+{}|:"<>?',
  'a'.repeat(2000), // Massive paste bomb
  '🗳️ 🇮🇳 मानवेन्द्र',
  'RLJ1234567',
  '9876543210'
];

for (const bad of badInputs) {
  try {
    const reg = buildDevanagariSearchRegex(bad);
    const cand = getHindiPhoneticCandidates(bad);
    // Ensure no throw / crash
    if (reg) {
      sampleVoters.filter(name => reg.test(name));
    }
    console.log(`  ✓ Safely handled bad input "${bad.slice(0, 30)}${bad.length > 30 ? '...' : ''}" with ZERO crash!`);
  } catch (err) {
    console.error(`❌ CRASHED on bad input "${bad}":`, err.message);
    failures++;
  }
}

// Test 4: Performance / Stress benchmark (5,000 regex compilations and matches)
console.log('\n[Test 4] Stress test: 5,000 search regex compilations and voter scans:');
const startTime = Date.now();
for (let i = 0; i < 5000; i++) {
  const q = keystrokes[i % keystrokes.length];
  const reg = buildDevanagariSearchRegex(q);
  if (reg) {
    for (let j = 0; j < sampleVoters.length; j++) {
      reg.test(sampleVoters[j]);
    }
  }
}
const elapsed = Date.now() - startTime;
console.log(`⚡ 5,000 queries over ${sampleVoters.length} records executed in ${elapsed}ms (${(elapsed / 5000).toFixed(3)}ms per query)!`);
if (elapsed > 2000) {
  console.error('❌ TOO SLOW! Elapsed time exceeded 2000ms');
  failures++;
}

console.log('====================================================');
if (failures === 0) {
  console.log('🎉 ALL 100% PHONETIC SEARCH STRESS TESTS PASSED CLEANLY!');
} else {
  console.error(`💥 ENCOUNTERED ${failures} TEST FAILURES!`);
  process.exit(1);
}
console.log('====================================================');
