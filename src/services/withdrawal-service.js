// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Manual-Approval Withdrawal Service (Atomic D1 Transactions)
// ============================================================================

import {
  ACTIVITY_ACTIONS,
  DAY_MS,
  formatCountdown,
  formatINR,
  formatUserName,
  generateId,
  getCategoryMeta,
} from '../config.js';
import {
  countAvailableVouchersByCategory,
  executeApproveWithdrawalTransaction,
  executeCreateWithdrawalTransaction,
  executeRejectWithdrawalTransaction,
  getSettings,
  getUser,
  getUserActivePendingWithdrawal,
  getWithdrawal,
  saveUser,
} from '../database.js';
import { logAdminActivity } from './activity-log.js';
import {
  notifyAdminsNewWithdrawal,
  notifyUserWithdrawalApproved,
  notifyUserWithdrawalRejected,
} from './notifications.js';
import {
  logBotErrorEvent,
  logWithdrawalApprovedEvent,
  logWithdrawalRejectedEvent,
  logWithdrawalRequestedEvent,
} from './secretary.js';
import {
  checkAndTriggerLowStockAlert,
  releaseReservedVoucher,
  reserveAvailableVoucher,
} from './voucher-service.js';

/**
 * Validate whether a user can submit a new withdrawal request for a category.
 */
export async function validateWithdrawalEligibility(env, user, categoryKey = null) {
  if (!user) {
    return { ok: false, error: 'User profile not found. Please send /start first.' };
  }
  if (user.status === 'banned') {
    return { ok: false, error: '🚫 Your account has been restricted. Contact support.' };
  }

  const settings = await getSettings(env);
  const minWithdrawalPaise = Math.max(100, Number(settings.minWithdrawalPaise || 1000));
  const voucherValuePaise = Math.max(100, Number(settings.defaultVoucherValuePaise || 1000));
  const requiredPaise = Math.max(minWithdrawalPaise, voucherValuePaise);

  // Check active pending withdrawal in D1 (single source of truth)
  const existingPending = await getUserActivePendingWithdrawal(env, user.id);
  if (existingPending) {
    return {
      ok: false,
      error:
        `⏳ You already have a pending withdrawal request (<code>${existingPending.id}</code>).\n\n` +
        `Please wait for admin review before submitting another request.`,
    };
  } else if (user.activePendingWithdrawalId) {
    // Self-heal stale pointer if present
    user.activePendingWithdrawalId = null;
    await saveUser(env, user);
  }

  // Enforce maximum ONE approved withdrawal in 24 hours
  if (user.lastApprovedWithdrawalAt) {
    const elapsed = Date.now() - Number(user.lastApprovedWithdrawalAt);
    if (elapsed < DAY_MS) {
      const remaining = DAY_MS - elapsed;
      return {
        ok: false,
        error:
          `⏳ <b>24-Hour Withdrawal Limit</b>\n\n` +
          `You can receive a maximum of <b>1 approved withdrawal per 24 hours</b>.\n` +
          `🕒 Next eligible withdrawal in: <b>${formatCountdown(remaining)}</b>`,
      };
    }
  }

  // Check sufficient available balance
  if (Number(user.balancePaise || 0) < requiredPaise) {
    return {
      ok: false,
      error:
        `⚠️ <b>Insufficient Available Balance</b>\n\n` +
        `💰 Your Available Balance: <b>${formatINR(user.balancePaise)}</b>\n` +
        `📌 Minimum Required: <b>${formatINR(requiredPaise)}</b>\n\n` +
        `Invite friends or claim your daily bonus to reach the minimum!`,
    };
  }

  // If a specific category is selected, verify stock availability
  if (categoryKey) {
    const cat = getCategoryMeta(categoryKey);
    if (!cat) {
      return { ok: false, error: 'Invalid voucher category selected.' };
    }
    const availableCount = await countAvailableVouchersByCategory(env, categoryKey);
    if (availableCount <= 0) {
      return {
        ok: false,
        error: `🔴 <b>${cat.name}</b> is currently <b>OUT OF STOCK</b>.\n\nPlease choose another available category or check back soon.`,
      };
    }
  }

  return {
    ok: true,
    amountPaise: voucherValuePaise,
    minWithdrawalPaise,
    voucherValuePaise,
  };
}

/**
 * Create a new manual-approval pending withdrawal request and atomically reserve user balance.
 * Protected by D1 CHECK(balance_paise >= 0), partial UNIQUE index on pending withdrawals,
 * and immutable ledger entry in a single atomic batch.
 * Never delivers a voucher here!
 */
export async function createWithdrawalRequest(env, userId, categoryKey) {
  const uid = String(userId);
  const user = await getUser(env, uid);
  const check = await validateWithdrawalEligibility(env, user, categoryKey);
  if (!check.ok) {
    return check;
  }

  const requestId = generateId('WD');
  const amountPaise = check.amountPaise;
  const balanceSnapshotPaise = Number(user.balancePaise || 0);
  const now = Date.now();

  const withdrawal = {
    id: requestId,
    userId: uid,
    username: user.username || '',
    userName: formatUserName(user),
    amountPaise,
    category: categoryKey,
    status: 'pending', // pending | approved | rejected
    createdAt: now,
    processedAt: null,
    processedBy: null,
    rejectionReason: '',
    voucherId: null,
    voucherCode: null,
    userBalanceSnapshotPaise: balanceSnapshotPaise,
  };

  const txResult = await executeCreateWithdrawalTransaction(env, withdrawal);
  if (!txResult.ok) {
    await logBotErrorEvent(env, {
      category: 'FINANCIAL_OP_FAILED',
      summary: `Withdrawal request creation failed: ${txResult.error}`,
      context: `user=${uid} category=${categoryKey} amountPaise=${amountPaise}`,
      dedupId: `wd_create_fail:${requestId}`,
    });
    return { ok: false, error: txResult.error };
  }

  // Notify Owner & Admins immediately and log to PnA X Logs
  await notifyAdminsNewWithdrawal(env, withdrawal);
  await logWithdrawalRequestedEvent(env, { withdrawal });

  return {
    ok: true,
    withdrawal,
    updatedUser: txResult.user,
  };
}

/**
 * Admin approval workflow (atomic D1 transactions):
 * 1. Verify pending withdrawal & 24-hour approved withdrawal rule
 * 2. Atomically reserve one unused voucher via SQL UPDATE ... RETURNING
 * 3. Execute ONE atomic D1 batch:
 *    - Mark withdrawal approved (trigger aborts if already processed)
 *    - Mark voucher delivered
 *    - Insert permanent voucher_history (UNIQUE voucher_id & withdrawal_request_id)
 *    - Finalize user balances & 24h cooldown
 *    - Write financial ledger entry
 * 4. On any interruption before commit, release reserved voucher cleanly
 * 5. Log admin activity, DM voucher privately, and check Low Stock Alert
 */
export async function approveWithdrawalRequest(env, requestId, adminId) {
  let reservedVoucher = null;

  try {
    const withdrawal = await getWithdrawal(env, requestId);
    if (!withdrawal) {
      return { ok: false, error: 'Withdrawal request not found.' };
    }
    if (withdrawal.status !== 'pending') {
      return {
        ok: false,
        error: `Request ${requestId} has already been ${withdrawal.status.toUpperCase()}.`,
      };
    }

    const user = await getUser(env, withdrawal.userId);
    if (!user) {
      return { ok: false, error: 'Associated user account no longer exists.' };
    }

    // Enforce max 1 approved withdrawal in 24h
    if (user.lastApprovedWithdrawalAt && Date.now() - Number(user.lastApprovedWithdrawalAt) < DAY_MS) {
      const rem = DAY_MS - (Date.now() - Number(user.lastApprovedWithdrawalAt));
      return {
        ok: false,
        error: `User already received an approved withdrawal within the last 24h (remaining: ${formatCountdown(rem)}). Reject or wait before approving.`,
      };
    }

    // Atomically reserve one unused voucher
    const reserveRes = await reserveAvailableVoucher(
      env,
      withdrawal.category,
      withdrawal.userId,
      withdrawal.id
    );
    if (!reserveRes.ok) {
      return { ok: false, error: `❌ Cannot approve: ${reserveRes.error}` };
    }
    reservedVoucher = reserveRes.voucher;
    const remainingStock = reserveRes.remainingStock;
    const now = Date.now();

    const txRes = await executeApproveWithdrawalTransaction(env, {
      withdrawal,
      voucher: reservedVoucher,
      adminId,
      processedAt: now,
    });

    if (!txRes.ok) {
      // Withdrawal was concurrently processed -> release reserved voucher immediately
      await releaseReservedVoucher(env, reservedVoucher);
      reservedVoucher = null;
      return { ok: false, error: txRes.error };
    }

    // Committed successfully -> do not roll back voucher
    const deliveredVoucher = txRes.voucher;
    const approvedWithdrawal = txRes.withdrawal;
    reservedVoucher = null;

    // Record admin activity log & Secretary Mode log (voucher ID only, never raw redeem code)
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.WITHDRAWAL_APPROVED,
      `Approved ${approvedWithdrawal.id} for user ${approvedWithdrawal.userId} (${formatINR(approvedWithdrawal.amountPaise)}, ${approvedWithdrawal.category}, voucher ${deliveredVoucher.id})`
    );
    await logWithdrawalApprovedEvent(env, {
      withdrawal: approvedWithdrawal,
      voucher: deliveredVoucher,
      adminId,
    });

    // Deliver voucher privately to user
    const dmRes = await notifyUserWithdrawalApproved(env, approvedWithdrawal, deliveredVoucher);

    // Check low stock threshold & alert admins if triggered
    await checkAndTriggerLowStockAlert(env, approvedWithdrawal.category, remainingStock);

    return {
      ok: true,
      withdrawal: approvedWithdrawal,
      voucher: deliveredVoucher,
      remainingStock,
      dmDelivered: dmRes.ok,
      dmError: dmRes.ok ? '' : dmRes.description,
    };
  } catch (err) {
    if (reservedVoucher) {
      await releaseReservedVoucher(env, reservedVoucher);
    }
    await logBotErrorEvent(env, {
      category: 'FINANCIAL_OP_FAILED',
      summary: `Withdrawal approval interrupted: ${err?.message || 'Unknown error'}`,
      context: `requestId=${requestId} adminId=${adminId}`,
      dedupId: `wd_app_fail:${requestId}:${Date.now()}`,
    });
    return {
      ok: false,
      error: `Approval interrupted safely: ${err?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Admin rejection workflow (atomic D1 transaction):
 * 1. Verify pending status
 * 2. Execute ONE atomic D1 batch:
 *    - Mark request rejected with optional reason (trigger aborts if already processed)
 *    - Refund 100% of reserved balance cleanly back to user's available balance
 *    - Write immutable ledger refund entry
 * 3. Log admin action and notify user
 */
export async function rejectWithdrawalRequest(env, requestId, adminId, reason = '') {
  const withdrawal = await getWithdrawal(env, requestId);
  if (!withdrawal) {
    return { ok: false, error: 'Withdrawal request not found.' };
  }
  if (withdrawal.status !== 'pending') {
    return {
      ok: false,
      error: `Request ${requestId} has already been ${withdrawal.status.toUpperCase()}.`,
    };
  }

  const now = Date.now();
  const cleanReason = String(reason || '').trim().slice(0, 250);

  const txRes = await executeRejectWithdrawalTransaction(env, {
    withdrawal,
    adminId,
    reason: cleanReason,
    processedAt: now,
  });

  if (!txRes.ok) {
    return { ok: false, error: txRes.error };
  }

  const rejectedWithdrawal = txRes.withdrawal;
  const refundedUser = txRes.user;

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.WITHDRAWAL_REJECTED,
    `Rejected ${rejectedWithdrawal.id} for user ${rejectedWithdrawal.userId} (${formatINR(rejectedWithdrawal.amountPaise)} refunded)${cleanReason ? ` — Reason: ${cleanReason}` : ''}`
  );
  await logWithdrawalRejectedEvent(env, {
    withdrawal: rejectedWithdrawal,
    adminId,
  });

  await notifyUserWithdrawalRejected(
    env,
    rejectedWithdrawal,
    refundedUser ? refundedUser.balancePaise : rejectedWithdrawal.amountPaise
  );

  return {
    ok: true,
    withdrawal: rejectedWithdrawal,
    refundedBalancePaise: refundedUser ? refundedUser.balancePaise : 0,
  };
}
