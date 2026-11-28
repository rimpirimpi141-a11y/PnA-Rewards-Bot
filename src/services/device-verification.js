// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Mini App Device Verification & Cross-Account Reputation Engine
// ============================================================================
// Runs exclusively on Cloudflare Workers with direct access to `env.DB` (D1)
// and `env.BOT_TOKEN`.
//
// Security & Anti-Abuse Architecture:
//  1. Cloud Run -> Cloudflare Worker calls authenticated via HMAC-SHA256
//     (`X-PnA-Timestamp`, `X-PnA-Nonce`, `X-PnA-Signature`) with constant-time
//     verification and ±60s skew window.
//  2. Telegram WebApp `initData` cryptographically validated via Web Crypto
//     HMAC-SHA256("WebAppData", BOT_TOKEN) per Telegram Mini Apps specification.
//  3. Server-signed WebView installation token (`pna_inst_v1.<id>.<hmac>`)
//     independently verified on BOTH Cloud Run and Cloudflare Worker.
//     Unsigned or client-generated tokens are strictly rejected.
//  4. Multi-component cross-account device matching across OTHER user IDs:
//     - install_token (strongest same-installation signal)
//     - strict_fp (deterministic system-font Canvas + WebGL + Audio + model)
//     - render_core (Canvas + WebGL + screen/DPR — immune to Audio timeout)
//     - hardware_core (GPU + screen + hardware + model + timezone)
//     - tg_biometric_id (optional Bot API 7.2+ BiometricManager.deviceId;
//       never mandatory, never forces biometric auth or permission)
//     - account_storage_id (optional Bot API 9.0+ DeviceStorage continuity;
//       strictly per-user same-account continuity tracking only)
//  5. Observation-only device association recording (`/observe`) for
//     grandfathered, verified, and admin accounts WITHOUT changing their
//     verification status or blocking access.
//  6. Clean separation of device identity signals vs secondary network/IP
//     signals (RFC 4291 IPv6 /48 expansion; never reads Cloud Run proxy ASN;
//     shared Wi-Fi alone NEVER causes rejection).
//  7. Clean separation of account access verdict vs referral reward approval
//     with high-priority same-device self-referral flagging.
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
  assertDB,
  consumeVerificationChallenge,
  countRecentDistinctUsersByIp,
  countRecentVerificationAttemptsByUser,
  createOrUpdateUserFromTelegram,
  createVerificationChallenge,
  findOtherUsersByFingerprint,
  findOtherUsersByIpSubnet,
  findOtherUsersBySignal,
  getDeviceVerificationByInitDataHash,
  getLatestUserDeviceVerification,
  getSettings,
  getUser,
  getUserDeviceSignalSummary,
  getUserReferralReview,
  isAdmin,
  recordDeviceObservationAtomic,
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

// Known hosting / VPN / cloud provider ASN keywords (only applied when genuine client ASN is supplied)
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

async function getInstallTokenSigningKey(env) {
  const bridge = getBridgeSecret(env);
  if (!bridge) return null;
  return hmacSha256Bytes(bridge, 'pna-rewards:install-token-key:v1');
}

async function getFingerprintSalt(env) {
  const bridge = getBridgeSecret(env);
  if (bridge) {
    return hmacSha256Hex(bridge, 'pna-rewards:fingerprint-salt:v1');
  }
  return sha256Hex('pna-rewards:local-dev-salt');
}

/**
 * Independently verify a server-signed WebView installation token (`pna_inst_v1.<id>.<hmac>`).
 * Uses the exact same derived HMAC key as `server.ts`. Never trusts unsigned/forged strings.
 */
export async function verifySignedInstallToken(rawToken, env) {
  const clean = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!clean) return { valid: false, tokenId: '' };
  const match = clean.match(/^pna_inst_v1\.([a-f0-9]{24,64})\.([a-f0-9]{64})$/i);
  if (!match) return { valid: false, tokenId: '' };
  const key = await getInstallTokenSigningKey(env);
  if (!key) return { valid: false, tokenId: '' };

  const tokenId = match[1].toLowerCase();
  const providedSig = hexToBytes(match[2].toLowerCase());
  if (!providedSig || providedSig.length !== 32) return { valid: false, tokenId: '' };

  const expectedSig = await hmacSha256Bytes(key, `pna_inst_v1.${tokenId}`);
  if (!timingSafeEqualBytes(expectedSig, providedSig)) {
    return { valid: false, tokenId: '' };
  }
  return { valid: true, tokenId };
}

export async function mintSignedInstallTokenWorker(env) {
  const key = await getInstallTokenSigningKey(env);
  if (!key) return '';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const tokenId = bytesToHex(bytes);
  const sigHex = bytesToHex(await hmacSha256Bytes(key, `pna_inst_v1.${tokenId}`));
  return `pna_inst_v1.${tokenId}.${sigHex}`;
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
// 4. Privacy-Conscious Fingerprint Normalization & RFC 4291 IPv6 Subnet Extraction
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

/**
 * Expand compressed IPv6 notation (including IPv4-mapped `::ffff:a.b.c.d`)
 * into canonical 8-hextet lowercase form before deriving a `/48` prefix.
 */
function expandIpv6(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip.includes(':')) return null;

  // Handle IPv4-mapped tail (e.g. ::ffff:192.0.2.128)
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map((x) => Number(x));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const h1 = ((octets[0] << 8) | octets[1]).toString(16);
    const h2 = ((octets[2] << 8) | octets[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${h1}:${h2}`;
  }

  const dblSplit = ip.split('::');
  if (dblSplit.length > 2) return null;

  let groups;
  if (dblSplit.length === 2) {
    const left = dblSplit[0] ? dblSplit[0].split(':') : [];
    const right = dblSplit[1] ? dblSplit[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = ip.split(':');
    if (groups.length !== 8) return null;
  }

  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.map((g) => g.padStart(4, '0'));
}

export function extractIpSubnet(rawIp) {
  let ip = sanitizeStr(rawIp, 64).toLowerCase();
  if (!ip) return '';

  // Strip IPv4-mapped IPv6 prefix so ::ffff:1.2.3.4 normalizes identically to 1.2.3.4
  if (ip.startsWith('::ffff:')) {
    const maybeV4 = ip.slice(7);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(maybeV4)) {
      ip = maybeV4;
    }
  }

  // IPv4 -> /24 subnet
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map((x) => Number(x));
    if (parts.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return '';
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  // IPv6 -> canonical expanded /48 prefix
  const expanded = expandIpv6(ip);
  if (expanded) {
    return `${expanded[0]}:${expanded[1]}:${expanded[2]}::/48`;
  }

  return '';
}

function isDatacenterOrVpnAsn(asnOrg, proxyHint = false) {
  if (proxyHint) return { proxyVpnFlag: true, datacenterFlag: false };
  const lower = sanitizeStr(asnOrg, 160).toLowerCase();
  if (!lower) return { proxyVpnFlag: false, datacenterFlag: false };
  for (const kw of DATACENTER_ASN_KEYWORDS) {
    if (lower.includes(kw)) {
      const isVpn =
        kw.includes('vpn') ||
        kw.includes('tor') ||
        kw.includes('mullvad') ||
        kw.includes('proton') ||
        kw.includes('warp');
      return { proxyVpnFlag: isVpn, datacenterFlag: !isVpn };
    }
  }
  return { proxyVpnFlag: false, datacenterFlag: false };
}

/**
 * Normalize and hash all device signals into component hashes.
 * Unavailable signals remain empty ("") so missing capabilities NEVER produce
 * false mismatches or false matches across devices.
 */
export async function normalizeAndHashSignals(rawSignals, clientNetwork, env, installAnchor = null) {
  const s = rawSignals && typeof rawSignals === 'object' ? rawSignals : {};
  const tgNative = s.telegramNative && typeof s.telegramNative === 'object' ? s.telegramNative : {};
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
    telegramVersion: sanitizeStr(s.telegramVersion, 24),
    userAgentFamily: sanitizeStr(s.userAgentFamily, 120),
    osVersion: sanitizeStr(s.osVersion, 32),
    webviewVersion: sanitizeStr(s.webviewVersion, 32),
    deviceModel: sanitizeStr(s.deviceModel, 64),
    webdriver: Boolean(s.webdriver),
    automationSignals: Array.isArray(s.automationSignals)
      ? s.automationSignals.slice(0, 10).map((x) => sanitizeStr(x, 40))
      : [],
    hasCanvas: Boolean(sanitizeStr(s.canvasHash, 80)),
    hasWebgl: Boolean(sanitizeStr(s.webglRenderer, 140) || sanitizeStr(s.webglParamsHash, 80)),
    hasAudio: Boolean(sanitizeStr(s.audioHash, 80)),
    biometricSupported: Boolean(tgNative.biometricSupported),
    biometricAvailable: Boolean(tgNative.biometricAvailable),
    biometricAccessGranted: Boolean(tgNative.biometricAccessGranted),
    biometricDeviceId: sanitizeStr(tgNative.biometricDeviceId, 128),
    deviceStorageSupported: Boolean(tgNative.deviceStorageSupported),
    accountContinuityId: sanitizeStr(tgNative.accountContinuityId, 128),
    accountContinuityRestored: Boolean(tgNative.accountContinuityRestored),
  };

  // Independently verify any server-signed installation tokens passed via Cloud Run bridge
  const anchor = installAnchor && typeof installAnchor === 'object' ? installAnchor : {};
  const verifiedTokenIds = new Set();
  let installTokenTampered = Boolean(anchor.tamperedCookieToken || anchor.tamperedStorageToken);

  const candidateTokens = [anchor.cookieToken, anchor.storageToken, anchor.canonicalToken];
  for (const tok of candidateTokens) {
    if (!tok || typeof tok !== 'string') continue;
    const check = await verifySignedInstallToken(tok, env);
    if (check.valid && check.tokenId) {
      verifiedTokenIds.add(check.tokenId);
    } else if (tok.trim()) {
      installTokenTampered = true;
    }
  }

  // Strict fingerprint v2: deterministic system-font Canvas + WebGL + quantized Audio + hardware/model
  const strictCanonical = [
    'strict:v2',
    normalized.canvasHash || 'missing:canvas',
    normalized.webglVendor || 'missing:glv',
    normalized.webglRenderer || 'missing:glr',
    normalized.webglParamsHash || 'missing:glp',
    normalized.audioHash || 'missing:audio',
    normalized.fontMetricsHash || 'missing:font',
    `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}:${normalized.colorDepth}`,
    `${normalized.timezone}:${normalized.timezoneOffset}`,
    `${normalized.hardwareConcurrency}:${normalized.deviceMemory}:${normalized.maxTouchPoints}`,
    normalized.platform,
    normalized.telegramPlatform,
    normalized.deviceModel,
    normalized.osVersion,
  ].join('|');

  // Render Core: Canvas + WebGL + screen/DPR + platform (immune to Audio timeouts & font scaling)
  // Only generated if Canvas OR WebGL is genuinely available (missing signals never match each other!)
  const hasRenderCore = normalized.hasCanvas || normalized.hasWebgl;
  const renderCoreCanonical = hasRenderCore
    ? [
        'render:v1',
        normalized.canvasHash || 'missing:canvas',
        normalized.webglVendor || 'missing:glv',
        normalized.webglRenderer || 'missing:glr',
        normalized.webglParamsHash || 'missing:glp',
        `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}`,
        normalized.platform,
      ].join('|')
    : '';

  // Hardware Core (also stored as legacy fuzzyFpHash): GPU + screen + cores/mem/touch + model + tz
  const hasHardwareCore = Boolean(
    normalized.webglRenderer ||
      normalized.webglVendor ||
      (normalized.screenWidth > 0 && normalized.screenHeight > 0) ||
      normalized.deviceModel
  );
  const hardwareCoreCanonical = hasHardwareCore
    ? [
        'hardware:v1',
        normalized.webglRenderer || normalized.webglVendor,
        `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}`,
        `${normalized.hardwareConcurrency}:${normalized.deviceMemory}:${normalized.maxTouchPoints}`,
        normalized.deviceModel,
        normalized.timezone,
        normalized.platform,
      ].join('|')
    : '';

  const clientIp = sanitizeStr(clientNetwork?.ip, 64);
  const subnet = extractIpSubnet(clientIp);

  const installTokenHashes = await Promise.all(
    Array.from(verifiedTokenIds).map((id) => sha256Hex(`${salt}|install_token|${id}`))
  );

  const [
    strictFpHash,
    renderCoreHash,
    hardwareCoreHash,
    tgBiometricIdHash,
    accountStorageIdHash,
    ipHash,
    ipSubnetHash,
  ] = await Promise.all([
    sha256Hex(`${salt}|${strictCanonical}`),
    renderCoreCanonical ? sha256Hex(`${salt}|${renderCoreCanonical}`) : Promise.resolve(''),
    hardwareCoreCanonical ? sha256Hex(`${salt}|${hardwareCoreCanonical}`) : Promise.resolve(''),
    normalized.biometricDeviceId.length >= 6
      ? sha256Hex(`${salt}|tg_bio|${normalized.biometricDeviceId}`)
      : Promise.resolve(''),
    normalized.accountContinuityId.length >= 16
      ? sha256Hex(`${salt}|acct_store|${normalized.accountContinuityId}`)
      : Promise.resolve(''),
    clientIp ? sha256Hex(`${salt}|ip|${clientIp}`) : Promise.resolve(''),
    subnet ? sha256Hex(`${salt}|subnet|${subnet}`) : Promise.resolve(''),
  ]);

  // Backward-compatible legacy fuzzyFpHash falls back to hardwareCoreHash (or strictFpHash if hardware absent)
  const fuzzyFpHash = hardwareCoreHash || strictFpHash;

  const signalLinks = [];
  for (const h of installTokenHashes) {
    signalLinks.push({ signalType: 'install_token', signalHash: h });
  }
  // Only index strict_fp / render_core / hardware_core when actual device signals exist
  if (hasRenderCore || hasHardwareCore) {
    signalLinks.push({ signalType: 'strict_fp', signalHash: strictFpHash });
  }
  if (renderCoreHash) {
    signalLinks.push({ signalType: 'render_core', signalHash: renderCoreHash });
  }
  if (hardwareCoreHash) {
    signalLinks.push({ signalType: 'hardware_core', signalHash: hardwareCoreHash });
  }
  if (tgBiometricIdHash) {
    signalLinks.push({ signalType: 'tg_biometric_id', signalHash: tgBiometricIdHash });
  }
  if (accountStorageIdHash) {
    signalLinks.push({ signalType: 'account_storage_id', signalHash: accountStorageIdHash });
  }

  const signalHashes = {
    installTokens: installTokenHashes.map((h) => h.slice(0, 16)),
    renderCore: renderCoreHash ? renderCoreHash.slice(0, 16) : '',
    hardwareCore: hardwareCoreHash ? hardwareCoreHash.slice(0, 16) : '',
    canvas: normalized.canvasHash ? normalized.canvasHash.slice(0, 16) : '',
    webgl: normalized.webglParamsHash ? normalized.webglParamsHash.slice(0, 16) : '',
    audio: normalized.audioHash ? normalized.audioHash.slice(0, 16) : '',
    fonts: normalized.fontMetricsHash ? normalized.fontMetricsHash.slice(0, 16) : '',
    screen: `${normalized.screenWidth}x${normalized.screenHeight}@${normalized.devicePixelRatio}`,
    tz: normalized.timezone,
    tgPlatform: normalized.telegramPlatform,
    tgVersion: normalized.telegramVersion,
    model: normalized.deviceModel,
    os: normalized.osVersion,
    webview: normalized.webviewVersion,
    cores: normalized.hardwareConcurrency,
    touch: normalized.maxTouchPoints,
    hasBioId: Boolean(tgBiometricIdHash),
    hasAcctStorage: Boolean(accountStorageIdHash),
  };

  return {
    normalized,
    installTokenHashes,
    installTokenTampered,
    strictFpHash,
    renderCoreHash,
    hardwareCoreHash,
    fuzzyFpHash,
    tgBiometricIdHash,
    accountStorageIdHash,
    signalLinks,
    ipHash,
    ipSubnetHash,
    signalHashes,
  };
}

// ----------------------------------------------------------------------------
// 5. Cross-Account Device Reputation & Risk Scoring Engine
// ----------------------------------------------------------------------------

function mergeUniqueMatches(...lists) {
  const byUser = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const uid = String(item?.userId || '');
      if (!uid) continue;
      const existing = byUser.get(uid);
      if (!existing || (item.lastSeenAt || 0) > (existing.lastSeenAt || 0)) {
        byUser.set(uid, item);
      }
    }
  }
  return Array.from(byUser.values());
}

export async function evaluateDeviceRisk(
  env,
  {
    userId,
    pendingReferrerId = null,
    normalized,
    installTokenHashes = [],
    installTokenTampered = false,
    strictFpHash,
    renderCoreHash = '',
    hardwareCoreHash = '',
    fuzzyFpHash,
    tgBiometricIdHash = '',
    accountStorageIdHash = '',
    ipHash,
    ipSubnetHash,
    clientNetwork,
    now = Date.now(),
  }
) {
  const reasons = [];
  let score = 0;

  const tenMinAgo = now - 10 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const installTokenQueries = (installTokenHashes || []).map((h) =>
    findOtherUsersBySignal(env, 'install_token', h, userId)
  );

  const [
    installTokenMatchLists,
    strictSignalMatches,
    legacyStrictMatches,
    renderCoreMatches,
    hardwareSignalMatches,
    legacyFuzzyMatches,
    biometricIdMatches,
    subnetMatches,
    recentIpAccounts,
    existingReview,
    ownSignalHistory,
  ] = await Promise.all([
    Promise.all(installTokenQueries),
    strictFpHash && (normalized.hasCanvas || normalized.hasWebgl || hardwareCoreHash)
      ? findOtherUsersBySignal(env, 'strict_fp', strictFpHash, userId)
      : Promise.resolve([]),
    strictFpHash && (normalized.hasCanvas || normalized.hasWebgl || hardwareCoreHash)
      ? findOtherUsersByFingerprint(env, 'strict', strictFpHash, userId)
      : Promise.resolve([]),
    renderCoreHash
      ? findOtherUsersBySignal(env, 'render_core', renderCoreHash, userId)
      : Promise.resolve([]),
    hardwareCoreHash
      ? findOtherUsersBySignal(env, 'hardware_core', hardwareCoreHash, userId)
      : Promise.resolve([]),
    fuzzyFpHash && hardwareCoreHash
      ? findOtherUsersByFingerprint(env, 'fuzzy', fuzzyFpHash, userId)
      : Promise.resolve([]),
    tgBiometricIdHash
      ? findOtherUsersBySignal(env, 'tg_biometric_id', tgBiometricIdHash, userId)
      : Promise.resolve([]),
    findOtherUsersByIpSubnet(env, ipSubnetHash, userId, sevenDaysAgo),
    countRecentDistinctUsersByIp(env, ipHash, tenMinAgo, userId),
    getUserReferralReview(env, userId),
    getUserDeviceSignalSummary(env, userId),
  ]);

  const installTokenMatches = mergeUniqueMatches(...installTokenMatchLists);
  const strictMatches = mergeUniqueMatches(strictSignalMatches, legacyStrictMatches);
  const hardwareMatches = mergeUniqueMatches(hardwareSignalMatches, legacyFuzzyMatches);

  const matchedUserSet = new Set();
  const matchedSignalTypes = new Set();
  const matchedSignalsDetail = {};
  let hasStrongDeviceMatch = false;

  // Preserve open duplicate-device hold so a caught user cannot self-clear by reinstalling or retrying
  if (
    existingReview &&
    existingReview.status === 'pending' &&
    Array.isArray(existingReview.matchedUserIds) &&
    existingReview.matchedUserIds.length > 0
  ) {
    score += 50;
    hasStrongDeviceMatch = true;
    for (const prevId of existingReview.matchedUserIds) matchedUserSet.add(String(prevId));
    reasons.push({
      code: 'PRIOR_DUPLICATE_DEVICE_HOLD',
      weight: 50,
      detail: 'Account has an open duplicate-device referral review awaiting admin decision',
    });
  }

  // --- DEVICE IDENTITY SIGNALS (Independent of IP / VPN) ---

  // 1. Server-signed WebView Installation Token shared across accounts (+75)
  if (installTokenMatches.length > 0) {
    score += 75;
    hasStrongDeviceMatch = true;
    matchedSignalTypes.add('install_token');
    matchedSignalsDetail.install_token = installTokenMatches.map((m) => m.userId);
    for (const m of installTokenMatches) matchedUserSet.add(m.userId);
    reasons.push({
      code: 'DUPLICATE_INSTALL_TOKEN',
      weight: 75,
      detail: `Shared server-signed Telegram WebView installation token with ${installTokenMatches.length} other account(s)`,
    });
  }

  // 2. Strict full fingerprint match across accounts (+65 if primary, +15 corroboration if install_token already matched)
  if (strictMatches.length > 0) {
    const w = installTokenMatches.length > 0 ? 15 : 65;
    score += w;
    hasStrongDeviceMatch = true;
    matchedSignalTypes.add('strict_fp');
    matchedSignalsDetail.strict_fp = strictMatches.map((m) => m.userId);
    for (const m of strictMatches) matchedUserSet.add(m.userId);
    reasons.push({
      code: 'DUPLICATE_STRICT_DEVICE',
      weight: w,
      detail: `Matches ${strictMatches.length} other Telegram account(s) on full deterministic device fingerprint`,
    });
  } else if (renderCoreMatches.length > 0) {
    // 3. Render Core (Canvas + WebGL + screen/DPR) match — immune to Audio timeout / font drift!
    const w = installTokenMatches.length > 0 ? 10 : 55;
    score += w;
    hasStrongDeviceMatch = true;
    matchedSignalTypes.add('render_core');
    matchedSignalsDetail.render_core = renderCoreMatches.map((m) => m.userId);
    for (const m of renderCoreMatches) matchedUserSet.add(m.userId);
    reasons.push({
      code: 'DUPLICATE_RENDER_CORE',
      weight: w,
      detail: `Matches ${renderCoreMatches.length} other account(s) on Canvas/WebGL rendering core (independent of IP/Audio drift)`,
    });
  } else if (hardwareMatches.length > 0) {
    // 4. Hardware Core fallback (GPU + screen + cores + model + timezone)
    const subnetSet = new Set(subnetMatches);
    const hardwareOnSameSubnet = hardwareMatches.filter((m) => subnetSet.has(m.userId));
    if (hardwareOnSameSubnet.length > 0 && installTokenMatches.length === 0) {
      score += 40;
      matchedSignalTypes.add('hardware_core');
      matchedSignalsDetail.hardware_core = hardwareOnSameSubnet.map((m) => m.userId);
      for (const m of hardwareOnSameSubnet) matchedUserSet.add(m.userId);
      reasons.push({
        code: 'DUPLICATE_HARDWARE_SAME_SUBNET',
        weight: 40,
        detail: `Hardware/screen profile matches ${hardwareOnSameSubnet.length} account(s) on the same network subnet`,
      });
    } else if (installTokenMatches.length === 0) {
      // Common phone model on a different network -> informational only (+10)
      score += 10;
      reasons.push({
        code: 'SIMILAR_HARDWARE_MODEL',
        weight: 10,
        detail: 'Similar hardware/screen model seen on another network (informational only)',
      });
    }
  }

  // 5. Optional Telegram BiometricManager.deviceId match (only when non-empty; missing NEVER penalized)
  if (biometricIdMatches.length > 0) {
    const w = hasStrongDeviceMatch ? 15 : 50;
    score += w;
    hasStrongDeviceMatch = true;
    matchedSignalTypes.add('tg_biometric_id');
    matchedSignalsDetail.tg_biometric_id = biometricIdMatches.map((m) => m.userId);
    for (const m of biometricIdMatches) matchedUserSet.add(m.userId);
    reasons.push({
      code: 'DUPLICATE_TG_BIOMETRIC_ID',
      weight: w,
      detail: `Optional Telegram BiometricManager deviceId matched ${biometricIdMatches.length} other account(s)`,
    });
  }

  // 6. Client tampered with installation token (+15 anomaly; forged token was NEVER trusted)
  if (installTokenTampered) {
    score += 15;
    reasons.push({
      code: 'INSTALL_TOKEN_TAMPERED',
      weight: 15,
      detail: 'Client presented an unsigned or tampered installation token (rejected by server)',
    });
  }

  // 7. High-Priority Same-Device Self-Referral Check (+25)
  const cleanReferrerId = pendingReferrerId ? String(pendingReferrerId).trim() : '';
  const selfReferralDeviceMatch = Boolean(cleanReferrerId && matchedUserSet.has(cleanReferrerId));
  if (selfReferralDeviceMatch) {
    score += 25;
    reasons.push({
      code: 'SAME_DEVICE_SELF_REFERRAL',
      weight: 25,
      detail: `Referrer account (${cleanReferrerId}) shares device signals with this referred account`,
    });
  }

  // --- SECONDARY NETWORK / IP SIGNALS (Shared Wi-Fi alone NEVER rejects!) ---

  if (subnetMatches.length > 0 && !hasStrongDeviceMatch) {
    score += 15;
    reasons.push({
      code: 'SHARED_NETWORK_SUBNET',
      weight: 15,
      detail: `Shared network subnet with ${subnetMatches.length} other account(s) (secondary signal — does not auto-reject)`,
    });
  }

  if (recentIpAccounts >= 2 && !hasStrongDeviceMatch) {
    score += 15;
    reasons.push({
      code: 'HIGH_IP_VELOCITY',
      weight: 15,
      detail: `${recentIpAccounts} other account(s) verified from this IP in the last 10 minutes`,
    });
  }

  // VPN / Datacenter ASN heuristic — ONLY applied when genuine client ASN/proxyHint is provided
  const asnOrg = sanitizeStr(clientNetwork?.asnOrg, 160);
  const netFlags = isDatacenterOrVpnAsn(asnOrg, Boolean(clientNetwork?.proxyHint));
  if (netFlags.proxyVpnFlag || netFlags.datacenterFlag) {
    score += 20;
    reasons.push({
      code: netFlags.proxyVpnFlag ? 'VPN_OR_PROXY_DETECTED' : 'DATACENTER_ASN_DETECTED',
      weight: 20,
      detail: asnOrg
        ? `Client network flagged as VPN/datacenter (${asnOrg})`
        : 'Proxy or VPN network header detected',
    });
  }

  // --- AUTOMATION & CAPABILITY SIGNALS ---

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

  // Missing both Canvas and WebGL -> minor partial signal (+10), NEVER rejects unsupported clients alone!
  if (!normalized.hasCanvas && !normalized.hasWebgl) {
    score += 10;
    reasons.push({
      code: 'MISSING_RENDER_SIGNALS',
      weight: 10,
      detail: 'Canvas and WebGL rendering unavailable on this client (informational partial signal)',
    });
  }

  // --- INFORMATIONAL SAME-ACCOUNT CONTINUITY SIGNALS (weight = 0, NEVER reject) ---
  if (
    renderCoreHash &&
    ownSignalHistory.renderCores.size > 0 &&
    !ownSignalHistory.renderCores.has(renderCoreHash)
  ) {
    reasons.push({
      code: 'SAME_ACCOUNT_NEW_DEVICE',
      weight: 0,
      detail: 'This Telegram account was previously observed on a different device rendering profile',
    });
  }

  if (
    accountStorageIdHash &&
    ownSignalHistory.accountStorageIds.size > 0 &&
    !ownSignalHistory.accountStorageIds.has(accountStorageIdHash)
  ) {
    reasons.push({
      code: 'STORAGE_CONTINUITY_RESET',
      weight: 0,
      detail: 'Per-account Telegram DeviceStorage continuity ID changed (reinstall or second device)',
    });
  }

  const finalScore = Math.max(0, Math.min(100, score));

  // Separate Account Access Verdict vs Referral Reward Decision
  let verdict = DEVICE_VERIFICATION_STATUS.VERIFIED;
  if (finalScore >= DEVICE_RISK_THRESHOLDS.REJECTED) {
    verdict = DEVICE_VERIFICATION_STATUS.REJECTED;
  } else if (finalScore >= DEVICE_RISK_THRESHOLDS.PENDING_REVIEW) {
    verdict = DEVICE_VERIFICATION_STATUS.PENDING_REVIEW;
  }

  let referralDecision = 'no_referrer';
  let holdReferralReview = false;
  if (cleanReferrerId) {
    if (verdict !== DEVICE_VERIFICATION_STATUS.VERIFIED || hasStrongDeviceMatch || selfReferralDeviceMatch) {
      referralDecision = 'held_for_review';
      holdReferralReview = true;
    } else {
      referralDecision = 'eligible';
    }
  }

  return {
    riskScore: finalScore,
    verdict,
    referralDecision,
    holdReferralReview,
    selfReferralDeviceMatch,
    hasStrongDeviceMatch,
    reasons,
    matchedUserIds: Array.from(matchedUserSet),
    matchedSignalTypes: Array.from(matchedSignalTypes),
    matchedSignalsDetail,
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

/**
 * Extract genuine client network metadata forwarded by Cloud Run (`server.ts`).
 * IMPORTANT: Never falls back to `request.cf.asn`, `request.cf.asOrganization`,
 * or `request.cf.country`, because those describe the Cloud Run egress proxy,
 * NOT the user's Android device!
 */
function extractClientNetwork(bodyNetwork, request) {
  const net = bodyNetwork && typeof bodyNetwork === 'object' ? bodyNetwork : {};
  return {
    ip: sanitizeStr(net.ip || '', 64),
    countryCode: sanitizeStr(net.countryCode || '', 16),
    asn: sanitizeStr(net.asn || '', 32),
    asnOrg: sanitizeStr(net.asnOrg || '', 160),
    proxyHint: Boolean(net.proxyHint),
    bridgeCallerIp: sanitizeStr(request?.headers?.get('CF-Connecting-IP') || '', 64),
  };
}

/**
 * Shared helper to resolve authoritative verification state and generation alignment.
 * Every user (including verified, grandfathered, admins, and owners) must satisfy
 * both verified status and last_verified_generation >= currentVerificationGeneration (gen 2).
 * Never automatically upgrades user generation.
 */
export async function resolveVerificationState(user, env, _adminUser = false) {
  if (!isDeviceVerificationEnabled(env)) {
    return { verified: true, requiredGen: 2, userGen: Number(user?.lastVerifiedGeneration || 0), status: user?.deviceVerificationStatus || 'verified' };
  }
  if (!user) {
    return { verified: false, requiredGen: 2, userGen: 0, status: 'unverified' };
  }
  const settings = await getSettings(env);
  const requiredGen = Number(settings.currentVerificationGeneration || 2);
  const userGen = Number(user.lastVerifiedGeneration || 0);
  const status = user.deviceVerificationStatus || DEVICE_VERIFICATION_STATUS.UNVERIFIED;

  const isVerifiedStatus =
    status === DEVICE_VERIFICATION_STATUS.VERIFIED ||
    status === DEVICE_VERIFICATION_STATUS.GRANDFATHERED;

  const verified = isVerifiedStatus && userGen >= requiredGen;
  return { verified, requiredGen, userGen, status };
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

  const state = await resolveVerificationState(user, env, adminUser);
  if (state.verified) {
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
 * POST /api/internal/device-verify/observe
 * Observation-only endpoint for grandfathered, already-verified, and admin accounts.
 * Indexes their server-signed installation token & device signals in D1 so secondary
 * accounts opened on the same physical phone are detected, WITHOUT EVER altering
 * their verification status, balances, referrals, or blocking access.
 */
export async function handleDeviceVerifyObserve(request, env) {
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

  const state = await resolveVerificationState(user, env, adminUser);
  const isEligibleForObserve = state.verified || adminUser;

  if (!isEligibleForObserve) {
    return workerJson({
      ok: true,
      observed: false,
      status: user.deviceVerificationStatus,
    });
  }

  const clientNetwork = extractClientNetwork(body.clientNetwork, request);
  const fpData = await normalizeAndHashSignals(
    body.signals,
    clientNetwork,
    env,
    body.installAnchor
  );
  const ownHistory = await getUserDeviceSignalSummary(env, userId);
  const switchedDevice = Boolean(
    fpData.renderCoreHash &&
      ownHistory.renderCores.size > 0 &&
      !ownHistory.renderCores.has(fpData.renderCoreHash)
  );
  const storageReset = Boolean(
    fpData.accountStorageIdHash &&
      ownHistory.accountStorageIds.size > 0 &&
      !ownHistory.accountStorageIds.has(fpData.accountStorageIdHash)
  );

  const now = Date.now();
  await recordDeviceObservationAtomic(env, {
    userId,
    strictFpHash: fpData.strictFpHash,
    fuzzyFpHash: fpData.fuzzyFpHash,
    signalLinks: fpData.signalLinks,
    ipHash: fpData.ipHash,
    countryCode: clientNetwork.countryCode,
    observedStatus: adminUser ? 'admin_observed' : user.deviceVerificationStatus,
    details: {
      isAdmin: adminUser,
      switchedDevice,
      storageReset,
      installTokenCount: fpData.installTokenHashes.length,
    },
    now,
  });

  return workerJson({
    ok: true,
    observed: true,
    status: user.deviceVerificationStatus,
    accountDecision: adminUser ? 'admin_bypass' : 'preserved_access',
    switchedDevice,
    storageReset,
  });
}

/**
 * POST /api/internal/device-verify/submit
 * Validates Telegram `initData`, consumes single-use challenge nonce, computes
 * component device hashes, evaluates cross-account reputation risk, persists
 * atomically in D1, issues signed server-side verification token, and on clean
 * pass unlocks the bot menu and runs eligible referral crediting.
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

  // Short-circuit only if user satisfies generation 2 verification state
  const state = await resolveVerificationState(user, env, adminUser);
  if (state.verified) {
    if (body.signals && typeof body.signals === 'object') {
      const obsNet = extractClientNetwork(body.clientNetwork, request);
      const obsFp = await normalizeAndHashSignals(body.signals, obsNet, env, body.installAnchor);
      await recordDeviceObservationAtomic(env, {
        userId,
        strictFpHash: obsFp.strictFpHash,
        fuzzyFpHash: obsFp.fuzzyFpHash,
        signalLinks: obsFp.signalLinks,
        ipHash: obsFp.ipHash,
        countryCode: obsNet.countryCode,
        observedStatus: user.deviceVerificationStatus,
        details: { viaSubmitShortCircuit: true },
      });
    }
    const token = await signVerificationToken(env, {
      jti: generateId('VTKN'),
      uid: userId,
      status: user.deviceVerificationStatus,
    });
    return workerJson({
      ok: true,
      alreadyVerified: true,
      verdict: user.deviceVerificationStatus,
      referralDecision: 'preserved',
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
  const fpData = await normalizeAndHashSignals(
    body.signals,
    clientNetwork,
    env,
    body.installAnchor
  );

  const risk = await evaluateDeviceRisk(env, {
    userId,
    pendingReferrerId: user.pendingReferrerId || null,
    normalized: fpData.normalized,
    installTokenHashes: fpData.installTokenHashes,
    installTokenTampered: fpData.installTokenTampered,
    strictFpHash: fpData.strictFpHash,
    renderCoreHash: fpData.renderCoreHash,
    hardwareCoreHash: fpData.hardwareCoreHash,
    fuzzyFpHash: fpData.fuzzyFpHash,
    tgBiometricIdHash: fpData.tgBiometricIdHash,
    accountStorageIdHash: fpData.accountStorageIdHash,
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
    signalLinks: fpData.signalLinks,
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
    referralDecision: risk.referralDecision,
    holdReferralReview: risk.holdReferralReview,
    verifiedTokenJti: tokenJti,
    pendingReferrerId: user.pendingReferrerId || null,
    matchedUserIds: risk.matchedUserIds,
    matchedSignalTypes: risk.matchedSignalTypes,
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

  // Clean VERIFIED verdict -> unlock bot menu, and credit pending referral ONLY if referralDecision === 'eligible'
  if (risk.verdict === DEVICE_VERIFICATION_STATUS.VERIFIED) {
    let referralResult = { credited: false };
    if (risk.referralDecision === 'eligible') {
      referralResult = await processPendingReferral(env, userId);
    }

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
      referralDecision: referralResult?.credited ? 'credited' : risk.referralDecision,
      riskScore: risk.riskScore,
      matchedUserIds: risk.matchedUserIds,
      matchedSignalTypes: risk.matchedSignalTypes,
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
    referralDecision: risk.referralDecision,
    riskScore: risk.riskScore,
    matchedUserIds: risk.matchedUserIds,
    matchedSignalTypes: risk.matchedSignalTypes,
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

  const adminUser = await isAdmin(initCheck.user.id, env);
  const state = await resolveVerificationState(user, env, adminUser);
  const [latest, review] = await Promise.all([
    getLatestUserDeviceVerification(env, user.id),
    getUserReferralReview(env, user.id),
  ]);

  return workerJson({
    ok: true,
    status: user.deviceVerificationStatus,
    verified: state.verified,
    requiredGen: state.requiredGen,
    userGen: state.userGen,
    forceJoinVerified: Boolean(user.forceJoinVerified),
    verifiedAt: user.deviceVerifiedAt,
    latestVerificationId: latest?.id || null,
    reviewId: review?.id || null,
    reviewStatus: review?.status || null,
  });
}
