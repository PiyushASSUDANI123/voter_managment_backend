const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { Organization, User, Voter, SlipDispatch, Lead } = require('./models/index');
const bcrypt = require('bcryptjs');

const ensureSchema = async () => {
  try {
    // Ensure all model indexes are maintained in MongoDB
    Promise.all([
      Voter.init(),
      User.init(),
      Organization.init(),
      SlipDispatch.init(),
      Lead.init(),
    ]).catch((idxErr) => console.warn('Background index sync notice:', idxErr.message));

    const orgCount = await Organization.countDocuments({ isActive: true });
    if (orgCount === 0) {
      await Organization.create({
        _id: 'org_developer_test',
        name: 'Developer Test Organization',
        enabledModules: ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants', 'accounts'],
        isActive: true,
      });
    }

    const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const bootstrapName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
    const bootstrapPhone = process.env.BOOTSTRAP_ADMIN_PHONE?.trim();
    const bootstrapConfigured = [bootstrapEmail, bootstrapPassword, bootstrapName, bootstrapPhone].some(Boolean);

    if (bootstrapConfigured) {
      if (!bootstrapEmail || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(bootstrapEmail)
        || !bootstrapPassword || bootstrapPassword.length < 12 || !bootstrapName || !bootstrapPhone) {
        throw new Error('All bootstrap admin settings are required; use a valid email and a password of at least 12 characters.');
      }

      const existingAdmin = await User.findOne({ email: bootstrapEmail });
      if (!existingAdmin) {
        await User.create({
          _id: `user_${crypto.randomUUID()}`,
          email: bootstrapEmail,
          passwordHash: await bcrypt.hash(bootstrapPassword, 12),
          fullName: bootstrapName,
          phone: bootstrapPhone,
          role: 'admin',
          organizationId: 'org_developer_test',
          isActive: true,
        });
      }
    }
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    throw err;
  }
};

module.exports = {
  // Expose mongoose connect logic
  ensureSchema,
  connectDB: async () => {
    try {
      const uri = process.env.MONGO_URI;
      if (!uri) {
        throw new Error('MONGO_URI is missing in .env');
      }

      await mongoose.connect(uri, {
        maxPoolSize: 50,
        minPoolSize: 5,
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 45000,
      });
      console.log('✅ MongoDB Connected Successfully!');

      await ensureSchema();
    } catch (err) {
      console.error('❌ MongoDB Connection Error:', err.message);
      throw err;
    }
  }
};
