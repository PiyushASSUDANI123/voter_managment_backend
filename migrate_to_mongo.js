require('dotenv').config();
const { Pool } = require('pg');
const mongoose = require('mongoose');

const mongoUri = 'mongodb+srv://antigravtiy4_db_user:yKwKra4yBte10gZT@cluster0.tzyuban.mongodb.net/voter_management?retryWrites=true&w=majority&appName=Cluster0';

// MongoDB Schemas
const organizationSchema = new mongoose.Schema({
  _id: String, // Maps to PostgreSQL id
  name: String,
  enabledModules: [String],
  allowedWards: [String],
  isActive: Boolean,
  createdAt: Date
});

const userSchema = new mongoose.Schema({
  _id: String,
  email: String,
  passwordHash: String,
  fullName: String,
  phone: String,
  role: String,
  subRole: String,
  scopeType: String,
  scopeValue: String,
  modules: [String],
  organizationId: String,
  isActive: Boolean,
  createdAt: Date
});

const voterSchema = new mongoose.Schema({
  _id: String,
  epic: String,
  wardNo: String,
  partNo: String,
  serialNo: Number,
  nameEn: String,
  nameHi: String,
  age: Number,
  gender: String,
  relationType: String,
  relativeNameEn: String,
  relativeNameHi: String,
  houseNo: String,
  houseNoHi: String,
  mobileNo: String,
  caste: String,
  supportStatus: String,
  voted: Boolean,
  votedAt: Date,
  assignedWorker: String,
  villageName: String,
  villageNameHi: String,
  organizationId: String,
  familyId: String,
  createdAt: Date
});

const slipDispatchSchema = new mongoose.Schema({
  _id: String,
  voterId: String,
  voterEpic: String,
  voterName: String,
  recipientPhone: String,
  status: String,
  organizationId: String,
  createdAt: Date
});

const Organization = mongoose.model('Organization', organizationSchema);
const User = mongoose.model('User', userSchema);
const Voter = mongoose.model('Voter', voterSchema);
const SlipDispatch = mongoose.model('SlipDispatch', slipDispatchSchema);

async function migrate() {
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB.');

    console.log('Fetching PostgreSQL data...');
    const { rows: organizations } = await pgPool.query('SELECT * FROM organizations');
    const { rows: users } = await pgPool.query('SELECT * FROM users');
    const { rows: voters } = await pgPool.query('SELECT * FROM voters');
    const { rows: dispatches } = await pgPool.query('SELECT * FROM slip_dispatches');

    console.log(`Found ${organizations.length} organizations, ${users.length} users, ${voters.length} voters, ${dispatches.length} dispatches.`);

    // Clear existing Mongo data
    await Organization.deleteMany({});
    await User.deleteMany({});
    await Voter.deleteMany({});
    await SlipDispatch.deleteMany({});

    // Migrate Organizations
    if (organizations.length > 0) {
      await Organization.insertMany(organizations.map(o => ({
        _id: o.id,
        name: o.name,
        enabledModules: o.enabled_modules || [],
        allowedWards: o.allowed_wards || [],
        isActive: o.is_active,
        createdAt: o.created_at
      })));
      console.log('Organizations migrated.');
    }

    // Migrate Users
    if (users.length > 0) {
      await User.insertMany(users.map(u => ({
        _id: u.id,
        email: u.email,
        passwordHash: u.password_hash,
        fullName: u.full_name,
        phone: u.phone,
        role: u.role,
        subRole: u.sub_role,
        scopeType: u.scope_type,
        scopeValue: u.scope_value,
        modules: u.modules || [],
        organizationId: u.organization_id,
        isActive: u.is_active,
        createdAt: u.created_at
      })));
      console.log('Users migrated.');
    }

    // Migrate Voters
    if (voters.length > 0) {
      await Voter.insertMany(voters.map(v => ({
        _id: v.id,
        epic: v.epic,
        wardNo: v.ward_no,
        partNo: v.part_no,
        serialNo: v.serial_no,
        nameEn: v.name_en,
        nameHi: v.name_hi,
        age: v.age,
        gender: v.gender,
        relationType: v.relation_type,
        relativeNameEn: v.relative_name_en,
        relativeNameHi: v.relative_name_hi,
        houseNo: v.house_no,
        houseNoHi: v.house_no_hi,
        mobileNo: v.mobile_no,
        caste: v.caste,
        supportStatus: v.support_status,
        voted: v.voted,
        votedAt: v.voted_at,
        assignedWorker: v.assigned_worker,
        villageName: v.village_name,
        villageNameHi: v.village_name_hi,
        organizationId: v.organization_id,
        familyId: v.family_id,
        createdAt: v.created_at
      })));
      console.log('Voters migrated.');
    }

    // Migrate Slip Dispatches
    if (dispatches.length > 0) {
      await SlipDispatch.insertMany(dispatches.map(d => ({
        _id: d.id,
        voterId: d.voter_id,
        voterEpic: d.voter_epic,
        voterName: d.voter_name,
        recipientPhone: d.recipient_phone,
        status: d.status,
        organizationId: d.organization_id,
        createdAt: d.created_at
      })));
      console.log('Slip Dispatches migrated.');
    }

    console.log('Migration completed successfully!');

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await pgPool.end();
    await mongoose.disconnect();
  }
}

migrate();
