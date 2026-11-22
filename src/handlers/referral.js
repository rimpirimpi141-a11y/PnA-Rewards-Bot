// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Refer & Earn Handler
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import { escapeHtml, formatINR, formatIST, formatUsernameTag } from '../config.js';
import { getSettings, getUserReferrals } from '../database.js';
import { referralInlineKeyboard } from '../keyboards.js';
import { buildReferralLink } from '../services/referral-service.js';
import { editOrSend } from '../telegram.js';
import { ensureUserAccess } from './start.js';

/**
 * 👥 Refer & Earn overview
 */
export async function handleReferralView(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const [settings, referralLink] = await Promise.all([
    getSettings(env),
    buildReferralLink(env, access.user.id),
  ]);

  const rewardStr = formatINR(settings.referralRewardPaise);
  const text =
    `${buildHeader('👥', 'REFER & EARN')}\n` +
    `💸 <b>Reward per Valid Referral:</b> <b>${rewardStr}</b>\n\n` +
    `🔗 <b>Your Unique Referral Link:</b>\n` +
    `<code>${escapeHtml(referralLink)}</code>\n\n` +
    `${DIVIDER}\n` +
    `🏆 <b>Total Successful Referrals:</b> <b>${access.user.totalReferrals || 0}</b>\n` +
    `💰 <b>Total Referral Earnings:</b> <b>${formatINR(access.user.referralEarningsPaise)}</b>\n` +
    `${DIVIDER}\n` +
    `📌 <b>Referral Rules:</b>\n` +
    `• Invite genuinely new Telegram users via your link\n` +
    `• Reward is credited after they join & verify\n` +
    `• Self-referrals & duplicate accounts are strictly blocked`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: referralInlineKeyboard(referralLink, rewardStr),
  });
}

/**
 * 📋 Recent Referrals list for the user
 */
export async function handleReferralListView(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const referrals = await getUserReferrals(env, access.user.id);
  const recent = referrals.slice(0, 15);

  let text =
    `${buildHeader('📋', 'MY REFERRAL HISTORY')}\n` +
    `🏆 <b>Total Successful Referrals:</b> <b>${access.user.totalReferrals || 0}</b>\n` +
    `💰 <b>Total Earned:</b> <b>${formatINR(access.user.referralEarningsPaise)}</b>\n` +
    `${DIVIDER}\n`;

  if (!recent.length) {
    text += `<i>You haven't referred anyone yet. Share your link to start earning!</i>`;
  } else {
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i];
      text +=
        `${i + 1}. <b>${escapeHtml(r.referredName || 'User')}</b> (${escapeHtml(formatUsernameTag(r.referredUsername))})\n` +
        `   💰 +${formatINR(r.amountPaise)} • <i>${formatIST(r.creditedAt, env)}</i>\n`;
    }
    if (referrals.length > 15) {
      text += `\n<i>Showing latest 15 of ${referrals.length} referrals.</i>`;
    }
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Back to Refer & Earn', callback_data: 'usr:refer' }],
        [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
      ],
    },
  });
}
