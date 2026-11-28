// ============================================================================
// End-to-End SQLite Integration & 14-Scenario Verification Suite
// PnA Rewards — Telegram Mini App Cross-Account Device Reputation System
// ============================================================================
// Applies `migrations/0001_initial_schema.sql`, `migrations/0002_device_verification.sql`,
// and `migrations/0003_device_reputation_signals.sql` on an in-memory real SQLite
// engine (`node:sqlite`), wraps it in a faithful Cloudflare D1 adapter, and verifies
// all 14 required production scenarios plus security, RFC 4291 IPv6, HMAC token
// parity, admin atomic approval/rejection, Secretary Mode safety, and pre/post
// migration data integrity.
//
// ZERO live D1 writes. ZERO external network calls.
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
  extractIpSubnet,
  handleDeviceVerifyObserve,
  handleDeviceVerifySession,
  handleDeviceVerifySubmit,
  mintSignedInstallTokenWorker,
  verifySignedInstallToken,
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

function buildSignedTelegramInitData(
  botToken,
  userObj,
  authDateSec = Math.floor(Date.now() / 1000)
) {
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

function buildSignedBridgeRequest(
  pathname,
  bodyObj,
  bridgeSecret,
  origin = 'https://p-a-rewards.ai.studio'
) {
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

// Mirrors server.ts mintSignedInstallToken() exactly using Node crypto
function mintCloudRunInstallToken(bridgeSecret) {
  const tokenId = crypto.randomBytes(16).toString('hex');
  const key = crypto
    .createHmac('sha256', bridgeSecret)
    .update('pna-rewards:install-token-key:v1')
    .digest();
  const sig = crypto.createHmac('sha256', key).update(`pna_inst_v1.${tokenId}`).digest('hex');
  return `pna_inst_v1.${tokenId}.${sig}`;
}

function makeAnchor(token, opts = {}) {
  return {
    cookieToken: opts.cookieToken !== undefined ? opts.cookieToken : token || '',
    storageToken: opts.storageToken !== undefined ? opts.storageToken : token || '',
    canonicalToken: opts.canonicalToken !== undefined ? opts.canonicalToken : token || '',
    tamperedCookieToken: Boolean(opts.tamperedCookieToken),
    tamperedStorageToken: Boolean(opts.tamperedStorageToken),
    wasNewlyMinted: Boolean(opts.wasNewlyMinted),
  };
}

function sampleDeviceSignals(seed, overrides = {}) {
  const base = {
    canvasHash: crypto.createHash('sha256').update(`canvas-${seed}`).digest('hex'),
    webglVendor: `Qualcomm-${seed}`,
    webglRenderer: `Adreno-GPU-${seed}`,
    webglParamsHash: crypto.createHash('sha256').update(`webgl-${seed}`).digest('hex'),
    audioHash: crypto.createHash('sha256').update(`audio-${seed}`).digest('hex'),
    fontMetricsHash: crypto.createHash('sha256').update(`fonts-${seed}`).digest('hex'),
    screenWidth: 412 + (seed.length % 7),
    screenHeight: 915,
    colorDepth: 24,
    devicePixelRatio: 2.625,
    timezone: 'Asia/Kolkata',
    timezoneOffset: -330,
    language: 'en-IN',
    languagesCount: 2,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 5,
    platform: 'Linux armv8l',
    telegramPlatform: 'android',
    telegramVersion: '9.0',
    userAgentFamily: 'Android/TelegramWebView/Chromium',
    osVersion: '14',
    webviewVersion: '129.0.6668.100',
    deviceModel: `SM-${seed.slice(0, 6).toUpperCase()}`,
    webdriver: false,
    automationSignals: [],
    telegramNative: {
      biometricSupported: true,
      biometricAvailable: false,
      biometricAccessGranted: false,
      biometricDeviceId: '',
      deviceStorageSupported: true,
      accountContinuityId: crypto.createHash('sha256').update(`acct-store-${seed}`).digest('hex').slice(0, 32),
      accountContinuityRestored: false,
    },
  };
  return {
    ...base,
    ...overrides,
    telegramNative: {
      ...base.telegramNative,
      ...(overrides.telegramNative || {}),
    },
  };
}

// Stub global fetch so Telegram sendMessage calls do not hit external network
globalThis.fetch = async () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function summarizeCollectedSignals(signals, anchor) {
  const collected = [];
  if (anchor?.cookieToken || anchor?.storageToken || anchor?.canonicalToken) {
    collected.push(
      anchor?.tamperedCookieToken || anchor?.tamperedStorageToken
        ? 'install_token(TAMPERED)'
        : 'install_token'
    );
  }
  if (signals.canvasHash) collected.push('canvas');
  if (signals.webglRenderer || signals.webglParamsHash) collected.push('webgl');
  if (signals.audioHash) collected.push('audio');
  if (signals.fontMetricsHash) collected.push('fontMetrics');
  if (signals.screenWidth && signals.screenHeight) collected.push('hardware/screen');
  if (signals.telegramNative?.biometricDeviceId) collected.push('tg_biometric_id');
  if (signals.telegramNative?.accountContinuityId) collected.push('account_storage_id');
  if (signals.webdriver || (signals.automationSignals && signals.automationSignals.length > 0)) {
    collected.push('automation_flags');
  }
  return collected.join(', ') || 'minimal';
}

function logScenarioResult(num, title, details) {
  console.log(`\n[Scenario ${num}] ${title}`);
  console.log(`  Signals collected      : ${details.signalsCollected}`);
  console.log(`  Cross-account match    : ${details.crossAccountMatch}`);
  console.log(`  Risk score             : ${details.riskScore}`);
  console.log(`  Account access decision: ${details.accountDecision}`);
  console.log(`  Referral reward        : ${details.referralDecision}`);
}

async function prepareFreshUser(env, { id, firstName, username = '', referrerId = null }) {
  const { user } = await createOrUpdateUserFromTelegram(env, {
    id,
    first_name: firstName,
    username,
  });
  if (referrerId) {
    await registerPendingReferralIfEligible(env, user, String(referrerId));
  }
  await updateUserForceJoinVerified(env, user.id, true);
  return getUser(env, user.id);
}

async function runFullSubmitFlow(env, { userId, firstName, signals, clientNetwork, installAnchor }) {
  const initData = buildSignedTelegramInitData(env.BOT_TOKEN, {
    id: Number(userId),
    first_name: firstName,
  });
  const sessionRes = await (
    await handleDeviceVerifySession(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/session',
        { initData, clientNetwork, installAnchor },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  assert.equal(sessionRes.ok, true, `Session must succeed for ${userId}: ${JSON.stringify(sessionRes)}`);
  assert.ok(sessionRes.challengeNonce, `Challenge nonce expected for ${userId}`);

  const submitRes = await (
    await handleDeviceVerifySubmit(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/submit',
        {
          initData,
          challengeNonce: sessionRes.challengeNonce,
          signals,
          clientNetwork,
          installAnchor,
        },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
  return submitRes;
}

async function runObserveFlow(env, { userId, firstName, signals, clientNetwork, installAnchor }) {
  const initData = buildSignedTelegramInitData(env.BOT_TOKEN, {
    id: Number(userId),
    first_name: firstName,
  });
  return (
    await handleDeviceVerifyObserve(
      buildSignedBridgeRequest(
        '/api/internal/device-verify/observe',
        { initData, signals, clientNetwork, installAnchor },
        env.MINIAPP_BRIDGE_SECRET
      ),
      env
    )
  ).json();
}

async function runTests() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  const sql0001 = fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8');
  const sql0002 = fs.readFileSync(path.resolve('migrations/0002_device_verification.sql'), 'utf8');
  const sql0003 = fs.readFileSync(path.resolve('migrations/0003_device_reputation_signals.sql'), 'utf8');

  // Seed pre-existing production-like users BEFORE applying 0002 & 0003
  sqlite.exec(sql0001);
  sqlite
    .prepare(
      `INSERT INTO users (telegram_id, first_name, username, joined_at, last_active_at, balance_paise, total_earned_paise, force_join_verified)
       VALUES ('100001', 'LegacyGrandfathered', 'legacy_gf', 1700000000000, 1700000000000, 2500, 2500, 1)`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO users (telegram_id, first_name, username, joined_at, last_active_at, balance_paise, total_earned_paise, force_join_verified)
       VALUES ('8838351233', 'OwnerAdmin', 'pna_owner', 1700000000000, 1700000000000, 5000, 5000, 1)`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO users (telegram_id, first_name, username, joined_at, last_active_at, balance_paise, total_earned_paise, force_join_verified)
       VALUES ('100099', 'ExternalReferrer', 'ext_ref', 1700000000000, 1700000000000, 1000, 1000, 1)`
    )
    .run();

  // Apply additive migrations 0002 and 0003
  sqlite.exec(sql0002);
  sqlite.exec(sql0003);

  const env = {
    DB: createD1Adapter(sqlite),
    BOT_TOKEN: '123456789:TEST_BOT_TOKEN_FOR_LOCAL_VERIFICATION_SUITE',
    OWNER_ID: '8838351233',
    MINIAPP_BRIDGE_SECRET: 'test-bridge-secret-0123456789abcdef0123456789abcdef',
    MINIAPP_URL: 'https://p-a-rewards.ai.studio',
    MINIAPP_ALLOWED_ORIGINS: 'https://p-a-rewards.ai.studio',
    DEVICE_VERIFICATION_ENABLED: 'true',
  };

  console.log('========================================================================');
  console.log('PART A: 14 REQUIRED PRODUCTION DEVICE VERIFICATION SCENARIOS');
  console.log('========================================================================');

  // --------------------------------------------------------------------------
  // SCENARIO 1: Account A grandfathered + Account B on the same installation
  // --------------------------------------------------------------------------
  const phone1Token = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const phone1Signals = sampleDeviceSignals('android-phone-1');
  const s1Obs = await runObserveFlow(env, {
    userId: '100001',
    firstName: 'LegacyGrandfathered',
    signals: phone1Signals,
    clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' },
    installAnchor: makeAnchor(phone1Token),
  });
  assert.equal(s1Obs.ok, true);
  assert.equal(s1Obs.observed, true);
  assert.equal(s1Obs.status, 'grandfathered', 'Grandfathered user status MUST remain unchanged');
  assert.equal(s1Obs.accountDecision, 'preserved_access');
  assert.equal((await getUser(env, '100001')).balancePaise, 2500, 'Grandfathered balance untouched');

  await prepareFreshUser(env, { id: 300001, firstName: 'AcctB_OnGFPhone', referrerId: '100099' });
  const extRefBalBeforeS1 = (await getUser(env, '100099')).balancePaise;
  const s1Sub = await runFullSubmitFlow(env, {
    userId: '300001',
    firstName: 'AcctB_OnGFPhone',
    signals: phone1Signals,
    clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' },
    installAnchor: makeAnchor(phone1Token),
  });
  assert.equal(s1Sub.ok, true);
  assert.equal(s1Sub.verdict, 'rejected');
  assert.equal(s1Sub.referralDecision, 'held_for_review');
  assert.ok(s1Sub.matchedUserIds.includes('100001'), 'Must match grandfathered Account A');
  assert.ok(s1Sub.matchedSignalTypes.includes('install_token'));
  assert.ok(s1Sub.matchedSignalTypes.includes('strict_fp'));
  assert.equal((await getUser(env, '100099')).balancePaise, extRefBalBeforeS1, 'Held referral must not credit');
  logScenarioResult(1, 'Account A grandfathered + Account B on same installation', {
    signalsCollected: summarizeCollectedSignals(phone1Signals, makeAnchor(phone1Token)),
    crossAccountMatch: `MATCHED userIds=[${s1Sub.matchedUserIds.join(', ')}] via [${s1Sub.matchedSignalTypes.join(', ')}]`,
    riskScore: `${s1Sub.riskScore}/100`,
    accountDecision: `Acct A: grandfathered (preserved_access) | Acct B: ${s1Sub.verdict}`,
    referralDecision: s1Sub.referralDecision,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 2: Account A admin + Account B on the same installation
  // --------------------------------------------------------------------------
  const adminToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const adminSignals = sampleDeviceSignals('android-admin-phone');
  const s2Obs = await runObserveFlow(env, {
    userId: '8838351233',
    firstName: 'OwnerAdmin',
    signals: adminSignals,
    clientNetwork: { ip: '103.21.55.12', countryCode: 'IN' },
    installAnchor: makeAnchor(adminToken),
  });
  assert.equal(s2Obs.ok, true);
  assert.equal(s2Obs.observed, true);
  assert.equal(s2Obs.accountDecision, 'admin_bypass', 'Admin must NEVER be blocked');
  assert.equal((await getUser(env, '8838351233')).deviceVerificationStatus, 'grandfathered');

  await prepareFreshUser(env, { id: 300002, firstName: 'AcctB_OnAdminPhone', referrerId: '100099' });
  const s2Sub = await runFullSubmitFlow(env, {
    userId: '300002',
    firstName: 'AcctB_OnAdminPhone',
    signals: adminSignals,
    clientNetwork: { ip: '103.21.55.12', countryCode: 'IN' },
    installAnchor: makeAnchor(adminToken),
  });
  assert.equal(s2Sub.ok, true);
  assert.equal(s2Sub.verdict, 'rejected');
  assert.equal(s2Sub.referralDecision, 'held_for_review');
  assert.ok(s2Sub.matchedUserIds.includes('8838351233'), 'Must detect shared device with Admin A');
  logScenarioResult(2, 'Account A admin + Account B on same installation', {
    signalsCollected: summarizeCollectedSignals(adminSignals, makeAnchor(adminToken)),
    crossAccountMatch: `MATCHED userIds=[${s2Sub.matchedUserIds.join(', ')}] via [${s2Sub.matchedSignalTypes.join(', ')}]`,
    riskScore: `${s2Sub.riskScore}/100`,
    accountDecision: `Admin A: admin_bypass (unblocked) | Acct B: ${s2Sub.verdict}`,
    referralDecision: s2Sub.referralDecision,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 3: Same installation with Canvas/Audio fingerprint drift
  // --------------------------------------------------------------------------
  // 3A: Both Canvas and Audio drifted, install_token intact -> caught by install_token (+75 -> pending_review)
  await prepareFreshUser(env, { id: 300003, firstName: 'AcctB_DriftInstallTok', referrerId: '100099' });
  const driftedSignalsA = sampleDeviceSignals('android-phone-1', {
    canvasHash: crypto.createHash('sha256').update('drifted-canvas-v2').digest('hex'),
    audioHash: '', // AudioContext unavailable / timed out
  });
  const s3aSub = await runFullSubmitFlow(env, {
    userId: '300003',
    firstName: 'AcctB_DriftInstallTok',
    signals: driftedSignalsA,
    clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' },
    installAnchor: makeAnchor(phone1Token),
  });
  assert.equal(s3aSub.ok, true);
  assert.equal(s3aSub.verdict, 'pending_review');
  assert.ok(s3aSub.matchedSignalTypes.includes('install_token'));
  assert.equal(s3aSub.referralDecision, 'held_for_review');

  // 3B: Audio timed out / drifted AND install_token missing -> STILL caught by render_core (+55 -> pending_review)!
  await prepareFreshUser(env, { id: 300004, firstName: 'AcctC_AudioDriftRenderCore', referrerId: '100099' });
  const driftedSignalsB = sampleDeviceSignals('android-phone-1', {
    audioHash: '', // AudioContext failed / timed out
    fontMetricsHash: crypto.createHash('sha256').update('scaled-font-size').digest('hex'),
  });
  const s3bToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const s3bSub = await runFullSubmitFlow(env, {
    userId: '300004',
    firstName: 'AcctC_AudioDriftRenderCore',
    signals: driftedSignalsB,
    clientNetwork: { ip: '152.58.11.4', countryCode: 'IN' },
    installAnchor: makeAnchor(s3bToken),
  });
  assert.equal(s3bSub.ok, true);
  assert.equal(s3bSub.verdict, 'pending_review');
  assert.ok(s3bSub.matchedSignalTypes.includes('render_core'), 'Render core must catch Audio/font drift without install_token');
  assert.equal(s3bSub.referralDecision, 'held_for_review');
  logScenarioResult(3, 'Same installation with Canvas/Audio fingerprint drift', {
    signalsCollected: `3A(Canvas drift+Audio missing+install_token) | 3B(Audio missing+Font drift, no shared token)`,
    crossAccountMatch: `3A: [${s3aSub.matchedSignalTypes.join(', ')}] -> [${s3aSub.matchedUserIds.slice(0, 2).join(', ')}] | 3B: [${s3bSub.matchedSignalTypes.join(', ')}] -> [${s3bSub.matchedUserIds.slice(0, 2).join(', ')}]`,
    riskScore: `3A: ${s3aSub.riskScore}/100 | 3B: ${s3bSub.riskScore}/100`,
    accountDecision: `3A: ${s3aSub.verdict} | 3B: ${s3bSub.verdict}`,
    referralDecision: `3A: ${s3aSub.referralDecision} | 3B: ${s3bSub.referralDecision}`,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 4: Same installation with different IP / VPN
  // --------------------------------------------------------------------------
  await prepareFreshUser(env, { id: 300005, firstName: 'AcctB_VPN', referrerId: '100099' });
  const s4Sub = await runFullSubmitFlow(env, {
    userId: '300005',
    firstName: 'AcctB_VPN',
    signals: phone1Signals,
    clientNetwork: { ip: '198.51.100.77', countryCode: 'NL', asnOrg: 'NordVPN SAS', proxyHint: true },
    installAnchor: makeAnchor(phone1Token),
  });
  assert.equal(s4Sub.ok, true);
  assert.equal(s4Sub.verdict, 'rejected');
  assert.equal(s4Sub.riskScore, 100);
  assert.ok(s4Sub.matchedUserIds.includes('100001'));
  assert.equal(s4Sub.referralDecision, 'held_for_review');
  logScenarioResult(4, 'Same installation with different IP / VPN', {
    signalsCollected: `${summarizeCollectedSignals(phone1Signals, makeAnchor(phone1Token))}, vpn_ip(198.51.100.77)`,
    crossAccountMatch: `MATCHED userIds=[${s4Sub.matchedUserIds.join(', ')}] via [${s4Sub.matchedSignalTypes.join(', ')}]`,
    riskScore: `${s4Sub.riskScore}/100`,
    accountDecision: s4Sub.verdict,
    referralDecision: s4Sub.referralDecision,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 5: Two different devices on the same Wi-Fi
  // --------------------------------------------------------------------------
  await prepareFreshUser(env, { id: 300006, firstName: 'WifiPhone1', referrerId: '100099' });
  const wifiToken1 = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const wifiSig1 = sampleDeviceSignals('family-phone-alpha');
  const s5aSub = await runFullSubmitFlow(env, {
    userId: '300006',
    firstName: 'WifiPhone1',
    signals: wifiSig1,
    clientNetwork: { ip: '49.36.210.14', countryCode: 'IN' },
    installAnchor: makeAnchor(wifiToken1),
  });
  assert.equal(s5aSub.verdict, 'verified');
  assert.equal(s5aSub.referralCredited, true);

  await prepareFreshUser(env, { id: 300007, firstName: 'WifiPhone2', referrerId: '100099' });
  const wifiToken2 = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const wifiSig2 = sampleDeviceSignals('family-phone-beta-distinct-gpu');
  const s5bSub = await runFullSubmitFlow(env, {
    userId: '300007',
    firstName: 'WifiPhone2',
    signals: wifiSig2,
    clientNetwork: { ip: '49.36.210.88', countryCode: 'IN' }, // Same /24 Wi-Fi subnet!
    installAnchor: makeAnchor(wifiToken2),
  });
  assert.equal(s5bSub.verdict, 'verified', 'Two distinct phones on same Wi-Fi MUST both pass');
  assert.equal(s5bSub.riskScore, 15, 'Shared subnet alone should contribute exactly +15');
  assert.equal(s5bSub.referralDecision, 'credited');
  assert.equal(s5bSub.referralCredited, true);
  logScenarioResult(5, 'Two different devices on the same Wi-Fi', {
    signalsCollected: `${summarizeCollectedSignals(wifiSig2, makeAnchor(wifiToken2))}, shared_wifi_subnet(49.36.210.0/24)`,
    crossAccountMatch: `NO device match (matchedUserIds=[]); secondary subnet overlap only (+15)`,
    riskScore: `Phone 1: ${s5aSub.riskScore}/100 | Phone 2: ${s5bSub.riskScore}/100`,
    accountDecision: `Phone 1: ${s5aSub.verdict} | Phone 2: ${s5bSub.verdict}`,
    referralDecision: `Phone 1: ${s5aSub.referralDecision} | Phone 2: ${s5bSub.referralDecision}`,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 6: Same account on two different devices
  // --------------------------------------------------------------------------
  const secondDeviceToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const secondDeviceSignals = sampleDeviceSignals('wifi-phone-1-tablet-second-device');
  const s6Obs = await runObserveFlow(env, {
    userId: '300006',
    firstName: 'WifiPhone1',
    signals: secondDeviceSignals,
    clientNetwork: { ip: '49.36.210.14', countryCode: 'IN' },
    installAnchor: makeAnchor(secondDeviceToken),
  });
  assert.equal(s6Obs.ok, true);
  assert.equal(s6Obs.observed, true);
  assert.equal(s6Obs.switchedDevice, true, 'Must detect same account switching to a second device');
  assert.equal(s6Obs.status, 'verified', 'Same account on second device must stay verified');
  assert.equal(s6Obs.accountDecision, 'preserved_access');
  logScenarioResult(6, 'Same account on two different devices', {
    signalsCollected: summarizeCollectedSignals(secondDeviceSignals, makeAnchor(secondDeviceToken)),
    crossAccountMatch: `NO cross-account conflict; same-account continuity flagged switchedDevice=${s6Obs.switchedDevice} (weight 0)`,
    riskScore: '0/100 (observation-only)',
    accountDecision: `${s6Obs.status} (${s6Obs.accountDecision})`,
    referralDecision: 'preserved (unchanged)',
  });

  // --------------------------------------------------------------------------
  // SCENARIO 7: Telegram restart
  // --------------------------------------------------------------------------
  const restartToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const restartSignals = sampleDeviceSignals('android-restart-phone');
  await prepareFreshUser(env, { id: 300008, firstName: 'RestartUserA', referrerId: '100099' });
  const s7aSub = await runFullSubmitFlow(env, {
    userId: '300008',
    firstName: 'RestartUserA',
    signals: restartSignals,
    clientNetwork: { ip: '106.51.12.20', countryCode: 'IN' },
    installAnchor: makeAnchor(restartToken),
  });
  assert.equal(s7aSub.verdict, 'verified');

  // After Telegram restart: same account opens Mini App -> same install_token + stable Canvas -> preserved!
  const s7Obs = await runObserveFlow(env, {
    userId: '300008',
    firstName: 'RestartUserA',
    signals: restartSignals,
    clientNetwork: { ip: '106.51.12.20', countryCode: 'IN' },
    installAnchor: makeAnchor(restartToken),
  });
  assert.equal(s7Obs.switchedDevice, false);
  assert.equal(s7Obs.storageReset, false);

  // Account B opened after Telegram restart on same phone -> caught immediately via install_token + strict_fp!
  await prepareFreshUser(env, { id: 300009, firstName: 'RestartUserB', referrerId: '100099' });
  const s7bSub = await runFullSubmitFlow(env, {
    userId: '300009',
    firstName: 'RestartUserB',
    signals: restartSignals,
    clientNetwork: { ip: '106.51.12.20', countryCode: 'IN' },
    installAnchor: makeAnchor(restartToken),
  });
  assert.equal(s7bSub.verdict, 'rejected');
  assert.ok(s7bSub.matchedUserIds.includes('300008'));
  logScenarioResult(7, 'Telegram restart', {
    signalsCollected: summarizeCollectedSignals(restartSignals, makeAnchor(restartToken)),
    crossAccountMatch: `Acct A restart: switchedDevice=false | Acct B after restart: MATCHED [${s7bSub.matchedUserIds.join(', ')}] via [${s7bSub.matchedSignalTypes.join(', ')}]`,
    riskScore: `Acct A: ${s7aSub.riskScore}/100 | Acct B: ${s7bSub.riskScore}/100`,
    accountDecision: `Acct A: verified (preserved) | Acct B: ${s7bSub.verdict}`,
    referralDecision: `Acct A: ${s7aSub.referralDecision} | Acct B: ${s7bSub.referralDecision}`,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 8: Telegram reinstall
  // --------------------------------------------------------------------------
  // Reinstall wipes install_token & DeviceStorage continuity ID, while WebView Canvas/WebGL stays identical
  const postReinstallTokenA = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const postReinstallSignalsA = sampleDeviceSignals('android-restart-phone', {
    telegramNative: {
      deviceStorageSupported: true,
      accountContinuityId: crypto.randomBytes(16).toString('hex'),
      accountContinuityRestored: false,
    },
  });
  const s8Obs = await runObserveFlow(env, {
    userId: '300008',
    firstName: 'RestartUserA',
    signals: postReinstallSignalsA,
    clientNetwork: { ip: '106.51.12.20', countryCode: 'IN' },
    installAnchor: makeAnchor(postReinstallTokenA),
  });
  assert.equal(s8Obs.storageReset, true, 'Same account after reinstall logs storageReset=true');
  assert.equal(s8Obs.status, 'verified', 'Same account after reinstall remains verified');

  // Different account after Telegram reinstall (brand-new install_token, same phone rendering) -> STILL caught via strict_fp (+65)!
  await prepareFreshUser(env, { id: 300010, firstName: 'ReinstallUserC', referrerId: '100099' });
  const postReinstallTokenC = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const postReinstallSignalsC = sampleDeviceSignals('android-restart-phone', {
    telegramNative: {
      deviceStorageSupported: true,
      accountContinuityId: crypto.randomBytes(16).toString('hex'),
      accountContinuityRestored: false,
    },
  });
  const s8Sub = await runFullSubmitFlow(env, {
    userId: '300010',
    firstName: 'ReinstallUserC',
    signals: postReinstallSignalsC,
    clientNetwork: { ip: '117.205.18.42', countryCode: 'IN' },
    installAnchor: makeAnchor(postReinstallTokenC),
  });
  assert.equal(s8Sub.verdict, 'pending_review');
  assert.ok(s8Sub.matchedSignalTypes.includes('strict_fp'));
  assert.equal(s8Sub.referralDecision, 'held_for_review');
  logScenarioResult(8, 'Telegram reinstall', {
    signalsCollected: `${summarizeCollectedSignals(postReinstallSignalsC, makeAnchor(postReinstallTokenC))} (new install_token + reset DeviceStorage)`,
    crossAccountMatch: `Acct A reinstall: storageReset=true (weight 0) | New Acct C: MATCHED [${s8Sub.matchedUserIds.slice(0, 2).join(', ')}] via [${s8Sub.matchedSignalTypes.join(', ')}]`,
    riskScore: `Acct A: 0/100 | Acct C: ${s8Sub.riskScore}/100`,
    accountDecision: `Acct A: verified (preserved) | Acct C: ${s8Sub.verdict}`,
    referralDecision: `Acct C: ${s8Sub.referralDecision}`,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 9: Missing biometric hardware
  // --------------------------------------------------------------------------
  await prepareFreshUser(env, { id: 300011, firstName: 'NoBiometricHW', referrerId: '100099' });
  const bioHwToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const bioHwSignals = sampleDeviceSignals('budget-android-no-biometric', {
    telegramNative: {
      biometricSupported: true,
      biometricAvailable: false,
      biometricAccessGranted: false,
      biometricDeviceId: '',
    },
  });
  const s9Sub = await runFullSubmitFlow(env, {
    userId: '300011',
    firstName: 'NoBiometricHW',
    signals: bioHwSignals,
    clientNetwork: { ip: '122.161.50.3', countryCode: 'IN' },
    installAnchor: makeAnchor(bioHwToken),
  });
  assert.equal(s9Sub.verdict, 'verified');
  assert.equal(s9Sub.riskScore, 0, 'Missing biometric hardware must incur ZERO risk penalty');
  assert.equal(s9Sub.referralDecision, 'credited');
  logScenarioResult(9, 'Missing biometric hardware', {
    signalsCollected: `${summarizeCollectedSignals(bioHwSignals, makeAnchor(bioHwToken))} (biometricAvailable=false)`,
    crossAccountMatch: 'NONE (missing biometricDeviceId treated as absent, never mismatched)',
    riskScore: `${s9Sub.riskScore}/100`,
    accountDecision: s9Sub.verdict,
    referralDecision: s9Sub.referralDecision,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 10: Biometric permission denied
  // --------------------------------------------------------------------------
  await prepareFreshUser(env, { id: 300012, firstName: 'BioPermDenied', referrerId: '100099' });
  const bioDenToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const bioDenSignals = sampleDeviceSignals('android-biometric-denied', {
    telegramNative: {
      biometricSupported: true,
      biometricAvailable: true,
      biometricAccessGranted: false,
      biometricDeviceId: '',
    },
  });
  const s10Sub = await runFullSubmitFlow(env, {
    userId: '300012',
    firstName: 'BioPermDenied',
    signals: bioDenSignals,
    clientNetwork: { ip: '122.161.51.9', countryCode: 'IN' },
    installAnchor: makeAnchor(bioDenToken),
  });
  assert.equal(s10Sub.verdict, 'verified');
  assert.equal(s10Sub.riskScore, 0, 'Denied biometric permission must incur ZERO risk penalty');
  assert.equal(s10Sub.referralDecision, 'credited');
  logScenarioResult(10, 'Biometric permission denied', {
    signalsCollected: `${summarizeCollectedSignals(bioDenSignals, makeAnchor(bioDenToken))} (biometricAccessGranted=false)`,
    crossAccountMatch: 'NONE (never prompts or penalizes biometric denial)',
    riskScore: `${s10Sub.riskScore}/100`,
    accountDecision: s10Sub.verdict,
    referralDecision: s10Sub.referralDecision,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 11: Unsupported Telegram client (old Bot API 6.x, no Canvas/WebGL)
  // --------------------------------------------------------------------------
  await prepareFreshUser(env, { id: 300013, firstName: 'OldClientUser', referrerId: '100099' });
  const oldToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const oldClientSignals = {
    canvasHash: '',
    webglVendor: '',
    webglRenderer: '',
    webglParamsHash: '',
    audioHash: '',
    fontMetricsHash: '',
    screenWidth: 360,
    screenHeight: 640,
    colorDepth: 24,
    devicePixelRatio: 2,
    timezone: 'Asia/Kolkata',
    timezoneOffset: -330,
    language: 'en',
    languagesCount: 1,
    hardwareConcurrency: 4,
    deviceMemory: 2,
    maxTouchPoints: 5,
    platform: 'Linux armv7l',
    telegramPlatform: 'android',
    telegramVersion: '6.4',
    userAgentFamily: 'Android/LegacyWebView',
    osVersion: '9',
    webviewVersion: '80.0',
    deviceModel: 'OLD-LEGACY-1',
    webdriver: false,
    automationSignals: [],
    telegramNative: {
      biometricSupported: false,
      biometricAvailable: false,
      biometricAccessGranted: false,
      biometricDeviceId: '',
      deviceStorageSupported: false,
      accountContinuityId: '',
      accountContinuityRestored: false,
    },
  };
  const s11Sub = await runFullSubmitFlow(env, {
    userId: '300013',
    firstName: 'OldClientUser',
    signals: oldClientSignals,
    clientNetwork: { ip: '122.161.52.14', countryCode: 'IN' },
    installAnchor: makeAnchor(oldToken),
  });
  assert.equal(s11Sub.verdict, 'verified', 'Unsupported old Telegram client MUST NOT be falsely rejected');
  assert.equal(s11Sub.riskScore, 10, 'Missing render signals only adds minor +10 informational weight');
  assert.equal(s11Sub.referralDecision, 'credited');
  logScenarioResult(11, 'Unsupported Telegram client (Bot API 6.4, no Canvas/WebGL/Biometrics)', {
    signalsCollected: summarizeCollectedSignals(oldClientSignals, makeAnchor(oldToken)),
    crossAccountMatch: 'NONE (missing capabilities safely ignored; +10 MISSING_RENDER_SIGNALS only)',
    riskScore: `${s11Sub.riskScore}/100`,
    accountDecision: s11Sub.verdict,
    referralDecision: s11Sub.referralDecision,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 12: Cloned or modified Telegram client
  // --------------------------------------------------------------------------
  // 12A: Cloned Telegram APK (separate app sandbox = distinct install_token, identical device WebView rendering)
  await prepareFreshUser(env, { id: 300014, firstName: 'ClonedAppUser', referrerId: '100099' });
  const clonedToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const s12aSub = await runFullSubmitFlow(env, {
    userId: '300014',
    firstName: 'ClonedAppUser',
    signals: phone1Signals,
    clientNetwork: { ip: '157.48.22.9', countryCode: 'IN' },
    installAnchor: makeAnchor(clonedToken),
  });
  assert.equal(s12aSub.verdict, 'pending_review');
  assert.ok(s12aSub.matchedSignalTypes.includes('strict_fp'));
  assert.equal(s12aSub.referralDecision, 'held_for_review');

  // 12B: Modified / automated client presenting webdriver + FORGED unsigned install_token
  await prepareFreshUser(env, { id: 300015, firstName: 'ModifiedClientBot', referrerId: '100099' });
  const forgedToken = `pna_inst_v1.${'deadbeef'.repeat(4)}.${'0'.repeat(64)}`;
  const modifiedSignals = sampleDeviceSignals('modified-client-unique', {
    webdriver: true,
    automationSignals: ['navigator.webdriver', 'headless_ua'],
  });
  const s12bSub = await runFullSubmitFlow(env, {
    userId: '300015',
    firstName: 'ModifiedClientBot',
    signals: modifiedSignals,
    clientNetwork: { ip: '157.48.99.3', countryCode: 'IN' },
    installAnchor: makeAnchor('', {
      cookieToken: forgedToken,
      storageToken: forgedToken,
      canonicalToken: '',
      tamperedCookieToken: true,
      tamperedStorageToken: true,
    }),
  });
  assert.equal(s12bSub.verdict, 'pending_review', 'Automated + forged-token modified client must be held');
  assert.equal(s12bSub.riskScore, 55, 'AUTOMATION_SIGNALS (+40) + INSTALL_TOKEN_TAMPERED (+15) = 55');
  assert.equal(s12bSub.referralDecision, 'held_for_review');
  // Confirm forged token was NEVER stored in device_signal_links!
  const forgedStored = sqlite
    .prepare(`SELECT COUNT(*) AS cnt FROM device_signal_links WHERE user_id = '300015' AND signal_type = 'install_token'`)
    .get();
  assert.equal(Number(forgedStored.cnt), 0, 'Forged install_token MUST NEVER be indexed in D1');
  logScenarioResult(12, 'Cloned or modified Telegram client', {
    signalsCollected: `12A(Cloned APK new token + same WebView) | 12B(webdriver + forged install_token)`,
    crossAccountMatch: `12A: MATCHED [${s12aSub.matchedUserIds.slice(0, 2).join(', ')}] via [${s12aSub.matchedSignalTypes.join(', ')}] | 12B: Forged token rejected (0 stored) + automation flagged`,
    riskScore: `12A: ${s12aSub.riskScore}/100 | 12B: ${s12bSub.riskScore}/100`,
    accountDecision: `12A: ${s12aSub.verdict} | 12B: ${s12bSub.verdict}`,
    referralDecision: `12A: ${s12aSub.referralDecision} | 12B: ${s12bSub.referralDecision}`,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 13: Same-device self-referral
  // --------------------------------------------------------------------------
  const selfRefToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const selfRefSignals = sampleDeviceSignals('self-ref-phone-x');
  await prepareFreshUser(env, { id: 300016, firstName: 'SelfReferrerA' });
  const s13aSub = await runFullSubmitFlow(env, {
    userId: '300016',
    firstName: 'SelfReferrerA',
    signals: selfRefSignals,
    clientNetwork: { ip: '103.88.14.22', countryCode: 'IN' },
    installAnchor: makeAnchor(selfRefToken),
  });
  assert.equal(s13aSub.verdict, 'verified');
  const referrerBalBeforeS13 = (await getUser(env, '300016')).balancePaise;

  // Account B uses Account A's referral link on the EXACT SAME Android phone
  await prepareFreshUser(env, { id: 300017, firstName: 'SelfReferredB', referrerId: '300016' });
  const s13bSub = await runFullSubmitFlow(env, {
    userId: '300017',
    firstName: 'SelfReferredB',
    signals: selfRefSignals,
    clientNetwork: { ip: '103.88.14.22', countryCode: 'IN' },
    installAnchor: makeAnchor(selfRefToken),
  });
  assert.equal(s13bSub.verdict, 'rejected');
  assert.equal(s13bSub.riskScore, 100);
  assert.equal(s13bSub.referralDecision, 'held_for_review');
  assert.ok(s13bSub.reviewId, 'Self-referral must open high-priority referral_reviews record');
  assert.ok(s13bSub.matchedUserIds.includes('300016'));
  const s13Reasons = JSON.parse(
    sqlite.prepare(`SELECT risk_reasons_json FROM device_verifications WHERE id = ?`).get(s13bSub.verificationId)
      .risk_reasons_json
  );
  assert.ok(
    s13Reasons.some((r) => r.code === 'SAME_DEVICE_SELF_REFERRAL'),
    'SAME_DEVICE_SELF_REFERRAL reason must be logged'
  );
  assert.equal((await getUser(env, '300016')).balancePaise, referrerBalBeforeS13, 'Referrer balance MUST NOT be credited or modified');
  assert.equal((await getUserReferrals(env, '300016')).length, 0);
  logScenarioResult(13, 'Same-device self-referral', {
    signalsCollected: summarizeCollectedSignals(selfRefSignals, makeAnchor(selfRefToken)),
    crossAccountMatch: `SELF-REFERRAL MATCHED referrer=300016 via [${s13bSub.matchedSignalTypes.join(', ')}] + SAME_DEVICE_SELF_REFERRAL (+25)`,
    riskScore: `${s13bSub.riskScore}/100`,
    accountDecision: s13bSub.verdict,
    referralDecision: `${s13bSub.referralDecision} (reviewId=${s13bSub.reviewId}, ₹0 credited)`,
  });

  // --------------------------------------------------------------------------
  // SCENARIO 14: Multiple accounts sharing device signals WITHOUT referral relationship
  // --------------------------------------------------------------------------
  const noRefToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const noRefSignals = sampleDeviceSignals('shared-phone-no-referral');
  await prepareFreshUser(env, { id: 300018, firstName: 'NoRefAcctA' });
  const s14aSub = await runFullSubmitFlow(env, {
    userId: '300018',
    firstName: 'NoRefAcctA',
    signals: noRefSignals,
    clientNetwork: { ip: '103.90.10.5', countryCode: 'IN' },
    installAnchor: makeAnchor(noRefToken),
  });
  assert.equal(s14aSub.verdict, 'verified');
  assert.equal(s14aSub.referralDecision, 'no_referrer');

  await prepareFreshUser(env, { id: 300019, firstName: 'NoRefAcctB' }); // No referrer!
  const s14bSub = await runFullSubmitFlow(env, {
    userId: '300019',
    firstName: 'NoRefAcctB',
    signals: noRefSignals,
    clientNetwork: { ip: '103.90.10.5', countryCode: 'IN' },
    installAnchor: makeAnchor(noRefToken),
  });
  assert.equal(s14bSub.verdict, 'rejected');
  assert.equal(s14bSub.referralDecision, 'no_referrer');
  assert.equal(s14bSub.reviewId, null, 'No fake referral_reviews row when no referrer exists');
  assert.ok(s14bSub.matchedUserIds.includes('300018'));

  // Verify non-referral multi-account cluster IS surfaced in Admin Clusters query!
  const clustersPage = await getSuspiciousDeviceClustersPage(env, 1, 20);
  const noRefCluster = clustersPage.items.find(
    (c) => c.userIds.includes('300018') && c.userIds.includes('300019')
  );
  assert.ok(noRefCluster, 'Non-referral multi-account device cluster MUST be recorded & surfaced to admins');
  assert.equal(noRefCluster.hasReferralLink, false);
  logScenarioResult(14, 'Multiple accounts sharing device signals WITHOUT referral relationship', {
    signalsCollected: summarizeCollectedSignals(noRefSignals, makeAnchor(noRefToken)),
    crossAccountMatch: `MATCHED userIds=[${s14bSub.matchedUserIds.join(', ')}] via [${s14bSub.matchedSignalTypes.join(', ')}] (Admin cluster recorded, hasReferralLink=false)`,
    riskScore: `${s14bSub.riskScore}/100`,
    accountDecision: s14bSub.verdict,
    referralDecision: `${s14bSub.referralDecision} (no referral review created)`,
  });

  console.log('\n========================================================================');
  console.log('PART B: SECURITY, PROTOCOL, ADMIN & DATA INTEGRITY REGRESSION SUITE');
  console.log('========================================================================');

  // R1. Telegram initData HMAC-SHA256 & freshness
  const validInit = buildSignedTelegramInitData(env.BOT_TOKEN, { id: 400001, first_name: 'CryptoTest' });
  assert.equal((await verifyTelegramInitData(validInit, env.BOT_TOKEN)).ok, true);
  assert.equal((await verifyTelegramInitData(validInit.replace('CryptoTest', 'Evil'), env.BOT_TOKEN)).ok, false);
  const expiredInit = buildSignedTelegramInitData(
    env.BOT_TOKEN,
    { id: 400001, first_name: 'CryptoTest' },
    Math.floor(Date.now() / 1000) - 600
  );
  assert.equal((await verifyTelegramInitData(expiredInit, env.BOT_TOKEN)).expired, true);
  console.log('✓ R1. Telegram WebApp initData HMAC-SHA256 & expiry checks passed');

  // R2. Cloud Run <-> Worker signed install token parity + tampered rejection + signed verification token
  const crToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const workerCheckCr = await verifySignedInstallToken(crToken, env);
  assert.equal(workerCheckCr.valid, true, 'Worker must verify Cloud Run minted install token');
  const wkToken = await mintSignedInstallTokenWorker(env);
  const workerCheckWk = await verifySignedInstallToken(wkToken, env);
  assert.equal(workerCheckWk.valid, true);
  const tamperedToken = crToken.slice(0, -2) + (crToken.endsWith('aa') ? 'bb' : 'aa');
  assert.equal((await verifySignedInstallToken(tamperedToken, env)).valid, false);
  assert.equal((await verifyVerificationToken(env, s5aSub.verificationToken)).ok, true);
  console.log('✓ R2. Server-signed install token HMAC parity (Cloud Run <-> Worker) & tamper rejection passed');

  // R3. Unsigned bridge request rejected with 401
  const unauthBridge = await handleDeviceVerifySession(
    new Request('https://worker.example.com/api/internal/device-verify/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: validInit }),
    }),
    env
  );
  assert.equal(unauthBridge.status, 401);
  console.log('✓ R3. Unsigned Cloud Run -> Worker bridge call rejected (HTTP 401)');

  // R4. RFC 4291 IPv6 expansion & IPv4-mapped normalization
  assert.equal(extractIpSubnet('103.21.44.88'), '103.21.44.0/24');
  assert.equal(extractIpSubnet('::ffff:103.21.44.88'), '103.21.44.0/24');
  assert.equal(extractIpSubnet('2401:4900:1c2a::55'), '2401:4900:1c2a::/48');
  assert.equal(extractIpSubnet('2401:4900:1c2a:0000:0000:0000:0000:0055'), '2401:4900:1c2a::/48');
  assert.equal(extractIpSubnet('2001:db8::1'), '2001:0db8:0000::/48');
  console.log('✓ R4. RFC 4291 IPv6 /48 expansion & IPv4-mapped ::ffff: normalization passed');

  // R5. Unverified user strictly blocked from crediting referral
  await prepareFreshUser(env, { id: 400002, firstName: 'UnverifiedRef', referrerId: '100099' });
  const preRef = await processPendingReferral(env, '400002');
  assert.equal(preRef.credited, false);
  assert.equal(preRef.reason, 'device_unverified');
  console.log('✓ R5. Unverified user strictly blocked from crediting referral');

  // R6. Prior duplicate-device hold cannot be bypassed by incognito retry
  const retryToken = mintCloudRunInstallToken(env.MINIAPP_BRIDGE_SECRET);
  const retrySub = await runFullSubmitFlow(env, {
    userId: '300003',
    firstName: 'AcctB_DriftInstallTok',
    signals: sampleDeviceSignals('brand-new-incognito-retry-device'),
    clientNetwork: { ip: '182.70.11.22', countryCode: 'IN' },
    installAnchor: makeAnchor(retryToken),
  });
  assert.equal(retrySub.verdict, 'pending_review', 'Prior duplicate-device hold must persist across incognito retries');
  console.log('✓ R6. Prior duplicate-device hold cannot self-clear via incognito/new-device retry');

  // R7. Single-batch atomic admin approval & rejection + idempotency + rejected retry block
  const extRefBeforeApprove = (await getUser(env, '100099')).balancePaise;
  const approveRes = await resolveReferralReviewAtomic(env, {
    reviewId: s3aSub.reviewId,
    decision: 'approved',
    adminId: '8838351233',
    note: 'Verified genuine family device',
  });
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.referralCredited, true);
  assert.equal((await getUser(env, '100099')).balancePaise, extRefBeforeApprove + 300);
  const dupApprove = await resolveReferralReviewAtomic(env, {
    reviewId: s3aSub.reviewId,
    decision: 'approved',
    adminId: '8838351233',
  });
  assert.equal(dupApprove.ok, false, 'Double approval must be rejected idempotently');

  const rejectRes = await resolveReferralReviewAtomic(env, {
    reviewId: s3bSub.reviewId,
    decision: 'rejected',
    adminId: '8838351233',
    note: 'Confirmed multi-account abuse',
  });
  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.referralCredited, false);
  const blockedRetry = await handleDeviceVerifySession(
    buildSignedBridgeRequest(
      '/api/internal/device-verify/session',
      { initData: buildSignedTelegramInitData(env.BOT_TOKEN, { id: 300004, first_name: 'AcctC' }) },
      env.MINIAPP_BRIDGE_SECRET
    ),
    env
  );
  assert.equal(blockedRetry.status, 403);
  console.log('✓ R7. Atomic admin approval/rejection, double-approve guard & rejected-retry block passed');

  // R8. Immutable verification_audit_logs triggers + multi-signal stats
  let updateBlocked = false;
  try {
    sqlite.exec("UPDATE verification_audit_logs SET verdict = 'tampered'");
  } catch (err) {
    updateBlocked = String(err.message).includes('VERIFICATION_AUDIT_IMMUTABLE_UPDATE_FORBIDDEN');
  }
  assert.equal(updateBlocked, true);
  let deleteBlocked = false;
  try {
    sqlite.exec('DELETE FROM verification_audit_logs');
  } catch (err) {
    deleteBlocked = String(err.message).includes('VERIFICATION_AUDIT_IMMUTABLE_DELETE_FORBIDDEN');
  }
  assert.equal(deleteBlocked, true);
  const stats = await getDeviceVerificationStats(env);
  assert.ok(stats.duplicateDeviceClusters >= 3);
  const pendingPage = await getPendingReferralReviewsPage(env, 1, 10);
  assert.ok(pendingPage.total >= 1);
  console.log(`✓ R8. Immutable audit triggers & multi-signal cluster stats passed (clusters=${stats.duplicateDeviceClusters}, pendingReviews=${pendingPage.total})`);

  // R9. Worker entrypoint /health, /webhook, /api/internal/device-verify/observe
  const { default: worker } = await import('../src/index.js');
  const workerEnv = { ...env, WEBHOOK_SECRET: 'test-webhook-secret-xyz' };
  const healthRes = await worker.fetch(new Request('https://worker.example.com/health'), workerEnv, {});
  assert.equal(healthRes.status, 200);
  const unauthWebhook = await worker.fetch(
    new Request('https://worker.example.com/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 90001 }),
    }),
    workerEnv,
    {}
  );
  assert.equal(unauthWebhook.status, 401);
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
          from: { id: 100001, first_name: 'LegacyGrandfathered', username: 'legacy_gf' },
          text: '/start',
        },
      }),
    }),
    workerEnv,
    {}
  );
  assert.equal(authWebhook.status, 200);
  const observeRouteRes = await worker.fetch(
    buildSignedBridgeRequest(
      '/api/internal/device-verify/observe',
      {
        initData: buildSignedTelegramInitData(env.BOT_TOKEN, {
          id: 100001,
          first_name: 'LegacyGrandfathered',
        }),
        signals: phone1Signals,
        clientNetwork: { ip: '103.21.44.10', countryCode: 'IN' },
        installAnchor: makeAnchor(phone1Token),
      },
      env.MINIAPP_BRIDGE_SECRET
    ),
    workerEnv,
    {}
  );
  assert.equal(observeRouteRes.status, 200);
  console.log('✓ R9. Cloudflare Worker /health, /webhook & /api/internal/device-verify/observe routes passed');

  // R10. Secretary Mode strictly inactive & hard-blocks public @pnarewards
  const { emitSecretaryLog, parseSecretaryChannelInput, verifySecretaryChannel } = await import(
    '../src/services/secretary.js'
  );
  assert.equal(parseSecretaryChannelInput('@pnarewards', env).ok, false);
  assert.equal((await verifySecretaryChannel({ ...env, PNA_LOG_CHANNEL_ID: '@pnarewards' })).ok, false);
  const inactiveEmit = await emitSecretaryLog(
    { ...env, PNA_LOG_CHANNEL_ID: '@pnarewards' },
    { eventType: 'TEST_PRIVATE', dedupKey: 'test_sec_block_1', text: 'Private audit test' }
  );
  assert.equal(inactiveEmit.ok, false);
  assert.equal(inactiveEmit.skipped, true);
  console.log('✓ R10. Secretary Mode stays inactive & hard-blocks public @pnarewards channel');

  // R11. Full Pre- vs Post-Migration 0003 Data Integrity Snapshot (100% additive check)
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
  integrityDb.exec(sql0002);

  const snapshotSql = `
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COALESCE(SUM(balance_paise), 0) FROM users) AS total_balance_paise,
      (SELECT COALESCE(SUM(referral_earnings_paise), 0) FROM users) AS total_referral_earnings_paise,
      (SELECT COUNT(*) FROM users WHERE device_verification_status = 'grandfathered') AS grandfathered_users,
      (SELECT COUNT(*) FROM referrals) AS total_referral_records,
      (SELECT COUNT(*) FROM withdrawals) AS total_withdrawals,
      (SELECT COUNT(*) FROM vouchers) AS total_vouchers,
      (SELECT COUNT(*) FROM tasks) AS total_tasks,
      (SELECT COUNT(*) FROM user_tasks) AS total_user_tasks
  `;
  const before0003 = integrityDb.prepare(snapshotSql).get();
  integrityDb.exec(sql0003);
  const after0003 = integrityDb.prepare(snapshotSql).get();
  assert.deepEqual(after0003, before0003, 'Migration 0003 MUST preserve every existing row and balance identically');
  const meta0003 = integrityDb.prepare(`SELECT version, name FROM migration_metadata WHERE version = '0003'`).get();
  assert.equal(meta0003.version, '0003');
  const sigLinksExists = integrityDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_signal_links'`)
    .get();
  assert.equal(sigLinksExists.name, 'device_signal_links');
  console.log('✓ R11. Pre- vs post-migration 0003 data integrity snapshot matched 100% identically');

  console.log('\nALL 14 REQUIRED SCENARIOS + 11 REGRESSION & INTEGRITY CHECKS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
