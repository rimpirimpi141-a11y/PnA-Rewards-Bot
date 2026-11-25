// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Force-Join & Request-to-Join Channel Management
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  ACTIVITY_ACTIONS,
  escapeHtml,
  generateId,
  isValidTelegramUrl,
} from '../config.js';
import {
  clearUserState,
  deleteForceChannel,
  getForceChannels,
  hasAdminPermission,
  setUserState,
  upsertForceChannel,
} from '../database.js';
import {
  adminActionKeyboard,
  adminReplyKeyboard,
  cancelInputKeyboard,
} from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import { inspectChannelForAdmin, resolveChannelTarget } from '../services/membership.js';
import { logForceChannelChangeEvent } from '../services/secretary.js';
import { answerCallbackQuery, editOrSend, sendMessage } from '../telegram.js';

/**
 * 3. 📢 Force-Join Channels Overview
 */
export async function handleAdminForceChannelsMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await sendMessage(env, chatId, '🚫 You do not have permission to manage force-join channels.');
    return;
  }

  const channels = await getForceChannels(env);
  let text =
    `${buildHeader('📢', 'FORCE-JOIN CHANNELS')}\n` +
    `Configured Channels: <b>${channels.length}</b>\n` +
    `⚠️ <i>Important: This bot MUST be an <b>Administrator</b> in every configured channel (with "Invite Users via Link" enabled for Request-to-Join links).</i>\n` +
    `${DIVIDER}\n`;

  const rows = [
    [{ text: '➕ Add Force Channel', callback_data: 'adm:fj_add' }],
  ];

  if (!channels.length) {
    text += `<i>No force-join channels configured yet. Users can currently enter directly.</i>\n`;
  } else {
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const modeBadge = ch.isRequestToJoin ? '🔐 Request-to-Join' : '🌐 Normal Join';
      const userLine = ch.username ? `\n   🏷️ Username: <code>${escapeHtml(ch.username)}</code>` : '';
      text +=
        `${i + 1}. <b>${escapeHtml(ch.title)}</b> (${modeBadge})\n` +
        `   🆔 Chat ID: <code>${escapeHtml(ch.chatId)}</code>${userLine}\n` +
        `   🔗 Invite URL: ${escapeHtml(ch.inviteLink)}\n\n`;
      rows.push([
        {
          text: `🗑️ Remove: ${String(ch.title || ch.chatId).slice(0, 26)}`,
          callback_data: `adm:fj_del:${ch.id}`,
        },
      ]);
    }
    rows.push([{ text: '🩺 Test Channels & Bot Admin Status', callback_data: 'adm:fj_test' }]);
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

/**
 * Step 1: Start Add Force Channel wizard (separate Channel ID / Username from Invite URL)
 */
export async function handleAdminForceChannelAddStart(env, callbackQuery) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  await setUserState(env, adminId, { type: 'admin_fj_chat_id' });
  await answerCallbackQuery(env, callbackQuery.id);

  await sendMessage(
    env,
    chatId,
    `${buildHeader('➕', 'ADD FORCE-JOIN CHANNEL (STEP 1/3)')}\n` +
      `Send the channel's <b>numeric Channel ID</b> (recommended for private & request-to-join channels, e.g. <code>-1001234567890</code>) OR public <b>@username</b> (e.g. <code>@pnarewards</code>).\n\n` +
      `⚠️ <b>Do NOT send an invite URL here</b> — you will enter the invite URL separately in Step 3.\n` +
      `🛡️ <b>Requirement:</b> Add this bot as an <b>Administrator</b> in the channel first.\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

/**
 * Step 1 input: Channel ID or @username -> inspect connectivity & Bot Admin status
 */
export async function handleAdminForceChannelChatIdInput(env, message) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await clearUserState(env, adminId);
    return;
  }

  const raw = String(message.text || '').trim();
  if (!raw) {
    await sendMessage(env, chatId, '⚠️ Please send a valid numeric Channel ID (<code>-100...</code>) or public <code>@username</code>.');
    return;
  }

  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.includes('t.me/')) {
    await sendMessage(
      env,
      chatId,
      '⚠️ That looks like an invite URL, not a Channel ID.\n\nPlease send the numeric Channel ID (e.g. <code>-1001234567890</code>) or public <code>@username</code> first. You will provide the invite URL in Step 3.'
    );
    return;
  }

  const isUsername = /^@[a-zA-Z0-9_]{4,32}$/.test(raw);
  const isNumericId = /^-100\d{5,20}$/.test(raw) || /^-\d{5,20}$/.test(raw);
  if (!isUsername && !isNumericId) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Invalid format. Send either a numeric channel ID starting with <code>-100</code> or a public <code>@channelusername</code>.'
    );
    return;
  }

  const inspection = await inspectChannelForAdmin(env, raw);
  let resolvedChatId = raw;
  let resolvedUsername = isUsername ? raw : '';
  let resolvedTitle = raw;
  let isPrivate = !isUsername;
  let suggestedLink = isUsername ? `https://t.me/${raw.slice(1)}` : '';
  let diagnosticBlock = '';

  if (inspection.ok) {
    resolvedChatId = inspection.chat.chatId;
    resolvedUsername = inspection.chat.username || resolvedUsername;
    resolvedTitle = inspection.chat.title;
    isPrivate = inspection.chat.isPrivate;
    if (inspection.chat.inviteLink) {
      suggestedLink = inspection.chat.inviteLink;
    }

    if (inspection.isBotAdmin) {
      const invitePerm = inspection.canInviteUsers
        ? '✅ Invite/Join-Request Access: Enabled'
        : '⚠️ Invite/Join-Request Access: OFF (enable "Invite Users via Link" for Request-to-Join channels)';
      diagnosticBlock =
        `✅ <b>Connectivity:</b> Connected\n` +
        `🛡️ <b>Bot Admin Status:</b> Confirmed (<code>${escapeHtml(inspection.botStatus)}</code>)\n` +
        `${invitePerm}`;
    } else {
      diagnosticBlock =
        `✅ <b>Connectivity:</b> Reachable\n` +
        `❌ <b>Bot Admin Status:</b> NOT Administrator (<code>${escapeHtml(inspection.botStatus)}</code>)\n` +
        `🛠️ <b>Fix Required:</b> ${escapeHtml(inspection.fixHint)}`;
    }
  } else {
    diagnosticBlock =
      `❌ <b>Connectivity Error:</b> <i>${escapeHtml(inspection.error)}</i>\n` +
      `🛠️ <b>Fix Required:</b> ${escapeHtml(inspection.fixHint)}`;
  }

  await setUserState(env, adminId, {
    type: 'admin_fj_mode_select',
    chatId: resolvedChatId,
    username: resolvedUsername,
    title: resolvedTitle,
    isPrivate,
    suggestedLink,
  });

  const userRow = resolvedUsername ? `\n🏷️ <b>Username:</b> <code>${escapeHtml(resolvedUsername)}</code>` : '';

  await sendMessage(
    env,
    chatId,
    `${buildHeader('🔐', 'ADD FORCE-JOIN CHANNEL (STEP 2/3)')}\n` +
      `📢 <b>Channel:</b> ${escapeHtml(resolvedTitle)}\n` +
      `🆔 <b>Resolved Channel ID:</b> <code>${escapeHtml(resolvedChatId)}</code>${userRow}\n` +
      `${DIVIDER}\n` +
      `${diagnosticBlock}\n` +
      `${DIVIDER}\n` +
      `Select the invite link type for this channel:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Normal Invite Link (Instant Join)', callback_data: 'adm:fj_mode:normal' }],
          [{ text: '🔐 Request-to-Join Invite Link (Admin Approval)', callback_data: 'adm:fj_mode:request' }],
        ],
      },
    }
  );
}

/**
 * Step 2 callback: Choose Normal vs Request-to-Join invite link mode
 */
export async function handleAdminForceChannelModeSelect(env, callbackQuery, mode, state) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  if (!state || state.type !== 'admin_fj_mode_select') {
    await answerCallbackQuery(env, callbackQuery.id, 'Session expired. Start adding the channel again.', true);
    return;
  }

  const isRequestToJoin = mode === 'request';
  await setUserState(env, adminId, {
    ...state,
    type: 'admin_fj_invite_link',
    isRequestToJoin,
  });

  await answerCallbackQuery(
    env,
    callbackQuery.id,
    isRequestToJoin ? 'Selected Request-to-Join' : 'Selected Normal Invite Link'
  );

  const hint = isRequestToJoin
    ? `Send your <b>Request-to-Join Invite URL</b> (e.g. <code>https://t.me/+AbCdEfGhIjK</code>).\n\n<i>Note: Users who request access will see a pending-approval status and will NOT be granted bot access until a channel admin approves them.</i>`
    : state.suggestedLink
    ? `Detected invite link: <code>${escapeHtml(state.suggestedLink)}</code>\nSend a custom invite link, or type <code>use</code> to use the detected link.`
    : `Send the channel's <b>Telegram Invite Link</b> (e.g. <code>https://t.me/+AbCdEfGhIjK</code> or <code>https://t.me/pnarewards</code>).`;

  await sendMessage(
    env,
    chatId,
    `${buildHeader('🔗', 'ADD FORCE-JOIN CHANNEL (STEP 3/3)')}\n` +
      `📢 <b>Channel:</b> ${escapeHtml(state.title)}\n` +
      `🆔 <b>Channel ID:</b> <code>${escapeHtml(state.chatId)}</code>\n` +
      `🔐 <b>Join Mode:</b> ${isRequestToJoin ? 'Request-to-Join (Approval Required)' : 'Normal Join'}\n\n` +
      `${hint}`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

/**
 * Step 3 input: Invite URL (stored strictly separate from Channel ID)
 */
export async function handleAdminForceChannelLinkInput(env, message, state) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await clearUserState(env, adminId);
    return;
  }

  let input = String(message.text || '').trim();
  if (input.toLowerCase() === 'use' && state.suggestedLink && !state.isRequestToJoin) {
    input = state.suggestedLink;
  }

  if (!isValidTelegramUrl(input)) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Please send a valid Telegram invite URL starting with <code>https://t.me/</code>.'
    );
    return;
  }

  const newChannel = await upsertForceChannel(env, {
    id: generateId('FJ'),
    chatId: String(state.chatId),
    username: String(state.username || ''),
    title: String(state.title || state.chatId),
    inviteLink: input,
    isPrivate: Boolean(state.isPrivate),
    isRequestToJoin: Boolean(state.isRequestToJoin),
    addedBy: String(adminId),
    addedAt: Date.now(),
  });

  await clearUserState(env, adminId);

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.FORCE_CHANNEL_ADDED,
    `Saved force-join channel "${newChannel.title}" (${newChannel.chatId}, ${newChannel.isRequestToJoin ? 'Request-to-Join' : 'Normal'}) -> ${newChannel.inviteLink}`
  );
  await logForceChannelChangeEvent(env, { adminId, action: 'ADDED', channel: newChannel });

  const modeLabel = newChannel.isRequestToJoin
    ? '🔐 Request-to-Join (Admin Approval Required)'
    : '🌐 Normal Invite Link';

  await sendMessage(
    env,
    chatId,
    `✅ <b>Force-Join Channel Saved!</b>\n` +
      `${DIVIDER}\n` +
      `📢 <b>Title:</b> ${escapeHtml(newChannel.title)}\n` +
      `🆔 <b>Channel ID:</b> <code>${escapeHtml(newChannel.chatId)}</code>\n` +
      `${newChannel.username ? `🏷️ <b>Username:</b> <code>${escapeHtml(newChannel.username)}</code>\n` : ''}` +
      `🔐 <b>Join Mode:</b> ${modeLabel}\n` +
      `🔗 <b>Invite URL:</b> ${escapeHtml(newChannel.inviteLink)}`,
    { reply_markup: adminReplyKeyboard() }
  );
  await handleAdminForceChannelsMenu(env, adminId, chatId);
}

/**
 * Remove a configured force-join channel
 */
export async function handleAdminForceChannelDelete(env, callbackQuery, channelId) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const target = await deleteForceChannel(env, channelId);
  if (!target) {
    await answerCallbackQuery(env, callbackQuery.id, 'Channel already removed.', true);
    await handleAdminForceChannelsMenu(env, adminId, chatId, msgId);
    return;
  }

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.FORCE_CHANNEL_REMOVED,
    `Removed force-join channel "${target.title}" (${target.chatId})`
  );
  await logForceChannelChangeEvent(env, { adminId, action: 'REMOVED', channel: target });

  await answerCallbackQuery(env, callbackQuery.id, `🗑️ Removed ${target.title}`, true);
  await handleAdminForceChannelsMenu(env, adminId, chatId, msgId);
}

/**
 * Full Connectivity & Bot Administrator Permission Diagnostic for all Force-Join Channels
 */
export async function handleAdminForceChannelTest(env, callbackQuery) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, '🩺 Running channel & bot admin diagnostics...');
  const channels = await getForceChannels(env);

  let text = `${buildHeader('🩺', 'FORCE-JOIN DIAGNOSTICS')}\n`;
  if (!channels.length) {
    text += `<i>No force-join channels configured.</i>`;
  } else {
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const target = resolveChannelTarget(ch);
      const check = await inspectChannelForAdmin(env, target);
      const modeTag = ch.isRequestToJoin ? 'Request-to-Join' : 'Normal';

      if (!check.ok) {
        text +=
          `${i + 1}. ❌ <b>${escapeHtml(ch.title)}</b> (${modeTag})\n` +
          `   🆔 <code>${escapeHtml(ch.chatId)}</code>\n` +
          `   ❌ Connectivity: <i>${escapeHtml(check.error)}</i>\n` +
          `   🛠️ Fix: ${escapeHtml(check.fixHint)}\n\n`;
      } else if (!check.isBotAdmin) {
        text +=
          `${i + 1}. ⚠️ <b>${escapeHtml(check.chat.title)}</b> (${modeTag})\n` +
          `   🆔 <code>${escapeHtml(check.chat.chatId)}</code>\n` +
          `   ✅ Connectivity: Reachable\n` +
          `   ❌ Bot Admin Status: <b>NOT ADMIN</b> (<code>${escapeHtml(check.botStatus)}</code>)\n` +
          `   🛠️ Fix: ${escapeHtml(check.fixHint)}\n\n`;
      } else {
        const permLine = ch.isRequestToJoin && !check.canInviteUsers
          ? `   ⚠️ Join-Request Permission: <b>Missing "Invite Users via Link"</b>\n   🛠️ Fix: ${escapeHtml(check.fixHint)}\n`
          : `   ✅ Permissions: Ready for verification${ch.isRequestToJoin ? ' & chat_join_request' : ''}\n`;
        text +=
          `${i + 1}. ✅ <b>${escapeHtml(check.chat.title)}</b> (${modeTag})\n` +
          `   🆔 <code>${escapeHtml(check.chat.chatId)}</code>\n` +
          `   🛡️ Bot Status: <b>${escapeHtml(check.botStatus.toUpperCase())}</b>\n` +
          `${permLine}\n`;
      }
    }
  }

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Re-run Diagnostics', callback_data: 'adm:fj_test' }],
        [{ text: '⬅️ Back to Force Channels', callback_data: 'adm:force_channels' }],
      ],
    },
  });
}
