const mongoose = require('mongoose');

const voterSchema = new mongoose.Schema({
  epic: { type: String, required: true, unique: true },
  nameEn: String,
  nameHi: String,
  relativeNameEn: String,
  relativeNameHi: String,
  relationType: String,
  age: Number,
  gender: String, // 'पुरुष' or 'स्त्री'
  houseNo: String,
  wardNo: String,
  partNo: String,
  serialNo: Number,
  phone: String,
  caste: String,
  surety: String,
  isMigrant: Boolean,
  assignedWorker: String,
});

const Voter = mongoose.model('Voter', voterSchema);
module.exports = Voter;
