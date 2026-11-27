// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Mini App Device Verification & Anti-Abuse Engine
// ============================================================================
// Runs exclusively on Cloudflare Workers with direct access to `env.DB` (D1)
// and `env.BOT_TOKEN`.
//
// Security Properties:
//  1. Cloud Run -> Cloudflare Worker calls authenticated via HMAC-SHA256
//     (`X-PnA-Timestamp`, `X-PnA-Nonce`, `X-PnA-Signature`) with constant-time
//     verification and ±60s skew window.
//  2. Telegram WebApp `initData` cryptographically validated via Web Crypto
//     HMAC-SHA256("WebAppData", BOT_TOKEN) per Telegram Mini Apps specification.
//  3. Freshness (`auth_date` <= 5 min) + single-use challenge nonce + UNIQUE
//     `init_data_hash` replay protection.
//  4. Probabilistic browser/WebView fingerprint hashing (strict + fuzzy).
//     NEVER claims hardware IMEI or Android ID access.
//  5. Balanced risk scoring: shared IP alone contributes +15 (NEVER auto-rejects
//     families, hostels, or shared Wi-Fi). Duplicate device fingerprints flag
//     `pending_review` for manual admin inspection.
//  6. Issues short-lived HMAC-signed verification token (`pna_v1.<payload>.<sig>`).
// ============================================================================

import { DIVIDER } from '../animations.js';
import {
  BOT_BRAND,
  DEVICE_RISK_THRESHOLDS,
  DEVICE_VERIFICATION_STATUS,
  escapeHtml,
  generateId,
  getMiniAppAllowedOrigins,
  isDeviceVerificationEnabled,
} from '../config.js';
import {
  consumeVerificationChallenge,
  countRecentDistinctUsersByIp,
  countRecentVerificationAttemptsByUser,
  createOrUpdateUserFromTelegram,
  createVerificationChallenge,
  findOtherUsersByFingerprint,
  findOtherUsersByIpSubnet,
  getDeviceVerificationByInitDataHash,
  getLatestUserDeviceVerification,
  getSettings,
  getUser,
  getUserReferralReview,
  isAdmin,
  recordDeviceVerificationAtomic,
  updateUserForceJoinVerified,
} from '../database.js';
import { mainMenuKeyboard } from '../keyboards.js';
import { sendMessage } from '../telegram.js';
import { verifyUserForceJoin } from './membership.js';
import { processPendingReferral } from './referral-service.js';
import { logSuspiciousDeviceEvent } from './secretary.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Known hosting / VPN / cloud provider ASN keywords (heuristic partial signal only)
const DATACENTER_ASN_KEYWORDS = [
  'amazon',
  'aws',
  'google cloud',
  'microsoft',
  'azure',
  'digitalocean',
  'linode',
  'akamai connected',
  'vultr',
  'hetzner',
  'ovh',
  'contabo',
  'oracle cloud',
  'choopa',
  'm247',
  'datacamp',
  'packethub',
  'tzulo',
  'nordvpn',
  'expressvpn',
  'surfshark',
  'proton',
  'mullvad',
  'private internet access',
  'cloudflare warp',
  'tor exit',
];

// ----------------------------------------------------------------------------
// Cryptographic Primitives (Web Crypto API — Cloudflare Workers native)
// ----------------------------------------------------------------------------

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex || '').trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncodeBytes(encoder.encode(JSON.stringify(obj)));
}

function base64UrlDecodeToBytes(b64url) {
  const padded = String(b64url || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(b64url || '').length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function timingSafeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Bytes(keyMaterial, message) {
  const keyBytes = typeof keyMaterial === 'string' ? encoder.encode(keyMaterial) : keyMaterial;
  const msgBytes = typeof message === 'string' ? encoder.encode(message) : message;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgBytes);
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(keyMaterial, message) {
  return bytesToHex(await hmacSha256Bytes(keyMaterial, message));
}

function getBridgeSecret(env) {
  return env?.MINIAPP_BRIDGE_SECRET ? String(env.MINIAPP_BRIDGE_SECRET).trim() : '';
}

async function getVerificationSigningKey(env) {
  const explicit = env?.VERIFICATION_SIGNING_SECRET
    ? String(env.VERIFICATION_SIGNING_SECRET).trim()
    : '';
  if (explicit) return encoder.encode(explicit);
  const bridge = getBridgeSecret(env);
  if (!bridge) {
    throw new Error('MINIAPP_BRIDGE_SECRET is not configured.');
  }
  return hmacSha256Bytes(bridge, 'pna-rewards:verification-token-key:v1');
}

async function getFingerprintSalt(env) {
  const bridge = getBridgeSecret(env);
  if (bridge) {
    return hmacSha256Hex(bridge, 'pna-rewards:fingerprint-salt:v1');
  }
  return sha256Hex('pna-rewards:local-dev-salt');
}

// ----------------------------------------------------------------------------
// 1. Cloud Run <-> Cloudflare Worker HMAC Bridge Authentication
// ----------------------------------------------------------------------------

export async function verifyBridgeSignature(request, rawBody, env) {
  const secret = getBridgeSecret(env);
  if (!secret || secret.length < 16) {
    return { ok: false, status: 503, error: 'Device verification bridge secret is not configured.' };
  }

  const timestampHeader = request.headers.get('X-PnA-Timestamp') || '';
  const nonceHeader = request.headers.get('X-PnA-Nonce') || '';
  const sigHeader = request.headers.get('X-PnA-Signature') || '';

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || !nonceHeader || nonceHeader.length < 8 || !sigHeader) {
    return { ok: false, status: 401, error: 'Missing bridge authentication headers.' };
  }

  const skew = Math.abs(Date.now() - ts);
  if (skew > DEVICE_RISK_THRESHOLDS.BRIDGE_MAX_SKEW_MS) {
    return { ok: false, status: 401, error: 'Bridge request timestamp expired.' };
  }

  const url = new URL(request.url);
  const bodyHash = await sha256Hex(rawBody || '');
  const canonical = `${request.method.toUpperCase()}\n${url.pathname}\n${timestampHeader}\n${nonceHeader}\n${bodyHash}`;
  const expectedBytes = await hmacSha256Bytes(secret, canonical);
  const providedBytes = hexToBytes(sigHeader);

  if (!providedBytes || !timingSafeEqualBytes(expectedBytes, providedBytes)) {
    return { ok: false, status: 401, error: 'Invalid bridge signature.' };
  }

  // Optional Origin allowlist check when forwarded by Cloud Run
  const forwardedOrigin = request.headers.get('X-PnA-Origin') || '';
  const allowedOrigins = getMiniAppAllowedOrigins(env);
  if (forwardedOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(forwardedOrigin)) {
    return { ok: false, status: 403, error: 'Origin not allowed.' };
  }

  return { ok: true };
}

// ----------------------------------------------------------------------------
// 2. Cryptographic Telegram WebApp `initData` Validation
// ----------------------------------------------------------------------------

/**
 * Validate Telegram Mini App `initData` strictly according to Telegram's official
 * WebApp HMAC-SHA256 specification:
 *   secret_key = HMAC_SHA256("WebAppData", BOT_TOKEN)
 *   expected_hash = HMAC_SHA256(data_check_string, secret_key)
 */
export async function verifyTelegramInitData(
  initDataRaw,
  botToken,
  maxAgeSeconds = DEVICE_RISK_THRESHOLDS.INIT_DATA_MAX_AGE_SECONDS,
  nowMs = Date.now()
) {
  const raw = String(initDataRaw || '').trim();
  const token = String(botToken || '').trim();
  if (!raw || raw.length > 8192) {
    return { ok: false, error: 'Missing or invalid Telegram WebApp initData.' };
  }
  if (!token) {
    return { ok: false, error: 'Bot token is not configured on backend.' };
  }

  const params = new URLSearchParams(raw);
  const providedHashHex = params.get('hash');
  if (!providedHashHex) {
    return { ok: false, error: 'Telegram initData signature hash is missing.' };
  }
  const providedHashBytes = hexToBytes(providedHashHex);
  if (!providedHashBytes || providedHashBytes.length !== 32) {
    return { ok: false, error: 'Telegram initData signature format is invalid.' };
  }

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = await hmacSha256Bytes('WebAppData', token);
  const expectedHashBytes = await hmacSha256Bytes(secretKey, dataCheckString);
  if (!timingSafeEqualBytes(expectedHashBytes, providedHashBytes)) {
    return { ok: false, error: 'Telegram WebApp initData cryptographic verification failed.' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, error: 'Invalid Telegram auth_date.' };
  }

  const nowSec = Math.floor(nowMs / 1000);
  const ageSec = nowSec - authDate;
  if (ageSec > maxAgeSeconds || ageSec < -60) {
    return {
      ok: false,
      expired: true,
      error: 'Telegram verification session expired. Please close and reopen the Mini App from the bot.',
    };
  }

  const userJson = params.get('user');
  if (!userJson) {
    return { ok: false, error: 'Telegram user identity missing in initData.' };
  }

  let tgUser;
  try {
    tgUser = JSON.parse(userJson);
  } catch {
    return { ok: false, error: 'Malformed Telegram user payload.' };
  }

  if (!tgUser || !tgUser.id || !/^\d{5,20}$/.test(String(tgUser.id))) {
    return { ok: false, error: 'Invalid Telegram user ID.' };
  }

  return {
    ok: true,
    user: {
      id: String(tgUser.id),
      first_name: String(tgUser.first_name || ''),
      last_name: String(tgUser.last_name || ''),
      username: String(tgUser.username || ''),
      language_code: String(tgUser.language_code || ''),
      is_premium: Boolean(tgUser.is_premium),
    },
    authDate,
    queryId: params.get('query_id') || '',
    initDataHash: await sha256Hex(raw),
  };
}

// ----------------------------------------------------------------------------
// 3. Signed Verification Result Token (`pna_v1.<payload>.<sig>`)
// ----------------------------------------------------------------------------

export async function signVerificationToken(env, payloadObj) {
  const key = await getVerificationSigningKey(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    v: 1,
    iss: 'pna-rewards-worker',
    iat: nowSec,
    exp: nowSec + DEVICE_RISK_THRESHOLDS.TOKEN_TTL_SECONDS,
    ...payloadObj,
  };
  const encodedPayload = base64UrlEncodeJson(fullPayload);
  const sigBytes = await hmacSha256Bytes(key, `pna_v1.${encodedPayload}`);
  return `pna_v1.${encodedPayload}.${base64UrlEncodeBytes(sigBytes)}`;
}

export async function verifyVerificationToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'pna_v1') {
    return { ok: false, error: 'Malformed token.' };
  }
  const key = await getVerificationSigningKey(env);
  const expectedSig = await hmacSha256Bytes(key, `pna_v1.${parts[1]}`);
  let providedSig;
  try {
    providedSig = base64UrlDecodeToBytes(parts[2]);
  } catch {
    return { ok: false, error: 'Invalid token encoding.' };
  }
  if (!timingSafeEqualBytes(expectedSig, providedSig)) {
    return { ok: false, error: 'Invalid token signature.' };
  }
  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecodeToBytes(parts[1])));
  } catch {
    return { ok: false, error: 'Malformed token payload.' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload?.exp || payload.exp < nowSec) {
    return { ok: false, error: 'Verification token expired.' };
  }
  return { ok: true, payload };
}

// ----------------------------------------------------------------------------
// 4. Privacy-Conscious Fingerprint Normalization & IP Subnet Extraction
// ----------------------------------------------------------------------------

function sanitizeStr(val, maxLen = 128) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

function sanitizeNum(val, min = 0, max = 100000) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

export function extractIpSubnet(rawIp) {
  const ip = sanitizeStr(rawIp, 64);
  if (!ip) return '';
  // IPv4 -> /24 subnet
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  // IPv6 -> /48 prefix
  if (ip.includes(':')) {
    const parts = ip.split(':').slice(0, 3);
    return `${parts.join(':')}::/48`;
  }
  return '';
}

function isDatacenterOrVpnAsn(asnOrg, proxyHint = false) {
  if (proxyHint) return { proxyVpnFlag: true, datacenterFlag: false };
  const lower = sanitizeStr(asnOrg, 160).toLowerCase();
  if (!lower) return { proxyVpnFlag: false, datacenterFlag: false };
  for (const kw of DATACENTER_ASN_KEYWORDS) {
    if (lower.includes(kw)) {
      const isVpn = kw.includes('vpn') || kw.includes('tor') || kw.includes('mullvad') || kw.includes('proton') || kw.includes('warp');
      return { proxyVpnFlag: isVpn, datacenterFlag: !isVpn };
    }
  }
  return { proxyVpnFlag: false, datacenterFlag: false };
}

export async function normalizeAndHashSignals(rawSignals, clientNetwork, env) {
  const s = rawSignals && typeof rawSignals === 'object' ? rawSignals : {};
  const salt = await getFingerprintSalt(env);

  const normalized = {
    canvasHash: sanitizeStr(s.canvasHash, 80),
    webglVendor: sanitizeStr(s.webglVendor, 100),
    webglRenderer: sanitizeStr(s.webglRenderer, 140),
    webglParamsHash: sanitizeStr(s.webglParamsHash, 80),
    audioHash: sanitizeStr(s.audioHash, 80),
    fontMetricsHash: sanitizeStr(s.fontMetricsHash, 80),
    screenWidth: sanitizeNum(s.screenWidth, 0, 16384),
    screenHeight: sanitizeNum(s.screenHeight, 0, 16384),
    colorDepth: sanitizeNum(s.colorDepth, 0, 64),
    devicePixelRatio: sanitizeNum(s.devicePixelRatio, 0, 16),
    timezone: sanitizeStr(s.timezone, 64),
    timezoneOffset: sanitizeNum(s.timezoneOffset, -900, 900),
    language: sanitizeStr(s.language, 32),
    languagesCount: sanitizeNum(s.languagesCount, 0, 32),
    hardwareConcurrency: sanitizeNum(s.hardwareConcurrency, 0, 256),
    deviceMemory: sanitizeNum(s.deviceMemory, 0, 512),
    maxTouchPoints: sanitizeNum(s.maxTouchPoints, 0, 64),
    platform: sanitizeStr(s.platform, 64),
    telegramPlatform: sanitizeStr(s.telegramPlatform, 32),
    userAgentFamily: sanitizeStr(s.userAgentFamily, 120),
    webdriver: Boolean(s.webdriver),
    automationSignals: Array.isArray(s.automationSignals)
      ? s.automationSignals.slice(0, 10).map((x) => sanitizeStr(x, 40))
      : [],
    hasCanvas: Boolean(s.canvasHash),
    hasWebgl: Boolean(s.webglRenderer || s.webglParamsHash),
  };

  // Strict fingerprint: combines full browser + rendering + hardware characteristics
  const strictCanonical = [
    'strict:v1',
    normalized.canvasHash,
    normalized.webglVendor,
    normalized.webglRenderer,
    normalized.webglParamsHash,
    normalized.audioHash,
    normalized.fontMetricsHash,
    `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}:${normalized.colorDepth}`,
    `${normalized.timezone}:${normalized.timezoneOffset}`,
    `${normalized.hardwareConcurrency}:${normalized.deviceMemory}:${normalized.maxTouchPoints}`,
    normalized.platform,
    normalized.telegramPlatform,
  ].join('|');

  // Fuzzy fingerprint: stable hardware/GPU/screen/timezone core (tolerates minor WebView updates)
  const fuzzyCanonical = [
    'fuzzy:v1',
    normalized.webglRenderer || normalized.webglVendor,
    `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}`,
    `${normalized.hardwareConcurrency}:${normalized.deviceMemory}:${normalized.maxTouchPoints}`,
    normalized.timezone,
    normalized.platform,
  ].join('|');

  const clientIp = sanitizeStr(clientNetwork?.ip, 64);
  const subnet = extractIpSubnet(clientIp);

  const [strictFpHash, fuzzyFpHash, ipHash, ipSubnetHash] = await Promise.all([
    sha256Hex(`${salt}|${strictCanonical}`),
    sha256Hex(`${salt}|${fuzzyCanonical}`),
    clientIp ? sha256Hex(`${salt}|ip|${clientIp}`) : Promise.resolve(''),
    subnet ? sha256Hex(`${salt}|subnet|${subnet}`) : Promise.resolve(''),
  ]);

  // Privacy-conscious signal summary (only hashes & non-PII technical dimensions)
  const signalHashes = {
    canvas: normalized.canvasHash ? normalized.canvasHash.slice(0, 16) : '',
    webgl: normalized.webglParamsHash ? normalized.webglParamsHash.slice(0, 16) : '',
    audio: normalized.audioHash ? normalized.audioHash.slice(0, 16) : '',
    fonts: normalized.fontMetricsHash ? normalized.fontMetricsHash.slice(0, 16) : '',
    screen: `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}`,
    tz: normalized.timezone,
    tgPlatform: normalized.telegramPlatform,
    cores: normalized.hardwareConcurrency,
    touch: normalized.maxTouchPoints,
  };

  return {
    normalized,
    strictFpHash,
    fuzzyFpHash,
    ipHash,
    ipSubnetHash,
    signalHashes,
  };
}

// ----------------------------------------------------------------------------
// 5. Balanced Risk Scoring Engine (Shared IP Alone NEVER Auto-Rejects)
// ----------------------------------------------------------------------------

export async function evaluateDeviceRisk(
  env,
  { userId, normalized, strictFpHash, fuzzyFpHash, ipHash, ipSubnetHash, clientNetwork, now = Date.now() }
) {
  const reasons = [];
  let score = 0;

  const tenMinAgo = now - 10 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const [strictMatches, fuzzyMatches, subnetMatches, recentIpAccounts, existingReview] =
    await Promise.all([
      findOtherUsersByFingerprint(env, 'strict', strictFpHash, userId),
      findOtherUsersByFingerprint(env, 'fuzzy', fuzzyFpHash, userId),
      findOtherUsersByIpSubnet(env, ipSubnetHash, userId, sevenDaysAgo),
      countRecentDistinctUsersByIp(env, ipHash, tenMinAgo, userId),
      getUserReferralReview(env, userId),
    ]);

  const matchedUserSet = new Set();

  // Preserve prior duplicate-device hold so a caught multi-account user cannot self-clear via incognito retry
  if (
    existingReview &&
    existingReview.status === 'pending' &&
    Array.isArray(existingReview.matchedUserIds) &&
    existingReview.matchedUserIds.length > 0
  ) {
    score += 50;
    for (const prevId of existingReview.matchedUserIds) matchedUserSet.add(String(prevId));
    reasons.push({
      code: 'PRIOR_DUPLICATE_DEVICE_HOLD',
      weight: 50,
      detail: 'Account has an open duplicate-device referral review awaiting admin decision',
    });
  }

  // 1. Strict device fingerprint match across multiple Telegram accounts (+70 -> pending_review)
  if (strictMatches.length > 0) {
    score += 70;
    for (const m of strictMatches) matchedUserSet.add(m.userId);
    reasons.push({
      code: 'DUPLICATE_STRICT_DEVICE',
      weight: 70,
      detail: `Matches ${strictMatches.length} other Telegram account(s) on strict browser/device fingerprint`,
    });
  } else if (fuzzyMatches.length > 0) {
    // 2. Fuzzy match: high risk ONLY if combined with same IP subnet; otherwise informational (+20)
    const subnetSet = new Set(subnetMatches);
    const fuzzyOnSameSubnet = fuzzyMatches.filter((m) => subnetSet.has(m.userId));
    if (fuzzyOnSameSubnet.length > 0) {
      score += 55;
      for (const m of fuzzyOnSameSubnet) matchedUserSet.add(m.userId);
      reasons.push({
        code: 'DUPLICATE_FUZZY_DEVICE_SAME_SUBNET',
        weight: 55,
        detail: `Hardware/WebView profile matches ${fuzzyOnSameSubnet.length} account(s) on the same network subnet`,
      });
    } else {
      score += 20;
      reasons.push({
        code: 'SIMILAR_DEVICE_MODEL',
        weight: 20,
        detail: 'Similar hardware/screen profile seen on another network (common device model — informational only)',
      });
    }
  }

  // 3. Shared IP / subnet ALONE contributes only +15 (NEVER auto-rejects families/hostels/Wi-Fi)
  if (subnetMatches.length > 0 && strictMatches.length === 0) {
    score += 15;
    reasons.push({
      code: 'SHARED_NETWORK_SUBNET',
      weight: 15,
      detail: `Shared network with ${subnetMatches.length} other account(s) (partial signal only — does not auto-reject)`,
    });
  }

  // 4. Rapid multi-account burst velocity from exact same IP within 10 minutes (+20)
  if (recentIpAccounts >= 2) {
    score += 20;
    reasons.push({
      code: 'HIGH_IP_VELOCITY',
      weight: 20,
      detail: `${recentIpAccounts} other account(s) verified from this IP in the last 10 minutes`,
    });
  }

  // 5. VPN / Proxy / Datacenter ASN heuristic (+25 partial signal only)
  const asnOrg = sanitizeStr(clientNetwork?.asnOrg, 160);
  const netFlags = isDatacenterOrVpnAsn(asnOrg, Boolean(clientNetwork?.proxyHint));
  if (netFlags.proxyVpnFlag || netFlags.datacenterFlag) {
    score += 25;
    reasons.push({
      code: netFlags.proxyVpnFlag ? 'VPN_OR_PROXY_DETECTED' : 'DATACENTER_ASN_DETECTED',
      weight: 25,
      detail: asnOrg
        ? `Network provider flagged as VPN/datacenter (${asnOrg})`
        : 'Proxy or VPN network header detected',
    });
  }

  // 6. Browser automation / tampering anomalies (+40)
  const automationDetected =
    normalized.webdriver ||
    (Array.isArray(normalized.automationSignals) && normalized.automationSignals.length > 0);
  if (automationDetected) {
    score += 40;
    reasons.push({
      code: 'AUTOMATION_SIGNALS',
      weight: 40,
      detail: 'Automated browser/WebDriver or tampered WebView signals detected',
    });
  }

  // 7. Missing basic rendering signals (possible stripped headless environment) (+15)
  if (!normalized.hasCanvas && !normalized.hasWebgl) {
    score += 15;
    reasons.push({
      code: 'MISSING_RENDER_SIGNALS',
      weight: 15,
      detail: 'Canvas and WebGL rendering characteristics unavailable',
    });
  }

  const finalScore = Math.max(0, Math.min(100, score));
  let verdict = DEVICE_VERIFICATION_STATUS.VERIFIED;
  if (finalScore >= DEVICE_RISK_THRESHOLDS.REJECTED) {
    verdict = DEVICE_VERIFICATION_STATUS.REJECTED;
  } else if (finalScore >= DEVICE_RISK_THRESHOLDS.PENDING_REVIEW) {
    verdict = DEVICE_VERIFICATION_STATUS.PENDING_REVIEW;
  }

  return {
    riskScore: finalScore,
    verdict,
    reasons,
    matchedUserIds: Array.from(matchedUserSet),
    proxyVpnFlag: netFlags.proxyVpnFlag,
    datacenterFlag: netFlags.datacenterFlag,
  };
}

// ----------------------------------------------------------------------------
// 6. HTTP Route Handlers Mounted on Cloudflare Worker (`/api/internal/device-verify/*`)
// ----------------------------------------------------------------------------

function workerJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function extractClientNetwork(bodyNetwork, request) {
  const net = bodyNetwork && typeof bodyNetwork === 'object' ? bodyNetwork : {};
  const cf = request?.cf && typeof request.cf === 'object' ? request.cf : {};
  return {
    ip: sanitizeStr(net.ip || request.headers.get('CF-Connecting-IP') || '', 64),
    countryCode: sanitizeStr(net.countryCode || cf.country || '', 16),
    asn: sanitizeStr(net.asn || (cf.asn ? String(cf.asn) : ''), 32),
    asnOrg: sanitizeStr(net.asnOrg || cf.asOrganization || '', 160),
    proxyHint: Boolean(net.proxyHint),
  };
}

/**
 * POST /api/internal/device-verify/session
 * Validates Telegram WebApp `initData`, confirms user force-join status,
 * and issues a single-use short-lived challenge nonce stored in D1.
 */
export async function handleDeviceVerifySession(request, env) {
  const rawBody = await request.text();
  const auth = await verifyBridgeSignature(request, rawBody, env);
  if (!auth.ok) {
    return workerJson({ ok: false, error: auth.error }, auth.status || 401);
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return workerJson({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const initCheck = await verifyTelegramInitData(body.initData, env?.BOT_TOKEN);
  if (!initCheck.ok) {
    return workerJson(
      { ok: false, expired: Boolean(initCheck.expired), error: initCheck.error },
      401
    );
  }

  const tgUser = initCheck.user;
  const { user } = await createOrUpdateUserFromTelegram(env, tgUser);
  const adminUser = await isAdmin(user.id, env);

  if (user.status === 'banned' && !adminUser) {
    return workerJson(
      { ok: false, code: 'USER_BANNED', error: 'Your account is currently restricted.' },
      403
    );
  }

  const settings = await getSettings(env);
  if (settings.maintenanceMode && !adminUser) {
    return workerJson(
      { ok: false, code: 'MAINTENANCE', error: 'Bot is currently under scheduled maintenance.' },
      503
    );
  }

  // Ensure force-join is satisfied BEFORE allowing device verification
  let forceJoined = Boolean(user.forceJoinVerified);
  if (!forceJoined && !adminUser) {
    const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
    if (fj.joinedAll) {
      forceJoined = true;
      await updateUserForceJoinVerified(env, user.id, true);
    }
  }

  if (!forceJoined && !adminUser) {
    return workerJson(
      {
        ok: false,
        code: 'FORCE_JOIN_REQUIRED',
        error: 'Please join all required channels and verify membership in the bot first.',
      },
      403
    );
  }

  if (user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.REJECTED && !adminUser) {
    return workerJson(
      {
        ok: false,
        code: 'VERIFICATION_REJECTED',
        error: 'Device verification was held for administrator review. Please contact Support with your Telegram ID.',
      },
      403
    );
  }

  const alreadyVerified =
    adminUser ||
    !isDeviceVerificationEnabled(env) ||
    user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.VERIFIED ||
    user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.GRANDFATHERED;

  if (alreadyVerified) {
    const token = await signVerificationToken(env, {
      jti: generateId('VTKN'),
      uid: user.id,
      status: user.deviceVerificationStatus || 'verified',
    });
    return workerJson({
      ok: true,
      alreadyVerified: true,
      status: user.deviceVerificationStatus,
      verificationToken: token,
      user: {
        id: user.id,
        firstName: user.firstName,
        username: user.username,
      },
    });
  }

  // Generate single-use challenge nonce
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  const challengeNonce = bytesToHex(randomBytes);
  const nonceHash = await sha256Hex(challengeNonce);
  const clientNet = extractClientNetwork(body.clientNetwork, request);
  const salt = await getFingerprintSalt(env);
  const ipHash = clientNet.ip ? await sha256Hex(`${salt}|ip|${clientNet.ip}`) : '';
  const now = Date.now();
  const expiresAt = now + DEVICE_RISK_THRESHOLDS.CHALLENGE_TTL_MS;

  await createVerificationChallenge(env, {
    nonceHash,
    userId: user.id,
    ipHash,
    expiresAt,
    createdAt: now,
  });

  const existingReview = await getUserReferralReview(env, user.id);

  return workerJson({
    ok: true,
    alreadyVerified: false,
    status: user.deviceVerificationStatus,
    challengeNonce,
    expiresAt,
    reviewId: existingReview?.status === 'pending' ? existingReview.id : null,
    user: {
      id: user.id,
      firstName: user.firstName,
      username: user.username,
    },
  });
}

/**
 * POST /api/internal/device-verify/submit
 * Validates Telegram `initData`, consumes single-use challenge nonce, computes
 * probabilistic fingerprints, evaluates risk, persists atomically in D1, issues
 * signed server-side verification token, and on clean pass unlocks the bot menu
 * and runs pending referral crediting.
 */
export async function handleDeviceVerifySubmit(request, env) {
  const rawBody = await request.text();
  const auth = await verifyBridgeSignature(request, rawBody, env);
  if (!auth.ok) {
    return workerJson({ ok: false, error: auth.error }, auth.status || 401);
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return workerJson({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const initCheck = await verifyTelegramInitData(body.initData, env?.BOT_TOKEN);
  if (!initCheck.ok) {
    return workerJson(
      { ok: false, expired: Boolean(initCheck.expired), error: initCheck.error },
      401
    );
  }

  const tgUser = initCheck.user;
  const userId = tgUser.id;
  const { user } = await createOrUpdateUserFromTelegram(env, tgUser);
  const adminUser = await isAdmin(userId, env);

  if (user.status === 'banned' && !adminUser) {
    return workerJson(
      { ok: false, code: 'USER_BANNED', error: 'Your account is currently restricted.' },
      403
    );
  }

  // Enforce force-join before device verification
  let forceJoined = Boolean(user.forceJoinVerified);
  if (!forceJoined && !adminUser) {
    const fj = await verifyUserForceJoin(env, userId, { bypassForAdmin: true });
    if (fj.joinedAll) {
      forceJoined = true;
      await updateUserForceJoinVerified(env, userId, true);
    }
  }
  if (!forceJoined && !adminUser) {
    return workerJson(
      {
        ok: false,
        code: 'FORCE_JOIN_REQUIRED',
        error: 'Channel membership must be verified in the bot before device verification.',
      },
      403
    );
  }

  // Short-circuit if user is already verified or grandfathered
  if (
    user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.VERIFIED ||
    user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.GRANDFATHERED
  ) {
    const token = await signVerificationToken(env, {
      jti: generateId('VTKN'),
      uid: userId,
      status: user.deviceVerificationStatus,
    });
    return workerJson({
      ok: true,
      alreadyVerified: true,
      verdict: user.deviceVerificationStatus,
      verificationToken: token,
      message: 'Your device is already verified.',
    });
  }

  if (user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.REJECTED && !adminUser) {
    return workerJson(
      {
        ok: false,
        code: 'VERIFICATION_REJECTED',
        error: 'This verification has been held for administrator review and cannot be retried automatically.',
      },
      403
    );
  }

  // Consume single-use challenge nonce (replay protection)
  const challengeNonce = sanitizeStr(body.challengeNonce, 128);
  if (!challengeNonce) {
    return workerJson(
      { ok: false, code: 'MISSING_NONCE', error: 'Missing verification challenge nonce. Please retry.' },
      400
    );
  }

  const now = Date.now();
  const nonceHash = await sha256Hex(challengeNonce);
  const consumed = await consumeVerificationChallenge(env, nonceHash, userId, now);
  if (!consumed) {
    return workerJson(
      {
        ok: false,
        code: 'INVALID_NONCE',
        error: 'Verification challenge expired or already used. Please tap Retry.',
      },
      409
    );
  }

  // Per-user attempt rate limit (max 6 attempts per 15 minutes)
  const recentAttempts = await countRecentVerificationAttemptsByUser(env, userId, now - 15 * 60 * 1000);
  if (recentAttempts >= 6) {
    return workerJson(
      {
        ok: false,
        code: 'RATE_LIMITED',
        error: 'Too many verification attempts. Please wait a few minutes before retrying.',
      },
      429
    );
  }

  // Replay guard on initDataHash
  const existingInit = await getDeviceVerificationByInitDataHash(env, initCheck.initDataHash);
  if (existingInit) {
    return workerJson(
      {
        ok: false,
        code: 'REPLAY_DETECTED',
        error: 'This Telegram session was already submitted. Close and reopen the Mini App from the bot to retry.',
      },
      409
    );
  }

  const clientNetwork = extractClientNetwork(body.clientNetwork, request);
  const fpData = await normalizeAndHashSignals(body.signals, clientNetwork, env);

  const risk = await evaluateDeviceRisk(env, {
    userId,
    normalized: fpData.normalized,
    strictFpHash: fpData.strictFpHash,
    fuzzyFpHash: fpData.fuzzyFpHash,
    ipHash: fpData.ipHash,
    ipSubnetHash: fpData.ipSubnetHash,
    clientNetwork,
    now,
  });

  const verificationId = generateId('DVER');
  const tokenJti = risk.verdict === DEVICE_VERIFICATION_STATUS.VERIFIED ? generateId('VTKN') : null;

  const saveRes = await recordDeviceVerificationAtomic(env, {
    verificationId,
    userId,
    telegramAuthDate: initCheck.authDate,
    initDataHash: initCheck.initDataHash,
    strictFpHash: fpData.strictFpHash,
    fuzzyFpHash: fpData.fuzzyFpHash,
    signalHashes: fpData.signalHashes,
    ipHash: fpData.ipHash,
    ipSubnetHash: fpData.ipSubnetHash,
    countryCode: clientNetwork.countryCode,
    asn: clientNetwork.asn,
    asnOrg: clientNetwork.asnOrg,
    proxyVpnFlag: risk.proxyVpnFlag,
    datacenterFlag: risk.datacenterFlag,
    riskScore: risk.riskScore,
    riskReasons: risk.reasons,
    verdict: risk.verdict,
    verifiedTokenJti: tokenJti,
    pendingReferrerId: user.pendingReferrerId || null,
    matchedUserIds: risk.matchedUserIds,
    now,
  });

  if (!saveRes.ok) {
    return workerJson(
      { ok: false, code: saveRes.replay ? 'REPLAY_DETECTED' : 'SAVE_FAILED', error: saveRes.error },
      saveRes.replay ? 409 : 500
    );
  }

  const verificationToken = await signVerificationToken(env, {
    jti: tokenJti || generateId('VTKN'),
    uid: userId,
    vid: verificationId,
    verdict: risk.verdict,
    score: risk.riskScore,
  });

  // Clean VERIFIED verdict -> credit pending referral (if any) & unlock Telegram bot menu!
  if (risk.verdict === DEVICE_VERIFICATION_STATUS.VERIFIED) {
    const referralResult = await processPendingReferral(env, userId);
    const refreshedUser = (await getUser(env, userId)) || user;

    try {
      const unlockText =
        `✅ <b>Device Verified — Welcome to ${BOT_BRAND}!</b>\n` +
        `${DIVIDER}\n` +
        `🛡️ Your device verification passed successfully.\n` +
        `🎁 Your rewards dashboard is now unlocked!\n\n` +
        `👇 Tap any button below to earn rewards & redeem vouchers:`;

      await sendMessage(env, userId, unlockText, {
        reply_markup: mainMenuKeyboard(adminUser),
      });
    } catch {
      // Do not fail verification response if Telegram message delivery has a transient error
    }

    return workerJson({
      ok: true,
      verdict: DEVICE_VERIFICATION_STATUS.VERIFIED,
      verificationId,
      verificationToken,
      referralCredited: Boolean(referralResult?.credited),
      message: 'Device verified successfully! Your bot menu is now unlocked.',
    });
  }

  // Flagged (pending_review) or Rejected -> DO NOT unlock menu, DO NOT credit referral
  const pendingReview = await getUserReferralReview(env, userId);

  try {
    await logSuspiciousDeviceEvent(env, {
      user,
      verificationId,
      reviewId: pendingReview?.id || saveRes.reviewId || '',
      verdict: risk.verdict,
      riskScore: risk.riskScore,
      reasons: risk.reasons,
      matchedUserIds: risk.matchedUserIds,
      referrerId: user.pendingReferrerId || '',
      strictFpPrefix: fpData.strictFpHash.slice(0, 12),
    });
  } catch {
    // Isolated logging
  }

  try {
    const statusHeadline =
      risk.verdict === DEVICE_VERIFICATION_STATUS.PENDING_REVIEW
        ? '⏳ <b>Device Verification Under Review</b>'
        : '🛡️ <b>Additional Security Review Required</b>';
    const userMsg =
      `${statusHeadline}\n` +
      `${DIVIDER}\n` +
      `Your device verification has been queued for administrator review to protect fair rewards.\n` +
      `🆔 <b>Reference ID:</b> <code>${escapeHtml(pendingReview?.id || verificationId)}</code>\n\n` +
      `• Your account has not been charged or deleted.\n` +
      `• Any pending referral will be reviewed by an admin before crediting.\n` +
      `• If you used a VPN or temporary browser, disable it and tap retry in the Mini App.`;

    await sendMessage(env, userId, userMsg);
  } catch {
    // Isolated notification
  }

  return workerJson({
    ok: true,
    verdict: risk.verdict,
    verificationId,
    reviewId: pendingReview?.id || saveRes.reviewId || null,
    verificationToken,
    canRetry: risk.verdict === DEVICE_VERIFICATION_STATUS.PENDING_REVIEW,
    message:
      risk.verdict === DEVICE_VERIFICATION_STATUS.PENDING_REVIEW
        ? 'Your verification is under security review. An admin can review and approve it, or you can retry after disabling VPN/incognito.'
        : 'Verification could not be completed automatically due to high duplicate-device or automation signals. An administrator can review your reference ID.',
  });
}

/**
 * POST /api/internal/device-verify/status
 * Checks current authoritative verification status in D1 for the signed Telegram user.
 */
export async function handleDeviceVerifyStatus(request, env) {
  const rawBody = await request.text();
  const auth = await verifyBridgeSignature(request, rawBody, env);
  if (!auth.ok) {
    return workerJson({ ok: false, error: auth.error }, auth.status || 401);
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return workerJson({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const initCheck = await verifyTelegramInitData(body.initData, env?.BOT_TOKEN);
  if (!initCheck.ok) {
    return workerJson(
      { ok: false, expired: Boolean(initCheck.expired), error: initCheck.error },
      401
    );
  }

  const user = await getUser(env, initCheck.user.id);
  if (!user) {
    return workerJson({ ok: false, error: 'User not registered. Send /start in the bot first.' }, 404);
  }

  const [latest, review] = await Promise.all([
    getLatestUserDeviceVerification(env, user.id),
    getUserReferralReview(env, user.id),
  ]);

  return workerJson({
    ok: true,
    status: user.deviceVerificationStatus,
    forceJoinVerified: Boolean(user.forceJoinVerified),
    verifiedAt: user.deviceVerifiedAt,
    latestVerificationId: latest?.id || null,
    reviewId: review?.id || null,
    reviewStatus: review?.status || null,
  });
}
