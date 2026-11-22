// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Start, Onboarding, Force-Join Gate & Access Control
// ============================================================================

import {
  DIVIDER,
  buildHeader,
  playVerificationAnimation,
  playWelcomeAnimation,
} from '../animations.js';
import { BOT_BRAND, escapeHtml } from '../config.js';
import {
  clearUserState,
  createOrUpdateUserFromTelegram,
  getSettings,
  getUser,
  isAdmin,
  saveUser,
} from '../database.js';
import { forceJoinKeyboard, mainMenuKeyboard } from '../keyboards.js';
import { verifyUserForceJoin } from '../services/membership.js';
import {
  processPendingReferral,
  registerPendingReferralIfEligible,
} from '../services/referral-service.js';
import { answerCallbackQuery, editMessageText, sendMessage } from '../telegram.js';

/**
 * Send the force-join gate prompt showing all required channels + VERIFY button.
 */
export async function sendForceJoinPrompt(env, chatId, channels, messageId = null) {
  const listText = channels
    .map((ch, idx) => `${idx + 1}. 📢 <b>${escapeHtml(ch.title || `Channel ${idx + 1}`)}</b>`)
    .join('\n');

  const text =
    `${buildHeader('🔐', 'JOIN REQUIRED CHANNELS')}\n` +
    `To unlock <b>${BOT_BRAND}</b> and start earning rewards, please join all required channels below:\n\n` +
    `${listText}\n\n` +
    `👇 Join every channel above, then tap <b>✅ JOINED - VERIFY</b>.`;

  const extra = { reply_markup: forceJoinKeyboard(channels) };
  if (messageId) {
    return editMessageText(env, chatId, messageId, text, extra);
  }
  return sendMessage(env, chatId, text, extra);
}

/**
 * Shared guard executed before any normal user reward operation.
 * Checks:
 *  1. Account exists & not banned
 *  2. Maintenance Mode (admins bypass)
 *  3. Force-Join channel membership (admins bypass)
 */
export async function ensureUserAccess(env, tgUser, chatId) {
  const { user } = await createOrUpdateUserFromTelegram(env, tgUser);
  const adminUser = await isAdmin(user.id, env);

  if (user.status === 'banned' && !adminUser) {
    await sendMessage(
      env,
      chatId,
      `🚫 <b>Account Restricted</b>\n${DIVIDER}\nYour account has been suspended by the administration team.\nPlease contact Support if you believe this is an error.`
    );
    return { allowed: false, user, isAdminUser: false };
  }

  const settings = await getSettings(env);
  if (settings.maintenanceMode && !adminUser) {
    await sendMessage(env, chatId, settings.maintenanceMessage);
    return { allowed: false, user, isAdminUser: false };
  }

  // Re-verify force-join membership whenever channels are configured
  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    if (user.forceJoinVerified) {
      user.forceJoinVerified = false;
      await saveUser(env, user);
    }
    await sendForceJoinPrompt(env, chatId, fj.missingChannels);
    return { allowed: false, user, isAdminUser: adminUser };
  }

  if (!user.forceJoinVerified) {
    user.forceJoinVerified = true;
    await saveUser(env, user);
  }

  return { allowed: true, user, isAdminUser: adminUser };
}

/**
 * Send Main Menu welcome confirmation card + persistent ReplyKeyboard.
 */
export async function sendMainMenu(env, chatId, user, isAdminUser = false, customIntro = '') {
  const safeName = escapeHtml(user?.firstName || 'Friend');
  const intro =
    customIntro ||
    `🏠 <b>Main Menu — ${BOT_BRAND}</b>\n${DIVIDER}\n👋 Welcome back, <b>${safeName}</b>!\nSelect an option from the menu below to earn rewards or redeem vouchers.`;

  return sendMessage(env, chatId, intro, {
    reply_markup: mainMenuKeyboard(isAdminUser),
  });
}

/**
 * Handle /start and /start <referrerId>
 */
export async function handleStartCommand(env, message, startPayload = '') {
  const tgUser = message.from;
  const chatId = message.chat.id;
  await clearUserState(env, tgUser.id);

  const { user, isNew } = await createOrUpdateUserFromTelegram(env, tgUser);
  const adminUser = await isAdmin(user.id, env);

  // Record referral intent ONLY if genuinely new Telegram user
  if (isNew && startPayload) {
    await registerPendingReferralIfEligible(env, user, startPayload);
  }

  // Check banned status
  if (user.status === 'banned' && !adminUser) {
    await sendMessage(
      env,
      chatId,
      `🚫 <b>Account Restricted</b>\n${DIVIDER}\nYour account cannot access ${BOT_BRAND}. Contact Support for help.`
    );
    return;
  }

  // Check maintenance mode
  const settings = await getSettings(env);
  if (settings.maintenanceMode && !adminUser) {
    await sendMessage(env, chatId, settings.maintenanceMessage);
    return;
  }

  // Play attractive multi-step welcome animation
  await playWelcomeAnimation(env, chatId, user.firstName);

  // Check force-join channels
  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    await sendForceJoinPrompt(env, chatId, fj.missingChannels);
    return;
  }

  // User passed force join (or no force-join channels configured)
  if (!user.forceJoinVerified) {
    user.forceJoinVerified = true;
    await saveUser(env, user);
  }

  // Credit pending referral if eligible
  await processPendingReferral(env, user.id);

  const confirmText =
    `✅ <b>Verification Complete — Welcome to ${BOT_BRAND}!</b>\n` +
    `${DIVIDER}\n` +
    `🎁 Earn INR by inviting friends & claiming daily bonuses\n` +
    `🎟️ Redeem Amazon, Google Play & Other Vouchers\n\n` +
    `👇 Choose an option from the menu below:`;

  await sendMainMenu(env, chatId, user, adminUser, confirmText);
}

/**
 * Handle "✅ JOINED - VERIFY" callback query (`fj:verify`).
 */
export async function handleVerifyForceJoinCallback(env, callbackQuery) {
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  const { user } = await createOrUpdateUserFromTelegram(env, tgUser);
  const adminUser = await isAdmin(user.id, env);

  const settings = await getSettings(env);
  if (settings.maintenanceMode && !adminUser) {
    await answerCallbackQuery(env, callbackQuery.id, '🔧 Bot is currently in maintenance mode.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, '🔍 Checking your channel membership...');
  await playVerificationAnimation(env, chatId, msgId);

  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    const missingNames = fj.missingChannels
      .map((c, idx) => `❌ ${escapeHtml(c.title || `Channel ${idx + 1}`)}`)
      .join('\n');

    const failText =
      `${buildHeader('⚠️', 'MEMBERSHIP NOT VERIFIED')}\n` +
      `You have not joined all required channels yet:\n\n` +
      `${missingNames}\n\n` +
      `👇 Please join all channels below and tap <b>✅ JOINED - VERIFY</b> again.`;

    await editMessageText(env, chatId, msgId, failText, {
      reply_markup: forceJoinKeyboard(fj.missingChannels),
    });
    return;
  }

  // Mark verified
  const freshUser = (await getUser(env, user.id)) || user;
  freshUser.forceJoinVerified = true;
  await saveUser(env, freshUser);

  // Credit pending referral immediately upon verification
  await processPendingReferral(env, freshUser.id);

  await editMessageText(
    env,
    chatId,
    msgId,
    `✅ <b>Membership Verified Successfully!</b>\n${DIVIDER}\n🎉 Welcome to <b>${BOT_BRAND}</b>!\nYour dashboard is now unlocked.`
  );

  await sendMainMenu(
    env,
    chatId,
    freshUser,
    adminUser,
    `🏠 <b>Main Menu — ${BOT_BRAND}</b>\n${DIVIDER}\n👇 Tap any button below to start earning rewards!`
  );
}
