// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Panel, Withdrawals Review, Settings, Users, Admins & Logs
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  ACTIVITY_ACTIONS,
  BOT_BRAND,
  DEFAULT_ADMIN_PERMISSIONS,
  escapeHtml,
  formatINR,
  formatIST,
  formatUserName,
  formatUsernameTag,
  getCategoryMeta,
  getOwnerId,
  inrToPaise,
  isValidTelegramUrl,
} from '../config.js';
import {
  clearUserState,
  countPendingWithdrawals,
  getActivityLogsPage,
  getAdminsMap,
  getPendingWithdrawalsPage,
  getSettings,
  getUser,
  getUserBalanceAdjustments,
  getUserWithdrawals,
  getUserState,
  getUsersPage,
  getWithdrawal,
  hasAdminPermission,
  isAdmin,
  isOwner,
  removeAdminRecord,
  setUserState,
  updateSettings,
  updateUserStatus,
  upsertAdminRecord,
} from '../database.js';
import {
  adminActionKeyboard,
  adminReplyKeyboard,
  cancelInputKeyboard,
  mainMenuKeyboard,
  paginationRow,
  withdrawalAdminDecisionKeyboard,
} from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import {
  logAdminRoleChangeEvent,
  logUserStatusChangeEvent,
} from '../services/secretary.js';
import {
  approveWithdrawalRequest,
  rejectWithdrawalRequest,
} from '../services/withdrawal-service.js';
import { answerCallbackQuery, editOrSend, sendMessage } from '../telegram.js';
import {
  handleAdminBalanceActionSelect,
  handleAdminBalanceAmountInput,
  handleAdminBalanceCancel,
  handleAdminBalanceConfirm,
  handleAdminBalanceReasonSubmit,
  handleAdminBalanceUserIdInput,
  handleAdminManageBalanceForUser,
} from './balance-admin.js';
import {
  handleAdminBroadcastCancel,
  handleAdminBroadcastComposeInput,
  handleAdminBroadcastConfirm,
  handleAdminBroadcastStart,
} from './broadcast.js';
import {
  handleAdminForceChannelAddStart,
  handleAdminForceChannelChatIdInput,
  handleAdminForceChannelDelete,
  handleAdminForceChannelLinkInput,
  handleAdminForceChannelModeSelect,
  handleAdminForceChannelTest,
  handleAdminForceChannelsMenu,
} from './forcejoin.js';
import {
  handleAdminSecretaryChannelInput,
  handleAdminSecretaryChannelPrompt,
  handleAdminSecretaryMenu,
  handleAdminSecretaryRetry,
  handleAdminSecretaryTest,
  handleAdminSecretaryToggle,
  handleAdminSecretaryVerify,
} from './secretary.js';
import { handleAdminStatistics } from './statistics.js';
import {
  handleAdminAddVoucherCategory,
  handleAdminAddVoucherMenu,
  handleAdminBulkVoucherInput,
  handleAdminDisableVoucherExecute,
  handleAdminDisableVoucherList,
  handleAdminDisableVoucherMenu,
  handleAdminLowStockInput,
  handleAdminLowStockMenu,
  handleAdminLowStockPrompt,
  handleAdminVoucherHistory,
  handleAdminVoucherStock,
} from './voucher.js';

/**
 * Main Admin Panel Entry Screen (Persistent Coloured Bottom ReplyKeyboard — No Inline Dashboard)
 */
export async function handleAdminPanel(env, tgUser, chatId) {
  const adminId = String(tgUser.id);
  if (!(await isAdmin(adminId, env))) {
    await sendMessage(env, chatId, '🚫 Access denied. Authorized administrators only.');
    return;
  }

  await clearUserState(env, adminId);
  const ownerFlag = isOwner(adminId, env);
  const [settings, pendingCount] = await Promise.all([
    getSettings(env),
    countPendingWithdrawals(env),
  ]);

  const roleBadge = ownerFlag ? '👑 Owner (Full Control)' : '🛡️ Administrator';
  const maintBadge = settings.maintenanceMode ? '🔴 ON' : '🟢 OFF';

  const text =
    `${buildHeader('👑', `${BOT_BRAND} — ADMIN PANEL`)}\n` +
    `🪪 <b>Role:</b> ${roleBadge}\n` +
    `📋 <b>Pending Withdrawals:</b> <b>${pendingCount}</b>\n` +
    `🔧 <b>Maintenance Mode:</b> ${maintBadge}\n` +
    `🕒 <b>Server Time:</b> ${formatIST(Date.now(), env)}\n` +
    `${DIVIDER}\n` +
    `👇 Use the <b>Admin Panel keyboard</b> at the bottom of your chat to manage the bot.`;

  await sendMessage(env, chatId, text, {
    reply_markup: adminReplyKeyboard(),
  });
}

// ============================================================================
// 2. 📋 PENDING WITHDRAWAL REQUESTS & APPROVAL / REJECTION
// ============================================================================

export async function handleAdminPendingRequests(env, adminId, chatId, page = 1, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'approveWithdrawals', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const pageData = await getPendingWithdrawalsPage(env, page, 5);
  const total = pageData.total;
  const totalPages = pageData.totalPages;
  const safePage = pageData.page;
  const slice = pageData.items;

  let text =
    `${buildHeader('📋', 'PENDING WITHDRAWAL REQUESTS')}\n` +
    `⏳ <b>Total Pending:</b> <b>${total}</b> (Page ${safePage}/${totalPages})\n` +
    `${DIVIDER}\n`;

  const rows = [];
  if (!slice.length) {
    text += `✅ <i>All caught up! No pending withdrawal requests right now.</i>`;
  } else {
    for (const w of slice) {
      const cat = getCategoryMeta(w.category);
      const catLabel = cat ? `${cat.emoji} ${cat.shortName}` : w.category;
      text +=
        `🆔 <code>${escapeHtml(w.id)}</code> — <b>${formatINR(w.amountPaise)}</b> (${escapeHtml(catLabel)})\n` +
        `👤 ${escapeHtml(w.userName)} (${escapeHtml(formatUsernameTag(w.username))}) [<code>${escapeHtml(w.userId)}</code>]\n` +
        `🕒 ${formatIST(w.createdAt, env)}\n\n`;
      rows.push([
        { text: `🔍 Inspect ${w.id}`, callback_data: `adm:wd_view:${w.id}` },
        { text: '✅ Approve', callback_data: `adm:wd_approve:${w.id}` },
        { text: '❌ Reject', callback_data: `adm:wd_reject:${w.id}` },
      ]);
    }
  }

  if (totalPages > 1) {
    rows.push(paginationRow('adm:pending', safePage, totalPages));
  }
  rows.push([{ text: '🔄 Refresh List', callback_data: `adm:pending:${safePage}` }]);

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

export async function handleAdminInspectWithdrawal(env, callbackQuery, requestId) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;
  if (!(await hasAdminPermission(adminId, 'approveWithdrawals', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const w = await getWithdrawal(env, requestId);
  if (!w) {
    await answerCallbackQuery(env, callbackQuery.id, 'Request not found.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  const user = await getUser(env, w.userId);
  const cat = getCategoryMeta(w.category);
  const catLabel = cat ? `${cat.emoji} ${cat.name}` : escapeHtml(w.category);

  const text =
    `${buildHeader('🔍', 'WITHDRAWAL REQUEST DETAILS')}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(w.id)}</code>\n` +
    `📌 <b>Status:</b> <b>${escapeHtml(w.status.toUpperCase())}</b>\n` +
    `👤 <b>User:</b> ${escapeHtml(w.userName)} (${escapeHtml(formatUsernameTag(w.username))})\n` +
    `🔢 <b>Telegram ID:</b> <code>${escapeHtml(w.userId)}</code>\n` +
    `💰 <b>Current Balance:</b> ${formatINR(user?.balancePaise || 0)} (Pending: ${formatINR(user?.pendingWithdrawalPaise || 0)})\n` +
    `💸 <b>Withdrawal Amount:</b> <b>${formatINR(w.amountPaise)}</b>\n` +
    `🎟️ <b>Category:</b> ${catLabel}\n` +
    `🕒 <b>Requested At:</b> ${formatIST(w.createdAt, env)}`;

  const reply_markup =
    w.status === 'pending'
      ? withdrawalAdminDecisionKeyboard(w.id)
      : adminActionKeyboard([[{ text: '📋 Pending Requests', callback_data: 'adm:pending:1' }]]);

  await editOrSend(env, chatId, msgId, text, { reply_markup });
}

export async function handleAdminApproveWithdrawal(env, callbackQuery, requestId) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'approveWithdrawals', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, '⏳ Approving & assigning voucher...');
  const res = await approveWithdrawalRequest(env, requestId, adminId);

  if (!res.ok) {
    await sendMessage(env, chatId, `❌ <b>Approval Failed:</b>\n${escapeHtml(res.error)}`);
    return;
  }

  const w = res.withdrawal;
  const v = res.voucher;
  const cat = getCategoryMeta(w.category);
  const dmNote = res.dmDelivered
    ? '✅ Voucher delivered to user via Telegram DM.'
    : `⚠️ User DM failed (${escapeHtml(res.dmError)}). Voucher is safely saved in user's My Vouchers history.`;

  const text =
    `${buildHeader('✅', 'WITHDRAWAL APPROVED')}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(w.id)}</code>\n` +
    `👤 <b>User:</b> ${escapeHtml(w.userName)} [<code>${escapeHtml(w.userId)}</code>]\n` +
    `🎟️ <b>Category:</b> ${cat ? `${cat.emoji} ${escapeHtml(cat.name)}` : escapeHtml(w.category)}\n` +
    `💵 <b>Amount:</b> <b>${formatINR(w.amountPaise)}</b>\n` +
    `🔑 <b>Assigned Voucher:</b> <code>${escapeHtml(v.id)}</code>\n` +
    `📦 <b>Remaining Category Stock:</b> <b>${res.remainingStock}</b>\n` +
    `👮 <b>Approved By:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🕒 <b>Processed At:</b> ${formatIST(w.processedAt, env)}\n` +
    `${DIVIDER}\n` +
    `${dmNote}`;

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: '📋 View Pending Requests', callback_data: 'adm:pending:1' }]],
    },
  });
}

export async function handleAdminRejectPrompt(env, callbackQuery, requestId) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'approveWithdrawals', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const w = await getWithdrawal(env, requestId);
  if (!w || w.status !== 'pending') {
    await answerCallbackQuery(env, callbackQuery.id, 'Request is no longer pending.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  const text =
    `${buildHeader('❌', 'REJECT WITHDRAWAL REQUEST')}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(w.id)}</code>\n` +
    `👤 <b>User:</b> ${escapeHtml(w.userName)} [<code>${escapeHtml(w.userId)}</code>]\n` +
    `💸 <b>Amount to Refund:</b> <b>${formatINR(w.amountPaise)}</b>\n\n` +
    `Choose how you want to reject this request:`;

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Reject With Custom Reason', callback_data: `adm:wd_rej_reason:${w.id}` }],
        [{ text: '❌ Reject Immediately (No Reason)', callback_data: `adm:wd_rej_now:${w.id}` }],
        [{ text: '⬅️ Back to Request', callback_data: `adm:wd_view:${w.id}` }],
      ],
    },
  });
}

export async function handleAdminRejectExecute(env, adminId, chatId, requestId, reason = '', messageId = null) {
  if (!(await hasAdminPermission(adminId, 'approveWithdrawals', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const res = await rejectWithdrawalRequest(env, requestId, adminId, reason);
  if (!res.ok) {
    await sendMessage(env, chatId, `❌ <b>Rejection Failed:</b> ${escapeHtml(res.error)}`, {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  const w = res.withdrawal;
  const text =
    `${buildHeader('❌', 'WITHDRAWAL REJECTED & REFUNDED')}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(w.id)}</code>\n` +
    `👤 <b>User:</b> ${escapeHtml(w.userName)} [<code>${escapeHtml(w.userId)}</code>]\n` +
    `💸 <b>Refunded Amount:</b> <b>${formatINR(w.amountPaise)}</b>\n` +
    `📝 <b>Reason:</b> ${escapeHtml(w.rejectionReason || 'Not specified')}\n` +
    `👮 <b>Rejected By:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🕒 <b>Processed At:</b> ${formatIST(w.processedAt, env)}`;

  if (messageId) {
    await editOrSend(env, chatId, messageId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: '📋 View Pending Requests', callback_data: 'adm:pending:1' }]],
      },
    });
  } else {
    await sendMessage(env, chatId, text, { reply_markup: adminReplyKeyboard() });
  }
}

// ============================================================================
// 4. ⚙️ SETTINGS MANAGEMENT
// ============================================================================

export async function handleAdminSettingsMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageSettings', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const s = await getSettings(env);
  const text =
    `${buildHeader('⚙️', 'BOT SETTINGS')}\n` +
    `👥 <b>Referral Reward:</b> <b>${formatINR(s.referralRewardPaise)}</b>\n` +
    `🎁 <b>Daily Bonus Amount:</b> <b>${formatINR(s.dailyBonusPaise)}</b>\n` +
    `💸 <b>Minimum Withdrawal:</b> <b>${formatINR(s.minWithdrawalPaise)}</b>\n` +
    `🎟️ <b>Default Voucher Value:</b> <b>${formatINR(s.defaultVoucherValuePaise)}</b>\n` +
    `🎧 <b>Support Handle:</b> ${escapeHtml(s.supportUsername)}\n` +
    `📢 <b>Update Channel:</b> ${escapeHtml(s.updateChannelUrl)}\n` +
    `${DIVIDER}\n` +
    `👇 Tap a setting below to modify it:`;

  const rows = [
    [
      { text: '👥 Referral Reward', callback_data: 'adm:set:referral' },
      { text: '🎁 Daily Bonus', callback_data: 'adm:set:daily_bonus' },
    ],
    [
      { text: '💸 Min Withdrawal', callback_data: 'adm:set:min_wd' },
      { text: '🎟️ Voucher Value', callback_data: 'adm:set:voucher_val' },
    ],
    [
      { text: '🎧 Support Handle', callback_data: 'adm:set:support' },
      { text: '📢 Update Channel', callback_data: 'adm:set:channel' },
    ],
  ];

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

export async function handleAdminSettingPrompt(env, callbackQuery, settingKey) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  if (!(await hasAdminPermission(adminId, 'manageSettings', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const prompts = {
    referral: 'Enter the new <b>Referral Reward</b> in INR (e.g. <code>3</code> or <code>5</code>):',
    daily_bonus:
      'Enter the new <b>Daily Bonus</b> in INR decimal (e.g. <code>0.10</code>, <code>0.20</code>, <code>0.50</code>, below ₹1 recommended):',
    min_wd: 'Enter the new <b>Minimum Withdrawal</b> in INR (e.g. <code>10</code> or <code>20</code>):',
    voucher_val: 'Enter the new <b>Default Voucher Value</b> in INR (e.g. <code>10</code>):',
    support: 'Enter the new <b>Support Username</b> (e.g. <code>@Pritam_power</code>):',
    channel: 'Enter the new <b>Update Channel URL</b> (e.g. <code>https://t.me/pnarewards</code>):',
  };

  if (!prompts[settingKey]) {
    await answerCallbackQuery(env, callbackQuery.id, 'Unknown setting.', true);
    return;
  }

  await setUserState(env, adminId, { type: 'admin_edit_setting', settingKey });
  await answerCallbackQuery(env, callbackQuery.id);
  await sendMessage(
    env,
    chatId,
    `${buildHeader('⚙️', 'UPDATE SETTING')}\n${prompts[settingKey]}\n\nTap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

async function handleAdminSettingInput(env, message, state) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageSettings', env))) {
    await clearUserState(env, adminId);
    return;
  }

  const val = String(message.text || '').trim();
  const key = state.settingKey;

  if (key === 'referral') {
    const paise = inrToPaise(val);
    if (paise === null || paise < 1 || paise > 100000) {
      await sendMessage(env, chatId, '⚠️ Enter a valid INR amount between ₹0.01 and ₹1000.');
      return;
    }
    await updateSettings(env, { referralRewardPaise: paise });
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.REFERRAL_REWARD_CHANGED,
      `Referral reward changed to ${formatINR(paise)}`
    );
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, `✅ Referral reward updated to <b>${formatINR(paise)}</b>.`, {
      reply_markup: adminReplyKeyboard(),
    });
  } else if (key === 'daily_bonus') {
    const paise = inrToPaise(val);
    if (paise === null || paise < 1 || paise > 50000) {
      await sendMessage(env, chatId, '⚠️ Enter a valid INR decimal amount (e.g., 0.10, 0.25, 0.50).');
      return;
    }
    await updateSettings(env, { dailyBonusPaise: paise });
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.DAILY_BONUS_CHANGED,
      `Daily bonus changed to ${formatINR(paise)}`
    );
    await clearUserState(env, adminId);
    const note = paise >= 100 ? '\n⚠️ <i>Note: Amount is ₹1.00 or above.</i>' : '';
    await sendMessage(
      env,
      chatId,
      `✅ Daily bonus updated to <b>${formatINR(paise)}</b>.${note}`,
      { reply_markup: adminReplyKeyboard() }
    );
  } else if (key === 'min_wd') {
    const paise = inrToPaise(val);
    if (paise === null || paise < 100 || paise > 1000000) {
      await sendMessage(env, chatId, '⚠️ Enter a valid minimum withdrawal between ₹1 and ₹10000.');
      return;
    }
    await updateSettings(env, { minWithdrawalPaise: paise });
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.MIN_WITHDRAWAL_CHANGED,
      `Minimum withdrawal changed to ${formatINR(paise)}`
    );
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, `✅ Minimum withdrawal updated to <b>${formatINR(paise)}</b>.`, {
      reply_markup: adminReplyKeyboard(),
    });
  } else if (key === 'voucher_val') {
    const paise = inrToPaise(val);
    if (paise === null || paise < 100 || paise > 1000000) {
      await sendMessage(env, chatId, '⚠️ Enter a valid voucher value between ₹1 and ₹10000.');
      return;
    }
    await updateSettings(env, { defaultVoucherValuePaise: paise });
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.VOUCHER_VALUE_CHANGED,
      `Default voucher value changed to ${formatINR(paise)}`
    );
    await clearUserState(env, adminId);
    await sendMessage(
      env,
      chatId,
      `✅ Default voucher value updated to <b>${formatINR(paise)}</b>.`,
      { reply_markup: adminReplyKeyboard() }
    );
  } else if (key === 'support') {
    const clean = val.startsWith('@') ? val : `@${val}`;
    if (!/^@[a-zA-Z0-9_]{4,32}$/.test(clean)) {
      await sendMessage(env, chatId, '⚠️ Please enter a valid Telegram username like <code>@Pritam_power</code>.');
      return;
    }
    await updateSettings(env, { supportUsername: clean });
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, `✅ Support handle updated to <b>${escapeHtml(clean)}</b>.`, {
      reply_markup: adminReplyKeyboard(),
    });
  } else if (key === 'channel') {
    if (!isValidTelegramUrl(val)) {
      await sendMessage(env, chatId, '⚠️ Please enter a valid Telegram URL starting with <code>https://t.me/</code>.');
      return;
    }
    await updateSettings(env, { updateChannelUrl: val });
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, `✅ Update channel link updated to <b>${escapeHtml(val)}</b>.`, {
      reply_markup: adminReplyKeyboard(),
    });
  }

  await handleAdminSettingsMenu(env, adminId, chatId);
}

// ============================================================================
// 5. 👥 USERS LIST (10 per page + Search by Telegram ID + Details)
// ============================================================================

export async function handleAdminUsersList(env, adminId, chatId, page = 1, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'viewUsers', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const data = await getUsersPage(env, page, 10);
  let text =
    `${buildHeader('👥', 'REGISTERED USERS LIST')}\n` +
    `📊 <b>Total Users:</b> <b>${data.total}</b> • Page <b>${data.page}/${data.totalPages}</b> (10/page)\n` +
    `${DIVIDER}\n`;

  const rows = [];
  if (!data.users.length) {
    text += `<i>No registered users yet.</i>`;
  } else {
    for (let i = 0; i < data.users.length; i++) {
      const u = data.users[i];
      const idx = (data.page - 1) * data.pageSize + i + 1;
      const statusDot = u.status === 'active' ? '🟢' : u.status === 'banned' ? '⛔' : '🔕';
      text +=
        `${idx}. ${statusDot} <b>${escapeHtml(formatUserName(u))}</b> (${escapeHtml(formatUsernameTag(u.username))})\n` +
        `   🆔 <code>${escapeHtml(u.id)}</code> | 💰 ${formatINR(u.balancePaise)} | 👥 ${u.totalReferrals || 0} refs | 📈 ${formatINR(u.totalEarnedPaise)}\n` +
        `   📅 ${formatIST(u.joinedAt, env)} | 🎟️ ${u.withdrawalCount || 0} wd\n`;
    }

    // Quick inspect buttons in rows of 2
    for (let i = 0; i < data.users.length; i += 2) {
      const btnRow = [];
      for (let j = i; j < Math.min(i + 2, data.users.length); j++) {
        const u = data.users[j];
        btnRow.push({
          text: `👤 ${u.id}`,
          callback_data: `adm:uview:${u.id}`,
        });
      }
      rows.push(btnRow);
    }
  }

  if (data.totalPages > 1) {
    rows.push(paginationRow('adm:users', data.page, data.totalPages));
  }
  rows.push([{ text: '🔍 Search User by Telegram ID', callback_data: 'adm:user_search' }]);

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

export async function handleAdminUserDetail(env, adminId, chatId, targetUserId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'viewUsers', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const u = await getUser(env, targetUserId);
  if (!u) {
    await sendMessage(env, chatId, `❌ No user found with Telegram ID <code>${escapeHtml(targetUserId)}</code>.`);
    return;
  }

  const [withdrawals, adjustments, canManageBal] = await Promise.all([
    getUserWithdrawals(env, u.id, 5),
    getUserBalanceAdjustments(env, u.id, 5),
    hasAdminPermission(adminId, 'manageBalances', env),
  ]);

  let wdSummary = '<i>No withdrawals yet.</i>';
  if (withdrawals.length) {
    wdSummary = withdrawals
      .map(
        (w) =>
          `• <code>${escapeHtml(w.id)}</code> ${formatINR(w.amountPaise)} (${escapeHtml(w.category)}) — <b>${escapeHtml(w.status.toUpperCase())}</b>`
      )
      .join('\n');
  }

  let adjSummary = '<i>No manual balance adjustments.</i>';
  if (adjustments.length) {
    adjSummary = adjustments
      .map((a) => {
        const sign = a.action === 'ADD' ? '+' : '-';
        const reasonPart = a.reason ? ` — <i>${escapeHtml(a.reason)}</i>` : '';
        return `• <code>${escapeHtml(a.id)}</code> <b>${sign}${formatINR(a.amountPaise)}</b> (${formatINR(a.balanceBeforePaise)}→${formatINR(a.balanceAfterPaise)}) by <code>${escapeHtml(a.adminId)}</code>${reasonPart}`;
      })
      .join('\n');
  }

  const statusLabel =
    u.status === 'active'
      ? '🟢 Active'
      : u.status === 'banned'
      ? '⛔ Banned'
      : '🔕 Blocked Bot';

  const text =
    `${buildHeader('👤', 'USER ACCOUNT DETAILS')}\n` +
    `🪪 <b>Name:</b> ${escapeHtml(formatUserName(u))}\n` +
    `🔗 <b>Username:</b> ${escapeHtml(formatUsernameTag(u.username))}\n` +
    `🆔 <b>Telegram ID:</b> <code>${escapeHtml(u.id)}</code>\n` +
    `📅 <b>Registered:</b> ${formatIST(u.joinedAt, env)}\n` +
    `🕒 <b>Last Active:</b> ${formatIST(u.lastActiveAt, env)}\n` +
    `🛡️ <b>Status:</b> ${statusLabel}\n` +
    `${DIVIDER}\n` +
    `💰 <b>Available Balance:</b> <b>${formatINR(u.balancePaise)}</b>\n` +
    `⏳ <b>Pending Withdrawal:</b> ${formatINR(u.pendingWithdrawalPaise)}\n` +
    `📈 <b>Total Earnings:</b> ${formatINR(u.totalEarnedPaise)}\n` +
    `👥 <b>Total Referrals:</b> ${u.totalReferrals || 0} (${formatINR(u.referralEarningsPaise)})\n` +
    `🎁 <b>Daily Bonuses:</b> ${u.dailyBonusCount || 0} (${formatINR(u.dailyBonusEarningsPaise)})\n` +
    `✅ <b>Total Withdrawn:</b> ${formatINR(u.totalWithdrawnPaise)}\n` +
    `${DIVIDER}\n` +
    `💸 <b>Recent Withdrawal History:</b>\n${wdSummary}\n` +
    `${DIVIDER}\n` +
    `💰 <b>Recent Manual Balance Adjustments:</b>\n${adjSummary}`;

  const rows = [];
  if (canManageBal) {
    rows.push([{ text: '💰 Manage User Balance', callback_data: `adm:bal_user:${u.id}` }]);
  }
  if (!isOwner(u.id, env)) {
    const toggleBtn =
      u.status === 'banned'
        ? { text: '✅ Unban User', callback_data: `adm:uban:${u.id}:active` }
        : { text: '⛔ Ban User', callback_data: `adm:uban:${u.id}:banned` };
    rows.push([toggleBtn]);
  }
  rows.push([{ text: '⬅️ Back to Users List', callback_data: 'adm:users:1' }]);

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

// ============================================================================
// 6. 👑 ADMIN MANAGEMENT (Strictly Owner-Only Modifications)
// ============================================================================

export async function handleAdminManagementMenu(env, adminId, chatId, messageId = null) {
  if (!(await isAdmin(adminId, env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const ownerId = getOwnerId(env);
  const ownerFlag = isOwner(adminId, env);
  const adminsMap = await getAdminsMap(env);
  const entries = Object.values(adminsMap).filter((a) => a && a.active !== false);

  let text =
    `${buildHeader('👑', 'ADMIN MANAGEMENT')}\n` +
    `👑 <b>Owner ID:</b> <code>${escapeHtml(ownerId)}</code>\n` +
    `<i>Permissions: Full Super-Admin Control (Protected)</i>\n` +
    `${DIVIDER}\n` +
    `🛡️ <b>Authorized Admins (${entries.length}):</b>\n`;

  const rows = [];
  if (!entries.length) {
    text += `<i>No additional admins configured.</i>\n`;
  } else {
    for (const a of entries) {
      const perms = Object.entries({ ...DEFAULT_ADMIN_PERMISSIONS, ...(a.permissions || {}) })
        .filter(([, enabled]) => enabled)
        .map(([k]) => k)
        .join(', ');
      text +=
        `• <b>${escapeHtml(a.name || 'Admin')}</b> [<code>${escapeHtml(a.id)}</code>]\n` +
        `  Added: ${formatIST(a.addedAt, env)}\n` +
        `  Permissions: <i>${escapeHtml(perms)}</i>\n\n`;
      if (ownerFlag) {
        rows.push([
          { text: `🗑️ Remove Admin ${a.id}`, callback_data: `adm:rem_admin:${a.id}` },
        ]);
      }
    }
  }

  if (ownerFlag) {
    rows.unshift([{ text: '➕ Add Admin', callback_data: 'adm:add_admin' }]);
  } else {
    text += `\n🔒 <i>Only the Bot Owner can add or remove administrators.</i>`;
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

// ============================================================================
// 12. 🔧 MAINTENANCE MODE
// ============================================================================

export async function handleAdminMaintenanceMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageMaintenance', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const s = await getSettings(env);
  const statusBadge = s.maintenanceMode ? '🔴 ENABLED (Users Blocked)' : '🟢 DISABLED (Bot Live)';

  const text =
    `${buildHeader('🔧', 'MAINTENANCE MODE')}\n` +
    `📌 <b>Current Status:</b> <b>${statusBadge}</b>\n` +
    `${DIVIDER}\n` +
    `💬 <b>Current Maintenance Message:</b>\n${s.maintenanceMessage}\n` +
    `${DIVIDER}\n` +
    `<i>When enabled, normal users cannot perform reward actions while admins retain full access. Balances and vouchers remain completely untouched.</i>`;

  const toggleBtn = s.maintenanceMode
    ? { text: '🟢 Disable Maintenance Mode', callback_data: 'adm:maint_toggle:off' }
    : { text: '🔴 Enable Maintenance Mode', callback_data: 'adm:maint_toggle:on' };

  const rows = [
    [toggleBtn],
    [{ text: '✏️ Edit Maintenance Message', callback_data: 'adm:maint_msg' }],
  ];

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

// ============================================================================
// 13. 📜 ADMIN ACTIVITY LOGS
// ============================================================================

export async function handleAdminActivityLogs(env, adminId, chatId, page = 1, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'viewLogs', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const data = await getActivityLogsPage(env, page, 8);
  let text =
    `${buildHeader('📜', 'ADMIN ACTIVITY LOGS')}\n` +
    `📊 <b>Recorded Events:</b> <b>${data.total}</b> (Page ${data.page}/${data.totalPages})\n` +
    `${DIVIDER}\n`;

  if (!data.logs.length) {
    text += `<i>No admin actions logged yet.</i>`;
  } else {
    for (const log of data.logs) {
      text +=
        `🔹 <b>${escapeHtml(log.action)}</b>\n` +
        `   👮 Admin: <code>${escapeHtml(log.adminId)}</code>\n` +
        `   📝 ${escapeHtml(log.details)}\n` +
        `   🕒 <i>${formatIST(log.timestamp, env)}</i>\n\n`;
    }
  }

  const rows = [];
  if (data.totalPages > 1) {
    rows.push(paginationRow('adm:logs', data.page, data.totalPages));
  }
  rows.push([{ text: '🔄 Refresh Logs', callback_data: `adm:logs:${data.page}` }]);

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

// ============================================================================
// CENTRALIZED ADMIN CALLBACK ROUTER (`adm:*`)
// ============================================================================

export async function handleAdminCallback(env, callbackQuery, ctx) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;
  const data = callbackQuery.data || '';

  // Strict authorization gate on EVERY admin callback
  if (!(await isAdmin(adminId, env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Authorized administrators only.', true);
    return;
  }

  if (data === 'adm:menu') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminPanel(env, callbackQuery.from, chatId);
    return;
  }

  if (data === 'adm:exit') {
    await clearUserState(env, adminId);
    await answerCallbackQuery(env, callbackQuery.id, 'Returned to main menu.');
    await sendMessage(env, chatId, `🏠 Returned to <b>${BOT_BRAND}</b> User Main Menu.`, {
      reply_markup: mainMenuKeyboard(true),
    });
    return;
  }

  if (data === 'adm:add_voucher') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminAddVoucherMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data.startsWith('adm:vadd_cat:')) {
    await handleAdminAddVoucherCategory(env, callbackQuery, data.slice('adm:vadd_cat:'.length));
    return;
  }

  if (data === 'adm:stock') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminVoucherStock(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:vdisable_menu') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminDisableVoucherMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data.startsWith('adm:vdis_cat:')) {
    await handleAdminDisableVoucherList(env, callbackQuery, data.slice('adm:vdis_cat:'.length));
    return;
  }

  if (data.startsWith('adm:vdis_do:')) {
    await handleAdminDisableVoucherExecute(env, callbackQuery, data.slice('adm:vdis_do:'.length));
    return;
  }

  if (data.startsWith('adm:vhist:')) {
    const page = Number(data.split(':')[2] || 1);
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminVoucherHistory(env, adminId, chatId, page, msgId);
    return;
  }

  if (data === 'adm:low_stock') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminLowStockMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data.startsWith('adm:low_set:')) {
    await handleAdminLowStockPrompt(env, callbackQuery, data.slice('adm:low_set:'.length));
    return;
  }

  if (data.startsWith('adm:pending:')) {
    const page = Number(data.split(':')[2] || 1);
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminPendingRequests(env, adminId, chatId, page, msgId);
    return;
  }

  if (data.startsWith('adm:wd_view:')) {
    await handleAdminInspectWithdrawal(env, callbackQuery, data.slice('adm:wd_view:'.length));
    return;
  }

  if (data.startsWith('adm:wd_approve:')) {
    await handleAdminApproveWithdrawal(env, callbackQuery, data.slice('adm:wd_approve:'.length));
    return;
  }

  if (data.startsWith('adm:wd_reject:')) {
    await handleAdminRejectPrompt(env, callbackQuery, data.slice('adm:wd_reject:'.length));
    return;
  }

  if (data.startsWith('adm:wd_rej_now:')) {
    await answerCallbackQuery(env, callbackQuery.id, 'Rejecting request...');
    await handleAdminRejectExecute(env, adminId, chatId, data.slice('adm:wd_rej_now:'.length), '', msgId);
    return;
  }

  if (data.startsWith('adm:wd_rej_reason:')) {
    const reqId = data.slice('adm:wd_rej_reason:'.length);
    if (!(await hasAdminPermission(adminId, 'approveWithdrawals', env))) {
      await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
      return;
    }
    await setUserState(env, adminId, { type: 'admin_wd_reject_reason', requestId: reqId });
    await answerCallbackQuery(env, callbackQuery.id);
    await sendMessage(
      env,
      chatId,
      `${buildHeader('📝', 'ENTER REJECTION REASON')}\nRequest ID: <code>${escapeHtml(reqId)}</code>\n\nType the rejection reason to send to the user (or tap ❌ Cancel):`,
      { reply_markup: cancelInputKeyboard(true) }
    );
    return;
  }

  if (data === 'adm:force_channels') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminForceChannelsMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:fj_add') {
    await handleAdminForceChannelAddStart(env, callbackQuery);
    return;
  }

  if (data.startsWith('adm:fj_mode:')) {
    const currentState = await getUserState(env, adminId);
    await handleAdminForceChannelModeSelect(
      env,
      callbackQuery,
      data.slice('adm:fj_mode:'.length),
      currentState
    );
    return;
  }

  if (data.startsWith('adm:fj_del:')) {
    await handleAdminForceChannelDelete(env, callbackQuery, data.slice('adm:fj_del:'.length));
    return;
  }

  if (data === 'adm:fj_test') {
    await handleAdminForceChannelTest(env, callbackQuery);
    return;
  }

  if (data === 'adm:settings') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminSettingsMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data.startsWith('adm:set:')) {
    await handleAdminSettingPrompt(env, callbackQuery, data.slice('adm:set:'.length));
    return;
  }

  if (data.startsWith('adm:users:')) {
    const page = Number(data.split(':')[2] || 1);
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminUsersList(env, adminId, chatId, page, msgId);
    return;
  }

  if (data === 'adm:user_search') {
    if (!(await hasAdminPermission(adminId, 'viewUsers', env))) {
      await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
      return;
    }
    await setUserState(env, adminId, { type: 'admin_search_user' });
    await answerCallbackQuery(env, callbackQuery.id);
    await sendMessage(
      env,
      chatId,
      `${buildHeader('🔍', 'SEARCH USER BY TELEGRAM ID')}\nSend the user's numeric Telegram ID (e.g. <code>8838351233</code>):`,
      { reply_markup: cancelInputKeyboard(true) }
    );
    return;
  }

  if (data.startsWith('adm:uview:')) {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminUserDetail(env, adminId, chatId, data.slice('adm:uview:'.length), msgId);
    return;
  }

  if (data.startsWith('adm:uban:')) {
    const parts = data.split(':');
    const targetId = parts[2];
    const newStatus = parts[3] === 'banned' ? 'banned' : 'active';
    if (!(await hasAdminPermission(adminId, 'viewUsers', env))) {
      await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
      return;
    }
    if (isOwner(targetId, env)) {
      await answerCallbackQuery(env, callbackQuery.id, '👑 Owner account cannot be modified.', true);
      return;
    }
    const target = await getUser(env, targetId);
    if (!target) {
      await answerCallbackQuery(env, callbackQuery.id, 'User not found.', true);
      return;
    }
    await updateUserStatus(env, targetId, newStatus);
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.USER_STATUS_CHANGED,
      `Set user ${targetId} status to ${newStatus}`
    );
    await logUserStatusChangeEvent(env, { adminId, targetUser: target, newStatus });
    await answerCallbackQuery(env, callbackQuery.id, `User marked ${newStatus}.`, true);
    await handleAdminUserDetail(env, adminId, chatId, targetId, msgId);
    return;
  }

  // Manual Balance Management callbacks
  if (data.startsWith('adm:bal_user:')) {
    const targetId = data.slice('adm:bal_user:'.length);
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminManageBalanceForUser(env, adminId, chatId, targetId, msgId);
    return;
  }

  if (data.startsWith('adm:bal_act:')) {
    const parts = data.split(':');
    const action = parts[2];
    const targetId = parts[3];
    await handleAdminBalanceActionSelect(env, callbackQuery, action, targetId);
    return;
  }

  if (data === 'adm:bal_skip_reason') {
    const currentState = await getUserState(env, adminId);
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminBalanceReasonSubmit(env, adminId, chatId, '', currentState, msgId);
    return;
  }

  if (data.startsWith('adm:bal_confirm:')) {
    const opId = data.slice('adm:bal_confirm:'.length);
    await handleAdminBalanceConfirm(env, callbackQuery, opId);
    return;
  }

  if (data.startsWith('adm:bal_cancel:')) {
    const opId = data.slice('adm:bal_cancel:'.length);
    await handleAdminBalanceCancel(env, callbackQuery, opId);
    return;
  }

  // Secretary Mode (PnA X Logs) callbacks
  if (data === 'adm:secretary') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminSecretaryMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:sec_verify') {
    await handleAdminSecretaryVerify(env, callbackQuery);
    return;
  }

  if (data === 'adm:sec_test') {
    await handleAdminSecretaryTest(env, callbackQuery);
    return;
  }

  if (data === 'adm:sec_retry') {
    await handleAdminSecretaryRetry(env, callbackQuery);
    return;
  }

  if (data === 'adm:sec_toggle') {
    await handleAdminSecretaryToggle(env, callbackQuery);
    return;
  }

  if (data === 'adm:sec_set_ch') {
    await handleAdminSecretaryChannelPrompt(env, callbackQuery);
    return;
  }

  if (data === 'adm:admins') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminManagementMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:add_admin') {
    if (!isOwner(adminId, env)) {
      await answerCallbackQuery(env, callbackQuery.id, '👑 Strictly Owner-only action.', true);
      return;
    }
    await setUserState(env, adminId, { type: 'admin_add_admin' });
    await answerCallbackQuery(env, callbackQuery.id);
    await sendMessage(
      env,
      chatId,
      `${buildHeader('👑', 'ADD NEW ADMINISTRATOR')}\nSend the Telegram ID of the user to promote to Admin (e.g. <code>123456789</code>):`,
      { reply_markup: cancelInputKeyboard(true) }
    );
    return;
  }

  if (data.startsWith('adm:rem_admin:')) {
    if (!isOwner(adminId, env)) {
      await answerCallbackQuery(env, callbackQuery.id, '👑 Strictly Owner-only action.', true);
      return;
    }
    const targetId = data.slice('adm:rem_admin:'.length);
    if (isOwner(targetId, env)) {
      await answerCallbackQuery(env, callbackQuery.id, '👑 Cannot remove the Bot Owner!', true);
      return;
    }
    const removed = await removeAdminRecord(env, targetId);
    if (!removed) {
      await answerCallbackQuery(env, callbackQuery.id, 'Admin not found.', true);
      return;
    }
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.ADMIN_REMOVED,
      `Removed admin Telegram ID ${targetId}`
    );
    await logAdminRoleChangeEvent(env, { ownerId: adminId, targetAdminId: targetId, action: 'REMOVED' });
    await answerCallbackQuery(env, callbackQuery.id, `🗑️ Removed admin ${targetId}`, true);
    await handleAdminManagementMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:stats') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminStatistics(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:broadcast') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminBroadcastStart(env, adminId, chatId);
    return;
  }

  if (data.startsWith('adm:bc_send:')) {
    await handleAdminBroadcastConfirm(env, callbackQuery, data.slice('adm:bc_send:'.length), ctx);
    return;
  }

  if (data.startsWith('adm:bc_cancel:')) {
    await handleAdminBroadcastCancel(env, callbackQuery, data.slice('adm:bc_cancel:'.length));
    return;
  }

  if (data === 'adm:maintenance') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminMaintenanceMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data.startsWith('adm:maint_toggle:')) {
    if (!(await hasAdminPermission(adminId, 'manageMaintenance', env))) {
      await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
      return;
    }
    const turnOn = data.endsWith(':on');
    await updateSettings(env, { maintenanceMode: turnOn });
    await logAdminActivity(
      env,
      adminId,
      turnOn ? ACTIVITY_ACTIONS.MAINTENANCE_ENABLED : ACTIVITY_ACTIONS.MAINTENANCE_DISABLED,
      turnOn ? 'Maintenance mode enabled' : 'Maintenance mode disabled'
    );
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      turnOn ? '🔧 Maintenance Mode ENABLED' : '🟢 Maintenance Mode DISABLED',
      true
    );
    await handleAdminMaintenanceMenu(env, adminId, chatId, msgId);
    return;
  }

  if (data === 'adm:maint_msg') {
    if (!(await hasAdminPermission(adminId, 'manageMaintenance', env))) {
      await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
      return;
    }
    await setUserState(env, adminId, { type: 'admin_edit_maint_msg' });
    await answerCallbackQuery(env, callbackQuery.id);
    await sendMessage(
      env,
      chatId,
      `${buildHeader('✏️', 'EDIT MAINTENANCE MESSAGE')}\nSend the new maintenance notice message for users:`,
      { reply_markup: cancelInputKeyboard(true) }
    );
    return;
  }

  if (data.startsWith('adm:logs:')) {
    const page = Number(data.split(':')[2] || 1);
    await answerCallbackQuery(env, callbackQuery.id);
    await handleAdminActivityLogs(env, adminId, chatId, page, msgId);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, 'Unknown admin action.');
}

// ============================================================================
// ADMIN MULTI-STEP STATE INPUT ROUTER
// ============================================================================

export async function handleAdminStateInput(env, message, state) {
  const adminId = String(message.from.id);
  const chatId = message.chat.id;

  if (!(await isAdmin(adminId, env))) {
    await clearUserState(env, adminId);
    return false;
  }

  switch (state.type) {
    case 'admin_bulk_vouchers':
      await handleAdminBulkVoucherInput(env, message, state);
      return true;

    case 'admin_set_low_stock':
      await handleAdminLowStockInput(env, message, state);
      return true;

    case 'admin_fj_chat_id':
      await handleAdminForceChannelChatIdInput(env, message);
      return true;

    case 'admin_fj_invite_link':
      await handleAdminForceChannelLinkInput(env, message, state);
      return true;

    case 'admin_edit_setting':
      await handleAdminSettingInput(env, message, state);
      return true;

    case 'admin_broadcast_compose':
      await handleAdminBroadcastComposeInput(env, message);
      return true;

    case 'admin_bal_user_id':
      await handleAdminBalanceUserIdInput(env, message);
      return true;

    case 'admin_bal_amount':
      await handleAdminBalanceAmountInput(env, message, state);
      return true;

    case 'admin_bal_reason':
      await handleAdminBalanceReasonSubmit(env, adminId, chatId, message.text || '', state);
      return true;

    case 'admin_sec_channel':
      await handleAdminSecretaryChannelInput(env, message);
      return true;

    case 'admin_wd_reject_reason': {
      const reason = String(message.text || '').trim();
      await clearUserState(env, adminId);
      await handleAdminRejectExecute(env, adminId, chatId, state.requestId, reason);
      return true;
    }

    case 'admin_search_user': {
      const q = String(message.text || '').trim();
      if (!/^\d{5,20}$/.test(q)) {
        await sendMessage(env, chatId, '⚠️ Please enter a valid numeric Telegram ID.');
        return true;
      }
      await clearUserState(env, adminId);
      await sendMessage(env, chatId, `🔍 Search result for <code>${escapeHtml(q)}</code>:`, {
        reply_markup: adminReplyKeyboard(),
      });
      await handleAdminUserDetail(env, adminId, chatId, q);
      return true;
    }

    case 'admin_add_admin': {
      if (!isOwner(adminId, env)) {
        await clearUserState(env, adminId);
        await sendMessage(env, chatId, '👑 Strictly Owner-only action.', {
          reply_markup: adminReplyKeyboard(),
        });
        return true;
      }
      const targetId = String(message.text || '').trim();
      if (!/^\d{5,20}$/.test(targetId)) {
        await sendMessage(env, chatId, '⚠️ Please send a valid numeric Telegram User ID.');
        return true;
      }
      if (isOwner(targetId, env)) {
        await clearUserState(env, adminId);
        await sendMessage(env, chatId, '👑 That ID is already the Bot Owner.', {
          reply_markup: adminReplyKeyboard(),
        });
        return true;
      }
      const existingUser = await getUser(env, targetId);
      await upsertAdminRecord(env, {
        id: targetId,
        name: existingUser ? formatUserName(existingUser) : `Admin ${targetId}`,
        username: existingUser?.username || '',
        addedBy: adminId,
        addedAt: Date.now(),
        active: true,
        permissions: { ...DEFAULT_ADMIN_PERMISSIONS },
      });
      await clearUserState(env, adminId);
      await logAdminActivity(
        env,
        adminId,
        ACTIVITY_ACTIONS.ADMIN_ADDED,
        `Added admin Telegram ID ${targetId}`
      );
      await logAdminRoleChangeEvent(env, { ownerId: adminId, targetAdminId: targetId, action: 'ADDED' });
      await sendMessage(
        env,
        chatId,
        `✅ Telegram ID <code>${escapeHtml(targetId)}</code> has been added as an Administrator!`,
        { reply_markup: adminReplyKeyboard() }
      );
      await handleAdminManagementMenu(env, adminId, chatId);
      return true;
    }

    case 'admin_edit_maint_msg': {
      const msg = String(message.text || '').trim();
      if (!msg) {
        await sendMessage(env, chatId, '⚠️ Please send non-empty text for the maintenance message.');
        return true;
      }
      await updateSettings(env, { maintenanceMessage: escapeHtml(msg) });
      await clearUserState(env, adminId);
      await sendMessage(env, chatId, '✅ Maintenance message updated.', {
        reply_markup: adminReplyKeyboard(),
      });
      await handleAdminMaintenanceMenu(env, adminId, chatId);
      return true;
    }

    default:
      return false;
  }
}
