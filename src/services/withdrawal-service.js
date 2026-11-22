// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Manual-Approval Withdrawal Service
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
  acquireLock,
  addAllWithdrawalId,
  addPendingWithdrawalId,
  addUserWithdrawalId,
  addVoucherHistory,
  getCategoryIndex,
  getPendingWithdrawalIds,
  getSettings,
  getUser,
  getWithdrawal,
  incrementGlobalStats,
  releaseLock,
  removePendingWithdrawalId,
  saveUser,
  saveWithdrawal,
} from '../database.js';
import { logAdminActivity } from './activity-log.js';
import {
  finalizeApprovedWithdrawalBalance,
  refundRejectedWithdrawalBalance,
  reserveWithdrawalBalance,
} from './balance.js';
import {
  notifyAdminsNewWithdrawal,
  notifyUserWithdrawalApproved,
  notifyUserWithdrawalRejected,
} from './notifications.js';
import {
  checkAndTriggerLowStockAlert,
  finalizeVoucherDelivery,
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

  // Check active pending withdrawal
  if (user.activePendingWithdrawalId) {
    const existing = await getWithdrawal(env, user.activePendingWithdrawalId);
    if (existing && existing.status === 'pending') {
      return {
        ok: false,
        error:
          `⏳ You already have a pending withdrawal request (<code>${existing.id}</code>).\n\n` +
          `Please wait for admin review before submitting another request.`,
      };
    } else {
      // Self-heal stale pointer
      user.activePendingWithdrawalId = null;
      await saveUser(env, user);
    }
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
    const idx = await getCategoryIndex(env, categoryKey);
    if (!idx.availableIds.length) {
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
 * Create a new manual-approval pending withdrawal request and reserve user balance.
 * Never delivers a voucher here!
 */
export async function createWithdrawalRequest(env, userId, categoryKey) {
  const uid = String(userId);
  const lockScope = `wd_user:${uid}`;
  const lockToken = await acquireLock(env, lockScope, 60);
  if (!lockToken) {
    return { ok: false, error: '⏳ Your previous withdrawal action is still processing. Please wait.' };
  }

  try {
    const user = await getUser(env, uid);
    const check = await validateWithdrawalEligibility(env, user, categoryKey);
    if (!check.ok) {
      return check;
    }

    // Extra safety check against pending list
    const pendingIds = await getPendingWithdrawalIds(env);
    for (const pid of pendingIds) {
      const pw = await getWithdrawal(env, pid);
      if (pw && String(pw.userId) === uid && pw.status === 'pending') {
        return {
          ok: false,
          error: `⏳ You already have a pending request (<code>${pw.id}</code>).`,
        };
      }
    }

    const requestId = generateId('WD');
    const amountPaise = check.amountPaise;
    const balanceSnapshotPaise = Number(user.balancePaise || 0);

    // Reserve balance safely BEFORE saving withdrawal
    const reserveRes = await reserveWithdrawalBalance(env, uid, amountPaise, requestId);
    if (!reserveRes.ok) {
      return { ok: false, error: reserveRes.error };
    }

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

    try {
      await saveWithdrawal(env, withdrawal);
      await addPendingWithdrawalId(env, requestId);
      await addAllWithdrawalId(env, requestId);
      await addUserWithdrawalId(env, uid, requestId);
    } catch (err) {
      // Recovery: refund balance if saving request failed
      await refundRejectedWithdrawalBalance(env, uid, amountPaise, requestId);
      return {
        ok: false,
        error: 'Temporary storage error while creating request. Your balance was not deducted.',
      };
    }

    // Notify Owner & Admins immediately
    await notifyAdminsNewWithdrawal(env, withdrawal);

    return {
      ok: true,
      withdrawal,
      updatedUser: reserveRes.user,
    };
  } finally {
    await releaseLock(env, lockScope, lockToken);
  }
}

/**
 * Admin approval workflow:
 * 1. Lock request & verify pending
 * 2. Re-verify 24-hour approved withdrawal rule
 * 3. Reserve one unused voucher from selected category
 * 4. Finalize voucher delivery & permanent voucher history
 * 5. Complete withdrawal & update user balance
 * 6. Notify user & log admin activity
 * 7. Check & trigger Low Stock Alert if needed
 */
export async function approveWithdrawalRequest(env, requestId, adminId) {
  const lockScope = `wd_act:${requestId}`;
  const lockToken = await acquireLock(env, lockScope, 60);
  if (!lockToken) {
    return { ok: false, error: 'This withdrawal request is currently being processed by another admin.' };
  }

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

    // Enforce max 1 approved withdrawal in 24h even if an edge case occurred
    if (user.lastApprovedWithdrawalAt && Date.now() - Number(user.lastApprovedWithdrawalAt) < DAY_MS) {
      const rem = DAY_MS - (Date.now() - Number(user.lastApprovedWithdrawalAt));
      return {
        ok: false,
        error: `User already received an approved withdrawal within the last 24h (remaining: ${formatCountdown(rem)}). Reject or wait before approving.`,
      };
    }

    // Reserve one unused voucher
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

    // Mark voucher permanently delivered
    const deliveredVoucher = await finalizeVoucherDelivery(env, reservedVoucher, adminId, now);

    // Record permanent voucher history
    const historyRecord = {
      id: generateId('VH'),
      voucherId: deliveredVoucher.id,
      code: deliveredVoucher.code,
      category: deliveredVoucher.category,
      valuePaise: deliveredVoucher.valuePaise,
      userId: withdrawal.userId,
      username: withdrawal.username || user.username || '',
      userName: withdrawal.userName || formatUserName(user),
      withdrawalRequestId: withdrawal.id,
      approvedBy: String(adminId),
      deliveredAt: now,
    };
    await addVoucherHistory(env, historyRecord);

    // Update withdrawal record
    withdrawal.status = 'approved';
    withdrawal.processedAt = now;
    withdrawal.processedBy = String(adminId);
    withdrawal.voucherId = deliveredVoucher.id;
    withdrawal.voucherCode = deliveredVoucher.code;
    await saveWithdrawal(env, withdrawal);
    await removePendingWithdrawalId(env, withdrawal.id);

    // Update user balances & cooldown
    await finalizeApprovedWithdrawalBalance(
      env,
      withdrawal.userId,
      withdrawal.amountPaise,
      withdrawal.id,
      now
    );

    // Update global statistics
    await incrementGlobalStats(env, {
      totalApprovedWithdrawals: 1,
      totalWithdrawnPaise: withdrawal.amountPaise,
      totalVouchersDelivered: 1,
    });

    // Record admin activity log
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.WITHDRAWAL_APPROVED,
      `Approved ${withdrawal.id} for user ${withdrawal.userId} (${formatINR(withdrawal.amountPaise)}, ${withdrawal.category}, voucher ${deliveredVoucher.id})`
    );

    // Deliver voucher privately to user
    const dmRes = await notifyUserWithdrawalApproved(env, withdrawal, deliveredVoucher);

    // Check low stock threshold & alert admins if triggered
    await checkAndTriggerLowStockAlert(env, withdrawal.category, remainingStock);

    return {
      ok: true,
      withdrawal,
      voucher: deliveredVoucher,
      remainingStock,
      dmDelivered: dmRes.ok,
      dmError: dmRes.ok ? '' : dmRes.description,
    };
  } catch (err) {
    // Recovery if failure happened before withdrawal was marked approved
    if (reservedVoucher) {
      await releaseReservedVoucher(env, reservedVoucher);
    }
    return {
      ok: false,
      error: `Approval interrupted safely: ${err?.message || 'Unknown error'}`,
    };
  } finally {
    await releaseLock(env, lockScope, lockToken);
  }
}

/**
 * Admin rejection workflow:
 * 1. Verify pending status under lock
 * 2. Mark request rejected with optional reason
 * 3. Refund reserved balance cleanly back to user's available balance
 * 4. Update stats, log admin action, and notify user
 */
export async function rejectWithdrawalRequest(env, requestId, adminId, reason = '') {
  const lockScope = `wd_act:${requestId}`;
  const lockToken = await acquireLock(env, lockScope, 60);
  if (!lockToken) {
    return { ok: false, error: 'This withdrawal request is currently being processed.' };
  }

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

    const now = Date.now();
    const cleanReason = String(reason || '').trim().slice(0, 250);

    withdrawal.status = 'rejected';
    withdrawal.processedAt = now;
    withdrawal.processedBy = String(adminId);
    withdrawal.rejectionReason = cleanReason;

    await saveWithdrawal(env, withdrawal);
    await removePendingWithdrawalId(env, withdrawal.id);

    const refundedUser = await refundRejectedWithdrawalBalance(
      env,
      withdrawal.userId,
      withdrawal.amountPaise,
      withdrawal.id
    );

    await incrementGlobalStats(env, {
      totalRejectedWithdrawals: 1,
    });

    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.WITHDRAWAL_REJECTED,
      `Rejected ${withdrawal.id} for user ${withdrawal.userId} (${formatINR(withdrawal.amountPaise)} refunded)${cleanReason ? ` — Reason: ${cleanReason}` : ''}`
    );

    await notifyUserWithdrawalRejected(
      env,
      withdrawal,
      refundedUser ? refundedUser.balancePaise : withdrawal.amountPaise
    );

    return {
      ok: true,
      withdrawal,
      refundedBalancePaise: refundedUser ? refundedUser.balancePaise : 0,
    };
  } finally {
    await releaseLock(env, lockScope, lockToken);
  }
}
