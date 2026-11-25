// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Manual User Balance Management (Add / Deduct)
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  MAX_MANUAL_BALANCE_ADJUSTMENT_PAISE,
  escapeHtml,
  formatINR,
  formatIST,
  formatUserName,
  formatUsernameTag,
  generateId,
  parseStrictPositiveINR,
} from '../config.js';
import {
  clearUserState,
  getUser,
  getUserState,
  hasAdminPermission,
  setUserState,
} from '../database.js';
import { adminReplyKeyboard, cancelInputKeyboard } from '../keyboards.js';
import { applyAdminBalanceAdjustment } from '../services/balance.js';
import { answerCallbackQuery, editOrSend, sendMessage } from '../telegram.js';

/**
 * Step 1: Open 💰 Manage User Balance -> prompt for target user's Telegram ID
 */
export async function handleAdminManageBalanceStart(env, adminId, chatId) {
  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await sendMessage(env, chatId, '🚫 You do not have permission to manage user balances.');
    return;
  }

  await setUserState(env, adminId, { type: 'admin_bal_user_id' });
  await sendMessage(
    env,
    chatId,
    `${buildHeader('💰', 'MANAGE USER BALANCE (STEP 1/5)')}\n` +
      `Send the target user's numeric <b>Telegram ID</b> (e.g. <code>8838351233</code>).\n\n` +
      `<i>You will review their profile and current balance before choosing Add or Deduct.</i>\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

/**
 * Step 2: Fetch user & show current balance + Add / Deduct buttons
 */
export async function handleAdminManageBalanceForUser(
  env,
  adminId,
  chatId,
  targetUserId,
  messageId = null
) {
  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const uid = String(targetUserId || '').trim();
  const user = await getUser(env, uid);
  if (!user) {
    await sendMessage(
      env,
      chatId,
      `❌ No registered user found with Telegram ID <code>${escapeHtml(uid)}</code>.\n\n` +
        `Send another numeric Telegram ID or tap <b>❌ Cancel</b>.`
    );
    return;
  }

  await clearUserState(env, adminId);

  const statusBadge =
    user.status === 'active'
      ? '🟢 Active'
      : user.status === 'banned'
      ? '⛔ Banned'
      : '🔕 Blocked Bot';

  const text =
    `${buildHeader('💰', 'MANAGE USER BALANCE (STEP 2/5)')}\n` +
    `👤 <b>User:</b> ${escapeHtml(formatUserName(user))}\n` +
    `🔗 <b>Username:</b> ${escapeHtml(formatUsernameTag(user.username))}\n` +
    `🆔 <b>Telegram ID:</b> <code>${escapeHtml(user.id)}</code>\n` +
    `🛡️ <b>Status:</b> ${statusBadge}\n` +
    `${DIVIDER}\n` +
    `🏦 <b>Current Available Balance:</b> <b>${formatINR(user.balancePaise)}</b>\n` +
    `⏳ <b>Pending Withdrawal:</b> ${formatINR(user.pendingWithdrawalPaise)}\n` +
    `📈 <b>Total Earned:</b> ${formatINR(user.totalEarnedPaise)}\n` +
    `${DIVIDER}\n` +
    `👇 Choose an action for this user:`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '➕ Add Balance', callback_data: `adm:bal_act:ADD:${user.id}` },
        { text: '➖ Deduct Balance', callback_data: `adm:bal_act:DEDUCT:${user.id}` },
      ],
      [{ text: '👤 View Full User Profile', callback_data: `adm:uview:${user.id}` }],
    ],
  };

  if (messageId) {
    await editOrSend(env, chatId, messageId, text, { reply_markup });
  } else {
    await sendMessage(env, chatId, text, { reply_markup });
  }
}

/**
 * Step 1 Input: Validate Telegram ID and show profile + Add/Deduct buttons
 */
export async function handleAdminBalanceUserIdInput(env, message) {
  const adminId = String(message.from.id);
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await clearUserState(env, adminId);
    return;
  }

  const targetId = String(message.text || '').trim();
  if (!/^\d{5,20}$/.test(targetId)) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Invalid Telegram ID. Please send a valid numeric Telegram ID (5–20 digits).'
    );
    return;
  }

  const user = await getUser(env, targetId);
  if (!user) {
    await sendMessage(
      env,
      chatId,
      `❌ User <code>${escapeHtml(targetId)}</code> is not registered in the database yet.\n\nPlease verify the ID and try again, or tap <b>❌ Cancel</b>.`
    );
    return;
  }

  await sendMessage(env, chatId, `✅ User <code>${escapeHtml(targetId)}</code> loaded.`, {
    reply_markup: adminReplyKeyboard(),
  });
  await handleAdminManageBalanceForUser(env, adminId, chatId, targetId);
}

/**
 * Step 3: Admin selected ➕ Add Balance or ➖ Deduct Balance -> ask for amount in INR
 */
export async function handleAdminBalanceActionSelect(env, callbackQuery, action, targetUserId) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;

  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const act = String(action || '').toUpperCase();
  if (act !== 'ADD' && act !== 'DEDUCT') {
    await answerCallbackQuery(env, callbackQuery.id, 'Invalid balance action.', true);
    return;
  }

  const user = await getUser(env, targetUserId);
  if (!user) {
    await answerCallbackQuery(env, callbackQuery.id, 'User not found.', true);
    return;
  }

  if (act === 'DEDUCT' && user.balancePaise <= 0) {
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      'User balance is ₹0.00 — cannot deduct below zero.',
      true
    );
    return;
  }

  await setUserState(env, adminId, {
    type: 'admin_bal_amount',
    action: act,
    targetUserId: user.id,
  });

  await answerCallbackQuery(
    env,
    callbackQuery.id,
    act === 'ADD' ? 'Selected Add Balance' : 'Selected Deduct Balance'
  );

  const maxInr = formatINR(MAX_MANUAL_BALANCE_ADJUSTMENT_PAISE);
  const deductNote =
    act === 'DEDUCT'
      ? `\n🛡️ <b>Maximum Deductible:</b> <b>${formatINR(user.balancePaise)}</b> (negative balance is never allowed)`
      : '';

  await sendMessage(
    env,
    chatId,
    `${buildHeader(act === 'ADD' ? '➕' : '➖', `${act === 'ADD' ? 'ADD' : 'DEDUCT'} BALANCE (STEP 3/5)`)}\n` +
      `👤 <b>Target User:</b> ${escapeHtml(formatUserName(user))} [<code>${escapeHtml(user.id)}</code>]\n` +
      `🏦 <b>Current Balance:</b> <b>${formatINR(user.balancePaise)}</b>${deductNote}\n` +
      `${DIVIDER}\n` +
      `Enter the amount in <b>INR Rupees</b> (up to 2 decimal places, max ${maxInr}):\n` +
      `Examples: <code>10</code>, <code>25.50</code>, <code>0.50</code>\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

/**
 * Step 4: Validate rupee amount -> ask for optional reason
 */
export async function handleAdminBalanceAmountInput(env, message, state) {
  const adminId = String(message.from.id);
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await clearUserState(env, adminId);
    return;
  }

  const amountPaise = parseStrictPositiveINR(message.text);
  if (amountPaise === null) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Invalid amount. Enter a positive number in rupees with up to 2 decimal places (e.g. <code>10</code> or <code>25.50</code>). Zero and negative values are rejected.'
    );
    return;
  }

  if (amountPaise > MAX_MANUAL_BALANCE_ADJUSTMENT_PAISE) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Amount exceeds the single-operation safety limit of <b>${formatINR(MAX_MANUAL_BALANCE_ADJUSTMENT_PAISE)}</b>. Enter a smaller amount.`
    );
    return;
  }

  const user = await getUser(env, state.targetUserId);
  if (!user) {
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, '❌ Target user no longer exists.', {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  if (state.action === 'DEDUCT' && amountPaise > user.balancePaise) {
    await sendMessage(
      env,
      chatId,
      `🚫 <b>Insufficient User Balance</b>\n` +
        `Cannot deduct <b>${formatINR(amountPaise)}</b> because user's current balance is <b>${formatINR(user.balancePaise)}</b>.\n` +
        `Negative balances are strictly prohibited. Enter an amount ≤ <b>${formatINR(user.balancePaise)}</b>.`
    );
    return;
  }

  await setUserState(env, adminId, {
    type: 'admin_bal_reason',
    action: state.action,
    targetUserId: user.id,
    amountPaise,
  });

  await sendMessage(
    env,
    chatId,
    `${buildHeader('📝', 'ENTER REASON (STEP 4/5)')}\n` +
      `⚡ <b>Action:</b> ${state.action === 'ADD' ? '➕ Add Balance' : '➖ Deduct Balance'}\n` +
      `💵 <b>Amount:</b> <b>${formatINR(amountPaise)}</b>\n` +
      `${DIVIDER}\n` +
      `Type an <b>optional reason</b> for this adjustment (recorded in user history, admin logs, and PnA X Logs), or tap <b>⏭️ Skip Reason</b>:`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '⏭️ Skip Reason', callback_data: 'adm:bal_skip_reason' }]],
      },
    }
  );
}

/**
 * Step 5: Render Confirmation Screen with unique one-time operationId
 */
export async function handleAdminBalanceReasonSubmit(
  env,
  adminId,
  chatId,
  rawReason,
  state,
  messageId = null
) {
  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  if (!state || state.type !== 'admin_bal_reason') {
    await sendMessage(env, chatId, '⚠️ Balance adjustment session expired. Please start again.', {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  const user = await getUser(env, state.targetUserId);
  if (!user) {
    await clearUserState(env, adminId);
    await sendMessage(env, chatId, '❌ Target user not found.', {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  const amountPaise = Number(state.amountPaise || 0);
  if (state.action === 'DEDUCT' && amountPaise > user.balancePaise) {
    await clearUserState(env, adminId);
    await sendMessage(
      env,
      chatId,
      `🚫 User balance changed to <b>${formatINR(user.balancePaise)}</b>; cannot deduct <b>${formatINR(amountPaise)}</b>.`,
      { reply_markup: adminReplyKeyboard() }
    );
    return;
  }

  let cleanReason = String(rawReason || '').trim().slice(0, 250);
  if (cleanReason === '-' || cleanReason.toLowerCase() === 'skip') {
    cleanReason = '';
  }

  const newBalancePaise =
    state.action === 'ADD'
      ? user.balancePaise + amountPaise
      : user.balancePaise - amountPaise;

  const operationId = generateId('BAL');
  await setUserState(env, adminId, {
    type: 'admin_bal_confirm',
    operationId,
    action: state.action,
    targetUserId: user.id,
    amountPaise,
    reason: cleanReason,
  });

  const actionLabel = state.action === 'ADD' ? '➕ ADD BALANCE' : '➖ DEDUCT BALANCE';
  const sign = state.action === 'ADD' ? '+' : '-';

  const text =
    `${buildHeader('🛡️', 'CONFIRM BALANCE ADJUSTMENT (STEP 5/5)')}\n` +
    `🆔 <b>Operation ID:</b> <code>${escapeHtml(operationId)}</code>\n` +
    `👤 <b>User ID:</b> <code>${escapeHtml(user.id)}</code> (${escapeHtml(formatUserName(user))})\n` +
    `🏦 <b>Current Balance:</b> <b>${formatINR(user.balancePaise)}</b>\n` +
    `⚡ <b>Action:</b> <b>${actionLabel}</b>\n` +
    `💵 <b>Amount:</b> <b>${sign}${formatINR(amountPaise)}</b>\n` +
    `🏦 <b>New Balance:</b> <b>${formatINR(newBalancePaise)}</b>\n` +
    `📝 <b>Reason:</b> ${escapeHtml(cleanReason || 'Not specified')}\n` +
    `${DIVIDER}\n` +
    `⚠️ <i>Please review carefully. This updates the user's wallet and immutable ledger atomically.</i>`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: '✅ Confirm & Apply Change', callback_data: `adm:bal_confirm:${operationId}` }],
      [{ text: '❌ Cancel Operation', callback_data: `adm:bal_cancel:${operationId}` }],
    ],
  };

  if (messageId) {
    await editOrSend(env, chatId, messageId, text, { reply_markup });
  } else {
    await sendMessage(env, chatId, '📋 Please confirm the balance adjustment below:', {
      reply_markup: adminReplyKeyboard(),
    });
    await sendMessage(env, chatId, text, { reply_markup });
  }
}

/**
 * Step 6: Execute confirmed atomic balance adjustment (strictly once per operationId)
 */
export async function handleAdminBalanceConfirm(env, callbackQuery, operationId) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const state = await getUserState(env, adminId);
  if (!state || state.type !== 'admin_bal_confirm' || state.operationId !== operationId) {
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      '⚠️ This balance operation was already processed or expired.',
      true
    );
    return;
  }

  // Clear state immediately before commit to block rapid double-click replays
  await clearUserState(env, adminId);

  const res = await applyAdminBalanceAdjustment(env, {
    operationId: state.operationId,
    adminId,
    targetUserId: state.targetUserId,
    action: state.action,
    amountPaise: state.amountPaise,
    reason: state.reason,
  });

  if (!res.ok) {
    await answerCallbackQuery(env, callbackQuery.id, res.error || 'Operation failed.', true);
    await editOrSend(
      env,
      chatId,
      msgId,
      `❌ <b>Balance Adjustment Rejected</b>\n${DIVIDER}\n${escapeHtml(res.error)}`
    );
    return;
  }

  const adj = res.adjustment;
  const sign = adj.action === 'ADD' ? '+' : '-';
  await answerCallbackQuery(env, callbackQuery.id, '✅ Balance updated atomically!', true);

  await editOrSend(
    env,
    chatId,
    msgId,
    `${buildHeader('✅', 'BALANCE ADJUSTMENT APPLIED')}\n` +
      `🆔 <b>Operation ID:</b> <code>${escapeHtml(adj.id)}</code>\n` +
      `👤 <b>User ID:</b> <code>${escapeHtml(adj.targetUserId)}</code>\n` +
      `⚡ <b>Action:</b> <b>${escapeHtml(adj.action)}</b>\n` +
      `💵 <b>Amount:</b> <b>${sign}${formatINR(adj.amountPaise)}</b>\n` +
      `🏦 <b>Previous Balance:</b> ${formatINR(adj.balanceBeforePaise)}\n` +
      `🏦 <b>New Balance:</b> <b>${formatINR(adj.balanceAfterPaise)}</b>\n` +
      `📝 <b>Reason:</b> ${escapeHtml(adj.reason || 'Not specified')}\n` +
      `👮 <b>Admin ID:</b> <code>${escapeHtml(adj.adminId)}</code>\n` +
      `🕒 <b>Applied At:</b> ${formatIST(adj.createdAt, env)}\n` +
      `${DIVIDER}\n` +
      `✅ Recorded in immutable ledger, user transaction history, admin logs, and PnA X Logs.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 View User Account', callback_data: `adm:uview:${adj.targetUserId}` }],
        ],
      },
    }
  );
}

/**
 * Cancel pending confirmation cleanly
 */
export async function handleAdminBalanceCancel(env, callbackQuery, operationId) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageBalances', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const state = await getUserState(env, adminId);
  if (state?.type === 'admin_bal_confirm' && state.operationId === operationId) {
    await clearUserState(env, adminId);
  }

  await answerCallbackQuery(env, callbackQuery.id, 'Balance operation cancelled.');
  await editOrSend(
    env,
    chatId,
    msgId,
    `❌ Balance adjustment <code>${escapeHtml(operationId)}</code> was cancelled. No balance changes were made.`
  );
}
