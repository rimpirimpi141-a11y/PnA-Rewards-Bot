// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Notification Service (Users & Admins)
// ============================================================================

import { DIVIDER } from '../animations.js';
import {
  BOT_BRAND,
  escapeHtml,
  formatINR,
  formatIST,
  formatUsernameTag,
  getCategoryMeta,
} from '../config.js';
import { getAllAdminIds, markUserBlocked } from '../database.js';
import { withdrawalAdminDecisionKeyboard } from '../keyboards.js';
import { sendMessage } from '../telegram.js';

/**
 * Notify all authorized admins (Owner + configured Admins).
 */
export async function notifyAllAdmins(env, text, extra = {}) {
  const adminIds = await getAllAdminIds(env);
  const results = [];
  for (const adminId of adminIds) {
    const res = await sendMessage(env, adminId, text, extra);
    results.push({ adminId, ok: res.ok });
  }
  return results;
}

/**
 * Send a new pending withdrawal request card to Owner & Admins.
 */
export async function notifyAdminsNewWithdrawal(env, withdrawal) {
  const cat = getCategoryMeta(withdrawal.category);
  const catLabel = cat ? `${cat.emoji} ${cat.name}` : escapeHtml(withdrawal.category);

  const text =
    `🔔 <b>NEW WITHDRAWAL REQUEST</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(withdrawal.id)}</code>\n` +
    `👤 <b>User:</b> ${escapeHtml(withdrawal.userName)} (${escapeHtml(formatUsernameTag(withdrawal.username))})\n` +
    `🔢 <b>Telegram ID:</b> <code>${escapeHtml(withdrawal.userId)}</code>\n` +
    `💰 <b>User Balance (Before):</b> <b>${formatINR(withdrawal.userBalanceSnapshotPaise)}</b>\n` +
    `💸 <b>Withdrawal Amount:</b> <b>${formatINR(withdrawal.amountPaise)}</b>\n` +
    `🎟️ <b>Category:</b> ${catLabel}\n` +
    `🕒 <b>Requested At:</b> ${formatIST(withdrawal.createdAt, env)}\n` +
    `${DIVIDER}\n` +
    `👇 Choose an action below:`;

  return notifyAllAdmins(env, text, {
    reply_markup: withdrawalAdminDecisionKeyboard(withdrawal.id),
  });
}

/**
 * Notify Owner & Admins when a voucher category hits or falls below its low-stock threshold.
 */
export async function notifyAdminsLowStock(env, categoryKey, remainingCount, threshold) {
  const cat = getCategoryMeta(categoryKey);
  const label = cat ? cat.name : categoryKey;
  const emoji = cat ? cat.emoji : '🎟️';

  const text =
    `🚨 <b>LOW STOCK ALERT</b>\n` +
    `${DIVIDER}\n` +
    `${emoji} <b>${escapeHtml(label)} remaining:</b> <b>${remainingCount}</b>\n` +
    `⚠️ <b>Alert Threshold:</b> ${threshold}\n` +
    `🕒 <b>Time:</b> ${formatIST(Date.now(), env)}\n` +
    `${DIVIDER}\n` +
    `Please upload fresh vouchers via <b>Admin Panel → ➕ Add Voucher</b>.`;

  return notifyAllAdmins(env, text);
}

/**
 * Notify referrer when a new valid referral earns them a reward.
 */
export async function notifyReferrerCredited(env, referrerId, referredUser, amountPaise, newBalancePaise) {
  const referredName = escapeHtml(
    [referredUser.firstName, referredUser.lastName].filter(Boolean).join(' ') || 'A new user'
  );
  const text =
    `🎉 <b>NEW REFERRAL REWARD CREDITED!</b>\n` +
    `${DIVIDER}\n` +
    `👤 <b>Invited User:</b> ${referredName}\n` +
    `💰 <b>Reward Earned:</b> <b>+${formatINR(amountPaise)}</b>\n` +
    `🏦 <b>Updated Balance:</b> <b>${formatINR(newBalancePaise)}</b>\n` +
    `${DIVIDER}\n` +
    `🔥 Keep inviting friends to earn more on <b>${BOT_BRAND}</b>!`;

  const res = await sendMessage(env, referrerId, text);
  if (res.isBlocked) {
    await markUserBlocked(env, referrerId);
  }
  return res;
}

/**
 * Deliver approved voucher code privately to the user.
 */
export async function notifyUserWithdrawalApproved(env, withdrawal, voucher) {
  const cat = getCategoryMeta(withdrawal.category);
  const catLabel = cat ? `${cat.emoji} ${cat.name}` : escapeHtml(withdrawal.category);

  const text =
    `🎉 <b>WITHDRAWAL APPROVED & VOUCHER DELIVERED!</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(withdrawal.id)}</code>\n` +
    `🎟️ <b>Category:</b> ${catLabel}\n` +
    `💵 <b>Voucher Value:</b> <b>${formatINR(voucher.valuePaise)}</b>\n\n` +
    `🔑 <b>YOUR REDEEM CODE:</b>\n` +
    `<code>${escapeHtml(voucher.code)}</code>\n\n` +
    `🕒 <b>Delivered At:</b> ${formatIST(withdrawal.processedAt, env)}\n` +
    `${DIVIDER}\n` +
    `💡 <i>Tap the code above to copy it. You can also view it anytime in 👤 My Profile → 🎟️ My Vouchers.</i>`;

  const res = await sendMessage(env, withdrawal.userId, text);
  if (res.isBlocked) {
    await markUserBlocked(env, withdrawal.userId);
  }
  return res;
}

/**
 * Notify user when withdrawal is rejected and balance refunded.
 */
export async function notifyUserWithdrawalRejected(env, withdrawal, refundedBalancePaise) {
  const cat = getCategoryMeta(withdrawal.category);
  const catLabel = cat ? `${cat.emoji} ${cat.name}` : escapeHtml(withdrawal.category);
  const reasonLine = withdrawal.rejectionReason
    ? `\n📝 <b>Reason:</b> ${escapeHtml(withdrawal.rejectionReason)}`
    : '';

  const text =
    `❌ <b>WITHDRAWAL REQUEST REJECTED</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(withdrawal.id)}</code>\n` +
    `🎟️ <b>Category:</b> ${catLabel}\n` +
    `💸 <b>Amount Refunded:</b> <b>+${formatINR(withdrawal.amountPaise)}</b>` +
    `${reasonLine}\n\n` +
    `💰 <b>Current Available Balance:</b> <b>${formatINR(refundedBalancePaise)}</b>\n` +
    `${DIVIDER}\n` +
    `If you have questions, please contact Support from the main menu.`;

  const res = await sendMessage(env, withdrawal.userId, text);
  if (res.isBlocked) {
    await markUserBlocked(env, withdrawal.userId);
  }
  return res;
}

/**
 * Notify target user when an admin manually adds or deducts balance.
 */
export async function notifyUserBalanceAdjusted(env, adjustment) {
  const isAdd = adjustment.action === 'ADD';
  const sign = isAdd ? '+' : '-';
  const reasonLine = adjustment.reason
    ? `\n📝 <b>Reason:</b> ${escapeHtml(adjustment.reason)}`
    : '';

  const text =
    `${isAdd ? '💰 <b>BALANCE CREDITED BY ADMIN</b>' : '➖ <b>BALANCE DEDUCTED BY ADMIN</b>'}\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Reference:</b> <code>${escapeHtml(adjustment.id)}</code>\n` +
    `💵 <b>Amount:</b> <b>${sign}${formatINR(adjustment.amountPaise)}</b>\n` +
    `🏦 <b>Previous Balance:</b> ${formatINR(adjustment.balanceBeforePaise)}\n` +
    `🏦 <b>New Balance:</b> <b>${formatINR(adjustment.balanceAfterPaise)}</b>` +
    `${reasonLine}\n` +
    `🕒 <b>Time:</b> ${formatIST(adjustment.createdAt, env)}\n` +
    `${DIVIDER}\n` +
    `💡 <i>View this entry anytime under 💰 My Balance → 📜 Transaction History.</i>`;

  const res = await sendMessage(env, adjustment.targetUserId, text);
  if (res.isBlocked) {
    await markUserBlocked(env, adjustment.targetUserId);
  }
  return res;
}
