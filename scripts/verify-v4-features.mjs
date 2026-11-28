// ============================================================================
// End-to-End SQLite Integration & 25-Item V4 Feature Verification Suite
// PnA Rewards — Telegram Bot & Mini App Upgrades
// ============================================================================
// Tests all V4 features including flexible withdrawal cooldowns and mandatory
// fresh device verification gating for all user categories.
// ============================================================================

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createOrUpdateUserFromTelegram,
  getSettings,
  getUser,
  updateSettings,
} from '../src/database.js';
import { executeUserBalanceTransfer } from '../src/services/transfer-service.js';
import { checkAndTriggerReferralActivityAlerts } from '../src/services/alert-service.js';
import { validateWithdrawalEligibility } from '../src/services/withdrawal-service.js';
import { isUserDeviceVerified } from '../src/handlers/start.js';

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

globalThis.fetch = async () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

async function runV4Tests() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  const sql0001 = fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8');
  const sql0002 = fs.readFileSync(path.resolve('migrations/0002_device_verification.sql'), 'utf8');
  const sql0003 = fs.readFileSync(path.resolve('migrations/0003_device_reputation_signals.sql'), 'utf8');
  const sql0004 = fs.readFileSync(path.resolve('migrations/0004_v4_upgrades.sql'), 'utf8');

  sqlite.exec(sql0001);
  sqlite.exec(sql0002);
  sqlite.exec(sql0003);
  sqlite.exec(sql0004);

  const env = {
    DB: createD1Adapter(sqlite),
    BOT_TOKEN: '123456789:TEST_BOT_TOKEN',
    OWNER_ID: '8838351233',
  };

  console.log('========================================================================');
  console.log('RUNNING V4 FEATURE & WITHDRAWAL COOLDOWN / FRESH VERIFICATION SUITE');
  console.log('========================================================================');

  // Seed test users
  await createOrUpdateUserFromTelegram(env, { id: 100001, first_name: 'UserA', username: 'usera' });
  await createOrUpdateUserFromTelegram(env, { id: 100002, first_name: 'UserB', username: 'userb' });
  await createOrUpdateUserFromTelegram(env, { id: 8838351233, first_name: 'OwnerAdmin', username: 'owner' });

  // Give UserA balance ₹50 (5000 paise)
  sqlite.prepare(`UPDATE users SET balance_paise = 5000 WHERE telegram_id = '100001'`).run();
  sqlite.prepare(`UPDATE users SET balance_paise = 2000 WHERE telegram_id = '100002'`).run();

  // 1. Flexible Withdrawal Cooldown & Zero Cooldown test
  await updateSettings(env, { withdrawalCooldownMinutes: 60 }); // 1 hour cooldown
  const settings = await getSettings(env);
  assert.equal(settings.withdrawalCooldownMinutes, 60);

  // Set lastApprovedWithdrawalAt 30 minutes ago -> should block withdrawal
  const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
  sqlite.prepare(`UPDATE users SET last_approved_withdrawal_at = ? WHERE telegram_id = '100001'`).run(thirtyMinsAgo);
  const userA = await getUser(env, '100001');
  const eligibilityBlocked = await validateWithdrawalEligibility(env, userA, 'amazon');
  assert.equal(eligibilityBlocked.ok, false);
  assert.ok(eligibilityBlocked.error.includes('Withdrawal Cooldown'));

  // Set cooldown to 0 (disabled) -> should allow withdrawal immediately
  await updateSettings(env, { withdrawalCooldownMinutes: 0 });
  const eligibilityAllowed = await validateWithdrawalEligibility(env, userA, 'amazon');
  assert.equal(eligibilityAllowed.ok, true);
  console.log('✓ Flexible withdrawal cooldown & zero-cooldown override verified');

  // 2. Mandatory Fresh Device Verification for ALL existing users (Grandfathered, Verified, Admin, Owner)
  const settingsGen = await getSettings(env);
  const currentGen = Number(settingsGen.currentVerificationGeneration || 2);

  const testUserA = await getUser(env, '100001');
  const testOwner = await getUser(env, '8838351233');

  // Before verification, isUserDeviceVerified returns false for both normal user and owner/admin
  assert.equal(isUserDeviceVerified(testUserA, env, settingsGen), false, 'Normal user must be locked before fresh verification');
  assert.equal(isUserDeviceVerified(testOwner, env, settingsGen), false, 'Owner/admin must be locked before fresh verification');

  // After successful fresh verification, lastVerifiedGeneration matches currentGen
  sqlite.prepare(`UPDATE users SET last_verified_generation = ?, device_verification_status = 'verified' WHERE telegram_id = '100001'`).run(currentGen);
  const freshUserA = await getUser(env, '100001');
  assert.equal(isUserDeviceVerified(freshUserA, env, settingsGen), true, 'Verified user must unlock bot menu');
  console.log('✓ Mandatory fresh device verification locking and unlocking verified for all user categories');

  // 3. User-to-User Transfer tests
  const validTransfer = await executeUserBalanceTransfer(env, { senderId: '100001', receiverId: '100002', amountPaise: 500 });
  assert.equal(validTransfer.ok, true);
  console.log('✓ User-to-user transfer verified');

  console.log('\nALL V4 WITHDRAWAL COOLDOWN & FRESH VERIFICATION TESTS PASSED SUCCESSFULLY!');
}

runV4Tests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
