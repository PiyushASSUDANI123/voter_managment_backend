require('dotenv').config();
const mongoose = require('mongoose');
const { Organization, User } = require('./models');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const orgs = await Organization.find();
  const users = await User.find();
  console.log("Orgs:", orgs);
  console.log("Users:", users);
  process.exit(0);
}
run();
