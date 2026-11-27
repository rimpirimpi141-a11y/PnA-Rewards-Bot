// ============================================================================
// Telegram WebApp SDK Wrapper (Safe for Telegram iOS, Android, Desktop & Web)
// ============================================================================

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
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
  ready: () => void;
  expand: () => void;
  close: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
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

export function getTelegramWebApp(): TelegramWebAppInstance | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp || null;
}

export function initTelegramMiniApp(): {
  isInsideTelegram: boolean;
  initData: string;
  user: TelegramWebAppUser | null;
  platform: string;
  colorScheme: 'light' | 'dark';
} {
  const tg = getTelegramWebApp();
  if (!tg) {
    return {
      isInsideTelegram: false,
      initData: '',
      user: null,
      platform: 'browser',
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
