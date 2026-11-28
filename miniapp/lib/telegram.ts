// ============================================================================
// Telegram WebApp SDK Wrapper (Safe for Telegram iOS, Android, Desktop & Web)
// ============================================================================
// Supports version-gated, strictly optional collection of:
//  - Telegram.WebApp.version & platform
//  - Telegram.WebApp.BiometricManager.deviceId (Bot API 7.2+, read-only after
//    init(); NEVER triggers biometric authentication or permission prompts)
//  - Telegram.WebApp.DeviceStorage (Bot API 9.0+, per-bot + per-user scoped
//    for same-account continuity detection only)
// ============================================================================

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TelegramNativeSignals {
  webAppVersion: string;
  platform: string;
  biometricSupported: boolean;
  biometricInited: boolean;
  biometricAvailable: boolean;
  biometricType: string;
  biometricAccessRequested: boolean;
  biometricAccessGranted: boolean;
  biometricDeviceId: string;
  deviceStorageSupported: boolean;
  accountContinuityId: string;
  accountContinuityRestored: boolean;
}

interface TelegramBiometricManager {
  isInited?: boolean;
  isBiometricAvailable?: boolean;
  biometricType?: string;
  isAccessRequested?: boolean;
  isAccessGranted?: boolean;
  isBiometricTokenSaved?: boolean;
  deviceId?: string;
  init?: (callback?: () => void) => void;
}

interface TelegramKeyValueStorage {
  setItem?: (key: string, value: string, callback?: (err: unknown, stored?: boolean) => void) => void;
  getItem?: (key: string, callback?: (err: unknown, value?: string | null) => void) => void;
}

interface TelegramWebAppInstance {
  initData: string;
  initDataUnsafe?: {
    user?: TelegramWebAppUser;
    auth_date?: number;
  };
  platform?: string;
  version?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  isVersionAtLeast?: (version: string) => boolean;
  ready: () => void;
  expand: () => void;
  close: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  BiometricManager?: TelegramBiometricManager;
  DeviceStorage?: TelegramKeyValueStorage;
  SecureStorage?: TelegramKeyValueStorage;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebAppInstance;
    };
  }
}

const ACCOUNT_CONTINUITY_KEY = 'pna_acct_cont_v1';

export function getTelegramWebApp(): TelegramWebAppInstance | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp || null;
}

function isVersionAtLeastSafe(tg: TelegramWebAppInstance, minVersion: string): boolean {
  try {
    if (typeof tg.isVersionAtLeast === 'function') {
      return Boolean(tg.isVersionAtLeast(minVersion));
    }
    const raw = String(tg.version || '0.0');
    const a = raw.split('.').map((n) => Number(n) || 0);
    const b = minVersion.split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] || 0;
      const bv = b[i] || 0;
      if (av > bv) return true;
      if (av < bv) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function generateOpaqueContinuityId(): string {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
  }
}

/**
 * Safely initialize BiometricManager (Bot API 7.2+) strictly in read-only mode.
 * NEVER prompts biometric authentication and NEVER requests biometric permission.
 */
async function readOptionalBiometricSignals(tg: TelegramWebAppInstance): Promise<{
  supported: boolean;
  inited: boolean;
  available: boolean;
  biometricType: string;
  accessRequested: boolean;
  accessGranted: boolean;
  deviceId: string;
}> {
  const empty = {
    supported: false,
    inited: false,
    available: false,
    biometricType: '',
    accessRequested: false,
    accessGranted: false,
    deviceId: '',
  };

  if (!isVersionAtLeastSafe(tg, '7.2') || !tg.BiometricManager) {
    return empty;
  }

  const bm = tg.BiometricManager;
  try {
    if (!bm.isInited && typeof bm.init === 'function') {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const timer = setTimeout(done, 1000);
        try {
          bm.init?.(() => {
            clearTimeout(timer);
            done();
          });
        } catch {
          clearTimeout(timer);
          done();
        }
      });
    }

    return {
      supported: true,
      inited: Boolean(bm.isInited),
      available: Boolean(bm.isBiometricAvailable),
      biometricType: String(bm.biometricType || '').slice(0, 32),
      accessRequested: Boolean(bm.isAccessRequested),
      accessGranted: Boolean(bm.isAccessGranted),
      deviceId: String(bm.deviceId || '').trim().slice(0, 128),
    };
  } catch {
    return { ...empty, supported: true };
  }
}

function readStorageItem(storage: TelegramKeyValueStorage | undefined, key: string): Promise<string> {
  return new Promise((resolve) => {
    if (!storage || typeof storage.getItem !== 'function') {
      resolve('');
      return;
    }
    let settled = false;
    const done = (val: string) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const timer = setTimeout(() => done(''), 700);
    try {
      storage.getItem(key, (err, value) => {
        clearTimeout(timer);
        if (err || typeof value !== 'string') {
          done('');
          return;
        }
        done(value.trim().slice(0, 128));
      });
    } catch {
      clearTimeout(timer);
      done('');
    }
  });
}

function writeStorageItem(
  storage: TelegramKeyValueStorage | undefined,
  key: string,
  value: string
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!storage || typeof storage.setItem !== 'function') {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const timer = setTimeout(() => done(false), 700);
    try {
      storage.setItem(key, value, (err, stored) => {
        clearTimeout(timer);
        done(!err && stored !== false);
      });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

/**
 * Use Bot API 9.0+ DeviceStorage strictly within its documented scope
 * (per-bot + per-Telegram-user) to detect same-account continuity / device switches.
 * Never triggers biometric prompts and degrades cleanly on older clients.
 */
async function readOrInitAccountContinuity(tg: TelegramWebAppInstance): Promise<{
  supported: boolean;
  continuityId: string;
  restored: boolean;
}> {
  if (!isVersionAtLeastSafe(tg, '9.0') || !tg.DeviceStorage) {
    return { supported: false, continuityId: '', restored: false };
  }

  try {
    const existing = await readStorageItem(tg.DeviceStorage, ACCOUNT_CONTINUITY_KEY);
    if (existing && /^[a-f0-9]{16,64}$/i.test(existing)) {
      return { supported: true, continuityId: existing, restored: true };
    }
    const created = generateOpaqueContinuityId();
    const saved = await writeStorageItem(tg.DeviceStorage, ACCOUNT_CONTINUITY_KEY, created);
    return {
      supported: true,
      continuityId: saved ? created : '',
      restored: false,
    };
  } catch {
    return { supported: true, continuityId: '', restored: false };
  }
}

export async function collectTelegramNativeSignals(): Promise<TelegramNativeSignals> {
  const tg = getTelegramWebApp();
  if (!tg) {
    return {
      webAppVersion: '',
      platform: 'browser',
      biometricSupported: false,
      biometricInited: false,
      biometricAvailable: false,
      biometricType: '',
      biometricAccessRequested: false,
      biometricAccessGranted: false,
      biometricDeviceId: '',
      deviceStorageSupported: false,
      accountContinuityId: '',
      accountContinuityRestored: false,
    };
  }

  const [bio, cont] = await Promise.all([
    readOptionalBiometricSignals(tg),
    readOrInitAccountContinuity(tg),
  ]);

  return {
    webAppVersion: String(tg.version || '').trim().slice(0, 24),
    platform: String(tg.platform || 'unknown').trim().slice(0, 32),
    biometricSupported: bio.supported,
    biometricInited: bio.inited,
    biometricAvailable: bio.available,
    biometricType: bio.biometricType,
    biometricAccessRequested: bio.accessRequested,
    biometricAccessGranted: bio.accessGranted,
    biometricDeviceId: bio.deviceId,
    deviceStorageSupported: cont.supported,
    accountContinuityId: cont.continuityId,
    accountContinuityRestored: cont.restored,
  };
}

export function initTelegramMiniApp(): {
  isInsideTelegram: boolean;
  initData: string;
  user: TelegramWebAppUser | null;
  platform: string;
  version: string;
  colorScheme: 'light' | 'dark';
} {
  const tg = getTelegramWebApp();
  if (!tg) {
    return {
      isInsideTelegram: false,
      initData: '',
      user: null,
      platform: 'browser',
      version: '',
      colorScheme: 'dark',
    };
  }

  try {
    tg.ready();
    tg.expand();
  } catch {
    // ignore SDK errors on older clients
  }

  const scheme = tg.colorScheme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', scheme);

  try {
    const bg = scheme === 'light' ? '#f4f7f9' : '#0b1117';
    tg.setHeaderColor?.(bg);
    tg.setBackgroundColor?.(bg);
  } catch {
    // ignore unsupported color methods
  }

  const initData = String(tg.initData || '').trim();
  return {
    isInsideTelegram: Boolean(initData),
    initData,
    user: tg.initDataUnsafe?.user || null,
    platform: String(tg.platform || 'unknown'),
    version: String(tg.version || ''),
    colorScheme: scheme,
  };
}

export function triggerHaptic(type: 'light' | 'medium' | 'success' | 'warning' | 'error') {
  const hf = getTelegramWebApp()?.HapticFeedback;
  if (!hf) return;
  try {
    if (type === 'light' || type === 'medium') {
      hf.impactOccurred(type);
    } else {
      hf.notificationOccurred(type);
    }
  } catch {
    // ignore unsupported haptics
  }
}

export function closeTelegramMiniApp() {
  const tg = getTelegramWebApp();
  if (tg && typeof tg.close === 'function') {
    tg.close();
  }
}
