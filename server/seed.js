// seed.js — Creates the admin user + runs schema
// Run once: node seed.js
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
require('dotenv').config();

async function seed() {
  try {
    console.log('📦 Running schema...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('✅ Schema applied');

    console.log('👤 Creating admin user...');
    const hash = await bcrypt.hash('admin123', 12);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Admin', 'admin@spf.com', $1, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1`,
      [hash]
    );
    console.log('✅ Admin user created: admin@spf.com / admin123');
    console.log('');
    console.log('🚀 Database ready! You can now start the server: npm start');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
