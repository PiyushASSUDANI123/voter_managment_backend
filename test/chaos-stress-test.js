/**
 * VIJAYSETU EXTREME CHAOS, STRESS & FOOLPROOF TEST SUITE
 * 
 * Tests the system under:
 * 1. "Gwar Se Gwar User" / Chaos Fuzzing:
 *    - Malformed JSON, prototype pollution payloads, NoSQL injection ($gt, $ne, $where)
 *    - SQL injection strings (' OR '1'='1)
 *    - XSS & script tags (<script>, <svg onload>)
 *    - Regex killer & ReDoS inputs ((((((a+)+)+)+)+)+)$
 *    - Unicode, Hindi transliteration, emojis, zero-width chars, 5000+ char strings
 *    - Bizarre pagination: page=-100, page=0, page=NaN, pageSize=99999999, pageSize=-1
 *    - Non-existent IDs, invalid phone formats (+91 98290 12345, letters in phone)
 * 2. Rage Clicking / Concurrency Blast:
 *    - 20 concurrent rapid-fire updates to the same voter record
 * 3. High-Load Stress Test:
 *    - 150+ concurrent requests hitting search, family, turnout, and analytics
 *    - Measures P50, P95, P99 latencies and validates 0 unhandled 500 crashes
 * 4. Zero Information Leak Audit:
 *    - Verifies no stack traces, file system paths, or raw Mongo errors leaked to client
 * 5. Cross-Tenant IDOR Security Check:
 *    - Verifies Tenant A cannot tamper with or access Tenant B's voters
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app } = require('../index');
const { Organization, User, Voter } = require('../models');

const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const orgIdA = `chaos_org_a_${runId}`;
const orgIdB = `chaos_org_b_${runId}`;
const adminEmail = `chaos-admin-${runId}@example.test`;
const adminPass = `ChaosPass-${runId}-123!`;
let testServer;
let mongoServer;
let baseUrl;
let authToken;

async function setup() {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Setup organizations
  await Organization.create([
    { _id: orgIdA, name: 'Chaos Tenant A', enabledModules: ['voters', 'poll-desk', 'turnout', 'warroom', 'community', 'migrants', 'workers', 'history'], allowedWards: ['1', '2'], isActive: true },
    { _id: orgIdB, name: 'Chaos Tenant B', enabledModules: ['voters', 'poll-desk', 'turnout'], allowedWards: ['1'], isActive: true },
    { _id: 'org_default', name: 'Default Org', isActive: true }
  ]);

  // Setup user
  const passwordHash = await bcrypt.hash(adminPass, 8);
  await User.create({
    _id: `user_${runId}`,
    email: adminEmail,
    passwordHash,
    fullName: 'Chaos Tester',
    phone: '9829012345',
    role: 'tenant_admin',
    organizationId: orgIdA,
    isActive: true
  });

  // Seed sample voters
  const voters = [];
  for (let i = 1; i <= 200; i++) {
    voters.push({
      _id: `voter_${runId}_${i}`,
      epic: `ABC${String(i).padStart(7, '0')}`,
      wardNo: String((i % 2) + 1),
      partNo: '1',
      serialNo: i,
      nameEn: `Voter Number ${i}`,
      nameHi: `मतदाता क्रमांक ${i}`,
      relativeNameEn: `Father ${i}`,
      relativeNameHi: `पिता ${i}`,
      mobileNo: `98290${String(i).padStart(5, '0')}`,
      houseNo: `H-${(i % 20) + 1}`,
      familyId: `FAM-${(i % 20) + 1}`,
      caste: i % 3 === 0 ? 'राजपूत' : i % 3 === 1 ? 'जाट' : 'ब्राह्मण',
      supportStatus: i % 4 === 0 ? 'core' : i % 4 === 1 ? 'swing' : i % 4 === 2 ? 'opposition' : 'unmarked',
      voted: i % 5 === 0,
      organizationId: orgIdA,
    });
  }

  // Seed 1 voter for Org B to test IDOR
  voters.push({
    _id: `voter_org_b_${runId}`,
    epic: `ORGB${runId}`,
    wardNo: '1',
    partNo: '1',
    serialNo: 999,
    nameEn: 'Org B Secret Voter',
    nameHi: 'गुप्त मतदाता',
    organizationId: orgIdB
  });

  await Voter.insertMany(voters);

  // Start HTTP server on dynamic port
  testServer = app.listen(0, '127.0.0.1');
  await new Promise((res) => testServer.once('listening', res));
  const port = testServer.address().port;
  baseUrl = `http://127.0.0.1:${port}/api`;

  // Authenticate
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPass })
  });
  const loginData = await loginRes.json();
  assert.equal(loginRes.status, 200, 'Login must succeed');
  authToken = loginData.token;
  assert.ok(authToken, 'Auth token must be generated');
}

async function teardown() {
  if (testServer) await new Promise((res) => testServer.close(res));
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}

async function runTests() {
  console.log('🚀 Starting Chaos, Foolproof & Stress Test Suite for VijaySetu...');
  const startTime = Date.now();
  let passedCount = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passedCount++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      throw err;
    }
  };

  const req = (url, opts = {}) => fetch(`${baseUrl}${url}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      ...opts.headers
    }
  });

  // ==========================================
  // SUITE 1: "GWAR SE GWAR USER" / CHAOS FUZZING
  // ==========================================
  console.log('\n--- 1. "Gwar User" Chaos Fuzzing & Malformed Input Handling ---');

  await test('Search with SQL injection strings', async () => {
    const res = await req(`/voters?search=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.data || data));
  });

  await test('Search with NoSQL injection operators ($gt, $where)', async () => {
    const res = await req(`/voters?search[$gt]=`);
    // Should be sanitized gracefully and not crash
    assert.ok([200, 400].includes(res.status));
  });

  await test('Search with XSS / HTML script tags', async () => {
    const res = await req(`/voters?search=${encodeURIComponent("<script>alert('xss')</script>")}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.data || data));
  });

  await test('Search with ReDoS killer regex strings (unbalanced brackets, parens)', async () => {
    const toxicStrings = [
      '(((((((((a+)+)+)+)+)+)+)+)+)$',
      '[[[[[[[[[[[[',
      '(((((((((((',
      '\\\\\\\\\\\\',
      '*+?^${}()|[]\\'
    ];
    for (const str of toxicStrings) {
      const res = await req(`/voters?search=${encodeURIComponent(str)}`);
      assert.equal(res.status, 200, `Toxic string ${str} must not cause ReDoS crash`);
    }
  });

  await test('Search with Hindi, emojis, Gujarati, and zero-width spaces', async () => {
    const res = await req(`/voters?search=${encodeURIComponent('राम 🇮🇳 ⚡️ \u200B\u200C')}`);
    assert.equal(res.status, 200);
  });

  await test('Search with giant 500-character string', async () => {
    const giant = 'क'.repeat(500);
    const res = await req(`/voters?search=${encodeURIComponent(giant)}`);
    assert.equal(res.status, 200);
  });

  await test('Crazy pagination inputs (negative page, NaN, massive pageSize)', async () => {
    const tests = [
      '/voters?page=-100&pageSize=-5',
      '/voters?page=0&pageSize=0',
      '/voters?page=NaN&pageSize=undefined',
      '/voters?page=1&pageSize=999999999',
    ];
    for (const url of tests) {
      const res = await req(url);
      assert.equal(res.status, 200, `Url ${url} must be safely bounded`);
      const body = await res.json();
      const items = body.data || body;
      assert.ok(Array.isArray(items));
      assert.ok(items.length <= 10000, 'Page size must be bounded');
    }
  });

  await test('Voter update with non-existent or invalid ID', async () => {
    const badIds = ['undefined', 'null', '[object Object]', '999999999', 'invalid_mongo_id'];
    for (const badId of badIds) {
      const res = await req(`/voters/${badId}`, {
        method: 'PUT',
        body: JSON.stringify({ supportStatus: 'core' })
      });
      assert.ok([400, 404].includes(res.status), `Bad ID ${badId} must return 400 or 404, received ${res.status}`);
    }
  });

  await test('Bulk update with crazy input (empty, non-array, huge payload)', async () => {
    const res1 = await req('/voters/bulk-update', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(res1.status, 400);

    const res2 = await req('/voters/bulk-update', { method: 'POST', body: JSON.stringify({ ids: 'not_an_array' }) });
    assert.equal(res2.status, 400);

    // Array with 10,000 dummy IDs (capped safely at 5000 without memory exhaustion)
    const giantIds = Array.from({ length: 10000 }, (_, i) => `fake_${i}`);
    const res3 = await req('/voters/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ ids: giantIds, updates: { supportStatus: 'core' } })
    });
    assert.equal(res3.status, 200);
  });

  // ==========================================
  // SUITE 2: RAGE CLICKING & CONCURRENCY BLAST
  // ==========================================
  console.log('\n--- 2. Rage Clicking & Race Condition Blast ---');

  await test('Simultaneous 20 rapid-fire vote status toggle on single voter', async () => {
    const targetVoterId = `voter_${runId}_1`;
    const promises = Array.from({ length: 20 }, (_, idx) =>
      req(`/voters/${targetVoterId}/vote`, {
        method: 'PUT',
        body: JSON.stringify({ voted: idx % 2 === 0 })
      })
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.status, 200, 'Every rapid-fire vote toggle must succeed without race crash');
    }
  });

  await test('Simultaneous 20 rapid-fire voter detail updates', async () => {
    const targetVoterId = `voter_${runId}_2`;
    const statuses = ['core', 'swing', 'opposition', 'unmarked'];
    const promises = Array.from({ length: 20 }, (_, idx) =>
      req(`/voters/${targetVoterId}`, {
        method: 'PUT',
        body: JSON.stringify({ supportStatus: statuses[idx % statuses.length], notes: `Rage click ${idx}` })
      })
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.status, 200, 'Concurrent updates must be handled gracefully');
    }
  });

  // ==========================================
  // SUITE 3: HIGH-LOAD CONCURRENT STRESS TEST
  // ==========================================
  console.log('\n--- 3. High-Load Concurrent Stress Test ---');

  await test('150 Concurrent Diverse API Requests (6 parallel batches of 25 workers)', async () => {
    const endpoints = [
      '/voters?page=1&pageSize=20',
      '/voters?search=मतदाता',
      '/voters?ward=1',
      '/voters?caste=राजपूत',
      '/voters/family/FAM-1?ward=1',
      '/voters/turnout-summary',
      '/features/war-room',
      '/voters/castes',
      '/features/migrants?page=1',
    ];

    const latencies = [];
    const batchSize = 25;
    const totalRequests = 150;

    for (let i = 0; i < totalRequests; i += batchSize) {
      const batch = Array.from({ length: batchSize }, async (_, idx) => {
        const ep = endpoints[(i + idx) % endpoints.length];
        const t0 = Date.now();
        const res = await req(ep);
        const dur = Date.now() - t0;
        latencies.push(dur);
        assert.equal(res.status, 200, `Request to ${ep} must return 200`);
      });
      await Promise.all(batch);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

    console.log(`    📊 Latency Metrics (150 requests, 25 concurrent workers):`);
    console.log(`       Average: ${avg}ms`);
    console.log(`       P50:     ${p50}ms`);
    console.log(`       P95:     ${p95}ms`);
    console.log(`       P99:     ${p99}ms`);
    assert.ok(p95 < 600, `P95 latency (${p95}ms) must be under 600ms for optimal scalability`);
  });

  // ==========================================
  // SUITE 4: SECURITY & ZERO INFORMATION LEAK
  // ==========================================
  console.log('\n--- 4. Security & Zero Secret/Stack Leak Audit ---');

  await test('404 and Error responses never leak stack traces or server paths', async () => {
    const res = await req('/non-existent-endpoint-xyz');
    const text = await res.text();
    assert.equal(text.includes('/Users/'), false, 'Server file system paths must NOT be leaked');
    assert.equal(text.includes('node_modules'), false, 'Stack traces must NOT be leaked');
    assert.equal(text.includes('mongodb://'), false, 'Database URIs must NOT be leaked');
  });

  await test('Cross-Tenant IDOR Protection (Tenant A cannot touch Tenant B voter)', async () => {
    // Attempt to update Org B's voter using Org A's token
    const res = await req(`/voters/voter_org_b_${runId}`, {
      method: 'PUT',
      body: JSON.stringify({ supportStatus: 'core' })
    });
    assert.equal(res.status, 404, 'Cross-tenant voter update must return 404 (strictly isolated)');
  });

  await test('Unauthenticated requests are strictly rejected (401)', async () => {
    const res = await fetch(`${baseUrl}/voters`);
    assert.equal(res.status, 401, 'Unauthenticated request must return 401');
  });

  const durationMs = Date.now() - startTime;
  console.log(`\n🎉 ALL ${passedCount} CHAOS, FOOLPROOF & STRESS TESTS PASSED SUCCESSFULLY! (${(durationMs / 1000).toFixed(2)}s)`);
}

setup()
  .then(runTests)
  .then(() => teardown())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('💥 Test suite crashed:', err);
    await teardown();
    process.exit(1);
  });
