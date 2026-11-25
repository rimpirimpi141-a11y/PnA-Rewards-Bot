// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Balance & Ledger Service (Exact Integer Paise Math on D1)
// ============================================================================

import { ACTIVITY_ACTIONS, formatINR } from '../config.js';
import {
  executeCreateWithdrawalTransaction,
  executeDailyBonusClaimTransaction,
  executeManualBalanceAdjustmentTransaction,
  executeReferralCreditTransaction,
  executeRejectWithdrawalTransaction,
  getUserBalanceAdjustments,
  getUserLedger,
} from '../database.js';
import { logAdminActivity } from './activity-log.js';
import { notifyUserBalanceAdjusted } from './notifications.js';
import { logBotErrorEvent, logManualBalanceEvent } from './secretary.js';

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

export async function getUserLedgerEntries(env, userId, limit = 50) {
  return getUserLedger(env, userId, limit);
}

export async function getUserManualAdjustments(env, userId, limit = 20) {
  return getUserBalanceAdjustments(env, userId, limit);
}

/**
 * Execute an audited manual admin balance ADD or DEDUCT operation:
 *   1. Atomic D1 batch (users + balance_adjustments + immutable ledger)
 *   2. Admin activity log entry
 *   3. Secretary Mode log to PnA X Logs
 *   4. Direct notification to target user
 */
export async function applyAdminBalanceAdjustment(
  env,
  { operationId, adminId, targetUserId, action, amountPaise, reason = '' }
) {
  const tx = await executeManualBalanceAdjustmentTransaction(env, {
    operationId,
    adminId,
    targetUserId,
    action,
    amountPaise,
    reason,
    createdAt: Date.now(),
  });

  if (!tx.ok) {
    if (!tx.duplicate) {
      await logBotErrorEvent(env, {
        category: 'FINANCIAL_OP_FAILED',
        summary: `Manual balance ${action} failed: ${tx.error}`,
        context: `admin=${adminId} target=${targetUserId} amountPaise=${amountPaise} opId=${operationId}`,
        dedupId: `bal_fail:${operationId}`,
      });
    }
    return tx;
  }

  const adj = tx.adjustment;
  const targetUser = tx.user;
  const actType =
    adj.action === 'ADD' ? ACTIVITY_ACTIONS.BALANCE_ADDED : ACTIVITY_ACTIONS.BALANCE_DEDUCTED;
  const sign = adj.action === 'ADD' ? '+' : '-';
  const reasonSuffix = adj.reason ? ` — Reason: ${adj.reason}` : '';

  await logAdminActivity(
    env,
    adminId,
    actType,
    `${adj.action} ${sign}${formatINR(adj.amountPaise)} for user ${adj.targetUserId} (${formatINR(adj.balanceBeforePaise)} → ${formatINR(adj.balanceAfterPaise)}) [${adj.id}]${reasonSuffix}`
  );

  await logManualBalanceEvent(env, { adjustment: adj, targetUser });
  await notifyUserBalanceAdjusted(env, adj);

  return tx;
}

// Re-export atomic D1 ledger-backed financial transaction helpers
export {
  executeCreateWithdrawalTransaction,
  executeDailyBonusClaimTransaction,
  executeManualBalanceAdjustmentTransaction,
  executeReferralCreditTransaction,
  executeRejectWithdrawalTransaction,
};
