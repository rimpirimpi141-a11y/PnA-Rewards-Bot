// ============================================================================
// Comprehensive Regression Test Suite: Mandatory Device Verification Enforcement
// PnA Rewards — Telegram Bot & Mini App
// ============================================================================

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createOrUpdateUserFromTelegram, getUser } from '../src/database.js';
import { ensureUserAccess } from '../src/handlers/start.js';

function createD1Adapter(sqlite) {
  function wrapStatement(sql, boundParams = []) {
    return {
      sql,
      boundParams,
      bind(...params) {
        return wrapStatement(sql, params);
      },
      async first(colName) {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...boundParams);
        if (!row) return null;
        return colName ? row[colName] : row;
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        const results = stmt.all(...boundParams);
        return { success: true, results };
      },
      async run() {
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...boundParams);
        return {
          success: true,
          meta: {
            changes: Number(info.changes || 0),
            last_row_id: Number(info.lastInsertRowid || 0),
          },
        };
      },
    };
  }

  return {
    prepare(sql) {
      return wrapStatement(sql);
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const outputs = [];
        for (const s of statements) {
          outputs.push(await s.run());
        }
        sqlite.exec('COMMIT');
        return outputs;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

async function runTests() {
  console.log('🧪 Starting Verification Bypass Regression Test Suite...');

  // Set up in-memory SQLite database using migrations 0001, 0002, 0003, 0004
  const sqlite = new DatabaseSync(':memory:');
  const migration1 = fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8');
  const migration2 = fs.readFileSync(path.resolve('migrations/0002_device_verification.sql'), 'utf8');
  const migration3 = fs.readFileSync(path.resolve('migrations/0003_device_reputation_signals.sql'), 'utf8');
  const migration4 = fs.readFileSync(path.resolve('migrations/0004_v4_upgrades.sql'), 'utf8');

  sqlite.exec(migration1);
  sqlite.exec(migration2);
  sqlite.exec(migration3);
  sqlite.exec(migration4);

  const env = {
    DB: createD1Adapter(sqlite),
    BOT_TOKEN: '123456:TEST_TOKEN_ABC',
    OWNER_ID: '8838351233',
    DEVICE_VERIFICATION_ENABLED: 'true',
  };

  // Insert test settings with currentVerificationGeneration = 2
  sqlite.prepare(`
    INSERT INTO settings (key, value_json, updated_at)
    VALUES ('global', '{"currentVerificationGeneration": 2}', ?);
  `).run(Date.now());

  // Helper to record messages sent by bot
  let lastSentMessage = null;
  global.fetch = async (url, options) => {
    if (String(url).includes('sendMessage')) {
      const body = JSON.parse(options.body);
      lastSentMessage = body;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  // Test 1: User with old open menu and last_verified_generation = 0 (unverified) must be blocked
  console.log('Test 1: Unverified user with old open menu blocked...');
  const user1Tg = { id: 11111, first_name: 'Alice', username: 'alice_old' };
  await createOrUpdateUserFromTelegram(env, user1Tg);
  sqlite.prepare(`
    UPDATE users SET device_verification_status = 'grandfathered', last_verified_generation = 0, force_join_verified = 1 WHERE telegram_id = '11111';
  `).run();

  const access1 = await ensureUserAccess(env, user1Tg, 11111);
  assert.equal(access1.allowed, false, 'Unverified / outdated generation user must be blocked');
  console.log('✅ Test 1 passed.');

  // Test 2: Previously verified user with outdated generation < 2 must be blocked
  console.log('Test 2: Previously verified user with old generation (gen 1) blocked...');
  const user2Tg = { id: 22222, first_name: 'Bob', username: 'bob_gen1' };
  await createOrUpdateUserFromTelegram(env, user2Tg);
  sqlite.prepare(`
    UPDATE users SET device_verification_status = 'verified', last_verified_generation = 1, force_join_verified = 1 WHERE telegram_id = '22222';
  `).run();

  const access2 = await ensureUserAccess(env, user2Tg, 22222);
  assert.equal(access2.allowed, false, 'Verified user with gen 1 < required gen 2 must be blocked');
  console.log('✅ Test 2 passed.');

  // Test 3: Admin / Owner account with outdated generation must also be blocked
  console.log('Test 3: Admin / Owner account with outdated generation blocked...');
  const ownerTg = { id: 8838351233, first_name: 'Owner', username: 'owner_user' };
  await createOrUpdateUserFromTelegram(env, ownerTg);
  sqlite.prepare(`
    UPDATE users SET device_verification_status = 'verified', last_verified_generation = 1, force_join_verified = 1 WHERE telegram_id = '8838351233';
  `).run();

  const accessOwner = await ensureUserAccess(env, ownerTg, 8838351233);
  assert.equal(accessOwner.allowed, false, 'Owner with old generation must be blocked until fresh verification');
  console.log('✅ Test 3 passed.');

  // Test 4: User who successfully completes verification (generation bumped to 2) is allowed
  console.log('Test 4: User who completes verification is allowed access...');
  sqlite.prepare(`
    UPDATE users SET last_verified_generation = 2, device_verification_status = 'verified' WHERE telegram_id = '11111';
  `).run();

  const access1Verified = await ensureUserAccess(env, user1Tg, 11111);
  assert.equal(access1Verified.allowed, true, 'User with gen 2 and verified status must be allowed access');
  console.log('✅ Test 4 passed.');

  console.log('🎉 All Mandatory Device Verification Bypass regression tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Regression test failed:', err);
  process.exit(1);
});
