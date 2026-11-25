// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Referral Tracking & Anti-Duplicate Protection Service (D1)
// ============================================================================

import { formatUserName } from '../config.js';
import {
  clearUserPendingReferrer,
  executeReferralCreditTransaction,
  getCachedBotUsername,
  getReferralClaim,
  getSettings,
  getUser,
  setCachedBotUsername,
  setUserPendingReferrer,
} from '../database.js';
import { getMe } from '../telegram.js';
import { notifyReferrerCredited } from './notifications.js';
import { logReferralCompletedEvent } from './secretary.js';

/**
 * Resolve the bot's Telegram username (from env, D1 settings cache, or getMe).
 */
export async function resolveBotUsername(env) {
  const cached = await getCachedBotUsername(env);
  if (cached) return cached;

  const me = await getMe(env);
  if (me.ok && me.result?.username) {
    await setCachedBotUsername(env, me.result.username);
    return me.result.username;
  }
  return '';
}

/**
 * Build a user's unique referral link.
 */
export async function buildReferralLink(env, userId) {
  const username = await resolveBotUsername(env);
  if (!username) {
    return `https://t.me/YOUR_BOT_USERNAME?start=${encodeURIComponent(String(userId))}`;
  }
  return `https://t.me/${username}?start=${encodeURIComponent(String(userId))}`;
}

/**
 * Record pending referral intent ONLY for a genuinely brand-new Telegram user.
 * Enforces:
 * - No self-referrals
 * - Referrer must exist in D1 and not be banned
 * - Only genuinely new users can be attributed
 * - One account can only ever be referred once (enforced by referral_claims PK)
 */
export async function registerPendingReferralIfEligible(env, newUser, rawStartPayload) {
  if (!newUser || !rawStartPayload) return false;
  const referrerId = String(rawStartPayload).trim();

  // Must be numeric Telegram user ID
  if (!/^\d{5,20}$/.test(referrerId)) return false;

  // Never reward self-referrals
  if (referrerId === String(newUser.id)) return false;

  // Check if user already referred or already claimed
  if (newUser.referredBy || newUser.referralCredited) return false;
  const existingClaim = await getReferralClaim(env, newUser.id);
  if (existingClaim) return false;

  // Referrer must be a real registered user
  const referrer = await getUser(env, referrerId);
  if (!referrer || referrer.status === 'banned') return false;

  return setUserPendingReferrer(env, newUser.id, referrerId);
}

/**
 * Finalize and credit a pending referral once the new user passes onboarding / force-join.
 * Protected atomically by D1 transaction batch + PRIMARY KEY on referral_claims(referred_user_id)
 * + UNIQUE ledger idempotency so a Telegram user can NEVER trigger duplicate referral rewards.
 */
export async function processPendingReferral(env, userId) {
  const referredId = String(userId);
  const user = await getUser(env, referredId);
  if (!user || !user.pendingReferrerId) {
    return { credited: false, reason: 'no_pending_referrer' };
  }

  if (user.referralCredited || user.referredBy) {
    await clearUserPendingReferrer(env, referredId);
    return { credited: false, reason: 'already_credited' };
  }

  const referrerId = String(user.pendingReferrerId);
  if (referrerId === referredId) {
    await clearUserPendingReferrer(env, referredId);
    return { credited: false, reason: 'self_referral' };
  }

  // Permanent idempotency check
  const existingClaim = await getReferralClaim(env, referredId);
  if (existingClaim) {
    await clearUserPendingReferrer(env, referredId);
    return { credited: false, reason: 'claim_exists' };
  }

  const referrer = await getUser(env, referrerId);
  if (!referrer || referrer.status === 'banned') {
    await clearUserPendingReferrer(env, referredId);
    return { credited: false, reason: 'invalid_referrer' };
  }

  const settings = await getSettings(env);
  const rewardPaise = Math.max(0, Math.round(Number(settings.referralRewardPaise || 300)));
  const now = Date.now();

  const txResult = await executeReferralCreditTransaction(env, {
    referrerId,
    referredUserId: referredId,
    referredName: formatUserName(user),
    referredUsername: user.username || '',
    amountPaise: rewardPaise,
    creditedAt: now,
  });

  if (!txResult.ok) {
    return { credited: false, reason: txResult.duplicate ? 'claim_exists' : 'tx_failed' };
  }

  // Notify referrer of reward credit & log to PnA X Logs
  if (txResult.referrer) {
    await notifyReferrerCredited(
      env,
      referrerId,
      user,
      rewardPaise,
      txResult.referrer.balancePaise
    );
    await logReferralCompletedEvent(env, {
      referrer: txResult.referrer,
      referredUser: user,
      amountPaise: rewardPaise,
      creditedAt: now,
    });
  }

  return {
    credited: true,
    referrerId,
    amountPaise: rewardPaise,
  };
}
