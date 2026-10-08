const mongoose = require('mongoose');
const { Voter } = require('./models');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const v = await Voter.findOne();
  console.log(v);
  process.exit(0);
}
run();
