// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Referral Tracking & Anti-Duplicate Protection Service
// ============================================================================

import { formatUserName } from '../config.js';
import {
  acquireLock,
  addUserReferral,
  getCachedBotUsername,
  getReferralClaim,
  getSettings,
  getUser,
  incrementGlobalStats,
  releaseLock,
  saveReferralClaim,
  saveUser,
  setCachedBotUsername,
} from '../database.js';
import { getMe } from '../telegram.js';
import { creditReferralReward } from './balance.js';
import { notifyReferrerCredited } from './notifications.js';

/**
 * Resolve the bot's Telegram username (from env, KV cache, or getMe).
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
 * - Referrer must exist in KV
 * - Only genuinely new users can be attributed
 * - One account can only ever be referred once
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

  newUser.pendingReferrerId = referrerId;
  await saveUser(env, newUser);
  return true;
}

/**
 * Finalize and credit a pending referral once the new user passes onboarding / force-join.
 * Protected with a per-referred-user lock + permanent ref_claim:<referredId> idempotency key
 * so a Telegram user can NEVER trigger duplicate referral rewards.
 */
export async function processPendingReferral(env, userId) {
  const referredId = String(userId);
  const lockScope = `ref_process:${referredId}`;
  const lockToken = await acquireLock(env, lockScope, 60);
  if (!lockToken) {
    return { credited: false, reason: 'locked' };
  }

  try {
    const user = await getUser(env, referredId);
    if (!user || !user.pendingReferrerId) {
      return { credited: false, reason: 'no_pending_referrer' };
    }

    if (user.referralCredited || user.referredBy) {
      return { credited: false, reason: 'already_credited' };
    }

    const referrerId = String(user.pendingReferrerId);
    if (referrerId === referredId) {
      user.pendingReferrerId = null;
      await saveUser(env, user);
      return { credited: false, reason: 'self_referral' };
    }

    // Permanent idempotency check
    const existingClaim = await getReferralClaim(env, referredId);
    if (existingClaim) {
      user.referredBy = existingClaim.referrerId;
      user.pendingReferrerId = null;
      user.referralCredited = true;
      await saveUser(env, user);
      return { credited: false, reason: 'claim_exists' };
    }

    const referrer = await getUser(env, referrerId);
    if (!referrer || referrer.status === 'banned') {
      user.pendingReferrerId = null;
      await saveUser(env, user);
      return { credited: false, reason: 'invalid_referrer' };
    }

    const settings = await getSettings(env);
    const rewardPaise = Math.max(0, Math.round(Number(settings.referralRewardPaise || 300)));
    const now = Date.now();

    // 1. Write permanent idempotency claim FIRST
    const claimRecord = {
      referrerId,
      referredUserId: referredId,
      referredName: formatUserName(user),
      referredUsername: user.username || '',
      amountPaise: rewardPaise,
      creditedAt: now,
    };
    await saveReferralClaim(env, referredId, claimRecord);

    // 2. Mark referred user permanently linked
    user.referredBy = referrerId;
    user.pendingReferrerId = null;
    user.referralCredited = true;
    await saveUser(env, user);

    // 3. Credit referrer balance & referral count
    const updatedReferrer = await creditReferralReward(env, referrerId, rewardPaise);

    // 4. Record in referrer's referral list
    await addUserReferral(env, referrerId, claimRecord);

    // 5. Update global statistics
    await incrementGlobalStats(env, {
      totalReferrals: 1,
      totalReferralRewardsPaise: rewardPaise,
    });

    // 6. Notify referrer of reward credit
    if (updatedReferrer) {
      await notifyReferrerCredited(
        env,
        referrerId,
        user,
        rewardPaise,
        updatedReferrer.balancePaise
      );
    }

    return {
      credited: true,
      referrerId,
      amountPaise: rewardPaise,
    };
  } finally {
    await releaseLock(env, lockScope, lockToken);
  }
}
