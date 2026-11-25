// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin 📡 Secretary Mode (PnA X Logs) Control Panel
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  ACTIVITY_ACTIONS,
  BOT_BRAND,
  escapeHtml,
  formatIST,
  generateId,
  getConfiguredLogChannelId,
} from '../config.js';
import {
  clearUserState,
  getSecretaryConfig,
  getSecretaryLogStats,
  isAdmin,
  isOwner,
  saveSecretaryConfig,
  setUserState,
} from '../database.js';
import { adminActionKeyboard, adminReplyKeyboard, cancelInputKeyboard } from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import {
  emitSecretaryLog,
  parseSecretaryChannelInput,
  retryFailedSecretaryLogs,
  verifySecretaryChannel,
} from '../services/secretary.js';
import { answerCallbackQuery, editOrSend, sendMessage } from '../telegram.js';

/**
 * 📡 Secretary Mode overview & owner configuration controls
 */
export async function handleAdminSecretaryMenu(env, adminId, chatId, messageId = null) {
  const aid = String(adminId);
  if (!(await isAdmin(aid, env))) {
    await sendMessage(env, chatId, '🚫 Access denied. Authorized administrators only.');
    return;
  }

  const ownerFlag = isOwner(aid, env);
  const [cfg, stats] = await Promise.all([
    getSecretaryConfig(env),
    getSecretaryLogStats(env),
  ]);

  const envDefault = getConfiguredLogChannelId(env);
  const statusBadge = cfg.manuallyDisabled
    ? '⏸️ PAUSED BY OWNER'
    : cfg.enabled && cfg.verifiedAdmin
    ? '🟢 ACTIVE & VERIFIED'
    : '🔴 INACTIVE (Admin Verification Required)';

  const text =
    `${buildHeader('📡', 'SECRETARY MODE — PnA X Logs')}\n` +
    `📌 <b>Status:</b> <b>${statusBadge}</b>\n` +
    `📢 <b>Channel Name:</b> ${escapeHtml(cfg.channelTitle || 'PnA X Logs')}\n` +
    `🎯 <b>Configured Target:</b> <code>${escapeHtml(cfg.channelInput || envDefault || 'Not set')}</code>\n` +
    `🆔 <b>Resolved Numeric Chat ID:</b> <code>${escapeHtml(cfg.resolvedChatId || 'Not resolved yet')}</code>\n` +
    `🛡️ <b>Bot Admin Verified:</b> ${cfg.verifiedAdmin ? `✅ Yes (${formatIST(cfg.verifiedAt, env)})` : '❌ Not verified'}\n` +
    `${cfg.lastError ? `⚠️ <b>Last Error:</b> <i>${escapeHtml(cfg.lastError)}</i>\n` : ''}` +
    `${DIVIDER}\n` +
    `📊 <b>Delivery Stats:</b>\n` +
    `• ✅ Sent: <b>${stats.sent}</b> | ❌ Failed: <b>${stats.failed}</b> | ⏭️ Skipped: <b>${stats.skipped}</b>\n` +
    `${DIVIDER}\n` +
    `<i>Automatic background logging for new users, referrals, withdrawals, manual balance edits, vouchers, daily bonuses, tasks, bans, admin changes, force-join, broadcasts, and bot errors.</i>`;

  const rows = [];
  if (ownerFlag) {
    rows.push([{ text: '✅ Verify Bot Admin & Activate', callback_data: 'adm:sec_verify' }]);
    rows.push([
      { text: '🧪 Send Test Log', callback_data: 'adm:sec_test' },
      { text: `🔁 Retry Failed (${stats.failed})`, callback_data: 'adm:sec_retry' },
    ]);
    rows.push([
      { text: '✏️ Set Channel ID / @username', callback_data: 'adm:sec_set_ch' },
      {
        text: cfg.manuallyDisabled ? '▶️ Resume Logging' : '⏸️ Pause Logging',
        callback_data: 'adm:sec_toggle',
      },
    ]);
  } else {
    rows.push([{ text: '🔄 Refresh Status', callback_data: 'adm:secretary' }]);
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

export async function handleAdminSecretaryVerify(env, callbackQuery) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!isOwner(adminId, env)) {
    await answerCallbackQuery(env, callbackQuery.id, '👑 Owner-only configuration.', true);
    return;
  }

  const res = await verifySecretaryChannel(env);
  if (res.ok) {
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.SECRETARY_CONFIG_CHANGED,
      `Verified & activated Secretary Mode on "${res.config.channelTitle}" (${res.config.resolvedChatId})`
    );
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      `✅ Verified! Secretary Mode is now ACTIVE on ${res.config.channelTitle}.`,
      true
    );
  } else {
    await answerCallbackQuery(env, callbackQuery.id, `❌ ${res.error.slice(0, 180)}`, true);
  }

  await handleAdminSecretaryMenu(env, adminId, chatId, msgId);
}

export async function handleAdminSecretaryTest(env, callbackQuery) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!isOwner(adminId, env)) {
    await answerCallbackQuery(env, callbackQuery.id, '👑 Owner-only action.', true);
    return;
  }

  const res = await emitSecretaryLog(env, {
    eventType: 'TEST_LOG',
    dedupKey: `test_log:${generateId('TST')}`,
    text:
      `📡 <b>PnA X Logs — 🧪 SECRETARY MODE TEST</b>\n` +
      `${DIVIDER}\n` +
      `✅ <b>${BOT_BRAND}</b> Secretary Mode is connected and verified.\n` +
      `👑 <b>Triggered By Owner:</b> <code>${escapeHtml(adminId)}</code>\n` +
      `🕒 <b>Time:</b> ${formatIST(Date.now(), env)}`,
  });

  if (res.ok) {
    await answerCallbackQuery(env, callbackQuery.id, '✅ Test log delivered to PnA X Logs!', true);
  } else {
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      `❌ Test failed: ${res.error || res.reason}`,
      true
    );
  }

  await handleAdminSecretaryMenu(env, adminId, chatId, msgId);
}

export async function handleAdminSecretaryRetry(env, callbackQuery) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!isOwner(adminId, env)) {
    await answerCallbackQuery(env, callbackQuery.id, '👑 Owner-only action.', true);
    return;
  }

  const res = await retryFailedSecretaryLogs(env, 15);
  if (!res.ok) {
    await answerCallbackQuery(env, callbackQuery.id, `❌ ${res.error}`, true);
  } else if (res.retried === 0) {
    await answerCallbackQuery(env, callbackQuery.id, '✅ No failed logs to retry.', true);
  } else {
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      `🔁 Retried ${res.retried}: ${res.sent} sent, ${res.failed} still failed.`,
      true
    );
  }

  await handleAdminSecretaryMenu(env, adminId, chatId, msgId);
}

export async function handleAdminSecretaryToggle(env, callbackQuery) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!isOwner(adminId, env)) {
    await answerCallbackQuery(env, callbackQuery.id, '👑 Owner-only configuration.', true);
    return;
  }

  const cfg = await getSecretaryConfig(env);
  if (!cfg.manuallyDisabled) {
    await saveSecretaryConfig(env, { manuallyDisabled: true, enabled: false });
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.SECRETARY_CONFIG_CHANGED,
      'Paused Secretary Mode channel logging'
    );
    await answerCallbackQuery(env, callbackQuery.id, '⏸️ Secretary Mode paused.', true);
  } else {
    await saveSecretaryConfig(env, { manuallyDisabled: false });
    const ver = await verifySecretaryChannel(env);
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.SECRETARY_CONFIG_CHANGED,
      ver.ok
        ? `Resumed & verified Secretary Mode (${ver.config.resolvedChatId})`
        : `Attempted to resume Secretary Mode (verification failed: ${ver.error})`
    );
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      ver.ok ? '▶️ Secretary Mode resumed & verified!' : `⚠️ Verification failed: ${ver.error.slice(0, 150)}`,
      true
    );
  }

  await handleAdminSecretaryMenu(env, adminId, chatId, msgId);
}

export async function handleAdminSecretaryChannelPrompt(env, callbackQuery) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;

  if (!isOwner(adminId, env)) {
    await answerCallbackQuery(env, callbackQuery.id, '👑 Owner-only configuration.', true);
    return;
  }

  await setUserState(env, adminId, { type: 'admin_sec_channel' });
  await answerCallbackQuery(env, callbackQuery.id);

  await sendMessage(
    env,
    chatId,
    `${buildHeader('📡', 'CONFIGURE PnA X Logs CHANNEL')}\n` +
      `Send either:\n` +
      `• Public channel username (e.g. <code>@pnarewards</code> or <code>https://t.me/pnarewards</code>)\n` +
      `• Private channel numeric ID (e.g. <code>-1001234567890</code>)\n\n` +
      `⚠️ <i>Do NOT send a private invite link (t.me/+...). Add the bot as Administrator with "Post Messages" permission first.</i>\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

export async function handleAdminSecretaryChannelInput(env, message) {
  const adminId = String(message.from.id);
  const chatId = message.chat.id;
  if (!isOwner(adminId, env)) {
    await clearUserState(env, adminId);
    return;
  }

  const raw = String(message.text || '').trim();
  const parsed = parseSecretaryChannelInput(raw);
  if (!parsed.ok) {
    await sendMessage(env, chatId, `⚠️ ${escapeHtml(parsed.error)}`);
    return;
  }

  await clearUserState(env, adminId);
  const ver = await verifySecretaryChannel(env, parsed.target);

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.SECRETARY_CONFIG_CHANGED,
    `Set Secretary Mode channel to ${parsed.target} (verified=${ver.ok}, resolvedId=${ver.config.resolvedChatId || 'none'})`
  );

  if (ver.ok) {
    await sendMessage(
      env,
      chatId,
      `✅ <b>PnA X Logs Verified & Activated!</b>\n` +
        `📢 Channel: <b>${escapeHtml(ver.config.channelTitle)}</b>\n` +
        `🆔 Resolved Chat ID: <code>${escapeHtml(ver.config.resolvedChatId)}</code>`,
      { reply_markup: adminReplyKeyboard() }
    );
  } else {
    await sendMessage(
      env,
      chatId,
      `⚠️ <b>Channel Saved, But Bot Admin Verification Failed</b>\n` +
        `${escapeHtml(ver.error)}\n\n` +
        `Secretary Mode remains <b>INACTIVE</b> until the bot is promoted to Administrator with Post Messages permission and verified.`,
      { reply_markup: adminReplyKeyboard() }
    );
  }

  await handleAdminSecretaryMenu(env, adminId, chatId);
}
