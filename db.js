const mongoose = require('mongoose');
const { Organization, User } = require('./models/index');
const bcrypt = require('bcryptjs');

const ensureSchema = async () => {
  try {
    // Check and insert default organization
    let defaultOrg = await Organization.findById('org_default');
    if (!defaultOrg) {
      await Organization.create({
        _id: 'org_default',
        name: 'Default Organization',
        enabledModules: ["voters","poll-desk","turnout","warroom","history","community","workers","migrants","accounts"],
        isActive: true
      });
      console.log('✅ Created Default Organization');
    }

    // Seed Admins requested by user
    const pwd1 = await bcrypt.hash('9413879444', 10);
    const pwd2 = await bcrypt.hash('Moxrathore@123456&qwerty', 10);
    
    await User.findOneAndUpdate(
      { email: 'piyushassudani' },
      { 
        $setOnInsert: { _id: 'user_piyush_' + Date.now(), fullName: 'Piyush Assudani', phone: '9413879444', organizationId: 'org_default' },
        $set: { role: 'admin', passwordHash: pwd1, isActive: true }
      },
      { upsert: true }
    );
    
    await User.findOneAndUpdate(
      { email: 'Moxrathore' },
      { 
        $setOnInsert: { _id: 'user_mox_' + Date.now(), fullName: 'Mox Rathore', phone: '0000000000', organizationId: 'org_default' },
        $set: { role: 'admin', passwordHash: pwd2, isActive: true }
      },
      { upsert: true }
    );
    
    console.log('✅ Admins seeded successfully in MongoDB');
  } catch(e) {
    console.error('❌ Failed to seed schemas:', e);
  }
};

module.exports = {
  // Expose mongoose connect logic
  ensureSchema,
  connectDB: async () => {
    try {
      const uri = process.env.MONGO_URI;
      if (!uri) {
        console.error('❌ MONGO_URI is missing in .env');
        process.exit(1);
      }
      
      await mongoose.connect(uri, {
        maxPoolSize: 20,
        serverSelectionTimeoutMS: 15000,
      });
      console.log('✅ MongoDB Connected Successfully!');
      
      await ensureSchema();
    } catch (err) {
      console.error('❌ MongoDB Connection Error:', err.message);
    }
  }
};
