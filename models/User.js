
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['admin', 'user', 'manager', 'worker'],
    default: 'admin'
  },
  organizationId: {
    type: String,
    default: 'org_default' // Multi-tenant SaaS concept
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
