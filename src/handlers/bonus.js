// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Daily Bonus Handler (Asia/Kolkata, Configurable Decimals)
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  DAY_MS,
  formatCountdown,
  formatINR,
  formatIST,
  generateId,
  getISTDateKey,
} from '../config.js';
import {
  acquireLock,
  addDailyBonusClaim,
  getDailyBonusHistory,
  getSettings,
  getUser,
  incrementGlobalStats,
  releaseLock,
} from '../database.js';
import { dailyBonusInlineKeyboard } from '../keyboards.js';
import { creditDailyBonus } from '../services/balance.js';
import { answerCallbackQuery, editOrSend } from '../telegram.js';
import { ensureUserAccess } from './start.js';

function getDailyEligibility(user) {
  const now = Date.now();
  const lastClaim = Number(user?.lastDailyClaimAt || 0);
  if (!lastClaim || now - lastClaim >= DAY_MS) {
    return { canClaim: true, remainingMs: 0, nextClaimAt: now };
  }
  const nextClaimAt = lastClaim + DAY_MS;
  return {
    canClaim: false,
    remainingMs: Math.max(0, nextClaimAt - now),
    nextClaimAt,
  };
}

/**
 * 🎁 Daily Bonus screen
 */
export async function handleDailyBonusView(env, tgUser, chatId, messageId = null) {
  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) return;

  const settings = await getSettings(env);
  const elig = getDailyEligibility(access.user);

  const statusBlock = elig.canClaim
    ? `🟢 <b>Status:</b> Available to claim now!`
    : `⏳ <b>Status:</b> Already claimed within 24h\n🕒 <b>Next Claim In:</b> <b>${formatCountdown(elig.remainingMs)}</b>\n📅 <b>Eligible At:</b> ${formatIST(elig.nextClaimAt, env)}`;

  const text =
    `${buildHeader('🎁', 'DAILY BONUS')}\n` +
    `💵 <b>Current Bonus Amount:</b> <b>${formatINR(settings.dailyBonusPaise)}</b>\n` +
    `🌍 <b>Schedule Timezone:</b> Asia/Kolkata (IST)\n` +
    `${DIVIDER}\n` +
    `${statusBlock}\n` +
    `${DIVIDER}\n` +
    `📊 <b>Your Total Claims:</b> <b>${access.user.dailyBonusCount || 0}</b>\n` +
    `💰 <b>Total Daily Bonus Earned:</b> <b>${formatINR(access.user.dailyBonusEarningsPaise)}</b>`;

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: dailyBonusInlineKeyboard(elig.canClaim),
  });
}

/**
 * Handle `bonus:claim` callback with KV lock to prevent double claims.
 */
export async function handleDailyBonusClaimCallback(env, callbackQuery) {
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) {
    await answerCallbackQuery(env, callbackQuery.id, 'Access restricted or verification required.', true);
    return;
  }

  const lockScope = `daily_claim:${access.user.id}`;
  const lockToken = await acquireLock(env, lockScope, 60);
  if (!lockToken) {
    await answerCallbackQuery(env, callbackQuery.id, '⏳ Claim already processing...', true);
    return;
  }

  try {
    // Re-read fresh user under lock
    const freshUser = await getUser(env, access.user.id);
    const elig = getDailyEligibility(freshUser);
    if (!elig.canClaim) {
      await answerCallbackQuery(
        env,
        callbackQuery.id,
        `⏳ Next claim in ${formatCountdown(elig.remainingMs)}`,
        true
      );
      await handleDailyBonusView(env, tgUser, chatId, msgId);
      return;
    }

    const settings = await getSettings(env);
    const bonusPaise = Math.max(1, Math.round(Number(settings.dailyBonusPaise || 25)));
    const now = Date.now();

    const updatedUser = await creditDailyBonus(env, freshUser.id, bonusPaise, now);
    await addDailyBonusClaim(env, freshUser.id, {
      id: generateId('DBN'),
      amountPaise: bonusPaise,
      claimedAt: now,
      istDate: getISTDateKey(now, env),
    });

    await incrementGlobalStats(env, {
      totalDailyBonusesCount: 1,
      totalDailyBonusPaise: bonusPaise,
    });

    await answerCallbackQuery(
      env,
      callbackQuery.id,
      `🎉 Claimed ${formatINR(bonusPaise)} Daily Bonus!`,
      true
    );

    const nextAt = now + DAY_MS;
    const text =
      `${buildHeader('🎉', 'DAILY BONUS CLAIMED!')}\n` +
      `💰 <b>Credited Amount:</b> <b>+${formatINR(bonusPaise)}</b>\n` +
      `🏦 <b>New Available Balance:</b> <b>${formatINR(updatedUser.balancePaise)}</b>\n` +
      `🕒 <b>Claimed At:</b> ${formatIST(now, env)}\n` +
      `${DIVIDER}\n` +
      `⏳ <b>Next Claim Available In:</b> <b>${formatCountdown(DAY_MS)}</b>\n` +
      `📅 <b>Next Eligible Time:</b> ${formatIST(nextAt, env)}`;

    await editOrSend(env, chatId, msgId, text, {
      reply_markup: dailyBonusInlineKeyboard(false),
    });
  } finally {
    await releaseLock(env, lockScope, lockToken);
  }
}

/**
 * 📜 User's Daily Bonus History (`bonus:history`)
 */
export async function handleDailyBonusHistoryCallback(env, callbackQuery) {
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  const access = await ensureUserAccess(env, tgUser, chatId);
  if (!access.allowed) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  const history = await getDailyBonusHistory(env, access.user.id);
  const recent = history.slice(0, 15);

  let text =
    `${buildHeader('📜', 'DAILY BONUS HISTORY')}\n` +
    `🎁 <b>Total Claims:</b> <b>${access.user.dailyBonusCount || 0}</b>\n` +
    `💰 <b>Total Earned:</b> <b>${formatINR(access.user.dailyBonusEarningsPaise)}</b>\n` +
    `${DIVIDER}\n`;

  if (!recent.length) {
    text += `<i>You haven't claimed any daily bonuses yet.</i>`;
  } else {
    for (let i = 0; i < recent.length; i++) {
      const item = recent[i];
      text += `${i + 1}. <b>+${formatINR(item.amountPaise)}</b> — <i>${formatIST(item.claimedAt, env)}</i>\n`;
    }
    if (history.length > 15) {
      text += `\n<i>Showing latest 15 of ${history.length} claims.</i>`;
    }
  }

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Back to Daily Bonus', callback_data: 'usr:bonus' }],
        [{ text: '🏠 Back to Main Menu', callback_data: 'usr:home' }],
      ],
    },
  });
}
