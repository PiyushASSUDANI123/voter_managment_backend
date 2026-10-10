require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDB } = require('../db');
const { Organization, User, Voter } = require('../models');

const SAMPLE_DEMO_NAMES = [
  { hi: 'रामगोपाल शर्मा', en: 'Ramgopal Sharma', relHi: 'मदनलाल शर्मा', relEn: 'Madanlal Sharma', relType: 'पिता', caste: 'ब्राह्मण', house: '14' },
  { hi: 'कमला देवी शर्मा', en: 'Kamla Devi Sharma', relHi: 'रामगोपाल शर्मा', relEn: 'Ramgopal Sharma', relType: 'पति', caste: 'ब्राह्मण', house: '14' },
  { hi: 'सुरेश कुमार मीणा', en: 'Suresh Kumar Meena', relHi: 'रामकेश मीणा', relEn: 'Ramkesh Meena', relType: 'पिता', caste: 'मीणा', house: '21' },
  { hi: 'सुनीता मीणा', en: 'Sunita Meena', relHi: 'सुरेश कुमार मीणा', relEn: 'Suresh Kumar Meena', relType: 'पति', caste: 'मीणा', house: '21' },
  { hi: 'विजय सिंह शेखावत', en: 'Vijay Singh Shekhawat', relHi: 'प्रताप सिंह', relEn: 'Pratap Singh', relType: 'पिता', caste: 'राजपूत', house: '32' },
  { hi: 'कौशल्या कंवर', en: 'Kaushalya Kanwar', relHi: 'विजय सिंह शेखावत', relEn: 'Vijay Singh Shekhawat', relType: 'पति', caste: 'राजपूत', house: '32' },
  { hi: 'राकेश कुमार जाट', en: 'Rakesh Kumar Jat', relHi: 'बलदेव जाट', relEn: 'Baldev Jat', relType: 'पिता', caste: 'जाट', house: '45' },
  { hi: 'मंजू जाट', en: 'Manju Jat', relHi: 'राकेश कुमार जाट', relEn: 'Rakesh Kumar Jat', relType: 'पति', caste: 'जाट', house: '45' },
  { hi: 'अब्दुल रशीद खान', en: 'Abdul Rasheed Khan', relHi: 'बशीर खान', relEn: 'Basheer Khan', relType: 'पिता', caste: 'मुस्लिम', house: '58' },
  { hi: 'शबाना बानो', en: 'Shabana Bano', relHi: 'अब्दुल रशीद खान', relEn: 'Abdul Rasheed Khan', relType: 'पति', caste: 'मुस्लिम', house: '58' },
  { hi: 'महेश कुमार कुमावत', en: 'Mahesh Kumar Kumawat', relHi: 'गोपाल कुमावत', relEn: 'Gopal Kumawat', relType: 'पिता', caste: 'कुमावत', house: '67' },
  { hi: 'रेखा कुमावत', en: 'Rekha Kumawat', relHi: 'महेश कुमार कुमावत', relEn: 'Mahesh Kumar Kumawat', relType: 'पति', caste: 'कुमावत', house: '67' },
  { hi: 'दिनेश कुमार गुर्जर', en: 'Dinesh Kumar Gurjar', relHi: 'रामफूल गुर्जर', relEn: 'Ramphool Gurjar', relType: 'पिता', caste: 'गुर्जर', house: '78' },
  { hi: 'सीमा गुर्जर', en: 'Seema Gurjar', relHi: 'दिनेश कुमार गुर्जर', relEn: 'Dinesh Kumar Gurjar', relType: 'पति', caste: 'गुर्जर', house: '78' },
  { hi: 'अशोक कुमार अग्रवाल', en: 'Ashok Kumar Agrawal', relHi: 'मुरारी लाल', relEn: 'Murari Lal', relType: 'पिता', caste: 'वैश्य', house: '92' },
  { hi: 'शारदा अग्रवाल', en: 'Sharda Agrawal', relHi: 'अशोक कुमार अग्रवाल', relEn: 'Ashok Kumar Agrawal', relType: 'पति', caste: 'वैश्य', house: '92' },
  { hi: 'विकास कुमार यादव', en: 'Vikas Kumar Yadav', relHi: 'हरिराम यादव', relEn: 'Hariram Yadav', relType: 'पिता', caste: 'यादव', house: '105' },
  { hi: 'पूजा यादव', en: 'Pooja Yadav', relHi: 'विकास कुमार यादव', relEn: 'Vikas Kumar Yadav', relType: 'पति', caste: 'यादव', house: '105' },
  { hi: 'प्रकाश चंद वर्मा', en: 'Prakash Chand Verma', relHi: 'किशोरी लाल', relEn: 'Kishori Lal', relType: 'पिता', caste: 'वर्मा / एससी', house: '118' },
  { hi: 'संतोष वर्मा', en: 'Santosh Verma', relHi: 'प्रकाश चंद वर्मा', relEn: 'Prakash Chand Verma', relType: 'पति', caste: 'वर्मा / एससी', house: '118' },
  { hi: 'संजय कुमार सैनी', en: 'Sanjay Kumar Saini', relHi: 'भंवर लाल सैनी', relEn: 'Bhanwar Lal Saini', relType: 'पिता', caste: 'माली / सैनी', house: '131' },
  { hi: 'अनिता सैनी', en: 'Anita Saini', relHi: 'संजय कुमार सैनी', relEn: 'Sanjay Kumar Saini', relType: 'पति', caste: 'माली / सैनी', house: '131' },
  { hi: 'मुकेश कुमार प्रजापत', en: 'Mukesh Kumar Prajapat', relHi: 'रामस्वरूप', relEn: 'Ramswaroop', relType: 'पिता', caste: 'प्रजापत', house: '144' },
  { hi: 'सरोज प्रजापत', en: 'Saroj Prajapat', relHi: 'मुकेश कुमार प्रजापत', relEn: 'Mukesh Kumar Prajapat', relType: 'पति', caste: 'प्रजापत', house: '144' },
  { hi: 'अनिल कुमार सोनी', en: 'Anil Kumar Soni', relHi: 'रतन लाल सोनी', relEn: 'Ratan Lal Soni', relType: 'पिता', caste: 'स्वर्णकार', house: '158' }
];

async function seedDemoAccount() {
  await connectDB();
  console.log('Connected to DB');

  // 1. Move any users in org_default to org_developer_test
  const defaultUserUpdate = await User.updateMany(
    { organizationId: 'org_default' },
    { $set: { organizationId: 'org_developer_test' } }
  );
  console.log('Migrated users from org_default to org_developer_test:', defaultUserUpdate.modifiedCount);

  // 2. Mark org_default as inactive or remove
  await Organization.updateOne({ _id: 'org_default' }, { $set: { isActive: false, name: 'Default Organization (Inactive)' } });

  // 3. Setup Demo Organization
  const orgId = 'tenant_demo_101';
  const plainPassword = 'Demo@VijaySetu2026';
  const demoEmail = 'demo@vijaysetu.com';
  const demoName = 'हवामहल विधानसभा (डेमो प्रत्याशी)';

  await Organization.deleteOne({ _id: orgId });
  await User.deleteOne({ email: demoEmail });
  await Voter.deleteMany({ organizationId: orgId });

  await Organization.create({
    _id: orgId,
    name: demoName,
    enabledModules: ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants', 'accounts'],
    allowedWards: ['वार्ड 1', 'वार्ड 2', 'वार्ड 3'],
    isActive: true,
    isDemo: true,
    demoPassword: plainPassword,
    whatsappEnabled: true,
    whatsappCredits: 50,
    whatsappUsed: 0,
    slipConfig: {
      candidateName: 'श्री राजेश कुमार शर्मा',
      candidateParty: 'भारतीय जनता पार्टी (भाजपा)',
      assemblyConstituency: 'हवामहल (विधानसभा क्षेत्र)',
      wardNumber: 'वार्ड 1',
      pollingDate: '25 नवम्बर 2026',
      appealHeadline: '(1 नंबर पर कमल का फूल का बटन दबाएं)',
      footerAppeal: 'कमल का बटन दबाएं और भारी मतों से विजयी बनाएं'
    }
  });

  const passwordHash = await bcrypt.hash(plainPassword, 10);
  await User.create({
    _id: 'user_demo_101',
    email: demoEmail,
    passwordHash,
    fullName: 'राजेश कुमार शर्मा (डेमो प्रत्याशी)',
    phone: '7231077770',
    role: 'tenant_admin',
    organizationId: orgId,
    isActive: true,
    isDemo: true,
    demoPassword: plainPassword
  });

  const supportStatuses = ['core', 'core', 'swing', 'swing', 'opposition', 'unmarked'];
  const sampleVoters = SAMPLE_DEMO_NAMES.map((item, idx) => {
    const serialNo = idx + 1;
    const wardNo = String((idx % 3) + 1);
    const partNo = String(10 + (idx % 2));
    const epicNum = String(1001000 + serialNo);
    const isFemale = item.relType === 'पति';
    const age = 22 + (idx * 3) % 45;
    const voted = idx % 3 === 0;

    return {
      _id: `voter_demo_101_${serialNo}`,
      epic: `RJX${epicNum}`,
      wardNo,
      partNo,
      serialNo,
      nameEn: item.en,
      nameHi: item.hi,
      age,
      gender: isFemale ? 'स्त्री' : 'पुरुष',
      relationType: item.relType,
      relativeNameEn: item.relEn,
      relativeNameHi: item.relHi,
      houseNo: item.house,
      houseNoHi: item.house,
      mobileNo: '9829' + String(100000 + serialNo * 1234).slice(0, 6),
      caste: item.caste,
      supportStatus: supportStatuses[idx % supportStatuses.length],
      voted,
      votedAt: voted ? new Date() : null,
      surety: idx % 2 === 0 ? 'पक्का' : 'संभावित',
      notes: idx === 0 ? 'वार्ड के प्रमुख सम्मानित नागरिक' : '',
      isMigrant: idx === 4 || idx === 12,
      migrantLocation: idx === 4 ? 'सूरत, गुजरात' : idx === 12 ? 'मुंबई' : '',
      organizationId: orgId,
      familyId: `fam_${item.house}`
    };
  });

  await Voter.insertMany(sampleVoters);
  console.log(`Successfully created demo org ${orgId}, user ${demoEmail}, and ${sampleVoters.length} sample voters!`);

  process.exit(0);
}

seedDemoAccount().catch((err) => {
  console.error('Error seeding demo account:', err);
  process.exit(1);
});
