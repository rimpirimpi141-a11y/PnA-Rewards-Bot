// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Voucher Stock, Bulk Upload, History & Low Stock Alerts
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  ACTIVITY_ACTIONS,
  VOUCHER_CATEGORY_LIST,
  escapeHtml,
  formatINR,
  formatIST,
  formatUsernameTag,
  getCategoryMeta,
} from '../config.js';
import {
  clearUserState,
  countAvailableVouchersByCategory,
  getAllCategoryStockSummary,
  getAvailableVouchersByCategory,
  getSettings,
  getVoucherHistoryPage,
  hasAdminPermission,
  setUserState,
  updateSettings,
} from '../database.js';
import {
  adminActionKeyboard,
  adminReplyKeyboard,
  cancelInputKeyboard,
  paginationRow,
  voucherCategorySelectKeyboard,
} from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import {
  bulkAddVouchers,
  disableAvailableVoucher,
} from '../services/voucher-service.js';
import { answerCallbackQuery, editOrSend, sendMessage } from '../telegram.js';

/**
 * 1. ➕ Add Voucher — Step 1: Select category
 */
export async function handleAdminAddVoucherMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await sendMessage(env, chatId, '🚫 You do not have permission to manage vouchers.');
    return;
  }

  const settings = await getSettings(env);
  const text =
    `${buildHeader('➕', 'BULK ADD VOUCHERS')}\n` +
    `💵 <b>Current Default Voucher Value:</b> <b>${formatINR(settings.defaultVoucherValuePaise)}</b>\n` +
    `<i>(You can change default voucher value anytime in ⚙️ Settings)</i>\n\n` +
    `👇 Select the voucher category you want to restock:`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: voucherCategorySelectKeyboard('adm:vadd_cat'),
  });
}

/**
 * ➕ Add Voucher — Step 2: Prompt admin for multiline voucher codes
 */
export async function handleAdminAddVoucherCategory(env, callbackQuery, categoryKey) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const cat = getCategoryMeta(categoryKey);
  if (!cat) {
    await answerCallbackQuery(env, callbackQuery.id, 'Invalid category.', true);
    return;
  }

  const settings = await getSettings(env);
  await setUserState(env, adminId, {
    type: 'admin_bulk_vouchers',
    category: categoryKey,
    valuePaise: settings.defaultVoucherValuePaise,
  });

  await answerCallbackQuery(env, callbackQuery.id, `Selected ${cat.shortName}`);
  await sendMessage(
    env,
    chatId,
    `${buildHeader('📥', `UPLOAD ${cat.shortName.toUpperCase()} VOUCHERS`)}\n` +
      `🎟️ <b>Category:</b> ${cat.emoji} ${escapeHtml(cat.name)}\n` +
      `💵 <b>Value per Voucher:</b> <b>${formatINR(settings.defaultVoucherValuePaise)}</b>\n` +
      `${DIVIDER}\n` +
      `Paste your voucher codes in <b>one message</b>, one code per line:\n\n` +
      `<code>CODE123456\nCODE987654\nCODE456789\nCODE111222</code>\n\n` +
      `✅ Whitespace & blank lines are cleaned automatically\n` +
      `🛡️ Global duplicate codes are rejected automatically\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

/**
 * ➕ Add Voucher — Step 3: Process pasted multiline codes
 */
export async function handleAdminBulkVoucherInput(env, message, state) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await clearUserState(env, adminId);
    return;
  }

  const rawText = message.text || '';
  if (!rawText.trim()) {
    await sendMessage(env, chatId, '⚠️ Please send text containing at least one voucher code.');
    return;
  }

  const result = await bulkAddVouchers(env, {
    category: state.category,
    rawText,
    valuePaise: state.valuePaise,
    adminId,
  });

  await clearUserState(env, adminId);

  if (!result.ok) {
    await sendMessage(env, chatId, `❌ <b>Upload Failed:</b> ${escapeHtml(result.error)}`, {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  const cat = getCategoryMeta(result.category);
  const stockBadge = result.currentStock > 0 ? '🟢 IN STOCK' : '🔴 OUT OF STOCK';

  const text =
    `${buildHeader('✅', 'BULK VOUCHER UPLOAD COMPLETE')}\n` +
    `🎟️ <b>Category:</b> ${cat.emoji} ${escapeHtml(cat.name)}\n` +
    `💵 <b>Voucher Value:</b> <b>${formatINR(result.valuePaise)}</b>\n` +
    `${DIVIDER}\n` +
    `✅ <b>Successfully Added:</b> <b>${result.addedCount}</b>\n` +
    `♻️ <b>Duplicates Rejected:</b> <b>${result.duplicateCount}</b>\n` +
    `🧹 <b>Empty Lines Ignored:</b> <b>${result.emptyCount}</b>\n` +
    `${DIVIDER}\n` +
    `📦 <b>Current Category Stock:</b> <b>${result.currentStock}</b> (${stockBadge})`;

  await sendMessage(env, chatId, text, {
    reply_markup: adminReplyKeyboard(),
  });
}

/**
 * 9. 📦 Voucher Stock Overview
 */
export async function handleAdminVoucherStock(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const [summary, settings] = await Promise.all([
    getAllCategoryStockSummary(env),
    getSettings(env),
  ]);

  let text =
    `${buildHeader('📦', 'VOUCHER INVENTORY & STOCK')}\n` +
    `📊 <b>Total Available Vouchers:</b> <b>${summary.totalAvailable}</b>\n` +
    `💎 <b>Total Available Value:</b> <b>${formatINR(summary.totalValuePaise)}</b>\n` +
    `${DIVIDER}\n`;

  for (const cat of VOUCHER_CATEGORY_LIST) {
    const info = summary.categories[cat.key];
    const threshold = settings.lowStockThresholds?.[cat.key] ?? 5;
    const status = info.inStock ? '🟢 IN STOCK' : '🔴 OUT OF STOCK';
    text +=
      `${cat.emoji} <b>${escapeHtml(cat.name)}</b>\n` +
      `   • Status: ${status}\n` +
      `   • Available: <b>${info.availableCount}</b> (${formatINR(info.valuePaise)})\n` +
      `   • Total Ever Added: ${info.totalAddedCount}\n` +
      `   • Low Stock Alert At: ≤ <b>${threshold}</b>\n\n`;
  }

  const extraRows = [
    [
      { text: '➕ Add Vouchers', callback_data: 'adm:add_voucher' },
      { text: '🗑️ Disable Voucher', callback_data: 'adm:vdisable_menu' },
    ],
    [
      { text: '🚨 Low Stock Alerts', callback_data: 'adm:low_stock' },
      { text: '🔄 Refresh Stock', callback_data: 'adm:stock' },
    ],
  ];

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(extraRows),
  });
}

/**
 * Inspect latest available vouchers in a category to allow disabling a bad code
 */
export async function handleAdminDisableVoucherMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) return;
  await editOrSend(
    env,
    chatId,
    messageId,
    `${buildHeader('🗑️', 'DISABLE AVAILABLE VOUCHER')}\nSelect a category to view its latest available vouchers:`,
    { reply_markup: voucherCategorySelectKeyboard('adm:vdis_cat') }
  );
}

export async function handleAdminDisableVoucherList(env, callbackQuery, categoryKey) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  const cat = getCategoryMeta(categoryKey);
  const vouchers = await getAvailableVouchersByCategory(env, categoryKey, 10);

  let text = `${buildHeader('🗑️', `AVAILABLE ${cat.shortName.toUpperCase()} VOUCHERS`)}\n`;
  const rows = [];

  if (!vouchers.length) {
    text += `<i>No available vouchers in this category.</i>`;
  } else {
    text += `Showing up to 10 available vouchers. Tap one to disable it:\n\n`;
    for (const v of vouchers) {
      const masked =
        v.code.length > 6
          ? `${v.code.slice(0, 3)}***${v.code.slice(-3)}`
          : v.code;
      text += `• <code>${escapeHtml(v.id)}</code> — <code>${escapeHtml(masked)}</code> (${formatINR(v.valuePaise)})\n`;
      rows.push([
        {
          text: `🚫 Disable ${v.id} (${masked})`,
          callback_data: `adm:vdis_do:${v.id}`,
        },
      ]);
    }
  }

  rows.push([{ text: '⬅️ Back to Stock', callback_data: 'adm:stock' }]);
  await editOrSend(env, chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
}

export async function handleAdminDisableVoucherExecute(env, callbackQuery, voucherId) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const res = await disableAvailableVoucher(env, voucherId, adminId);
  if (!res.ok) {
    await answerCallbackQuery(env, callbackQuery.id, res.error, true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, `✅ Voucher ${voucherId} disabled.`, true);
  await handleAdminVoucherStock(env, adminId, chatId, msgId);
}

/**
 * 10. 📝 Voucher Delivery History (Paginated)
 */
export async function handleAdminVoucherHistory(env, adminId, chatId, page = 1, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageVouchers', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const data = await getVoucherHistoryPage(env, page, 5);
  let text =
    `${buildHeader('📝', 'VOUCHER DELIVERY HISTORY')}\n` +
    `📊 <b>Total Delivered Vouchers:</b> <b>${data.total}</b> (Page ${data.page}/${data.totalPages})\n` +
    `${DIVIDER}\n`;

  if (!data.items.length) {
    text += `<i>No vouchers have been delivered yet.</i>`;
  } else {
    for (const item of data.items) {
      const cat = getCategoryMeta(item.category);
      const catLabel = cat ? `${cat.emoji} ${cat.shortName}` : escapeHtml(item.category);
      text +=
        `🎟️ <b>${catLabel}</b> — <b>${formatINR(item.valuePaise)}</b>\n` +
        `🔑 Code: <code>${escapeHtml(item.code)}</code>\n` +
        `👤 User: ${escapeHtml(item.userName || 'User')} (${escapeHtml(formatUsernameTag(item.username))}) [<code>${escapeHtml(item.userId)}</code>]\n` +
        `🆔 Req: <code>${escapeHtml(item.withdrawalRequestId)}</code> • Approved by: <code>${escapeHtml(item.approvedBy)}</code>\n` +
        `🕒 ${formatIST(item.deliveredAt, env)}\n` +
        `${DIVIDER}\n`;
    }
  }

  const extraRows = [];
  if (data.totalPages > 1) {
    extraRows.push(paginationRow('adm:vhist', data.page, data.totalPages));
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(extraRows),
  });
}

/**
 * 11. 🚨 Low Stock Alert Settings
 */
export async function handleAdminLowStockMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageLowStock', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const [settings, summary] = await Promise.all([
    getSettings(env),
    getAllCategoryStockSummary(env),
  ]);

  let text =
    `${buildHeader('🚨', 'LOW STOCK ALERT SETTINGS')}\n` +
    `Automatic notifications are sent to admins whenever a category's available stock reaches or drops below its configured threshold.\n` +
    `${DIVIDER}\n`;

  const rows = [];
  for (const cat of VOUCHER_CATEGORY_LIST) {
    const threshold = settings.lowStockThresholds?.[cat.key] ?? 5;
    const stock = summary.categories[cat.key].availableCount;
    const alertState = settings.lowStockAlertSent?.[cat.key] ? '🔔 Alert Triggered' : '✅ Armed';
    text +=
      `${cat.emoji} <b>${escapeHtml(cat.name)}</b>\n` +
      `   • Current Stock: <b>${stock}</b> | Threshold: <b>${threshold}</b> | ${alertState}\n\n`;
    rows.push([
      {
        text: `✏️ Edit ${cat.shortName} Threshold (Current: ${threshold})`,
        callback_data: `adm:low_set:${cat.key}`,
      },
    ]);
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

export async function handleAdminLowStockPrompt(env, callbackQuery, categoryKey) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  if (!(await hasAdminPermission(adminId, 'manageLowStock', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const cat = getCategoryMeta(categoryKey);
  if (!cat) {
    await answerCallbackQuery(env, callbackQuery.id, 'Invalid category.', true);
    return;
  }

  await setUserState(env, adminId, {
    type: 'admin_set_low_stock',
    category: categoryKey,
  });

  await answerCallbackQuery(env, callbackQuery.id);
  await sendMessage(
    env,
    chatId,
    `${buildHeader('🚨', `SET ${cat.shortName.toUpperCase()} LOW STOCK THRESHOLD`)}\n` +
      `Enter a whole number (0–1000). Example: <code>5</code>\n\n` +
      `Admins will be alerted when ${escapeHtml(cat.name)} stock reaches this number or lower.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

export async function handleAdminLowStockInput(env, message, state) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageLowStock', env))) {
    await clearUserState(env, adminId);
    return;
  }

  const num = Number(String(message.text || '').trim());
  if (!Number.isInteger(num) || num < 0 || num > 1000) {
    await sendMessage(env, chatId, '⚠️ Please enter a valid integer between 0 and 1000.');
    return;
  }

  const cat = getCategoryMeta(state.category);
  const availableCount = await countAvailableVouchersByCategory(env, state.category);
  const patch = {
    lowStockThresholds: { [state.category]: num },
  };
  if (availableCount > num) {
    patch.lowStockAlertSent = { [state.category]: false };
  }

  await updateSettings(env, patch);

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.LOW_STOCK_THRESHOLD_CHANGED,
    `Updated ${cat.shortName} low-stock threshold to ${num}`
  );

  await clearUserState(env, adminId);
  await sendMessage(
    env,
    chatId,
    `✅ <b>${escapeHtml(cat.name)}</b> low-stock threshold updated to <b>${num}</b>.`,
    { reply_markup: adminReplyKeyboard() }
  );
  await handleAdminLowStockMenu(env, adminId, chatId);
}
