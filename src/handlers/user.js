// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — User Balance, Profile, History, Support & Update Channel
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  BOT_BRAND,
  escapeHtml,
  formatINR,
  formatIST,
  formatUserName,
  formatUsernameTag,
  getCategoryMeta,
} from '../config.js';
import {
  getSettings,
  getUserVoucherHistory,
  getUserWithdrawals,
} from '../database.js';
import {
  balanceInlineKeyboard,
  profileInlineKeyboard,
  supportInlineKeyboard,
  updateChannelInlineKeyboard,
} from '../keyboards.js';
import { getBalanceSummary } from '../services/balance.js';
import { editOrSend, sendMessage } from '../telegram.js';
import { ensureUserAccess } from './start.js';

/**
 * 💰 My Balance
 */
export async function handleBalanceView(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const summary = getBalanceSummary(access.user);
  const text =
    `${buildHeader('💰', 'MY BALANCE')}\n` +
    `🏦 <b>Available Balance:</b> <b>${formatINR(summary.availablePaise)}</b>\n` +
    `${DIVIDER}\n` +
    `📈 <b>Total Earned:</b> ${formatINR(summary.totalEarnedPaise)}\n` +
    `👥 <b>Referral Earnings:</b> ${formatINR(summary.referralEarningsPaise)}\n` +
    `🎁 <b>Daily Bonus Earnings:</b> ${formatINR(summary.dailyBonusEarningsPaise)}\n` +
    `${DIVIDER}\n` +
    `✅ <b>Total Withdrawn:</b> ${formatINR(summary.totalWithdrawnPaise)}\n` +
    `⏳ <b>Pending Withdrawal:</b> ${formatINR(summary.pendingWithdrawalPaise)}\n` +
    `${DIVIDER}\n` +
    `💡 <i>Currency: INR (₹) • Invite friends or claim daily bonus to grow your wallet!</i>`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: balanceInlineKeyboard(),
  });
}

/**
 * 👤 My Profile
 */
export async function handleProfileView(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const u = access.user;
  const statusBadge = u.status === 'active' ? '🟢 Active' : `🔴 ${escapeHtml(u.status)}`;

  const text =
    `${buildHeader('👤', 'MY PROFILE')}\n` +
    `🪪 <b>Name:</b> ${escapeHtml(formatUserName(u))}\n` +
    `🔗 <b>Username:</b> ${escapeHtml(formatUsernameTag(u.username))}\n` +
    `🆔 <b>Telegram ID:</b> <code>${escapeHtml(u.id)}</code>\n` +
    `📅 <b>Joined On:</b> ${formatIST(u.joinedAt, env)}\n` +
    `🛡️ <b>Account Status:</b> ${statusBadge}\n` +
    `${DIVIDER}\n` +
    `💰 <b>Available Balance:</b> <b>${formatINR(u.balancePaise)}</b>\n` +
    `👥 <b>Total Referrals:</b> <b>${u.totalReferrals || 0}</b>\n` +
    `🎁 <b>Daily Bonuses Claimed:</b> <b>${u.dailyBonusCount || 0}</b>\n` +
    `🎟️ <b>Approved Withdrawals:</b> <b>${u.withdrawalCount || 0}</b>\n` +
    `${DIVIDER}`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: profileInlineKeyboard(),
  });
}

/**
 * 🎟️ User's Own Voucher & Withdrawal History (Strictly isolated to caller's userId!)
 */
export async function handleUserHistoryView(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const [vouchers, withdrawals] = await Promise.all([
    getUserVoucherHistory(env, access.user.id, 8),
    getUserWithdrawals(env, access.user.id, 8),
  ]);

  let text = `${buildHeader('🎟️', 'MY VOUCHERS & WITHDRAWALS')}\n`;

  if (vouchers.length > 0) {
    text += `🔑 <b>Delivered Vouchers (Latest ${vouchers.length}):</b>\n`;
    for (const v of vouchers) {
      const cat = getCategoryMeta(v.category);
      const label = cat ? `${cat.emoji} ${cat.shortName}` : escapeHtml(v.category);
      text +=
        `• ${label} (${formatINR(v.valuePaise)})\n` +
        `  Code: <code>${escapeHtml(v.code)}</code>\n` +
        `  Date: <i>${formatIST(v.deliveredAt, env)}</i>\n`;
    }
    text += `${DIVIDER}\n`;
  } else {
    text += `🔑 <b>Delivered Vouchers:</b>\n<i>No vouchers delivered yet.</i>\n${DIVIDER}\n`;
  }

  if (withdrawals.length > 0) {
    text += `💸 <b>Recent Withdrawal Requests:</b>\n`;
    for (const w of withdrawals) {
      const cat = getCategoryMeta(w.category);
      const label = cat ? cat.shortName : w.category;
      const badge =
        w.status === 'approved'
          ? '✅ Approved'
          : w.status === 'rejected'
          ? '❌ Rejected'
          : '⏳ Pending';
      text += `• <code>${escapeHtml(w.id)}</code> — ${escapeHtml(label)} (${formatINR(w.amountPaise)}) — ${badge}\n`;
    }
  } else {
    text += `💸 <b>Recent Withdrawal Requests:</b>\n<i>No withdrawal requests submitted yet.</i>`;
  }

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💸 Withdraw Now', callback_data: 'usr:withdraw' }],
        [{ text: '👤 Back to Profile', callback_data: 'usr:profile' }],
        [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
      ],
    },
  });
}

/**
 * 🎧 Support
 */
export async function handleSupportView(env, tgUser, chatId) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const settings = await getSettings(env);
  const support = settings.supportUsername || '@Pritam_power';

  const text =
    `${buildHeader('🎧', 'CUSTOMER SUPPORT')}\n` +
    `Need help with referrals, daily bonus, or a voucher withdrawal?\n\n` +
    `👨‍💻 <b>Official Support:</b> ${escapeHtml(support)}\n` +
    `🆔 <b>Your Telegram ID:</b> <code>${escapeHtml(access.user.id)}</code>\n\n` +
    `💡 <i>Tip: Include your Telegram ID or Withdrawal Request ID when messaging support for faster help.</i>`;

  await sendMessage(env, chatId, text, {
    reply_markup: supportInlineKeyboard(support),
  });
}

/**
 * 📢 Update Channel
 */
export async function handleUpdateChannelView(env, tgUser, chatId) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const settings = await getSettings(env);
  const channelUrl = settings.updateChannelUrl || 'https://t.me/pnarewards';

  const text =
    `${buildHeader('📢', 'OFFICIAL UPDATE CHANNEL')}\n` +
    `Stay updated with <b>${BOT_BRAND}</b> stock restocks, bonus events, and payout proofs!\n\n` +
    `🔗 <b>Channel Link:</b> ${escapeHtml(channelUrl)}\n\n` +
    `👇 Tap the button below to open our official channel:`;

  await sendMessage(env, chatId, text, {
    reply_markup: updateChannelInlineKeyboard(channelUrl),
  });
}
