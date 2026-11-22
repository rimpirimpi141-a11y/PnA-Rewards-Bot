// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Bot Statistics Handler
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import { BOT_BRAND, formatINR, formatIST } from '../config.js';
import {
  countActiveUsers,
  getAllCategoryStockSummary,
  getGlobalStats,
  getPendingWithdrawalIds,
  getSettings,
  hasAdminPermission,
} from '../database.js';
import { adminBackKeyboard } from '../keyboards.js';
import { editOrSend, sendMessage } from '../telegram.js';

/**
 * 7. 📊 Bot Statistics
 */
export async function handleAdminStatistics(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'viewStats', env))) {
    await sendMessage(env, chatId, '🚫 You do not have permission to view statistics.');
    return;
  }

  const [userCounts, stats, stock, pendingIds, settings] = await Promise.all([
    countActiveUsers(env),
    getGlobalStats(env),
    getAllCategoryStockSummary(env),
    getPendingWithdrawalIds(env),
    getSettings(env),
  ]);

  const amazonStock = stock.categories.amazon.availableCount;
  const gplayStock = stock.categories.google_play.availableCount;
  const otherStock = stock.categories.other.availableCount;

  const text =
    `${buildHeader('📊', `${BOT_BRAND} — BOT STATISTICS`)}\n` +
    `👥 <b>Users Overview</b>\n` +
    `• Total Registered Users: <b>${userCounts.totalUsers}</b>\n` +
    `• Active Users (7d): <b>${userCounts.activeUsers}</b>\n` +
    `${DIVIDER}\n` +
    `🤝 <b>Referrals & Daily Bonuses</b>\n` +
    `• Total Referrals: <b>${stats.totalReferrals}</b>\n` +
    `• Total Referral Rewards: <b>${formatINR(stats.totalReferralRewardsPaise)}</b>\n` +
    `• Total Daily Bonuses: <b>${stats.totalDailyBonusesCount}</b> (${formatINR(stats.totalDailyBonusPaise)})\n` +
    `${DIVIDER}\n` +
    `💸 <b>Withdrawals</b>\n` +
    `• Pending Withdrawals: <b>${pendingIds.length}</b>\n` +
    `• Approved Withdrawals: <b>${stats.totalApprovedWithdrawals}</b> (${formatINR(stats.totalWithdrawnPaise)})\n` +
    `• Rejected Withdrawals: <b>${stats.totalRejectedWithdrawals}</b>\n` +
    `${DIVIDER}\n` +
    `📦 <b>Voucher Inventory</b>\n` +
    `• Total Available Stock: <b>${stock.totalAvailable}</b> (${formatINR(stock.totalValuePaise)})\n` +
    `• 🛒 Amazon Stock: <b>${amazonStock}</b> ${amazonStock > 0 ? '🟢' : '🔴'}\n` +
    `• 🎮 Google Play Stock: <b>${gplayStock}</b> ${gplayStock > 0 ? '🟢' : '🔴'}\n` +
    `• 🎟️ Other Redeem Stock: <b>${otherStock}</b> ${otherStock > 0 ? '🟢' : '🔴'}\n` +
    `• 🎁 Total Vouchers Delivered: <b>${stats.totalVouchersDelivered}</b>\n` +
    `${DIVIDER}\n` +
    `🔧 Maintenance: <b>${settings.maintenanceMode ? 'ON 🔴' : 'OFF 🟢'}</b>\n` +
    `🕒 Snapshot: <i>${formatIST(Date.now(), env)}</i>`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminBackKeyboard([
      [{ text: '🔄 Refresh Statistics', callback_data: 'adm:stats' }],
    ]),
  });
}
