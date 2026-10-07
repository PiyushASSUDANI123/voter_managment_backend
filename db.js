require('dotenv').config();

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL?.trim();
const pool = connectionString ? new Pool({ connectionString }) : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });
}

module.exports = {
  isConfigured: () => Boolean(pool),
  query: (text, params) => {
    if (!pool) {
      return Promise.reject(new Error('DATABASE_URL is not configured.'));
    }
    return pool.query(text, params);
  },
  transaction: async (callback) => {
    if (!pool) throw new Error('DATABASE_URL is not configured.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
  ensureSchema: async () => {
    if (!pool) return;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'worker',
        organization_id VARCHAR(255) NOT NULL DEFAULT 'org_default',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voters (
        id SERIAL PRIMARY KEY,
        epic VARCHAR(50) NOT NULL,
        name_en VARCHAR(255),
        name_hi VARCHAR(255),
        relative_name_en VARCHAR(255),
        relative_name_hi VARCHAR(255),
        relation_type VARCHAR(50),
        age INTEGER,
        gender VARCHAR(50),
        house_no VARCHAR(50),
        ward_no VARCHAR(50),
        part_no VARCHAR(50),
        serial_no INTEGER,
        phone VARCHAR(50),
        caste VARCHAR(100),
        surety VARCHAR(100),
        is_migrant BOOLEAN NOT NULL DEFAULT false,
        assigned_worker VARCHAR(255),
        village_name VARCHAR(255),
        voted BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        enabled_modules JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowed_wards JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      INSERT INTO organizations (id, name, enabled_modules)
      VALUES ('org_default', 'Default organization', '["voters","poll-desk","turnout","warroom","history","community","workers","migrants","accounts"]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS full_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS phone VARCHAR(50),
        ADD COLUMN IF NOT EXISTS sub_role VARCHAR(50) NOT NULL DEFAULT 'Operator',
        ADD COLUMN IF NOT EXISTS scope_type VARCHAR(20) NOT NULL DEFAULT 'All',
        ADD COLUMN IF NOT EXISTS scope_value VARCHAR(255),
        ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true
    `);
    await pool.query(`
      ALTER TABLE voters
        ADD COLUMN IF NOT EXISTS support_status VARCHAR(32) NOT NULL DEFAULT 'unmarked',
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS family_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS migrant_location VARCHAR(255),
        ADD COLUMN IF NOT EXISTS village_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS organization_id VARCHAR(255) NOT NULL DEFAULT 'org_default'
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slip_dispatches (
        id BIGSERIAL PRIMARY KEY,
        voter_id INTEGER REFERENCES voters(id) ON DELETE SET NULL,
        voter_epic VARCHAR(50),
        voter_name VARCHAR(255),
        recipient_phone VARCHAR(50) NOT NULL,
        slip_type VARCHAR(30) NOT NULL DEFAULT 'individual',
        status VARCHAR(20) NOT NULL DEFAULT 'sending',
        provider_message_id VARCHAR(255),
        error_message TEXT,
        organization_id VARCHAR(255) NOT NULL DEFAULT 'org_default',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      ALTER TABLE slip_dispatches
        ADD COLUMN IF NOT EXISTS organization_id VARCHAR(255) NOT NULL DEFAULT 'org_default'
    `);
    await pool.query(`
      INSERT INTO organizations (id, name, enabled_modules)
      SELECT DISTINCT organization_id, organization_id,
        '["voters","poll-desk","turnout","warroom","history","community","workers","migrants","accounts"]'::jsonb
      FROM (
        SELECT organization_id FROM users
        UNION
        SELECT organization_id FROM voters
      ) existing
      WHERE organization_id IS NOT NULL AND organization_id <> ''
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      UPDATE organizations SET enabled_modules =
        '["voters","poll-desk","turnout","warroom","history","community","workers","migrants","accounts"]'::jsonb
      WHERE id <> 'org_default' AND enabled_modules = '[]'::jsonb
        AND EXISTS (SELECT 1 FROM users WHERE users.organization_id = organizations.id AND users.role IN ('tenant_admin', 'worker'))
    `);
    await pool.query('ALTER TABLE voters DROP CONSTRAINT IF EXISTS voters_epic_key');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS voters_organization_epic_uidx ON voters (organization_id, epic)');
    await pool.query("UPDATE users SET sub_role = 'Admin' WHERE role = 'admin' AND sub_role = 'Operator'");
    await pool.query(`
      UPDATE users SET modules = '["voters", "poll-desk", "turnout"]'::jsonb
      WHERE role = 'user' AND modules = '[]'::jsonb
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS voters_ward_serial_idx ON voters (ward_no, part_no, serial_no)');
    await pool.query('CREATE INDEX IF NOT EXISTS voters_support_status_idx ON voters (support_status)');
    await pool.query('CREATE INDEX IF NOT EXISTS slip_dispatches_created_at_idx ON slip_dispatches (created_at DESC)');
  },
};
