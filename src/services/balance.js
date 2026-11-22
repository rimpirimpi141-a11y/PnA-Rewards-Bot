// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Balance & Ledger Service (Exact Integer Paise Math)
// ============================================================================

import { getUser, saveUser } from '../database.js';

export function getBalanceSummary(user) {
  return {
    availablePaise: Math.max(0, Math.round(Number(user?.balancePaise || 0))),
    totalEarnedPaise: Math.max(0, Math.round(Number(user?.totalEarnedPaise || 0))),
    referralEarningsPaise: Math.max(0, Math.round(Number(user?.referralEarningsPaise || 0))),
    dailyBonusEarningsPaise: Math.max(0, Math.round(Number(user?.dailyBonusEarningsPaise || 0))),
    totalWithdrawnPaise: Math.max(0, Math.round(Number(user?.totalWithdrawnPaise || 0))),
    pendingWithdrawalPaise: Math.max(0, Math.round(Number(user?.pendingWithdrawalPaise || 0))),
  };
}

export async function creditReferralReward(env, referrerId, amountPaise) {
  const safeAmount = Math.max(0, Math.round(Number(amountPaise || 0)));
  if (safeAmount <= 0) return null;

  const user = await getUser(env, referrerId);
  if (!user) return null;

  user.balancePaise = Math.round(Number(user.balancePaise || 0)) + safeAmount;
  user.totalEarnedPaise = Math.round(Number(user.totalEarnedPaise || 0)) + safeAmount;
  user.referralEarningsPaise = Math.round(Number(user.referralEarningsPaise || 0)) + safeAmount;
  user.totalReferrals = Math.round(Number(user.totalReferrals || 0)) + 1;

  return saveUser(env, user);
}

export async function creditDailyBonus(env, userId, amountPaise, claimedAt = Date.now()) {
  const safeAmount = Math.max(0, Math.round(Number(amountPaise || 0)));
  if (safeAmount <= 0) return null;

  const user = await getUser(env, userId);
  if (!user) return null;

  user.balancePaise = Math.round(Number(user.balancePaise || 0)) + safeAmount;
  user.totalEarnedPaise = Math.round(Number(user.totalEarnedPaise || 0)) + safeAmount;
  user.dailyBonusEarningsPaise =
    Math.round(Number(user.dailyBonusEarningsPaise || 0)) + safeAmount;
  user.lastDailyClaimAt = claimedAt;
  user.dailyBonusCount = Math.round(Number(user.dailyBonusCount || 0)) + 1;

  return saveUser(env, user);
}

/**
 * Safely deduct & reserve user balance when creating a pending withdrawal.
 */
export async function reserveWithdrawalBalance(env, userId, amountPaise, requestId) {
  const safeAmount = Math.max(0, Math.round(Number(amountPaise || 0)));
  const user = await getUser(env, userId);
  if (!user) return { ok: false, error: 'User account not found.' };

  const available = Math.round(Number(user.balancePaise || 0));
  if (available < safeAmount) {
    return { ok: false, error: 'Insufficient available balance.' };
  }

  user.balancePaise = available - safeAmount;
  user.pendingWithdrawalPaise =
    Math.round(Number(user.pendingWithdrawalPaise || 0)) + safeAmount;
  user.activePendingWithdrawalId = requestId;

  const saved = await saveUser(env, user);
  return { ok: true, user: saved };
}

/**
 * Finalize reserved balance into totalWithdrawn upon admin approval.
 */
export async function finalizeApprovedWithdrawalBalance(
  env,
  userId,
  amountPaise,
  requestId,
  approvedAt = Date.now()
) {
  const safeAmount = Math.max(0, Math.round(Number(amountPaise || 0)));
  const user = await getUser(env, userId);
  if (!user) return null;

  user.pendingWithdrawalPaise = Math.max(
    0,
    Math.round(Number(user.pendingWithdrawalPaise || 0)) - safeAmount
  );
  user.totalWithdrawnPaise = Math.round(Number(user.totalWithdrawnPaise || 0)) + safeAmount;
  user.withdrawalCount = Math.round(Number(user.withdrawalCount || 0)) + 1;
  user.lastApprovedWithdrawalAt = approvedAt;
  if (user.activePendingWithdrawalId === requestId) {
    user.activePendingWithdrawalId = null;
  }

  return saveUser(env, user);
}

/**
 * Refund reserved balance back to available balance upon admin rejection.
 */
export async function refundRejectedWithdrawalBalance(env, userId, amountPaise, requestId) {
  const safeAmount = Math.max(0, Math.round(Number(amountPaise || 0)));
  const user = await getUser(env, userId);
  if (!user) return null;

  user.pendingWithdrawalPaise = Math.max(
    0,
    Math.round(Number(user.pendingWithdrawalPaise || 0)) - safeAmount
  );
  user.balancePaise = Math.round(Number(user.balancePaise || 0)) + safeAmount;
  if (user.activePendingWithdrawalId === requestId) {
    user.activePendingWithdrawalId = null;
  }

  return saveUser(env, user);
}
