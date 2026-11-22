// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Keyboards (Reply & Inline Layouts)
// ============================================================================

import { MENU_BUTTONS, VOUCHER_CATEGORY_LIST } from './config.js';

/**
 * Main User Menu ReplyKeyboard:
 * - Three visually prominent primary buttons on top rows
 * - Cleanly organized secondary actions
 * - Optional Admin Panel button for authorized admins
 */
export function mainMenuKeyboard(isAdminUser = false) {
  const rows = [
    [{ text: MENU_BUTTONS.BALANCE }, { text: MENU_BUTTONS.REFER }],
    [{ text: MENU_BUTTONS.WITHDRAW }],
    [{ text: MENU_BUTTONS.DAILY_BONUS }, { text: MENU_BUTTONS.PROFILE }],
    [{ text: MENU_BUTTONS.UPDATE_CHANNEL }, { text: MENU_BUTTONS.SUPPORT }],
  ];

  if (isAdminUser) {
    rows.push([{ text: MENU_BUTTONS.ADMIN_PANEL }]);
  }

  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

/**
 * Cancel / Return keyboard for interactive text-input states.
 */
export function cancelInputKeyboard() {
  return {
    keyboard: [[{ text: MENU_BUTTONS.CANCEL }, { text: MENU_BUTTONS.MAIN_MENU }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

/**
 * Force-join channel buttons + verification CTA.
 */
export function forceJoinKeyboard(channels) {
  const inline_keyboard = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (ch.inviteLink) {
      inline_keyboard.push([
        {
          text: `📢 Join ${ch.title || `Channel ${i + 1}`}`,
          url: ch.inviteLink,
        },
      ]);
    }
  }
  inline_keyboard.push([{ text: '✅ JOINED - VERIFY', callback_data: 'fj:verify' }]);
  return { inline_keyboard };
}

export function balanceInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💸 Withdraw Now', callback_data: 'usr:withdraw' },
        { text: '👥 Refer & Earn', callback_data: 'usr:refer' },
      ],
      [
        { text: '🎁 Daily Bonus', callback_data: 'usr:bonus' },
        { text: '🎟️ My Vouchers', callback_data: 'usr:history' },
      ],
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
      [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
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
  rows.push([{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }]);
  return { inline_keyboard: rows };
}

export function profileInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎟️ My Vouchers & Withdrawals', callback_data: 'usr:history' }],
      [
        { text: '💰 My Balance', callback_data: 'usr:balance' },
        { text: '👥 Refer & Earn', callback_data: 'usr:refer' },
      ],
      [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
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
  rows.push([{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }]);
  return { inline_keyboard: rows };
}

export function withdrawConfirmKeyboard(categoryKey) {
  return {
    inline_keyboard: [
      [{ text: '✅ Confirm Withdrawal Request', callback_data: `wd:confirm:${categoryKey}` }],
      [{ text: '⬅️ Change Category', callback_data: 'usr:withdraw' }],
      [{ text: '❌ Cancel', callback_data: 'usr:home' }],
    ],
  };
}

export function supportInlineKeyboard(supportUsername) {
  const clean = String(supportUsername || '@Pritam_power').replace(/^@/, '');
  return {
    inline_keyboard: [
      [{ text: `💬 Message @${clean}`, url: `https://t.me/${clean}` }],
      [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
    ],
  };
}

export function updateChannelInlineKeyboard(channelUrl) {
  return {
    inline_keyboard: [
      [{ text: '📢 Join Update Channel', url: channelUrl }],
      [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
    ],
  };
}

// ============================================================================
// ADMIN PANEL KEYBOARDS (All 13 Requested Sections)
// ============================================================================

export function adminMainKeyboard(isOwnerUser = false) {
  const rows = [
    [
      { text: '➕ Add Voucher', callback_data: 'adm:add_voucher' },
      { text: '📋 Pending Requests', callback_data: 'adm:pending:1' },
    ],
    [
      { text: '📢 Force Channels', callback_data: 'adm:force_channels' },
      { text: '⚙️ Settings', callback_data: 'adm:settings' },
    ],
    [
      { text: '👥 Users List', callback_data: 'adm:users:1' },
      {
        text: isOwnerUser ? '👑 Manage Admins' : '👑 View Admins',
        callback_data: 'adm:admins',
      },
    ],
    [
      { text: '📊 Bot Statistics', callback_data: 'adm:stats' },
      { text: '📣 Broadcast', callback_data: 'adm:broadcast' },
    ],
    [
      { text: '📦 Voucher Stock', callback_data: 'adm:stock' },
      { text: '📝 Voucher History', callback_data: 'adm:vhist:1' },
    ],
    [
      { text: '🚨 Low Stock Settings', callback_data: 'adm:low_stock' },
      { text: '🔧 Maintenance Mode', callback_data: 'adm:maintenance' },
    ],
    [{ text: '📜 Admin Activity Logs', callback_data: 'adm:logs:1' }],
    [{ text: '🏠 Exit to Main Menu', callback_data: 'adm:exit' }],
  ];
  return { inline_keyboard: rows };
}

export function adminBackKeyboard(extraRows = []) {
  return {
    inline_keyboard: [
      ...extraRows,
      [{ text: '⬅️ Back to Admin Panel', callback_data: 'adm:menu' }],
    ],
  };
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
  rows.push([{ text: '⬅️ Back to Admin Panel', callback_data: 'adm:menu' }]);
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
