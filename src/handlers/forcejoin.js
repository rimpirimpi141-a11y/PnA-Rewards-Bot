// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Force-Join Channel Management Handler
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
  getForceChannels,
  hasAdminPermission,
  saveForceChannels,
  setUserState,
} from '../database.js';
import {
  adminBackKeyboard,
  cancelInputKeyboard,
  mainMenuKeyboard,
} from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import { inspectChannelForAdmin } from '../services/membership.js';
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
    `${DIVIDER}\n`;

  const rows = [
    [{ text: '➕ Add Force Channel', callback_data: 'adm:fj_add' }],
  ];

  if (!channels.length) {
    text += `<i>No force-join channels configured yet. Users can currently enter directly.</i>\n`;
  } else {
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      text +=
        `${i + 1}. <b>${escapeHtml(ch.title)}</b>\n` +
        `   🆔 Chat ID: <code>${escapeHtml(ch.chatId)}</code>\n` +
        `   🔗 Link: ${escapeHtml(ch.inviteLink)}\n\n`;
      rows.push([
        {
          text: `🗑️ Remove: ${ch.title.slice(0, 26)}`,
          callback_data: `adm:fj_del:${ch.id}`,
        },
      ]);
    }
    rows.push([{ text: '🩺 Test Channel Permissions', callback_data: 'adm:fj_test' }]);
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminBackKeyboard(rows),
  });
}

/**
 * Start Add Force Channel wizard
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
    `${buildHeader('➕', 'ADD FORCE-JOIN CHANNEL (STEP 1/2)')}\n` +
      `Send the channel's <b>@username</b> (public) OR numeric <b>Chat ID</b> (private, e.g. <code>-1001234567890</code>).\n\n` +
      `⚠️ <i>Make sure this bot is already added as an <b>Admin</b> in that channel so membership checks succeed.</i>\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard() }
  );
}

/**
 * Step 1 input: Chat ID or @username
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
    await sendMessage(env, chatId, '⚠️ Please send a valid @channelusername or numeric -100... chat ID.');
    return;
  }

  // Validate format: @username or negative numeric ID
  const isUsername = /^@[a-zA-Z0-9_]{4,32}$/.test(raw);
  const isNumericId = /^-100\d{5,20}$/.test(raw) || /^-\d{5,20}$/.test(raw);
  if (!isUsername && !isNumericId) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Invalid format. Send either a public <code>@channelusername</code> or a channel ID starting with <code>-100</code>.'
    );
    return;
  }

  const inspection = await inspectChannelForAdmin(env, raw);
  let resolvedChatId = raw;
  let resolvedTitle = raw;
  let suggestedLink = isUsername ? `https://t.me/${raw.slice(1)}` : '';
  let warningText = '';

  if (inspection.ok) {
    resolvedChatId = inspection.chat.chatId;
    resolvedTitle = inspection.chat.title;
    if (inspection.chat.inviteLink) {
      suggestedLink = inspection.chat.inviteLink;
    }
  } else {
    warningText =
      `\n\n⚠️ <b>Heads-up:</b> Telegram returned: <i>${escapeHtml(inspection.error)}</i>\n` +
      `Please double-check that the bot is an Admin in that channel before expecting users to verify.`;
  }

  await setUserState(env, adminId, {
    type: 'admin_fj_invite_link',
    chatId: resolvedChatId,
    title: resolvedTitle,
    suggestedLink,
  });

  const hint = suggestedLink
    ? `Detected invite link: <code>${escapeHtml(suggestedLink)}</code>\nSend a custom invite link, or type <code>use</code> to use the detected link.`
    : `Send the channel's <b>Telegram Invite Link</b> (e.g. <code>https://t.me/+AbCdEfGhIjK</code> or <code>https://t.me/pnarewards</code>).`;

  await sendMessage(
    env,
    chatId,
    `${buildHeader('🔗', 'ADD FORCE-JOIN CHANNEL (STEP 2/2)')}\n` +
      `📢 <b>Channel:</b> ${escapeHtml(resolvedTitle)}\n` +
      `🆔 <b>Chat ID:</b> <code>${escapeHtml(resolvedChatId)}</code>\n\n` +
      `${hint}${warningText}`,
    { reply_markup: cancelInputKeyboard() }
  );
}

/**
 * Step 2 input: Invite link
 */
export async function handleAdminForceChannelLinkInput(env, message, state) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await clearUserState(env, adminId);
    return;
  }

  let input = String(message.text || '').trim();
  if (input.toLowerCase() === 'use' && state.suggestedLink) {
    input = state.suggestedLink;
  }

  if (!isValidTelegramUrl(input)) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Please send a valid Telegram channel link starting with <code>https://t.me/</code>.'
    );
    return;
  }

  const channels = await getForceChannels(env);
  const existingIdx = channels.findIndex((c) => String(c.chatId) === String(state.chatId));

  const newChannel = {
    id: existingIdx >= 0 ? channels[existingIdx].id : generateId('FJ'),
    chatId: String(state.chatId),
    title: String(state.title || state.chatId),
    inviteLink: input,
    addedBy: String(adminId),
    addedAt: Date.now(),
  };

  if (existingIdx >= 0) {
    channels[existingIdx] = newChannel;
  } else {
    channels.push(newChannel);
  }

  await saveForceChannels(env, channels);
  await clearUserState(env, adminId);

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.FORCE_CHANNEL_ADDED,
    `Added/Updated force-join channel "${newChannel.title}" (${newChannel.chatId}) -> ${newChannel.inviteLink}`
  );

  await sendMessage(
    env,
    chatId,
    `✅ <b>Force-Join Channel Saved!</b>\n${DIVIDER}\n📢 <b>Title:</b> ${escapeHtml(newChannel.title)}\n🆔 <b>Chat ID:</b> <code>${escapeHtml(newChannel.chatId)}</code>\n🔗 <b>Link:</b> ${escapeHtml(newChannel.inviteLink)}`,
    { reply_markup: mainMenuKeyboard(true) }
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

  const channels = await getForceChannels(env);
  const target = channels.find((c) => c.id === channelId);
  if (!target) {
    await answerCallbackQuery(env, callbackQuery.id, 'Channel already removed.', true);
    await handleAdminForceChannelsMenu(env, adminId, chatId, msgId);
    return;
  }

  const updated = channels.filter((c) => c.id !== channelId);
  await saveForceChannels(env, updated);

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.FORCE_CHANNEL_REMOVED,
    `Removed force-join channel "${target.title}" (${target.chatId})`
  );

  await answerCallbackQuery(env, callbackQuery.id, `🗑️ Removed ${target.title}`, true);
  await handleAdminForceChannelsMenu(env, adminId, chatId, msgId);
}

/**
 * Diagnose bot access/permissions across all configured force-join channels
 */
export async function handleAdminForceChannelTest(env, callbackQuery) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageForceChannels', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, '🩺 Testing channel access...');
  const channels = await getForceChannels(env);

  let text = `${buildHeader('🩺', 'FORCE-JOIN CHANNEL HEALTH CHECK')}\n`;
  if (!channels.length) {
    text += `<i>No channels configured.</i>`;
  } else {
    for (const ch of channels) {
      const check = await inspectChannelForAdmin(env, ch.chatId);
      if (check.ok) {
        text += `✅ <b>${escapeHtml(check.chat.title)}</b> (<code>${escapeHtml(ch.chatId)}</code>) — Accessible\n`;
      } else {
        text += `❌ <b>${escapeHtml(ch.title)}</b> (<code>${escapeHtml(ch.chatId)}</code>) — <i>${escapeHtml(check.error)}</i>\n`;
      }
    }
  }

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Back to Force Channels', callback_data: 'adm:force_channels' }],
        [{ text: '⬅️ Admin Panel', callback_data: 'adm:menu' }],
      ],
    },
  });
}
