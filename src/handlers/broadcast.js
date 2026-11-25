// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Broadcast System (Text, Photo, Video & Media)
// ============================================================================

import { DIVIDER, buildHeader, progressBar } from '../animations.js';
import {
  ACTIVITY_ACTIONS,
  escapeHtml,
  formatIST,
  generateId,
  sleep,
} from '../config.js';
import {
  clearUserState,
  getBroadcastAudienceCounts,
  getBroadcastEligibleUserIds,
  getBroadcastRecord,
  hasAdminPermission,
  markUserBlocked,
  saveBroadcastRecord,
  setUserState,
} from '../database.js';
import { adminReplyKeyboard, cancelInputKeyboard } from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import { logBroadcastEvent } from '../services/secretary.js';
import {
  answerCallbackQuery,
  copyMessage,
  editMessageText,
  sendMessage,
} from '../telegram.js';

/**
 * 8. 📣 Broadcast — Step 1: Prompt admin to send broadcast content
 */
export async function handleAdminBroadcastStart(env, adminId, chatId) {
  if (!(await hasAdminPermission(adminId, 'broadcast', env))) {
    await sendMessage(env, chatId, '🚫 You do not have permission to send broadcasts.');
    return;
  }

  await setUserState(env, adminId, { type: 'admin_broadcast_compose' });

  await sendMessage(
    env,
    chatId,
    `${buildHeader('📣', 'CREATE BROADCAST')}\n` +
      `Send the message you want to broadcast to all users.\n\n` +
      `✅ <b>Supported Formats:</b>\n` +
      `• Text messages\n` +
      `• Photos with captions\n` +
      `• Videos with captions\n` +
      `• GIFs / Animations / Documents with captions\n\n` +
      `<i>You will see a recipient count and confirmation screen before anything is sent.</i>\n\n` +
      `Tap <b>❌ Cancel</b> to abort.`,
    { reply_markup: cancelInputKeyboard(true) }
  );
}

/**
 * Step 2: Capture admin's text or media message and show Confirmation screen
 */
export async function handleAdminBroadcastComposeInput(env, message) {
  const adminId = message.from.id;
  const chatId = message.chat.id;
  if (!(await hasAdminPermission(adminId, 'broadcast', env))) {
    await clearUserState(env, adminId);
    return;
  }

  let mediaType = 'text';
  let previewSummary = '';

  if (message.photo?.length) {
    mediaType = 'photo';
    previewSummary = message.caption || '[Photo without caption]';
  } else if (message.video) {
    mediaType = 'video';
    previewSummary = message.caption || '[Video without caption]';
  } else if (message.animation) {
    mediaType = 'animation';
    previewSummary = message.caption || '[Animation without caption]';
  } else if (message.document) {
    mediaType = 'document';
    previewSummary = message.caption || `[Document: ${message.document.file_name || 'file'}]`;
  } else if (message.audio) {
    mediaType = 'audio';
    previewSummary = message.caption || '[Audio]';
  } else if (message.text) {
    mediaType = 'text';
    previewSummary = message.text;
  } else {
    await sendMessage(
      env,
      chatId,
      '⚠️ Unsupported message type. Please send text, photo, video, GIF, audio, or document.'
    );
    return;
  }

  const { eligibleCount, skippedBlocked } = await getBroadcastAudienceCounts(env);

  const broadcastId = generateId('BC');
  const record = {
    id: broadcastId,
    adminId: String(adminId),
    sourceChatId: String(chatId),
    sourceMessageId: message.message_id,
    mediaType,
    previewSummary: String(previewSummary).slice(0, 200),
    totalRecipients: eligibleCount,
    skippedBlocked,
    sentCount: 0,
    failedCount: 0,
    newlyBlockedCount: 0,
    status: 'draft', // draft | running | completed | cancelled
    createdAt: Date.now(),
    completedAt: null,
  };

  await saveBroadcastRecord(env, record);
  await clearUserState(env, adminId);

  const text =
    `${buildHeader('📣', 'CONFIRM BROADCAST')}\n` +
    `🆔 <b>Broadcast ID:</b> <code>${escapeHtml(broadcastId)}</code>\n` +
    `📦 <b>Media Type:</b> <b>${escapeHtml(mediaType.toUpperCase())}</b>\n` +
    `👥 <b>Eligible Recipients:</b> <b>${eligibleCount}</b>\n` +
    `🚫 <b>Skipped (Blocked Bot):</b> <b>${skippedBlocked}</b>\n` +
    `${DIVIDER}\n` +
    `📝 <b>Preview:</b>\n<i>${escapeHtml(record.previewSummary)}${previewSummary.length > 200 ? '...' : ''}</i>\n` +
    `${DIVIDER}\n` +
    `Are you sure you want to broadcast this message?`;

  await sendMessage(env, chatId, '✅ Broadcast draft prepared.', {
    reply_markup: adminReplyKeyboard(),
  });

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🚀 Confirm & Send (${eligibleCount} users)`, callback_data: `adm:bc_send:${broadcastId}` }],
        [{ text: '❌ Cancel Broadcast', callback_data: `adm:bc_cancel:${broadcastId}` }],
      ],
    },
  });
}

/**
 * Step 3a: Cancel draft broadcast
 */
export async function handleAdminBroadcastCancel(env, callbackQuery, broadcastId) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'broadcast', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const record = await getBroadcastRecord(env, broadcastId);
  if (record && record.status === 'draft') {
    record.status = 'cancelled';
    await saveBroadcastRecord(env, record);
  }

  await answerCallbackQuery(env, callbackQuery.id, 'Broadcast cancelled.');
  await editMessageText(
    env,
    chatId,
    msgId,
    `❌ Broadcast <code>${escapeHtml(broadcastId)}</code> was cancelled.`
  );
}

/**
 * Step 3b: Execute rate-limited broadcast safely using ctx.waitUntil so
 * Telegram webhook returns promptly while deliveries stream with progress updates.
 */
export async function handleAdminBroadcastConfirm(env, callbackQuery, broadcastId, ctx) {
  const adminId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'broadcast', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const record = await getBroadcastRecord(env, broadcastId);
  if (!record) {
    await answerCallbackQuery(env, callbackQuery.id, 'Broadcast draft not found.', true);
    return;
  }
  if (record.status !== 'draft') {
    await answerCallbackQuery(env, callbackQuery.id, `Broadcast is already ${record.status}.`, true);
    return;
  }

  record.status = 'running';
  await saveBroadcastRecord(env, record);
  await logBroadcastEvent(env, { phase: 'STARTED', record });
  await answerCallbackQuery(env, callbackQuery.id, '🚀 Broadcast started!');

  await editMessageText(
    env,
    chatId,
    msgId,
    `${buildHeader('📣', 'BROADCAST IN PROGRESS')}\n` +
      `🆔 <code>${escapeHtml(broadcastId)}</code>\n` +
      `⏳ ${progressBar(0)}\n\n` +
      `Starting rate-limited delivery...`
  );

  const runJob = async () => {
    const recipients = await getBroadcastEligibleUserIds(env);

    const total = recipients.length;
    let sent = 0;
    let failed = 0;
    let newlyBlocked = 0;
    const progressInterval = Math.max(10, Math.min(25, Math.ceil(total / 6)));

    for (let i = 0; i < total; i++) {
      const targetUserId = recipients[i];

      // Use Telegram copyMessage to support text, photo, video, GIF, doc & captions natively
      let res = await copyMessage(
        env,
        targetUserId,
        record.sourceChatId,
        record.sourceMessageId
      );

      // Respect Telegram 429 rate limits gracefully
      if (!res.ok && res.errorCode === 429 && res.retryAfter > 0 && res.retryAfter <= 10) {
        await sleep(res.retryAfter * 1000 + 150);
        res = await copyMessage(
          env,
          targetUserId,
          record.sourceChatId,
          record.sourceMessageId
        );
      }

      if (res.ok) {
        sent++;
      } else {
        failed++;
        if (res.isBlocked) {
          newlyBlocked++;
          await markUserBlocked(env, targetUserId);
        }
      }

      // Safe Telegram API rate limiting (~20-22 msgs/sec)
      if (i < total - 1) {
        await sleep(45);
      }

      // Live progress updates for admin
      if ((i + 1) % progressInterval === 0 && i + 1 < total) {
        const pct = Math.round(((i + 1) / total) * 100);
        await editMessageText(
          env,
          chatId,
          msgId,
          `${buildHeader('📣', 'BROADCAST IN PROGRESS')}\n` +
            `🆔 <code>${escapeHtml(broadcastId)}</code>\n` +
            `⚡ ${progressBar(pct)}\n\n` +
            `👥 Processed: <b>${i + 1} / ${total}</b>\n` +
            `✅ Delivered: <b>${sent}</b>\n` +
            `❌ Failed: <b>${failed}</b> (Blocked: ${newlyBlocked})`
        );
      }
    }

    record.totalRecipients = total;
    record.sentCount = sent;
    record.failedCount = failed;
    record.newlyBlockedCount = newlyBlocked;
    record.status = 'completed';
    record.completedAt = Date.now();
    await saveBroadcastRecord(env, record);

    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.BROADCAST_SENT,
      `Broadcast ${broadcastId} (${record.mediaType}): ${sent}/${total} delivered, ${failed} failed (${newlyBlocked} newly blocked)`
    );
    await logBroadcastEvent(env, { phase: 'COMPLETED', record });

    await editMessageText(
      env,
      chatId,
      msgId,
      `${buildHeader('✅', 'BROADCAST COMPLETED')}\n` +
        `🆔 <b>Broadcast ID:</b> <code>${escapeHtml(broadcastId)}</code>\n` +
        `📦 <b>Type:</b> ${escapeHtml(record.mediaType.toUpperCase())}\n` +
        `${DIVIDER}\n` +
        `👥 <b>Total Recipients:</b> <b>${total}</b>\n` +
        `✅ <b>Successful Deliveries:</b> <b>${sent}</b>\n` +
        `❌ <b>Failed Deliveries:</b> <b>${failed}</b>\n` +
        `🚫 <b>Marked Blocked (Skipped Future):</b> <b>${newlyBlocked}</b>\n` +
        `🕒 <b>Finished At:</b> ${formatIST(record.completedAt, env)}`
    );
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runJob());
  } else {
    await runJob();
  }
}
