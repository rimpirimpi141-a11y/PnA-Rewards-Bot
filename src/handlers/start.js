// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Start, Onboarding, Force-Join Gate & Access Control
// ============================================================================

import {
  DIVIDER,
  buildHeader,
  playVerificationAnimation,
  playWelcomeAnimation,
} from '../animations.js';
import {
  BOT_BRAND,
  DEVICE_VERIFICATION_STATUS,
  escapeHtml,
  getMiniAppUrl,
  isDeviceVerificationEnabled,
} from '../config.js';
import {
  clearUserState,
  createOrUpdateUserFromTelegram,
  getSettings,
  getUser,
  getUserReferralReview,
  isAdmin,
  updateUserForceJoinVerified,
} from '../database.js';
import {
  deviceVerificationKeyboard,
  forceJoinKeyboard,
  mainMenuKeyboard,
} from '../keyboards.js';
import { verifyUserForceJoin } from '../services/membership.js';
import {
  processPendingReferral,
  registerPendingReferralIfEligible,
} from '../services/referral-service.js';
import { logNewUserEvent } from '../services/secretary.js';
import { answerCallbackQuery, editMessageText, sendMessage } from '../telegram.js';

/**
 * Check whether a user satisfies the server-side device verification requirement
 * and current verification generation. Admins and owners are also required to verify.
 */
export async function isUserDeviceVerified(user, env, isAdminUser = false) {
  if (!isDeviceVerificationEnabled(env)) return true;
  if (!user) return false;
  const settings = await getSettings(env);
  const requiredGen = Number(settings.currentVerificationGeneration || 2);
  const userGen = Number(user.lastVerifiedGeneration || 0);
  const status = user.deviceVerificationStatus || DEVICE_VERIFICATION_STATUS.UNVERIFIED;

  const isVerifiedStatus =
    status === DEVICE_VERIFICATION_STATUS.VERIFIED ||
    status === DEVICE_VERIFICATION_STATUS.GRANDFATHERED;

  return isVerifiedStatus && userGen >= requiredGen;
}

/**
 * Build the Device Verification Mini App gate message shown after channel force-join.
 */
export async function sendDeviceVerificationPrompt(env, chatId, user, messageId = null) {
  const miniAppUrl = getMiniAppUrl(env);
  const status = user?.deviceVerificationStatus || DEVICE_VERIFICATION_STATUS.UNVERIFIED;
  const review = user?.id ? await getUserReferralReview(env, user.id) : null;

  let text = '';
  if (status === DEVICE_VERIFICATION_STATUS.PENDING_REVIEW) {
    text =
      `${buildHeader('⏳', 'DEVICE VERIFICATION UNDER REVIEW')}\n` +
      `✅ Channel membership is verified!\n\n` +
      `Your device verification is currently <b>under security review</b> by our admin team to keep referrals fair for everyone.\n` +
      `${review?.id ? `🆔 <b>Review ID:</b> <code>${escapeHtml(review.id)}</code>\n` : ''}\n` +
      `• If you used a VPN or temporary browser, disable it and retry below.\n` +
      `• Otherwise, once an admin approves your review, tap <b>✅ Check Verification Status</b>.`;
  } else if (status === DEVICE_VERIFICATION_STATUS.REJECTED) {
    text =
      `${buildHeader('🛡️', 'DEVICE VERIFICATION REQUIRED')}\n` +
      `Automatic device verification could not be completed for this account.\n` +
      `${review?.id ? `🆔 <b>Review ID:</b> <code>${escapeHtml(review.id)}</code>\n` : ''}\n` +
      `Please contact Support with your Telegram ID (<code>${escapeHtml(user?.id || '')}</code>) if you believe this is a mistake.`;
  } else {
    text =
      `${buildHeader('🛡️', 'ONE LAST STEP — VERIFY DEVICE')}\n` +
      `✅ <b>Channel membership verified!</b>\n\n` +
      `To unlock <b>${BOT_BRAND}</b> and protect genuine rewards against multi-account abuse, please complete a quick one-time device check in our secure Telegram Mini App.\n\n` +
      `🔒 <i>Privacy note: We check standard browser/device signals (not hardware IMEI or private files) to verify your session.</i>\n\n` +
      `👇 Tap <b>🛡️ Open Mini App & Verify Device</b> below:`;
  }

  if (!miniAppUrl) {
    text += `\n\n⚠️ <i>Mini App URL is not configured yet. Please contact the bot administrator.</i>`;
  }

  const extra = { reply_markup: deviceVerificationKeyboard(miniAppUrl, status) };
  if (messageId) {
    return editMessageText(env, chatId, messageId, text, extra);
  }
  return sendMessage(env, chatId, text, extra);
}

/**
 * Build detailed per-channel force-join message so users know exactly
 * which channels are joined, which still need joining, and which are
 * awaiting channel administrator approval (Request-to-Join).
 */
function buildForceJoinMessage(fjResult, isRetry = false) {
  const pendingSet = new Set(fjResult.pendingChannels.map((p) => p.channel.id));
  const joinedSet = new Set(fjResult.joinedChannels.map((c) => c.id));
  const errorMap = new Map(fjResult.permissionErrorChannels.map((e) => [e.channel.id, e.error]));

  const lines = fjResult.channels.map((ch, idx) => {
    const title = escapeHtml(ch.title || `Channel ${idx + 1}`);
    const reqTag = ch.isRequestToJoin ? ' <i>(Approval Required)</i>' : '';

    if (joinedSet.has(ch.id)) {
      return `${idx + 1}. ✅ <b>${title}</b> — Joined`;
    }
    if (pendingSet.has(ch.id)) {
      return `${idx + 1}. ⏳ <b>${title}</b> — <b>Join Request Pending Admin Approval</b>`;
    }
    if (errorMap.has(ch.id)) {
      return `${idx + 1}. ⚠️ <b>${title}</b> — Verification unavailable (channel admin setup required)`;
    }
    return `${idx + 1}. ❌ <b>${title}</b>${reqTag} — Not Joined`;
  });

  const header = isRetry
    ? buildHeader('⚠️', 'MEMBERSHIP NOT VERIFIED YET')
    : buildHeader('🔐', 'JOIN REQUIRED CHANNELS');

  let notice = '';
  if (fjResult.pendingChannels.length > 0) {
    notice +=
      `\n\n⏳ <b>Pending Join Request Detected:</b>\n` +
      `Your join request has been submitted, but <b>channel administrator approval is still awaited</b>.\n` +
      `A pending request does not unlock the bot. Once a channel admin approves your request, tap <b>✅ VERIFY MEMBERSHIP</b> again!`;
  }

  if (fjResult.permissionErrorChannels.length > 0) {
    notice +=
      `\n\n⚠️ <i>One or more channels could not be verified due to channel permission settings. Please try again shortly or contact Support.</i>`;
  }

  const footer =
    fjResult.notJoinedChannels.length > 0
      ? `👇 Join every remaining channel below, then tap <b>✅ VERIFY MEMBERSHIP</b>.`
      : `👇 Once your channel join request is approved, tap <b>✅ VERIFY MEMBERSHIP</b> to unlock access.`;

  return (
    `${header}\n` +
    `To unlock <b>${BOT_BRAND}</b> and start earning rewards, you must be an active member of all required channels:\n\n` +
    `${lines.join('\n')}` +
    `${notice}\n\n` +
    `${footer}`
  );
}

/**
 * Send the force-join gate prompt showing missing channels + ✅ VERIFY MEMBERSHIP.
 */
export async function sendForceJoinPrompt(env, chatId, fjResult, messageId = null, isRetry = false) {
  const text = buildForceJoinMessage(fjResult, isRetry);
  const channelsToShow =
    fjResult.missingChannels && fjResult.missingChannels.length > 0
      ? fjResult.missingChannels
      : fjResult.channels;
  const extra = { reply_markup: forceJoinKeyboard(channelsToShow) };

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
 *  3. Force-Join channel membership (never bypassed for normal users)
 *  4. Server-side Telegram Mini App Device Verification (grandfathered & admins pass)
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

  // Always re-verify membership via Telegram getChatMember when force channels exist
  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    if (user.forceJoinVerified) {
      user.forceJoinVerified = false;
      await updateUserForceJoinVerified(env, user.id, false);
    }
    await sendForceJoinPrompt(env, chatId, fj, null, false);
    return { allowed: false, user, isAdminUser: adminUser };
  }

  if (!user.forceJoinVerified) {
    user.forceJoinVerified = true;
    await updateUserForceJoinVerified(env, user.id, true);
  }

  // Enforce server-side device verification gate before unlocking bot menu or rewards
  if (!(await isUserDeviceVerified(user, env, adminUser))) {
    await sendDeviceVerificationPrompt(env, chatId, user, null);
    return { allowed: false, user, isAdminUser: adminUser };
  }

  return { allowed: true, user, isAdminUser: adminUser };
}

/**
 * Send Main Menu welcome confirmation card + colourful persistent ReplyKeyboard.
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

  // Record referral intent ONLY if genuinely new Telegram user (NOT credited yet)
  let attributedReferrerId = '';
  if (isNew && startPayload) {
    const registered = await registerPendingReferralIfEligible(env, user, startPayload);
    if (registered) {
      attributedReferrerId = String(startPayload).trim();
    }
  }

  // Emit Secretary Mode log for genuinely new users
  if (isNew) {
    await logNewUserEvent(env, { user, referrerId: attributedReferrerId });
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

  // Step 1: Check force-join channels (unlock NOTHING until verified)
  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    await sendForceJoinPrompt(env, chatId, fj, null, false);
    return;
  }

  if (!user.forceJoinVerified) {
    user.forceJoinVerified = true;
    await updateUserForceJoinVerified(env, user.id, true);
  }

  // Step 2: Check server-side Mini App Device Verification before unlocking menu or referrals
  if (!(await isUserDeviceVerified(user, env, adminUser))) {
    await sendDeviceVerificationPrompt(env, chatId, user, null);
    return;
  }

  // Only verified/grandfathered users can finalize pending referrals
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
 * Handle "✅ VERIFY MEMBERSHIP" callback query (`fj:verify`).
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

  await answerCallbackQuery(env, callbackQuery.id, '🔍 Verifying your channel membership...');
  await playVerificationAnimation(env, chatId, msgId);

  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    await sendForceJoinPrompt(env, chatId, fj, msgId, true);
    return;
  }

  // Mark force-join verified without overwriting concurrent fields
  await updateUserForceJoinVerified(env, user.id, true);
  const freshUser = (await getUser(env, user.id)) || { ...user, forceJoinVerified: true };

  // Step 2 Gate: Do NOT unlock main menu or credit referral until device verification passes
  if (!(await isUserDeviceVerified(freshUser, env, adminUser))) {
    await sendDeviceVerificationPrompt(env, chatId, freshUser, msgId);
    return;
  }

  // Already verified/grandfathered user -> finalize pending referral and unlock menu
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

/**
 * Handle "✅ Check Verification Status" callback (`dv:status`).
 */
export async function handleDeviceVerifyStatusCallback(env, callbackQuery) {
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  const { user } = await createOrUpdateUserFromTelegram(env, tgUser);
  const adminUser = await isAdmin(user.id, env);

  const fj = await verifyUserForceJoin(env, user.id, { bypassForAdmin: true });
  if (!fj.joinedAll) {
    await answerCallbackQuery(env, callbackQuery.id, '⚠️ Please join all required channels first.', true);
    await sendForceJoinPrompt(env, chatId, fj, msgId, true);
    return;
  }

  if (!(await isUserDeviceVerified(user, env, adminUser))) {
    const statusLabel =
      user.deviceVerificationStatus === DEVICE_VERIFICATION_STATUS.PENDING_REVIEW
        ? '⏳ Still under admin security review.'
        : '🛡️ Please open the Mini App button to verify your device.';
    await answerCallbackQuery(env, callbackQuery.id, statusLabel, true);
    await sendDeviceVerificationPrompt(env, chatId, user, msgId);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, '✅ Device verified! Unlocking dashboard...');
  await processPendingReferral(env, user.id);

  await editMessageText(
    env,
    chatId,
    msgId,
    `✅ <b>Device Verified Successfully!</b>\n${DIVIDER}\n🎉 Welcome to <b>${BOT_BRAND}</b>!\nYour rewards dashboard is now unlocked.`
  );

  await sendMainMenu(env, chatId, user, adminUser);
}
