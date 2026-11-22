// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — User Withdrawal Handler (Manual Approval Flow)
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  VOUCHER_CATEGORY_LIST,
  escapeHtml,
  formatINR,
  formatIST,
  getCategoryMeta,
} from '../config.js';
import { getAllCategoryStockSummary, getSettings } from '../database.js';
import { withdrawCategoriesKeyboard, withdrawConfirmKeyboard } from '../keyboards.js';
import {
  createWithdrawalRequest,
  validateWithdrawalEligibility,
} from '../services/withdrawal-service.js';
import { answerCallbackQuery, editOrSend } from '../telegram.js';
import { ensureUserAccess } from './start.js';

/**
 * 💸 Withdraw main screen showing live stock for every voucher category.
 */
export async function handleWithdrawMenu(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const [settings, stockSummary] = await Promise.all([
    getSettings(env),
    getAllCategoryStockSummary(env),
  ]);

  const minReqPaise = Math.max(settings.minWithdrawalPaise, settings.defaultVoucherValuePaise);
  const stockLines = VOUCHER_CATEGORY_LIST.map((cat) => {
    const info = stockSummary.categories[cat.key];
    const badge = info.inStock ? '🟢 IN STOCK' : '🔴 OUT OF STOCK';
    return `${cat.emoji} <b>${cat.name}:</b> ${badge} (<b>${info.availableCount}</b>)`;
  }).join('\n');

  const text =
    `${buildHeader('💸', 'WITHDRAW REWARDS')}\n` +
    `💰 <b>Available Balance:</b> <b>${formatINR(access.user.balancePaise)}</b>\n` +
    `⏳ <b>Pending Withdrawal:</b> <b>${formatINR(access.user.pendingWithdrawalPaise)}</b>\n` +
    `📌 <b>Minimum Withdrawal:</b> <b>${formatINR(minReqPaise)}</b>\n` +
    `🎟️ <b>Voucher Value:</b> <b>${formatINR(settings.defaultVoucherValuePaise)}</b>\n` +
    `${DIVIDER}\n` +
    `📦 <b>Live Voucher Stock:</b>\n` +
    `${stockLines}\n` +
    `${DIVIDER}\n` +
    `⚠️ <i>Rules: Manual admin approval • Max 1 approved withdrawal per 24 hours</i>\n\n` +
    `👇 Select an available voucher category below:`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: withdrawCategoriesKeyboard(stockSummary),
  });
}

/**
 * Handle category selection (`wd:cat:<categoryKey>`) and show confirmation screen.
 */
export async function handleWithdrawCategorySelect(env, callbackQuery, categoryKey) {
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) {
    await answerCallbackQuery(env, callbackQuery.id, 'Verification required.', true);
    return;
  }

  const check = await validateWithdrawalEligibility(env, access.user, categoryKey);
  if (!check.ok) {
    await answerCallbackQuery(env, callbackQuery.id, 'Cannot withdraw right now.', false);
    await editOrSend(env, chatId, msgId, `${buildHeader('⚠️', 'WITHDRAWAL UNAVAILABLE')}\n${check.error}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Withdraw', callback_data: 'usr:withdraw' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
        ],
      },
    });
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  const cat = getCategoryMeta(categoryKey);
  const stockSummary = await getAllCategoryStockSummary(env);
  const catStock = stockSummary.categories[categoryKey];
  const remainingAfter = Math.max(0, access.user.balancePaise - check.amountPaise);

  const text =
    `${buildHeader('✅', 'CONFIRM WITHDRAWAL REQUEST')}\n` +
    `🎟️ <b>Category:</b> ${cat.emoji} <b>${escapeHtml(cat.name)}</b>\n` +
    `📦 <b>Stock Status:</b> 🟢 IN STOCK (<b>${catStock.availableCount}</b> available)\n` +
    `💸 <b>Withdrawal Amount:</b> <b>${formatINR(check.amountPaise)}</b>\n` +
    `💰 <b>Balance After Reservation:</b> <b>${formatINR(remainingAfter)}</b>\n` +
    `${DIVIDER}\n` +
    `⏳ Your balance will be safely reserved until admin approval.\n` +
    `🎁 If rejected, 100% of the reserved amount is refunded automatically.\n\n` +
    `👇 Tap <b>Confirm Withdrawal Request</b> to submit:`;

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: withdrawConfirmKeyboard(categoryKey),
  });
}

/**
 * Handle confirmed submission (`wd:confirm:<categoryKey>`).
 */
export async function handleWithdrawConfirm(env, callbackQuery, categoryKey) {
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) {
    await answerCallbackQuery(env, callbackQuery.id, 'Verification required.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, '⏳ Submitting withdrawal request...');

  const res = await createWithdrawalRequest(env, access.user.id, categoryKey);
  if (!res.ok) {
    await editOrSend(env, chatId, msgId, `${buildHeader('❌', 'WITHDRAWAL FAILED')}\n${res.error}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Withdraw', callback_data: 'usr:withdraw' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
        ],
      },
    });
    return;
  }

  const cat = getCategoryMeta(res.withdrawal.category);
  const text =
    `✅ <b>Withdrawal Request Submitted!</b>\n\n` +
    `Your request has been sent to our admin team.\n` +
    `⏳ Requests are usually processed within 1 hour.\n` +
    `🎁 Your voucher will be delivered after admin approval.\n\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Request ID:</b> <code>${escapeHtml(res.withdrawal.id)}</code>\n` +
    `🎟️ <b>Category:</b> ${cat ? `${cat.emoji} ${escapeHtml(cat.name)}` : escapeHtml(categoryKey)}\n` +
    `💸 <b>Amount Reserved:</b> <b>${formatINR(res.withdrawal.amountPaise)}</b>\n` +
    `🕒 <b>Submitted At:</b> ${formatIST(res.withdrawal.createdAt, env)}`;

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📜 My Withdrawals', callback_data: 'usr:history' }],
        [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
      ],
    },
  });
}
