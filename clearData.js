require('dotenv').config();
const mongoose = require('mongoose');
const { Voter } = require('./models');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to DB");
  
  if (Voter) {
    const res = await Voter.deleteMany({});
    console.log(`Deleted ${res.deletedCount} voters`);
  }
  
  console.log("Done");
  process.exit(0);
}
run();
