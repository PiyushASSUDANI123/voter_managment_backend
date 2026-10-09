const mongoose = require('mongoose');

// ==========================================
// MONGODB SCHEMAS WITH ADVANCED INDEXING
// ==========================================

const organizationSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  enabledModules: { type: [String], default: [] },
  allowedWards: { type: [String], default: [] },
  isActive: { type: Boolean, default: true },
  whatsappEnabled: { type: Boolean, default: true },
  whatsappCredits: { type: Number, default: 100 },
  whatsappUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  role: { type: String, required: true },
  subRole: { type: String, default: null },
  scopeType: { type: String, default: null },
  scopeValue: { type: String, default: null },
  modules: { type: [String], default: [] },
  organizationId: { type: String, required: true, index: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Partial Index removed to avoid duplicates since organizationId already has index: true

const voterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  epic: { type: String, required: true, index: true },
  wardNo: { type: String, required: true },
  partNo: { type: String, required: true },
  serialNo: { type: Number, required: true },
  nameEn: { type: String, required: true },
  nameHi: { type: String, required: true },
  age: { type: Number },
  gender: { type: String },
  relationType: { type: String },
  relativeNameEn: { type: String },
  relativeNameHi: { type: String },
  houseNo: { type: String },
  houseNoHi: { type: String },
  mobileNo: { type: String },
  caste: { type: String },
  supportStatus: { type: String, default: 'unmarked' },
  voted: { type: Boolean, default: false },
  votedAt: { type: Date, default: null },
  surety: { type: String },
  notes: { type: String },
  isMigrant: { type: Boolean, default: false },
  migrantLocation: { type: String },
  assignedWorker: { type: String, default: null },
  villageName: { type: String },
  villageNameHi: { type: String },
  organizationId: { type: String, required: true },
  familyId: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// 🚀 Performance Optimization: Compound Indexes
// Helps in filtering voters by organization and part/ward quickly
voterSchema.index({ organizationId: 1, partNo: 1, serialNo: 1 });
voterSchema.index({ organizationId: 1, wardNo: 1 });
voterSchema.index({ organizationId: 1, houseNo: 1 });
voterSchema.index({ organizationId: 1, familyId: 1 });
voterSchema.index({ organizationId: 1, epic: 1 });
voterSchema.index({ organizationId: 1, assignedWorker: 1 });
voterSchema.index({ organizationId: 1, supportStatus: 1 });
voterSchema.index({ organizationId: 1, isMigrant: 1 });

// 🚀 Performance Optimization: Text Search Index
// Enables fast text searching across multiple name fields (English & Hindi)
voterSchema.index(
  { nameEn: 'text', nameHi: 'text', relativeNameEn: 'text', relativeNameHi: 'text' },
  { weights: { nameHi: 10, nameEn: 5, relativeNameHi: 2, relativeNameEn: 1 } }
);

const slipDispatchSchema = new mongoose.Schema({
  _id: { type: String, default: () => `disp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}` },
  voterId: { type: String, required: true, index: true },
  voterEpic: { type: String, required: true },
  voterName: { type: String, required: true },
  recipientPhone: { type: String, required: true },
  slipType: { type: String, enum: ['individual', 'family'], default: 'individual' },
  dispatchType: { type: String, enum: ['whatsapp', 'manual_whatsapp', 'sms'], default: 'whatsapp' },
  status: { type: String, required: true },
  providerMessageId: { type: String, default: null, index: true },
  errorMessage: { type: String, default: null },
  organizationId: { type: String, required: true, index: true },
  sentBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});

slipDispatchSchema.index({ organizationId: 1, createdAt: -1 });

const leadSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  constituency: { type: String, default: '' },
  electionType: { type: String, default: 'विधानसभा (Assembly)' },
  status: { type: String, enum: ['new', 'contacted', 'converted', 'closed'], default: 'new' },
  notes: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true }
});

const Organization = mongoose.model('Organization', organizationSchema);
const User = mongoose.model('User', userSchema);
const Voter = mongoose.model('Voter', voterSchema);
const SlipDispatch = mongoose.model('SlipDispatch', slipDispatchSchema);
const Lead = mongoose.model('Lead', leadSchema);

module.exports = {
  Organization,
  User,
  Voter,
  SlipDispatch,
  Lead
};
