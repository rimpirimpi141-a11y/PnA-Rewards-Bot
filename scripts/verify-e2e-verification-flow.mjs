// ============================================================================
// End-to-End Regression Test: Complete Device Verification Flow & Unlock
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

async function runE2ETest() {
  console.log('🧪 Starting E2E Device Verification Flow & Unlock Test...');

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8'));
  sqlite.exec(fs.readFileSync(path.resolve('migrations/0002_device_verification.sql'), 'utf8'));
  sqlite.exec(fs.readFileSync(path.resolve('migrations/0003_device_reputation_signals.sql'), 'utf8'));
  sqlite.exec(fs.readFileSync(path.resolve('migrations/0004_v4_upgrades.sql'), 'utf8'));

  const env = {
    DB: createD1Adapter(sqlite),
    BOT_TOKEN: '123456:TEST_TOKEN_ABC',
    OWNER_ID: '8838351233',
    DEVICE_VERIFICATION_ENABLED: 'true',
  };

  // Set currentVerificationGeneration = 2 in global settings
  sqlite.prepare(`
    INSERT INTO settings (key, value_json, updated_at)
    VALUES ('global', '{"currentVerificationGeneration": 2}', ?);
  `).run(Date.now());

  global.fetch = async (url, options) => {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }));
  };

  const tgUser = { id: 99999, first_name: 'E2ETestUser', username: 'e2e_test' };

  // Step 1: Unverified user registers
  console.log('Step 1: New unverified user opens bot...');
  const accessBefore = await ensureUserAccess(env, tgUser, 99999);
  assert.equal(accessBefore.allowed, false, 'Unverified user must be blocked');
  
  let dbUser = await getUser(env, 99999);
  assert.equal(dbUser.lastVerifiedGeneration, 0, 'Initial generation must be 0');
  assert.equal(dbUser.deviceVerificationStatus, 'unverified', 'Initial status must be unverified');
  console.log('✅ Step 1 passed: User blocked and prompted for device verification.');

  // Step 2: Simulate successful Mini App device verification completion
  console.log('Step 2: Simulating successful Mini App device verification...');
  sqlite.prepare(`
    UPDATE users
    SET device_verification_status = 'verified',
        last_verified_generation = 2,
        device_verified_at = ?
    WHERE telegram_id = '99999'
  `).run(Date.now());

  dbUser = await getUser(env, 99999);
  assert.equal(dbUser.lastVerifiedGeneration, 2, 'Database generation updated to 2');
  assert.equal(dbUser.deviceVerificationStatus, 'verified', 'Status updated to verified');
  console.log('✅ Step 2 passed: Database successfully updated.');

  // Step 3: User returns to bot / checks verification status
  console.log('Step 3: User returns to bot and triggers verification check...');
  const accessAfter = await ensureUserAccess(env, tgUser, 99999);
  assert.equal(accessAfter.allowed, true, 'User must now be allowed access and menu unlocked');
  console.log('✅ Step 3 passed: Normal menu successfully unlocked!');

  console.log('🎉 E2E Device Verification Flow & Unlock Test PASSED successfully!');
}

runE2ETest().catch((err) => {
  console.error('❌ E2E test failed:', err);
  process.exit(1);
});
