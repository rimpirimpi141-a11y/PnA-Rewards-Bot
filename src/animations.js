// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Animations & Premium Formatting Helpers
// ============================================================================

import { BOT_BRAND, escapeHtml, sleep } from './config.js';
import { deleteMessage, editMessageText, sendMessage } from './telegram.js';

export const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

export function buildHeader(emoji, title) {
  return `${emoji} <b>${title}</b>\n${DIVIDER}`;
}

/**
 * Generates an emoji progress bar, e.g. [▓▓▓▓▓░░░░░] 50%
 */
export function progressBar(percent, size = 10) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * size);
  const empty = size - filled;
  return `[${'▓'.repeat(filled)}${'░'.repeat(empty)}] ${clamped}%`;
}

/**
 * Multi-step welcome animation using controlled edits & short delays
 * so it feels smooth and premium without spamming chat history.
 */
export async function playWelcomeAnimation(env, chatId, firstName = '') {
  const safeName = escapeHtml(firstName || 'Friend');

  const first = await sendMessage(
    env,
    chatId,
    `✨ <b>Initializing ${BOT_BRAND}...</b>\n\n⏳ ${progressBar(25)}`
  );
  if (!first.ok || !first.result?.message_id) {
    return null;
  }

  const msgId = first.result.message_id;

  await sleep(320);
  await editMessageText(
    env,
    chatId,
    msgId,
    `🎁 <b>Loading Rewards & Voucher Vault...</b>\n\n⚡ ${progressBar(65)}`
  );

  await sleep(320);
  await editMessageText(
    env,
    chatId,
    msgId,
    `🚀 <b>Ready! Welcome, ${safeName}!</b>\n\n✅ ${progressBar(100)}`
  );

  await sleep(280);
  const welcomeBanner =
    `✨ <b>Welcome to</b>\n` +
    `<b>${BOT_BRAND}</b>\n` +
    `${DIVIDER}\n` +
    `🎁 <b>Earn Rewards | Invite Friends | Redeem Vouchers</b>\n\n` +
    `👋 Hello, <b>${safeName}</b>!\n` +
    `💎 Invite friends & earn instant INR rewards\n` +
    `🎁 Claim your Daily Bonus every 24 hours\n` +
    `🎟️ Redeem Amazon, Google Play & Other Vouchers\n` +
    `${DIVIDER}`;

  await editMessageText(env, chatId, msgId, welcomeBanner);
  return msgId;
}

/**
 * Shows a sleek loading indicator while performing an action, then cleanly
 * edits or removes it to avoid clutter.
 */
export async function showLoadingMessage(env, chatId, text = '⏳ Processing your request...') {
  const res = await sendMessage(env, chatId, `<i>${escapeHtml(text)}</i>`);
  return res.ok ? res.result?.message_id : null;
}

export async function clearLoadingMessage(env, chatId, messageId) {
  if (!messageId) return;
  await deleteMessage(env, chatId, messageId).catch(() => {});
}

export async function playVerificationAnimation(env, chatId, messageId) {
  if (!messageId) return;
  await editMessageText(
    env,
    chatId,
    messageId,
    `🔍 <b>Verifying Channel Membership...</b>\n\n⏳ ${progressBar(40)}`
  );
  await sleep(300);
  await editMessageText(
    env,
    chatId,
    messageId,
    `🔐 <b>Checking Permissions & Syncing Account...</b>\n\n⚡ ${progressBar(85)}`
  );
  await sleep(250);
}
