// ============================================================================
// End-to-End SQLite Integration Test for Telegram Mini App Device Verification
// ============================================================================
// Applies BOTH `migrations/0001_initial_schema.sql` and
// `migrations/0002_device_verification.sql` on a real SQLite engine (`node:sqlite`),
// wraps it in a faithful Cloudflare D1 adapter, and tests every security &
// referral protection guarantee directly against `src/services/device-verification.js`,
// `src/services/referral-service.js`, and `src/database.js`.
// ============================================================================

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createOrUpdateUserFromTelegram,
  getDeviceVerificationStats,
  getPendingReferralReviewsPage,
  getSuspiciousDeviceClustersPage,
  getUser,
  getUserReferrals,
  resolveReferralReviewAtomic,
  updateUserForceJoinVerified,
} from '../src/database.js';
import {
  handleDeviceVerifySession,
  handleDeviceVerifySubmit,
  verifyTelegramInitData,
  verifyVerificationToken,
} from '../src/services/device-verification.js';
import {
  processPendingReferral,
  registerPendingReferralIfEligible,
} from '../src/services/referral-service.js';

// Faithful Cloudflare D1 adapter over real SQLite (`node:sqlite`)
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

function buildSignedTelegramInitData(botToken, userObj, authDateSec = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDateSec));
  params.set('query_id', `Q-${crypto.randomBytes(6).toString('hex')}`);
  params.set('user', JSON.stringify(userObj));

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function buildSignedBridgeRequest(pathname, bodyObj, bridgeSecret, origin = 'https://ais-pre-5anw25hqtptdicmzho3ex7-704214232389.asia-east1.run.app') {
  const rawBody = JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `POST\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = crypto.createHmac('sha256', bridgeSecret).update(canonical).digest('hex');

  return new Request(`https://worker.example.com${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PnA-Timestamp': timestamp,
      'X-PnA-Nonce': nonce,
      'X-PnA-Signature': signature,
      'X-PnA-Origin': origin,
    },
    body: rawBody,
  });
}

function sampleDeviceSignals(seed) {
  return {
    canvasHash: crypto.createHash('sha256').update(`canvas-${seed}`).digest('hex'),
    webglVendor: `Vendor-${seed}`,
    webglRenderer: `Renderer-${seed}`,
    webglParamsHash: crypto.createHash('sha256').update(`webgl-${seed}`).digest('hex'),
    audioHash: crypto.createHash('sha256').update(`audio-${seed}`).digest('hex'),
    fontMetricsHash: crypto.createHash('sha256').update(`fonts-${seed}`).digest('hex'),
    screenWidth: 390 + (seed.length % 10),
    screenHeight: 844,
    colorDepth: 24,
    devicePixelRatio: 3,
    timezone: 'Asia/Kolkata',
    timezoneOffset: -330,
    language: 'en-IN',
    languagesCount: 2,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 5,
    platform: 'Linux armv8l',
    telegramPlatform: 'android',
    userAgentFamily: 'Android/TelegramWebView/Chromium',
    webdriver: false,
    automationSignals: [],
  };
}

// Stub global fetch so Telegram sendMessage calls do not hit external network
globalThis.fetch = async () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

async function runTests() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  const sql0001 = fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8');
  const sql0002 = fs.readFileSync(path.resolve('migrations/0002_device_verification.sql'), 'utf8');

  // Step 1: Apply 0001 and seed a pre-existing user with ₹25.00 balance
  sqlite.exec(sql0001);
  sqlite
    .prepare(
      `INSERT INTO users (telegram_id, first_name, username, joined_at, last_active_at, balance_paise, total_earned_paise, force_join_verified)
       VALUES ('100001', 'LegacyUser', 'legacy', 1700000000000, 1700000000000, 2500, 2500, 1)`
    )
    .run();

  // Step 2: Apply 0002 additive migration and verify safe grandfathering & untouched balance
  sqlite.exec(sql0002);

  const env = {
    DB: createD1Adapter(sqlite),
    BOT_TOKEN: '123456789:TEST_BOT_TOKEN_FOR_LOCAL_VERIFICATION_SUITE',
    OWNER_ID: '8838351233',
    MINIAPP_BRIDGE_SECRET: 'test-bridge-secret-0123456789abcdef0123456789abcdef',
    MINIAPP_URL: 'https://ais-pre-5anw25hqtptdicmzho3ex7-704214232389.asia-east1.run.app',
    MINIAPP_ALLOWED_ORIGINS: 'https://ais-pre-5anw25hqtptdicmzho3ex7-704214232389.asia-east1.run.app',
    DEVICE_VERIFICATION_ENABLED: 'true',
  };

  const legacy = await getUser(env, '100001');
  assert.equal(legacy.balancePaise, 2500, 'Pre-existing balance must never change');
  assert.equal(legacy.deviceVerificationStatus, 'grandfathered', 'Pre-existing user must be grandfathered');
  assert.equal(legacy.deviceVerificationRequired, false);
  console.log('✓ 1. Additive migration 0002 preserves existing users & balances (grandfathered)');

  // Step 3: Verify Telegram initData HMAC validation rejects tampered & expired payloads
  const validInit = buildSignedTelegramInitData(env.BOT_TOKEN, { id: 200001, first_name: 'Alice' });
  const okCheck = await verifyTelegramInitData(validInit, env.BOT_TOKEN);
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.user.id, '200001');

  const tamperedInit = validInit.replace('Alice', 'Malice');
  const badCheck = await verifyTelegramInitData(tamperedInit, env.BOT_TOKEN);
  assert.equal(badCheck.ok, false, 'Tampered initData must fail HMAC verification');

  const expiredInit = buildSignedTelegramInitData(
    env.BOT_TOKEN,
    { id: 200001, first_name: 'Alice' },
    Math.floor(Date.now() / 1000) - 600
  );
  const expCheck = await verifyTelegramInitData(expiredInit, env.BOT_TOKEN);
  assert.equal(expCheck.ok, false);
  assert.equal(expCheck.expired, true, 'Stale initData must be rejected');
  console.log('✓ 2. Telegram WebApp initData HMAC-SHA256 & freshness checks verified');

  // Step 4: Verify bridge authentication rejects unsigned/tampered calls
  const badBridgeReq = new Request('https://worker.example.com/api/internal/device-verify/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: validInit }),
  });
  const badBridgeRes = await handleDeviceVerifySession(badBridgeReq, env);
  assert.equal(badBridgeRes.status, 401, 'Unsigned bridge call must return 401');
  console.log('✓ 3. Cloud Run -> Worker HMAC bridge authentication enforced');

  // Step 5: New user registers with referral from LegacyUser (100001) — MUST NOT credit before verification
  const { user: alice } = await createOrUpdateUserFromTelegram(env, {
    id: 200001,
    first_name: 'Alice',
    username: 'alice_tg',
  });
  assert.equal(alice.deviceVerificationStatus, 'unverified');
  await registerPendingReferralIfEligible(env, alice, '100001');
  await updateUserForceJoinVerified(env, alice.id, true);

  const preVerifyCredit = await processPendingReferral(env, alice.id);
  assert.equal(preVerifyCredit.credited, false, 'Unverified user MUST NOT credit referral');
  assert.equal(preVerifyCredit.reason, 'device_unverified');
  assert.equal((await getUser(env, '100001')).balancePaise, 2500);
  assert.equal((await getUserReferrals(env, '100001')).length, 0);
  console.log('✓ 4. Unverified referral strictly blocked from crediting & hidden from completed referrals');

  // Step 6: Alice completes Mini App verification cleanly -> verified, signed token issued, referral credited once
  const aliceSessionReq = buildSignedBridgeRequest(
    '/api/internal/device-verify/session',
    { initData: validInit, clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' } },
    env.MINIAPP_BRIDGE_SECRET
  );
  const aliceSessionRes = await (await handleDeviceVerifySession(aliceSessionReq, env)).json();
  assert.equal(aliceSessionRes.ok, true);
  assert.ok(aliceSessionRes.challengeNonce);

  const aliceSignals = sampleDeviceSignals('device-A');
  const aliceSubmitReq = buildSignedBridgeRequest(
    '/api/internal/device-verify/submit',
    {
      initData: validInit,
      challengeNonce: aliceSessionRes.challengeNonce,
      signals: aliceSignals,
      clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' },
    },
    env.MINIAPP_BRIDGE_SECRET
  );
  const aliceSubmitRes = await (await handleDeviceVerifySubmit(aliceSubmitReq, env)).json();
  assert.equal(aliceSubmitRes.ok, true);
  assert.equal(aliceSubmitRes.verdict, 'verified');
  assert.equal(aliceSubmitRes.referralCredited, true);
  assert.ok(aliceSubmitRes.verificationToken);

  const verifiedToken = await verifyVerificationToken(env, aliceSubmitRes.verificationToken);
  assert.equal(verifiedToken.ok, true);
  assert.equal(verifiedToken.payload.uid, '200001');

  const referrerAfterAlice = await getUser(env, '100001');
  assert.equal(referrerAfterAlice.balancePaise, 2800, 'Referrer credited ₹3.00 (300 paise)');
  assert.equal(referrerAfterAlice.totalReferrals, 1);
  console.log('✓ 5. Clean Mini App verification unlocks user, issues signed token, and credits referral atomically');

  // Step 7: Shared IP alone (Bob on same Wi-Fi 103.21.44.10, DIFFERENT device) MUST NOT be rejected!
  const { user: bob } = await createOrUpdateUserFromTelegram(env, { id: 200002, first_name: 'Bob' });
  await registerPendingReferralIfEligible(env, bob, '100001');
  await updateUserForceJoinVerified(env, bob.id, true);
  const bobInit = buildSignedTelegramInitData(env.BOT_TOKEN, { id: 200002, first_name: 'Bob' });
  const bobSession = await (
    await handleDeviceVerifySession(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/session',
        { initData: bobInit, clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' } },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  const bobSubmit = await (
    await handleDeviceVerifySubmit(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/submit',
        {
          initData: bobInit,
          challengeNonce: bobSession.challengeNonce,
          signals: sampleDeviceSignals('device-B-different-phone'),
          clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' },
        },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  assert.equal(bobSubmit.ok, true);
  assert.equal(bobSubmit.verdict, 'verified', 'Shared IP alone must NEVER auto-reject a distinct device');
  assert.equal(bobSubmit.referralCredited, true);
  assert.equal((await getUser(env, '100001')).balancePaise, 3100);
  console.log('✓ 6. Shared IP alone contributes partial risk (+15) and NEVER auto-rejects legitimate users');

  // Step 8: Duplicate Device (Charlie uses Alice's EXACT device fingerprint!) -> pending_review + referral held!
  const { user: charlie } = await createOrUpdateUserFromTelegram(env, {
    id: 200003,
    first_name: 'Charlie',
  });
  await registerPendingReferralIfEligible(env, charlie, '100001');
  await updateUserForceJoinVerified(env, charlie.id, true);
  const charlieInit = buildSignedTelegramInitData(env.BOT_TOKEN, {
    id: 200003,
    first_name: 'Charlie',
  });
  const charlieSession = await (
    await handleDeviceVerifySession(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/session',
        { initData: charlieInit, clientNetwork: { ip: '49.36.12.5', countryCode: 'IN' } },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  const charlieSubmit = await (
    await handleDeviceVerifySubmit(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/submit',
        {
          initData: charlieInit,
          challengeNonce: charlieSession.challengeNonce,
          signals: aliceSignals, // Same strict device fingerprint as Alice!
          clientNetwork: { ip: '49.36.12.5', countryCode: 'IN' },
        },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  assert.equal(charlieSubmit.ok, true);
  assert.equal(charlieSubmit.verdict, 'pending_review', 'Duplicate device must trigger suspicious referral review');
  assert.ok(charlieSubmit.reviewId);
  assert.equal((await getUser(env, '100001')).balancePaise, 3100, 'Flagged referral MUST NOT auto-credit');
  assert.equal((await getUserReferrals(env, '100001')).length, 2, 'Flagged referral MUST NOT appear as completed');

  const clusters = await getSuspiciousDeviceClustersPage(env, 1, 5);
  assert.equal(clusters.total, 1, 'Duplicate device cluster must be visible in Admin Panel');
  assert.equal(clusters.items[0].accountCount, 2);

  const pendingReviews = await getPendingReferralReviewsPage(env, 1, 5);
  assert.equal(pendingReviews.total, 1);
  console.log('✓ 7. Same device across multiple accounts triggers pending_review, holds referral, and surfaces cluster');

  // Step 8b: Charlie tries to bypass duplicate-device hold by retrying with a brand-new browser fingerprint -> MUST stay pending_review!
  const charlieRetryInit = buildSignedTelegramInitData(env.BOT_TOKEN, {
    id: 200003,
    first_name: 'Charlie',
  });
  const charlieRetrySession = await (
    await handleDeviceVerifySession(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/session',
        { initData: charlieRetryInit, clientNetwork: { ip: '49.36.99.5', countryCode: 'IN' } },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  const charlieRetrySubmit = await (
    await handleDeviceVerifySubmit(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/submit',
        {
          initData: charlieRetryInit,
          challengeNonce: charlieRetrySession.challengeNonce,
          signals: sampleDeviceSignals('charlie-spoofed-incognito-device'),
          clientNetwork: { ip: '49.36.99.5', countryCode: 'IN' },
        },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  assert.equal(
    charlieRetrySubmit.verdict,
    'pending_review',
    'Prior duplicate-device hold must NOT self-clear via incognito retry'
  );
  assert.equal((await getUser(env, '100001')).balancePaise, 3100);
  console.log('✓ 8. Prior duplicate-device review cannot be bypassed by incognito/new-device retry');

  // Step 9: Admin approves Charlie's review in ONE single atomic D1 batch -> verified + referral credited + ledger + audit
  const approveRes = await resolveReferralReviewAtomic(env, {
    reviewId: charlieSubmit.reviewId,
    decision: 'approved',
    adminId: '8838351233',
    note: 'Verified family member',
  });
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.referralCredited, true, 'Single-batch approval must credit referral atomically');
  assert.equal(approveRes.amountPaise, 300);
  assert.equal((await getUser(env, '100001')).balancePaise, 3400);
  assert.equal((await getUser(env, '200003')).deviceVerificationStatus, 'verified');
  assert.equal((await getUserReferrals(env, '100001')).length, 3);

  // Double-approving the same review must be rejected idempotently
  const dupApprove = await resolveReferralReviewAtomic(env, {
    reviewId: charlieSubmit.reviewId,
    decision: 'approved',
    adminId: '8838351233',
  });
  assert.equal(dupApprove.ok, false);
  assert.equal((await getUser(env, '100001')).balancePaise, 3400, 'Double approval must never double-credit');

  // Step 10: Admin rejects a flagged duplicate-device referral (Dave) -> stays uncredited forever & blocks self-retry
  const { user: dave } = await createOrUpdateUserFromTelegram(env, { id: 200004, first_name: 'Dave' });
  await registerPendingReferralIfEligible(env, dave, '100001');
  await updateUserForceJoinVerified(env, dave.id, true);
  const daveInit = buildSignedTelegramInitData(env.BOT_TOKEN, { id: 200004, first_name: 'Dave' });
  const daveSession = await (
    await handleDeviceVerifySession(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/session',
        { initData: daveInit, clientNetwork: { ip: '103.55.1.9', countryCode: 'IN' } },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  const daveSubmit = await (
    await handleDeviceVerifySubmit(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/submit',
        {
          initData: daveInit,
          challengeNonce: daveSession.challengeNonce,
          signals: aliceSignals,
          clientNetwork: { ip: '103.55.1.9', countryCode: 'IN' },
        },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  assert.equal(daveSubmit.verdict, 'pending_review');
  const rejectRes = await resolveReferralReviewAtomic(env, {
    reviewId: daveSubmit.reviewId,
    decision: 'rejected',
    adminId: '8838351233',
    note: 'Confirmed multi-account abuse',
  });
  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.referralCredited, false);
  assert.equal((await getUser(env, '100001')).balancePaise, 3400);
  assert.equal((await getUser(env, '200004')).deviceVerificationStatus, 'rejected');

  // Rejected user cannot re-open a verification session via API
  const daveBlockedRes = await handleDeviceVerifySession(
    buildSignedBridgeRequest(
      '/api/internal/device-verify/session',
      { initData: buildSignedTelegramInitData(env.BOT_TOKEN, { id: 200004, first_name: 'Dave' }) },
      env.MINIAPP_BRIDGE_SECRET
    ),
    env
  );
  assert.equal(daveBlockedRes.status, 403, 'Rejected account must be blocked from self-retry');
  console.log('✓ 9. Single-batch atomic admin approval/rejection, double-approve guard & rejected-retry block verified');

  // Step 11: Verify immutable verification_audit_logs triggers prevent UPDATE & DELETE
  let updateBlocked = false;
  try {
    sqlite.exec("UPDATE verification_audit_logs SET verdict = 'tampered'");
  } catch (err) {
    updateBlocked = String(err.message).includes('VERIFICATION_AUDIT_IMMUTABLE_UPDATE_FORBIDDEN');
  }
  assert.equal(updateBlocked, true, 'verification_audit_logs UPDATE must be blocked by SQLite trigger');

  let deleteBlocked = false;
  try {
    sqlite.exec('DELETE FROM verification_audit_logs');
  } catch (err) {
    deleteBlocked = String(err.message).includes('VERIFICATION_AUDIT_IMMUTABLE_DELETE_FORBIDDEN');
  }
  assert.equal(deleteBlocked, true, 'verification_audit_logs DELETE must be blocked by SQLite trigger');

  const stats = await getDeviceVerificationStats(env);
  assert.equal(stats.grandfatheredUsers, 1);
  assert.equal(stats.verifiedUsers, 3);
  assert.equal(stats.rejectedUsers, 1);
  assert.equal(stats.duplicateDeviceClusters, 1);
  assert.equal(stats.approvedReferralReviews, 1);
  assert.equal(stats.rejectedReferralReviews, 1);
  console.log('✓ 10. Database-immutable verification audit triggers & device stats verified');

  // Step 12: Verify existing Cloudflare Worker entrypoint (`src/index.js`) health & webhook security
  const { default: worker } = await import('../src/index.js');
  const workerEnv = { ...env, WEBHOOK_SECRET: 'test-webhook-secret-xyz' };
  const healthRes = await worker.fetch(new Request('https://worker.example.com/health'), workerEnv, {});
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.database, 'connected');

  const unauthWebhook = await worker.fetch(
    new Request('https://worker.example.com/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 90001 }),
    }),
    workerEnv,
    {}
  );
  assert.equal(unauthWebhook.status, 401, 'Webhook must still reject unauthorized requests');

  const authWebhook = await worker.fetch(
    new Request('https://worker.example.com/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-xyz',
      },
      body: JSON.stringify({
        update_id: 90002,
        message: {
          message_id: 10,
          chat: { id: 100001, type: 'private' },
          from: { id: 100001, first_name: 'LegacyUser', username: 'legacy' },
          text: '/start',
        },
      }),
    }),
    workerEnv,
    {}
  );
  assert.equal(authWebhook.status, 200, 'Authorized webhook update for grandfathered user must succeed');
  console.log('✓ 11. Existing Cloudflare Worker /health & /webhook routes remain 100% operational');

  // Step 13: Verify Secretary Mode stays strictly inactive & hard-blocks public @pnarewards channel
  const { emitSecretaryLog, parseSecretaryChannelInput, verifySecretaryChannel } = await import(
    '../src/services/secretary.js'
  );
  const blockedParse = parseSecretaryChannelInput('@pnarewards', env);
  assert.equal(blockedParse.ok, false, 'Secretary Mode must reject public @pnarewards channel');

  const blockedVerify = await verifySecretaryChannel({ ...env, PNA_LOG_CHANNEL_ID: '@pnarewards' });
  assert.equal(blockedVerify.ok, false, 'verifySecretaryChannel must refuse @pnarewards');

  const inactiveEmit = await emitSecretaryLog(
    { ...env, PNA_LOG_CHANNEL_ID: '@pnarewards' },
    { eventType: 'TEST_PRIVATE', dedupKey: 'test_sec_block_1', text: 'Private audit test' }
  );
  assert.equal(inactiveEmit.ok, false);
  assert.equal(inactiveEmit.skipped, true, 'Secretary Mode must stay inactive and skip posting');
  console.log('✓ 12. Secretary Mode remains inactive by default & hard-blocks public @pnarewards channel');

  // Step 14: Full pre- vs post-migration 0002 data integrity snapshot check (all existing tables preserved)
  const integrityDb = new DatabaseSync(':memory:');
  integrityDb.exec('PRAGMA foreign_keys = ON;');
  integrityDb.exec(sql0001);
  integrityDb.exec(`
    INSERT INTO users (telegram_id, first_name, joined_at, last_active_at, balance_paise, total_earned_paise, referral_earnings_paise, total_referrals, force_join_verified)
      VALUES ('900001', 'ExistingA', 1700000000000, 1700000000000, 1500, 1800, 300, 1, 1);
    INSERT INTO users (telegram_id, first_name, joined_at, last_active_at, balance_paise, total_earned_paise, referred_by, referral_credited, force_join_verified)
      VALUES ('900002', 'ExistingB', 1700000001000, 1700000001000, 450, 450, '900001', 1, 1);
    INSERT INTO referral_claims (referred_user_id, referrer_id, amount_paise, credited_at)
      VALUES ('900002', '900001', 300, 1700000002000);
    INSERT INTO referrals (id, referrer_id, referred_user_id, referred_name, amount_paise, credited_at)
      VALUES ('REF-EXIST1', '900001', '900002', 'ExistingB', 300, 1700000002000);
    INSERT INTO vouchers (id, code, normalized_code, code_hash, category, value_paise, status, added_at, added_by)
      VALUES ('VCH-EXIST1', 'AMZN-1234', 'AMZN-1234', 'hash-exist-1', 'amazon', 1000, 'available', 1700000003000, '8838351233');
    INSERT INTO withdrawals (id, user_id, amount_paise, category, status, created_at, user_balance_snapshot_paise)
      VALUES ('WD-EXIST1', '900001', 1000, 'amazon', 'pending', 1700000004000, 1500);
    INSERT INTO tasks (id, title, reward_paise, status, created_by, created_at, updated_at)
      VALUES ('TSK-EXIST1', 'Sample Task', 100, 'active', '8838351233', 1700000005000, 1700000005000);
    INSERT INTO user_tasks (id, task_id, user_id, status, reward_paise, completed_at)
      VALUES ('UTK-EXIST1', 'TSK-EXIST1', '900001', 'completed', 100, 1700000006000);
  `);

  const snapshotSql = `
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COALESCE(SUM(balance_paise), 0) FROM users) AS total_balance_paise,
      (SELECT COALESCE(SUM(referral_earnings_paise), 0) FROM users) AS total_referral_earnings_paise,
      (SELECT COUNT(*) FROM referrals) AS total_referral_records,
      (SELECT COUNT(*) FROM withdrawals) AS total_withdrawals,
      (SELECT COUNT(*) FROM vouchers) AS total_vouchers,
      (SELECT COUNT(*) FROM tasks) AS total_tasks,
      (SELECT COUNT(*) FROM user_tasks) AS total_user_tasks
  `;
  const beforeSnap = integrityDb.prepare(snapshotSql).get();
  integrityDb.exec(sql0002);
  const afterSnap = integrityDb.prepare(snapshotSql).get();
  assert.deepEqual(afterSnap, beforeSnap, 'Migration 0002 MUST preserve every existing financial/user/voucher/task record identically');

  const gfRow = integrityDb
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE device_verification_status = 'grandfathered' AND device_verification_required = 0")
    .get();
  assert.equal(Number(gfRow.cnt), 2, 'All pre-existing users must be grandfathered');
  console.log('✓ 13. Pre- vs post-migration 0002 data integrity snapshot matched 100% identically');

  console.log('\nALL 13 DEVICE VERIFICATION, SECRETARY SAFETY & DATA INTEGRITY TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
