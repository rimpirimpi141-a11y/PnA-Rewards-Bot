// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Global Configuration, Constants & Formatting Utilities
// ============================================================================

export const BOT_BRAND = '𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒';
export const DEFAULT_OWNER_ID = '8838351233';
export const DEFAULT_SUPPORT_USERNAME = '@Pritam_power';
export const DEFAULT_UPDATE_CHANNEL_URL = 'https://t.me/pnarewards';
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_WEBHOOK_PATH = '/webhook';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 7 * DAY_MS;

export const VOUCHER_CATEGORIES = {
  amazon: {
    key: 'amazon',
    name: 'Amazon Gift Vouchers',
    shortName: 'Amazon',
    emoji: '🛒',
  },
  google_play: {
    key: 'google_play',
    name: 'Google Play Redeem Codes',
    shortName: 'Google Play',
    emoji: '🎮',
  },
  other: {
    key: 'other',
    name: 'Other Redeem Codes',
    shortName: 'Other Codes',
    emoji: '🎟️',
  },
};

export const VOUCHER_CATEGORY_LIST = Object.values(VOUCHER_CATEGORIES);

export const DEFAULT_ADMIN_PERMISSIONS = {
  manageVouchers: true,
  approveWithdrawals: true,
  manageForceChannels: true,
  manageSettings: true,
  viewUsers: true,
  viewStats: true,
  broadcast: true,
  manageLowStock: true,
  manageMaintenance: true,
  viewLogs: true,
  manageAdmins: false, // Strictly Owner-only
};

export const OWNER_PERMISSIONS = {
  manageVouchers: true,
  approveWithdrawals: true,
  manageForceChannels: true,
  manageSettings: true,
  viewUsers: true,
  viewStats: true,
  broadcast: true,
  manageLowStock: true,
  manageMaintenance: true,
  viewLogs: true,
  manageAdmins: true,
};

export const DEFAULT_SETTINGS = {
  referralRewardPaise: 300, // ₹3.00
  dailyBonusPaise: 25, // ₹0.25 (below ₹1 by default)
  minWithdrawalPaise: 1000, // ₹10.00 (configurable by admin)
  defaultVoucherValuePaise: 1000, // ₹10.00
  initialStockTargetCount: 50,
  maintenanceMode: false,
  maintenanceMessage:
    '🔧 <b>Scheduled Maintenance</b>\n\n𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 is currently undergoing maintenance to improve your experience.\n\n✅ Your balance, referrals, and vouchers remain 100% safe.\n⏳ Please check back shortly!',
  supportUsername: DEFAULT_SUPPORT_USERNAME,
  updateChannelUrl: DEFAULT_UPDATE_CHANNEL_URL,
  lowStockThresholds: {
    amazon: 5,
    google_play: 5,
    other: 5,
  },
  lowStockAlertSent: {
    amazon: false,
    google_play: false,
    other: false,
  },
  updatedAt: null,
};

export const BUTTON_STYLES = {
  SUCCESS: 'success', // GREEN
  PRIMARY: 'primary', // BLUE
  DANGER: 'danger', // RED
};

export const MENU_BUTTONS = {
  BALANCE: '💰 My Balance',
  REFER: '👥 Refer & Earn',
  WITHDRAW: '💸 Withdraw',
  DAILY_BONUS: '🎁 Daily Bonus',
  PROFILE: '👤 My Profile',
  UPDATE_CHANNEL: '📢 Update Channel',
  SUPPORT: '🎧 Support',
  ADMIN_PANEL: '👑 Admin Panel',
  MAIN_MENU: '🏠 Main Menu',
  CANCEL: '❌ Cancel',
};

export const ADMIN_BUTTONS = {
  ADD_VOUCHER: '➕ Add Voucher',
  PENDING_REQUESTS: '📋 Pending Requests',
  FORCE_CHANNELS: '📢 Force Channels',
  SETTINGS: '⚙️ Settings',
  USERS_LIST: '👥 Users List',
  ADD_ADMIN: '👑 Add Admin',
  STATISTICS: '📊 Statistics',
  BROADCAST: '📣 Broadcast',
  VOUCHER_STOCK: '📦 Voucher Stock',
  VOUCHER_HISTORY: '📝 Voucher History',
  LOW_STOCK: '🚨 Low Stock',
  MAINTENANCE: '🔧 Maintenance',
  ACTIVITY_LOGS: '📜 Activity Logs',
};

export const ACTIVITY_ACTIONS = {
  VOUCHER_ADDED: 'VOUCHER_ADDED',
  VOUCHER_DISABLED: 'VOUCHER_DISABLED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  FORCE_CHANNEL_ADDED: 'FORCE_CHANNEL_ADDED',
  FORCE_CHANNEL_REMOVED: 'FORCE_CHANNEL_REMOVED',
  ADMIN_ADDED: 'ADMIN_ADDED',
  ADMIN_REMOVED: 'ADMIN_REMOVED',
  MIN_WITHDRAWAL_CHANGED: 'MIN_WITHDRAWAL_CHANGED',
  REFERRAL_REWARD_CHANGED: 'REFERRAL_REWARD_CHANGED',
  DAILY_BONUS_CHANGED: 'DAILY_BONUS_CHANGED',
  VOUCHER_VALUE_CHANGED: 'VOUCHER_VALUE_CHANGED',
  LOW_STOCK_THRESHOLD_CHANGED: 'LOW_STOCK_THRESHOLD_CHANGED',
  MAINTENANCE_ENABLED: 'MAINTENANCE_ENABLED',
  MAINTENANCE_DISABLED: 'MAINTENANCE_DISABLED',
  BROADCAST_SENT: 'BROADCAST_SENT',
  USER_STATUS_CHANGED: 'USER_STATUS_CHANGED',
};

export function getOwnerId(env) {
  const configured = env?.OWNER_ID ? String(env.OWNER_ID).trim() : '';
  return configured || DEFAULT_OWNER_ID;
}

export function getTimezone(env) {
  return env?.TIMEZONE ? String(env.TIMEZONE).trim() : DEFAULT_TIMEZONE;
}

export function getWebhookPath(env) {
  const raw = env?.WEBHOOK_PATH ? String(env.WEBHOOK_PATH).trim() : DEFAULT_WEBHOOK_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Convert INR decimal amount (e.g. 0.25, 3, 10) safely into integer paise.
 */
export function inrToPaise(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

/**
 * Format integer paise into a clean INR string (e.g., ₹3.00 or ₹0.25).
 */
export function formatINR(paise) {
  const safe = Number.isFinite(Number(paise)) ? Math.round(Number(paise)) : 0;
  const sign = safe < 0 ? '-' : '';
  const abs = Math.abs(safe);
  const rupees = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}₹${rupees}.${String(rem).padStart(2, '0')}`;
}

/**
 * Escape HTML special characters for Telegram HTML parse_mode.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format timestamp (ms or ISO) in Asia/Kolkata timezone.
 */
export function formatIST(timestamp, env) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'N/A';
  const tz = getTimezone(env);
  try {
    return (
      new Intl.DateTimeFormat('en-IN', {
        timeZone: tz,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }).format(date) + ' IST'
    );
  } catch {
    return date.toISOString();
  }
}

/**
 * Format IST calendar date string (YYYY-MM-DD) for daily logs.
 */
export function getISTDateKey(timestamp = Date.now(), env) {
  const tz = getTimezone(env);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

/**
 * Format milliseconds remaining as "12h 34m 56s".
 */
export function formatCountdown(ms) {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Format a user's display name safely.
 */
export function formatUserName(user) {
  if (!user) return 'Unknown User';
  const full = [user.firstName || user.first_name || '', user.lastName || user.last_name || '']
    .join(' ')
    .trim();
  return full || 'Telegram User';
}

export function formatUsernameTag(username) {
  if (!username) return 'No username';
  const clean = String(username).replace(/^@/, '').trim();
  return clean ? `@${clean}` : 'No username';
}

export function isValidTelegramUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (parsed.hostname === 't.me' ||
        parsed.hostname === 'telegram.me' ||
        parsed.hostname === 'telegram.dog')
    );
  } catch {
    return false;
  }
}

export function generateId(prefix) {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  return `${prefix}-${rand}`;
}

export function normalizeVoucherCode(code) {
  return String(code || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function getCategoryMeta(categoryKey) {
  return VOUCHER_CATEGORIES[categoryKey] || null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
