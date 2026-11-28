// ============================================================================
// Privacy-Conscious Probabilistic Browser/WebView Fingerprint Collector
// + Redundant WebView Storage Mirror for Server-Signed Installation Token
// ============================================================================
// Stability guarantees:
//  • Canvas uses ONLY built-in system generic fonts (sans-serif / serif /
//    monospace) — zero asynchronous Google Font race conditions.
//  • OfflineAudioContext uses a 1500ms timeout and stable quantization; if
//    unavailable or timed out it returns "" (treated as missing, never mismatch).
//  • Collects non-PII Android WebView version & Client Hints device model when
//    available, degrading gracefully on older or privacy-hardened clients.
//  • NEVER creates self-signed/client-generated installation IDs. It ONLY
//    stores and replays opaque server-signed tokens issued by the backend.
// ============================================================================

import { collectTelegramNativeSignals, type TelegramNativeSignals } from './telegram';

export interface DeviceFingerprintSignals {
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  webglParamsHash: string;
  audioHash: string;
  fontMetricsHash: string;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  devicePixelRatio: number;
  timezone: string;
  timezoneOffset: number;
  language: string;
  languagesCount: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  platform: string;
  telegramPlatform: string;
  telegramVersion: string;
  userAgentFamily: string;
  osVersion: string;
  webviewVersion: string;
  deviceModel: string;
  webdriver: boolean;
  automationSignals: string[];
  telegramNative: {
    biometricSupported: boolean;
    biometricInited: boolean;
    biometricAvailable: boolean;
    biometricType: string;
    biometricAccessGranted: boolean;
    biometricDeviceId: string;
    deviceStorageSupported: boolean;
    accountContinuityId: string;
    accountContinuityRestored: boolean;
  };
}

const INSTALL_TOKEN_STORAGE_KEY = 'pna_inst_token_v1';
const INSTALL_IDB_NAME = 'pna_rewards_device_anchor';
const INSTALL_IDB_STORE = 'kv';
const INSTALL_CACHE_NAME = 'pna_rewards_anchor_v1';
const INSTALL_CACHE_URL = '/__pna_inst_anchor__';

function isPlausibleSignedToken(val: unknown): val is string {
  return typeof val === 'string' && /^pna_inst_v1\.[a-f0-9]{24,64}\.[a-f0-9]{64}$/i.test(val.trim());
}

function readLocalStorageToken(): string {
  try {
    const val = window.localStorage?.getItem(INSTALL_TOKEN_STORAGE_KEY) || '';
    return isPlausibleSignedToken(val) ? val.trim() : '';
  } catch {
    return '';
  }
}

function writeLocalStorageToken(token: string): void {
  try {
    window.localStorage?.setItem(INSTALL_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore storage quota / private mode errors
  }
}

function readIndexedDbToken(): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve('');
        return;
      }
      const req = indexedDB.open(INSTALL_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(INSTALL_IDB_STORE)) {
          db.createObjectStore(INSTALL_IDB_STORE);
        }
      };
      req.onerror = () => resolve('');
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction(INSTALL_IDB_STORE, 'readonly');
          const store = tx.objectStore(INSTALL_IDB_STORE);
          const getReq = store.get(INSTALL_TOKEN_STORAGE_KEY);
          getReq.onsuccess = () => {
            const val = getReq.result;
            db.close();
            resolve(isPlausibleSignedToken(val) ? val.trim() : '');
          };
          getReq.onerror = () => {
            db.close();
            resolve('');
          };
        } catch {
          resolve('');
        }
      };
    } catch {
      resolve('');
    }
  });
}

function writeIndexedDbToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve();
        return;
      }
      const req = indexedDB.open(INSTALL_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(INSTALL_IDB_STORE)) {
          db.createObjectStore(INSTALL_IDB_STORE);
        }
      };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction(INSTALL_IDB_STORE, 'readwrite');
          tx.objectStore(INSTALL_IDB_STORE).put(token, INSTALL_TOKEN_STORAGE_KEY);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
        } catch {
          resolve();
        }
      };
    } catch {
      resolve();
    }
  });
}

async function readCacheStorageToken(): Promise<string> {
  try {
    if (typeof caches === 'undefined') return '';
    const cache = await caches.open(INSTALL_CACHE_NAME);
    const res = await cache.match(INSTALL_CACHE_URL);
    if (!res) return '';
    const val = (await res.text()).trim();
    return isPlausibleSignedToken(val) ? val : '';
  } catch {
    return '';
  }
}

async function writeCacheStorageToken(token: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(INSTALL_CACHE_NAME);
    await cache.put(
      INSTALL_CACHE_URL,
      new Response(token, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    );
  } catch {
    // ignore CacheStorage errors
  }
}

/**
 * Read any previously server-issued signed installation token from redundant
 * WebView origin stores (localStorage, IndexedDB, CacheStorage).
 * Self-heals missing stores when another store still holds the valid token.
 */
export async function readStoredInstallToken(): Promise<string> {
  const ls = readLocalStorageToken();
  const [idb, cs] = await Promise.all([readIndexedDbToken(), readCacheStorageToken()]);
  const token = ls || idb || cs || '';
  if (token) {
    // Self-heal any evicted mirror silently
    if (!ls) writeLocalStorageToken(token);
    if (!idb) void writeIndexedDbToken(token);
    if (!cs) void writeCacheStorageToken(token);
  }
  return token;
}

/**
 * Persist a server-signed installation token into redundant WebView origin stores.
 * Never persists unsigned or client-generated strings.
 */
export async function persistInstallToken(token: string | null | undefined): Promise<void> {
  if (!isPlausibleSignedToken(token)) return;
  const clean = token.trim();
  writeLocalStorageToken(clean);
  await Promise.all([writeIndexedDbToken(clean), writeCacheStorageToken(clean)]);
}

async function sha256Hex(text: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

/**
 * Deterministic Canvas fingerprint using ONLY built-in system generic fonts.
 * Removes async Google Font race conditions completely.
 */
async function collectCanvasHash(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 240, 64);

    const grad = ctx.createLinearGradient(0, 0, 240, 64);
    grad.addColorStop(0, '#10b981');
    grad.addColorStop(1, '#3b82f6');
    ctx.fillStyle = grad;
    ctx.fillRect(6, 6, 228, 22);

    // Strictly generic built-in fonts only (immune to remote webfont load timing)
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('PnA-Verify-Sys-v2 #98765', 10, 10);

    ctx.font = '13px monospace';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText('0123456789-ABCD-xyz', 72, 40);

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
    ctx.beginPath();
    ctx.arc(36, 46, 12, 0, Math.PI * 1.65);
    ctx.stroke();

    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl || dataUrl.length < 32) return '';
    return await sha256Hex(dataUrl);
  } catch {
    return '';
  }
}

async function collectWebGLInfo(): Promise<{
  vendor: string;
  renderer: string;
  paramsHash: string;
}> {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: '', renderer: '', paramsHash: '' };

    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugExt
      ? String(gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) || '')
      : String(gl.getParameter(gl.VENDOR) || '');
    const renderer = debugExt
      ? String(gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) || '')
      : String(gl.getParameter(gl.RENDERER) || '');

    const params = [
      vendor,
      renderer,
      gl.getParameter(gl.VERSION),
      gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      gl.getParameter(gl.MAX_TEXTURE_SIZE),
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      (gl.getSupportedExtensions() || []).slice(0, 20).join(','),
    ].join('|');

    return {
      vendor: vendor.slice(0, 100),
      renderer: renderer.slice(0, 140),
      paramsHash: await sha256Hex(params),
    };
  } catch {
    return { vendor: '', renderer: '', paramsHash: '' };
  }
}

/**
 * Stabilized OfflineAudioContext fingerprint:
 * - 1500ms timeout (prevents cold-start misses on budget Android phones)
 * - Coarser 1e4 quantization (reduces sub-ULP floating-point drift)
 * - Returns "" when unsupported or timed out (backend treats "" as missing, not mismatch)
 */
async function collectAudioHash(): Promise<string> {
  try {
    const OfflineCtx =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;
    if (!OfflineCtx) return '';

    const ctx = new OfflineCtx(1, 4096, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(10000, ctx.currentTime);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-50, ctx.currentTime);
    compressor.knee.setValueAtTime(40, ctx.currentTime);
    compressor.ratio.setValueAtTime(12, ctx.currentTime);
    compressor.attack.setValueAtTime(0, ctx.currentTime);
    compressor.release.setValueAtTime(0.25, ctx.currentTime);

    osc.connect(compressor);
    compressor.connect(ctx.destination);
    osc.start(0);

    const rendered = await Promise.race([
      ctx.startRendering(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);

    if (!rendered) return '';
    const channel = rendered.getChannelData(0);
    let acc = '';
    for (let i = 1000; i < 1200; i += 5) {
      acc += Math.round(channel[i] * 10000).toString(36) + ',';
    }
    if (!acc) return '';
    return await sha256Hex(acc);
  } catch {
    return '';
  }
}

async function collectFontMetricsHash(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const sample = 'mmmmmmmmmmlli0123456789';
    const families = ['sans-serif', 'serif', 'monospace', 'Arial', 'Roboto', 'Georgia', 'Courier New'];
    const widths: string[] = [];
    for (const family of families) {
      ctx.font = `16px "${family}", sans-serif`;
      widths.push(`${family}:${Math.round(ctx.measureText(sample).width)}`);
    }
    return await sha256Hex(widths.join('|'));
  } catch {
    return '';
  }
}

function detectAutomationSignals(): string[] {
  const signals: string[] = [];
  const win = window as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;

  if (nav.webdriver === true) signals.push('navigator_webdriver');
  if ('_phantom' in win || 'callPhantom' in win) signals.push('phantom');
  if ('__nightmare' in win) signals.push('nightmare');
  if ('__puppeteer_evaluation_script__' in win) signals.push('puppeteer');
  if ('__playwright' in win || '__pw_manual' in win) signals.push('playwright');
  if (typeof navigator.userAgent === 'string' && /HeadlessChrome/i.test(navigator.userAgent)) {
    signals.push('headless_ua');
  }
  return signals;
}

interface NavigatorUAData {
  platform?: string;
  getHighEntropyValues?: (
    hints: string[]
  ) => Promise<{
    model?: string;
    platformVersion?: string;
    architecture?: string;
    fullVersionList?: Array<{ brand?: string; version?: string }>;
  }>;
}

async function collectUserAgentSignals(): Promise<{
  userAgentFamily: string;
  osVersion: string;
  webviewVersion: string;
  deviceModel: string;
}> {
  const ua = String(navigator.userAgent || '');
  const parts: string[] = [];
  if (/Android/i.test(ua)) parts.push('Android');
  else if (/iPhone|iPad|iPod/i.test(ua)) parts.push('iOS');
  else if (/Windows/i.test(ua)) parts.push('Windows');
  else if (/Mac OS X/i.test(ua)) parts.push('macOS');
  else if (/Linux/i.test(ua)) parts.push('Linux');
  else parts.push('OtherOS');

  if (/Telegram/i.test(ua)) parts.push('TelegramWebView');
  else if (/;\s*wv\)/i.test(ua)) parts.push('AndroidWebView');

  if (/Chrome\//i.test(ua)) parts.push('Chromium');
  else if (/Safari\//i.test(ua)) parts.push('WebKit');
  else if (/Firefox\//i.test(ua)) parts.push('Gecko');

  let osVersion = '';
  const androidMatch = ua.match(/Android\s+([0-9]+(?:\.[0-9]+)?)/i);
  const iosMatch = ua.match(/OS\s+([0-9]+_[0-9]+)/i);
  if (androidMatch) osVersion = `Android ${androidMatch[1]}`;
  else if (iosMatch) osVersion = `iOS ${iosMatch[1].replace(/_/g, '.')}`;

  let webviewVersion = '';
  const chromeMatch = ua.match(/Chrome\/([0-9]+\.[0-9]+)/i);
  const versionMatch = ua.match(/Version\/([0-9]+\.[0-9]+)/i);
  if (chromeMatch) webviewVersion = `Chrome/${chromeMatch[1]}`;
  else if (versionMatch) webviewVersion = `WebKit/${versionMatch[1]}`;

  let deviceModel = '';
  const uaModelMatch = ua.match(/Android\s+[0-9.]+;\s*([^;)]+?)(?:\s+Build\/|[;)])/i);
  if (uaModelMatch && uaModelMatch[1]) {
    const candidate = uaModelMatch[1].trim();
    if (candidate && candidate.toUpperCase() !== 'K' && candidate.toLowerCase() !== 'mobile') {
      deviceModel = candidate.slice(0, 64);
    }
  }

  // Optional User-Agent Client Hints (recovers Android device model & OS version cleanly)
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
  if (nav.userAgentData && typeof nav.userAgentData.getHighEntropyValues === 'function') {
    try {
      const hints = await Promise.race([
        nav.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (hints) {
        if (hints.model && String(hints.model).trim()) {
          deviceModel = String(hints.model).trim().slice(0, 64);
        }
        if (hints.platformVersion && String(hints.platformVersion).trim()) {
          const pv = String(hints.platformVersion).trim().split('.')[0];
          if (pv && /Android/i.test(ua)) {
            osVersion = `Android ${pv}`;
          }
        }
        if (Array.isArray(hints.fullVersionList)) {
          const chromiumBrand = hints.fullVersionList.find((b) =>
            /chrom/i.test(String(b?.brand || ''))
          );
          if (chromiumBrand?.version) {
            const majorMinor = String(chromiumBrand.version).split('.').slice(0, 2).join('.');
            if (majorMinor) webviewVersion = `Chrome/${majorMinor}`;
          }
        }
      }
    } catch {
      // ignore Client Hints denial/unavailability
    }
  }

  return {
    userAgentFamily: parts.join('/'),
    osVersion: osVersion.slice(0, 32),
    webviewVersion: webviewVersion.slice(0, 32),
    deviceModel: deviceModel.slice(0, 64),
  };
}

export async function collectDeviceFingerprint(
  telegramPlatform: string
): Promise<DeviceFingerprintSignals> {
  const [canvasHash, webgl, audioHash, fontMetricsHash, uaSignals, tgNative] = await Promise.all([
    collectCanvasHash(),
    collectWebGLInfo(),
    collectAudioHash(),
    collectFontMetricsHash(),
    collectUserAgentSignals(),
    collectTelegramNativeSignals(),
  ]);

  const nav = navigator as Navigator & { deviceMemory?: number };
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();

  const automationSignals = detectAutomationSignals();
  const safeNative: TelegramNativeSignals = tgNative;

  return {
    canvasHash,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    webglParamsHash: webgl.paramsHash,
    audioHash,
    fontMetricsHash,
    screenWidth: Number(window.screen?.width || 0),
    screenHeight: Number(window.screen?.height || 0),
    colorDepth: Number(window.screen?.colorDepth || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    timezone: tz,
    timezoneOffset: new Date().getTimezoneOffset(),
    language: String(navigator.language || ''),
    languagesCount: Array.isArray(navigator.languages) ? navigator.languages.length : 0,
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    deviceMemory: Number(nav.deviceMemory || 0),
    maxTouchPoints: Number(navigator.maxTouchPoints || 0),
    platform: String(navigator.platform || ''),
    telegramPlatform: String(telegramPlatform || safeNative.platform || 'unknown'),
    telegramVersion: safeNative.webAppVersion || '',
    userAgentFamily: uaSignals.userAgentFamily,
    osVersion: uaSignals.osVersion,
    webviewVersion: uaSignals.webviewVersion,
    deviceModel: uaSignals.deviceModel,
    webdriver: Boolean(navigator.webdriver),
    automationSignals,
    telegramNative: {
      biometricSupported: safeNative.biometricSupported,
      biometricInited: safeNative.biometricInited,
      biometricAvailable: safeNative.biometricAvailable,
      biometricType: safeNative.biometricType,
      biometricAccessGranted: safeNative.biometricAccessGranted,
      biometricDeviceId: safeNative.biometricDeviceId,
      deviceStorageSupported: safeNative.deviceStorageSupported,
      accountContinuityId: safeNative.accountContinuityId,
      accountContinuityRestored: safeNative.accountContinuityRestored,
    },
  };
}
