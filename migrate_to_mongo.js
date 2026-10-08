require('dotenv').config();
const { Pool } = require('pg');
const mongoose = require('mongoose');

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) throw new Error('MONGO_URI is required for migration.');
