// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Real Colourful Telegram Reply Keyboards & Secondary Actions
// ============================================================================
// Uses Telegram Bot API KeyboardButton `style` field on ReplyKeyboardMarkup:
//   "success" = GREEN
//   "primary" = BLUE
//   "danger"  = RED
// Main user and admin navigation stays persistently at the bottom of chat.
// Inline buttons are used ONLY for external URLs or item/request-specific actions.
// ============================================================================

import {
  ADMIN_BUTTONS,
  BUTTON_STYLES,
  MENU_BUTTONS,
  VOUCHER_CATEGORY_LIST,
} from './config.js';

const { SUCCESS, PRIMARY, DANGER } = BUTTON_STYLES;

/**
 * Colourful Persistent User Main Menu ReplyKeyboard:
 * Row 1: 💰 My Balance (GREEN) | 👥 Refer & Earn (BLUE)
 * Row 2: 💸 Withdraw (RED)     | 🎁 Daily Bonus (GREEN)
 * Row 3: 👤 My Profile (BLUE)  | 📢 Update Channel (GREEN)
 * Row 4: 🎧 Support (BLUE)
 * Row 5 (Admins only): 👑 Admin Panel (BLUE)
 */
export function mainMenuKeyboard(isAdminUser = false) {
  const rows = [
    [
      { text: MENU_BUTTONS.BALANCE, style: SUCCESS },
      { text: MENU_BUTTONS.REFER, style: PRIMARY },
    ],
    [
      { text: MENU_BUTTONS.WITHDRAW, style: DANGER },
      { text: MENU_BUTTONS.DAILY_BONUS, style: SUCCESS },
    ],
    [
      { text: MENU_BUTTONS.PROFILE, style: PRIMARY },
      { text: MENU_BUTTONS.UPDATE_CHANNEL, style: SUCCESS },
    ],
    [{ text: MENU_BUTTONS.SUPPORT, style: PRIMARY }],
  ];

  if (isAdminUser) {
    rows.push([{ text: MENU_BUTTONS.ADMIN_PANEL, style: PRIMARY }]);
  }

  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

/**
 * Colourful Persistent Admin Panel ReplyKeyboard (Bottom Navigation — No Inline Dashboard):
 * Row 1: ➕ Add Voucher (GREEN)    | 📋 Pending Requests (BLUE)
 * Row 2: 📢 Force Channels (GREEN) | ⚙️ Settings (BLUE)
 * Row 3: 👥 Users List (BLUE)      | 👑 Add Admin (GREEN)
 * Row 4: 📊 Statistics (BLUE)      | 📣 Broadcast (GREEN)
 * Row 5: 📦 Voucher Stock (GREEN)  | 📝 Voucher History (BLUE)
 * Row 6: 🚨 Low Stock (RED)        | 🔧 Maintenance (RED)
 * Row 7: 📜 Activity Logs (BLUE)   | 🏠 Main Menu (BLUE)
 */
export function adminReplyKeyboard() {
  return {
    keyboard: [
      [
        { text: ADMIN_BUTTONS.ADD_VOUCHER, style: SUCCESS },
        { text: ADMIN_BUTTONS.PENDING_REQUESTS, style: PRIMARY },
      ],
      [
        { text: ADMIN_BUTTONS.MANAGE_BALANCE, style: SUCCESS },
        { text: ADMIN_BUTTONS.SECRETARY_MODE, style: PRIMARY },
      ],
      [
        { text: ADMIN_BUTTONS.FORCE_CHANNELS, style: SUCCESS },
        { text: ADMIN_BUTTONS.SETTINGS, style: PRIMARY },
      ],
      [
        { text: ADMIN_BUTTONS.USERS_LIST, style: PRIMARY },
        { text: ADMIN_BUTTONS.ADD_ADMIN, style: SUCCESS },
      ],
      [
        { text: ADMIN_BUTTONS.STATISTICS, style: PRIMARY },
        { text: ADMIN_BUTTONS.BROADCAST, style: SUCCESS },
      ],
      [
        { text: ADMIN_BUTTONS.VOUCHER_STOCK, style: SUCCESS },
        { text: ADMIN_BUTTONS.VOUCHER_HISTORY, style: PRIMARY },
      ],
      [
        { text: ADMIN_BUTTONS.LOW_STOCK, style: DANGER },
        { text: ADMIN_BUTTONS.MAINTENANCE, style: DANGER },
      ],
      [
        { text: ADMIN_BUTTONS.ACTIVITY_LOGS, style: PRIMARY },
        { text: MENU_BUTTONS.MAIN_MENU, style: PRIMARY },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

/**
 * Colourful Cancel / Escape ReplyKeyboard for multi-step text/media inputs.
 */
export function cancelInputKeyboard(isAdminContext = false) {
  return {
    keyboard: [
      [
        { text: MENU_BUTTONS.CANCEL, style: DANGER },
        {
          text: isAdminContext ? MENU_BUTTONS.ADMIN_PANEL : MENU_BUTTONS.MAIN_MENU,
          style: PRIMARY,
        },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

// ============================================================================
// SECONDARY INLINE KEYBOARDS (External URLs & Item/Request-Specific Actions Only)
// ============================================================================

/**
 * Force-join channel URL buttons + ✅ VERIFY MEMBERSHIP action.
 */
export function forceJoinKeyboard(channels) {
  const inline_keyboard = [];
  const multiple = channels.length > 1;

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (ch.inviteLink) {
      const label = multiple
        ? `🔗 JOIN CHANNEL (${ch.title || `#${i + 1}`})`
        : '🔗 JOIN CHANNEL';
      inline_keyboard.push([
        {
          text: label.slice(0, 60),
          url: ch.inviteLink,
        },
      ]);
    }
  }

  inline_keyboard.push([{ text: '✅ VERIFY MEMBERSHIP', callback_data: 'fj:verify' }]);
  return { inline_keyboard };
}

export function balanceInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📜 Transaction History', callback_data: 'usr:ledger' }],
      [{ text: '🎟️ My Vouchers & Withdrawals', callback_data: 'usr:history' }],
    ],
  };
}

export function referralInlineKeyboard(referralLink, rewardText) {
  const shareText = encodeURIComponent(
    `🎁 Join 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 & earn ${rewardText} per referral + daily bonuses & free gift vouchers!\n\n👇 Start earning now:`
  );
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${shareText}`;
  return {
    inline_keyboard: [
      [{ text: '📤 Share Referral Link', url: shareUrl }],
      [{ text: '📋 My Referral List', callback_data: 'usr:ref_list' }],
    ],
  };
}

export function dailyBonusInlineKeyboard(canClaim) {
  const rows = [];
  if (canClaim) {
    rows.push([{ text: '🎁 Claim Daily Bonus Now', callback_data: 'bonus:claim' }]);
  } else {
    rows.push([{ text: '🔄 Refresh Countdown', callback_data: 'bonus:refresh' }]);
  }
  rows.push([{ text: '📜 My Bonus History', callback_data: 'bonus:history' }]);
  return { inline_keyboard: rows };
}

export function profileInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📜 Transaction History', callback_data: 'usr:ledger' }],
      [{ text: '🎟️ My Vouchers & Withdrawals', callback_data: 'usr:history' }],
    ],
  };
}

export function withdrawCategoriesKeyboard(stockSummary) {
  const rows = [];
  for (const cat of VOUCHER_CATEGORY_LIST) {
    const info = stockSummary.categories[cat.key];
    const badge = info.inStock ? `🟢 IN STOCK (${info.availableCount})` : '🔴 OUT OF STOCK';
    rows.push([
      {
        text: `${cat.emoji} ${cat.shortName} — ${badge}`,
        callback_data: `wd:cat:${cat.key}`,
      },
    ]);
  }
  rows.push([{ text: '📜 My Withdrawal History', callback_data: 'usr:history' }]);
  return { inline_keyboard: rows };
}

export function withdrawConfirmKeyboard(categoryKey) {
  return {
    inline_keyboard: [
      [{ text: '✅ Confirm Withdrawal Request', callback_data: `wd:confirm:${categoryKey}` }],
      [{ text: '⬅️ Change Category', callback_data: 'usr:withdraw' }],
    ],
  };
}

export function supportInlineKeyboard(supportUsername) {
  const clean = String(supportUsername || '@Pritam_power').replace(/^@/, '');
  return {
    inline_keyboard: [[{ text: `💬 Message @${clean}`, url: `https://t.me/${clean}` }]],
  };
}

export function updateChannelInlineKeyboard(channelUrl) {
  return {
    inline_keyboard: [[{ text: '📢 Join Update Channel', url: channelUrl }]],
  };
}

/**
 * Optional secondary action keyboard for admin item views (never renders full admin menu inline).
 */
export function adminActionKeyboard(extraRows = []) {
  if (!extraRows || !extraRows.length) return undefined;
  return { inline_keyboard: extraRows };
}

export function withdrawalAdminDecisionKeyboard(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ APPROVE', callback_data: `adm:wd_approve:${requestId}` },
        { text: '❌ REJECT', callback_data: `adm:wd_reject:${requestId}` },
      ],
      [{ text: '📋 All Pending Requests', callback_data: 'adm:pending:1' }],
    ],
  };
}

export function voucherCategorySelectKeyboard(prefix) {
  const rows = VOUCHER_CATEGORY_LIST.map((cat) => [
    {
      text: `${cat.emoji} ${cat.name}`,
      callback_data: `${prefix}:${cat.key}`,
    },
  ]);
  return { inline_keyboard: rows };
}

export function paginationRow(prefix, page, totalPages) {
  const row = [];
  if (page > 1) {
    row.push({ text: '⬅️ Previous', callback_data: `${prefix}:${page - 1}` });
  }
  row.push({ text: `📄 ${page}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages) {
    row.push({ text: 'Next ➡️', callback_data: `${prefix}:${page + 1}` });
  }
  return row;
}
