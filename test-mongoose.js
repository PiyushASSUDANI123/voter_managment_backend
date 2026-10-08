const mongoose = require('mongoose');
const crypto = require('crypto');
const { Voter } = require('./models');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/voter_management').then(async () => {
  try {
    const epic = 'ABC1234567';
    await Voter.bulkWrite([{
      updateOne: {
        filter: { epic: epic },
        update: {
          $setOnInsert: {
            _id: `voter_${crypto.randomUUID()}`,
            epic: epic,
            wardNo: "1",
            partNo: "1",
            serialNo: 1,
            nameEn: "PDF Extracted",
            nameHi: "PDF Extracted",
            organizationId: "org_default"
          }
        },
        upsert: true
      }
    }]);
    console.log("SUCCESS");
  } catch(e) {
    console.error("ERROR", e.message);
  }
  process.exit(0);
});
