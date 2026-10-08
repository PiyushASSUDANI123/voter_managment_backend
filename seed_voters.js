const mongoose = require('mongoose');
require('dotenv').config();
const { Voter } = require('./models/index');

async function seed() {
  try {
    const uri = process.env.MONGO_URI;
    await mongoose.connect(uri, { maxPoolSize: 20 });
    console.log('Connected to MongoDB');

    // "pehle nah database khali kar"
    await Voter.deleteMany({});
    console.log('Cleared existing voters');

    // "and fir usme data add kar"
    const fakeVoters = [];
    for (let i = 1; i <= 20; i++) {
      fakeVoters.push({
        _id: `voter_${i}`, epic: `ABC12345${i}`,
        wardNo: 'Ward 1',
        partNo: 'Part 1',
        serialNo: i,
        nameEn: `Test Voter ${i}`,
        nameHi: `टेस्ट वोटर ${i}`,
        age: 20 + i,
        gender: i % 2 === 0 ? 'M' : 'F',
        relationType: 'F',
        relativeNameEn: 'Test Father',
        relativeNameHi: 'टेस्ट पिता',
        houseNo: `H-${i}`,
        mobileNo: `99999999${i < 10 ? '0' + i : i}`,
        caste: 'General',
        supportStatus: i % 3 === 0 ? 'core' : 'unmarked',
        voted: i % 5 === 0,
        organizationId: 'org_default'
      });
    }

    await Voter.insertMany(fakeVoters);
    console.log(`Inserted ${fakeVoters.length} fake voters!`);
    
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

seed();
