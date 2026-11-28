// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Device Verification & Suspicious Referral Review Handler
// ============================================================================

import { DIVIDER, buildHeader } from '../animations.js';
import {
  ACTIVITY_ACTIONS,
  BOT_BRAND,
  escapeHtml,
  formatINR,
  formatIST,
  formatUserName,
  formatUsernameTag,
  getMiniAppUrl,
  isDeviceVerificationEnabled,
} from '../config.js';
import {
  getDeviceVerificationStats,
  getPendingReferralReviewsPage,
  getReferralReviewById,
  getSuspiciousDeviceClustersPage,
  getUser,
  hasAdminPermission,
  isAdmin,
  resolveReferralReviewAtomic,
} from '../database.js';
import { adminActionKeyboard, mainMenuKeyboard, paginationRow } from '../keyboards.js';
import { logAdminActivity } from '../services/activity-log.js';
import { notifyReferrerCredited } from '../services/notifications.js';
import {
  logReferralCompletedEvent,
  logReferralReviewDecisionEvent,
} from '../services/secretary.js';
import { answerCallbackQuery, editOrSend, sendMessage } from '../telegram.js';

/**
 * Main Admin Device Verification Dashboard (`🛡️ Device Verification`)
 */
export async function handleAdminDeviceVerifyMenu(env, adminId, chatId, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageDeviceVerify', env))) {
    await sendMessage(env, chatId, '🚫 You do not have permission to manage device verification.');
    return;
  }

  const stats = await getDeviceVerificationStats(env);
  const enabled = isDeviceVerificationEnabled(env);
  const miniAppUrl = getMiniAppUrl(env);

  const text =
    `${buildHeader('🛡️', 'DEVICE VERIFICATION & ANTI-ABUSE')}\n` +
    `⚙️ <b>Gate Status:</b> ${enabled ? '🟢 ACTIVE' : '🔴 DISABLED'}\n` +
    `🌐 <b>Mini App URL:</b> ${miniAppUrl ? `<code>${escapeHtml(miniAppUrl)}</code>` : '⚠️ Not configured'}\n` +
    `${DIVIDER}\n` +
    `📊 <b>Verification Breakdown</b>\n` +
    `• ✅ Verified (Mini App): <b>${stats.verifiedUsers}</b>\n` +
    `• 🏛️ Grandfathered (Existing): <b>${stats.grandfatheredUsers}</b>\n` +
    `• ⏳ Pending Security Review: <b>${stats.pendingReviewUsers}</b>\n` +
    `• 🔓 Unverified New Users: <b>${stats.unverifiedUsers}</b>\n` +
    `• 🚫 Rejected: <b>${stats.rejectedUsers}</b>\n` +
    `• 🧪 Total Verification Checks: <b>${stats.totalAttempts}</b>\n` +
    `${DIVIDER}\n` +
    `🚨 <b>Suspicious Activity & Referral Queue</b>\n` +
    `• ⏳ Pending Referral Reviews: <b>${stats.pendingReferralReviews}</b>\n` +
    `• ✅ Approved Reviews: <b>${stats.approvedReferralReviews}</b> | ❌ Rejected: <b>${stats.rejectedReferralReviews}</b>\n` +
    `• 📱 Duplicate Device Clusters: <b>${stats.duplicateDeviceClusters}</b>\n` +
    `🕒 Snapshot: <i>${formatIST(Date.now(), env)}</i>`;

  const rows = [
    [
      {
        text: `⏳ Pending Referral Reviews (${stats.pendingReferralReviews})`,
        callback_data: 'adm:dv:reviews:1',
      },
    ],
    [
      {
        text: `📱 Suspicious Device Clusters (${stats.duplicateDeviceClusters})`,
        callback_data: 'adm:dv:clusters:1',
      },
    ],
    [{ text: '🔄 Refresh Overview', callback_data: 'adm:dv:menu' }],
  ];

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

/**
 * Paginated list of pending suspicious referrals awaiting admin approval/rejection
 */
export async function handleAdminReferralReviewsList(env, adminId, chatId, page = 1, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageDeviceVerify', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const pageData = await getPendingReferralReviewsPage(env, page, 5);
  let text =
    `${buildHeader('⏳', 'PENDING REFERRAL REVIEWS')}\n` +
    `📋 <b>Total Pending:</b> <b>${pageData.total}</b> (Page ${pageData.page}/${pageData.totalPages})\n` +
    `${DIVIDER}\n`;

  const rows = [];
  if (!pageData.items.length) {
    text += `✅ <i>All caught up! No suspicious referrals awaiting review.</i>`;
  } else {
    for (const r of pageData.items) {
      const reasonsText = (r.riskReasons || [])
        .slice(0, 3)
        .map((x) => escapeHtml(x.code || String(x)))
        .join(', ');
      const isSelfRefDevice = (r.matchedUserIds || []).includes(String(r.referrerId));
      const matchedPreview = (r.matchedUserIds || []).length
        ? r.matchedUserIds
            .slice(0, 4)
            .map((id) => `<code>${escapeHtml(id)}</code>`)
            .join(', ')
        : 'None';
      text +=
        `🆔 <code>${escapeHtml(r.id)}</code> — Risk: <b>${r.riskScore}/100</b>${isSelfRefDevice ? ' 🚨 <b>SELF-REFERRAL DEVICE</b>' : ''}\n` +
        `👤 Referred: <code>${escapeHtml(r.referredUserId)}</code> ← Referrer: <code>${escapeHtml(r.referrerId)}</code>\n` +
        `👥 Matched IDs: ${matchedPreview}\n` +
        `🔎 Signals: <i>${reasonsText || 'N/A'}</i>\n` +
        `🕒 ${formatIST(r.createdAt, env)}\n\n`;

      rows.push([
        { text: `🔍 ${r.id}`, callback_data: `adm:dv:rev_view:${r.id}` },
        { text: '✅ Approve', callback_data: `adm:dv:rev_approve:${r.id}` },
        { text: '❌ Reject', callback_data: `adm:dv:rev_reject:${r.id}` },
      ]);
    }
  }

  if (pageData.totalPages > 1) {
    rows.push(paginationRow('adm:dv:reviews', pageData.page, pageData.totalPages));
  }
  rows.push([
    { text: '🔄 Refresh', callback_data: `adm:dv:reviews:${pageData.page}` },
    { text: '⬅️ Back', callback_data: 'adm:dv:menu' },
  ]);

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

/**
 * Detailed inspection view of a single suspicious referral review
 */
export async function handleAdminReferralReviewDetail(env, callbackQuery, reviewId) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageDeviceVerify', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const review = await getReferralReviewById(env, reviewId);
  if (!review) {
    await answerCallbackQuery(env, callbackQuery.id, 'Review record not found.', true);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  const [referredUser, referrerUser] = await Promise.all([
    getUser(env, review.referredUserId),
    getUser(env, review.referrerId),
  ]);

  const reasonsList = (review.riskReasons || [])
    .map((r) => `• <b>${escapeHtml(r.code || 'FLAG')}</b> (+${r.weight || 0}): ${escapeHtml(r.detail || '')}`)
    .join('\n');

  const matchedIds = (review.matchedUserIds || []).length
    ? review.matchedUserIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')
    : 'None';

  const isSelfRefDevice = (review.matchedUserIds || []).includes(String(review.referrerId));
  const text =
    `${buildHeader('🔍', 'SUSPICIOUS REFERRAL REVIEW')}\n` +
    `🆔 <b>Review ID:</b> <code>${escapeHtml(review.id)}</code>\n` +
    `📌 <b>Status:</b> <b>${escapeHtml(review.status.toUpperCase())}</b>\n` +
    `⚠️ <b>Risk Score:</b> <b>${review.riskScore}/100</b>${isSelfRefDevice ? ' | 🚨 <b>SAME-DEVICE SELF-REFERRAL</b>' : ''}\n` +
    `${DIVIDER}\n` +
    `👤 <b>Referred User:</b> ${escapeHtml(formatUserName(referredUser))} (${escapeHtml(formatUsernameTag(referredUser?.username))}) [<code>${escapeHtml(review.referredUserId)}</code>]\n` +
    `👑 <b>Referrer:</b> ${escapeHtml(formatUserName(referrerUser))} (${escapeHtml(formatUsernameTag(referrerUser?.username))}) [<code>${escapeHtml(review.referrerId)}</code>]\n` +
    `🔗 <b>Referral Relationship:</b> ${isSelfRefDevice ? '🚨 Referrer is in matched device cluster' : 'Referred user matched another account cluster'}\n` +
    `🧬 <b>Device Hash:</b> <code>${escapeHtml((review.clusterFpHash || '').slice(0, 16))}…</code>\n` +
    `👥 <b>Matched Accounts:</b> ${matchedIds}\n` +
    `${DIVIDER}\n` +
    `🧾 <b>Risk Signals:</b>\n${reasonsList || '• None recorded'}\n` +
    `🕒 <b>Flagged At:</b> ${formatIST(review.createdAt, env)}`;

  const rows = [];
  if (review.status === 'pending') {
    rows.push([
      { text: '✅ Approve & Credit Referral', callback_data: `adm:dv:rev_approve:${review.id}` },
      { text: '❌ Reject Referral', callback_data: `adm:dv:rev_reject:${review.id}` },
    ]);
  }
  rows.push([
    { text: '📋 Pending Reviews', callback_data: 'adm:dv:reviews:1' },
    { text: '⬅️ Overview', callback_data: 'adm:dv:menu' },
  ]);

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}

/**
 * Approve or Reject a pending suspicious referral review atomically with full audit log.
 */
export async function handleAdminReferralReviewDecision(env, callbackQuery, reviewId, decision) {
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message?.chat?.id || adminId;
  const msgId = callbackQuery.message?.message_id;

  if (!(await hasAdminPermission(adminId, 'manageDeviceVerify', env))) {
    await answerCallbackQuery(env, callbackQuery.id, '🚫 Permission denied.', true);
    return;
  }

  const isApprove = decision === 'approved';
  await answerCallbackQuery(
    env,
    callbackQuery.id,
    isApprove ? '⏳ Approving & crediting referral...' : '⏳ Rejecting suspicious referral...'
  );

  const res = await resolveReferralReviewAtomic(env, {
    reviewId,
    decision: isApprove ? 'approved' : 'rejected',
    adminId,
    note: isApprove ? 'Approved by admin via Telegram panel' : 'Rejected by admin via Telegram panel',
  });

  if (!res.ok) {
    await sendMessage(env, chatId, `❌ <b>Review Action Failed:</b> ${escapeHtml(res.error)}`);
    return;
  }

  const review = res.review;
  let creditSummary = 'No reward credited (rejected).';

  if (isApprove) {
    if (res.referralCredited && res.referrer) {
      creditSummary = `Credited <b>${formatINR(res.amountPaise)}</b> to referrer <code>${escapeHtml(review.referrerId)}</code>.`;
      try {
        await notifyReferrerCredited(
          env,
          review.referrerId,
          res.user,
          res.amountPaise,
          res.referrer.balancePaise
        );
        await logReferralCompletedEvent(env, {
          referrer: res.referrer,
          referredUser: res.user,
          amountPaise: res.amountPaise,
          creditedAt: review.reviewedAt || Date.now(),
        });
      } catch {
        // Isolated post-commit notification
      }
    } else {
      creditSummary = 'User verified; referral already credited or ineligible.';
    }

    // Unlock the referred user's Telegram dashboard automatically
    try {
      const targetIsAdmin = await isAdmin(review.referredUserId, env);
      await sendMessage(
        env,
        review.referredUserId,
        `✅ <b>Device Verification Approved!</b>\n${DIVIDER}\nAn administrator has approved your security review.\n🎉 Welcome to <b>${BOT_BRAND}</b> — your dashboard is now unlocked!`,
        { reply_markup: mainMenuKeyboard(targetIsAdmin) }
      );
    } catch {
      // Isolated user notification
    }
  }

  await logAdminActivity(
    env,
    adminId,
    isApprove ? ACTIVITY_ACTIONS.REFERRAL_REVIEW_APPROVED : ACTIVITY_ACTIONS.REFERRAL_REVIEW_REJECTED,
    `${isApprove ? 'Approved' : 'Rejected'} referral review ${review.id} (referred=${review.referredUserId}, referrer=${review.referrerId})`
  );

  await logReferralReviewDecisionEvent(env, {
    review,
    adminId,
    decision: isApprove ? 'APPROVED' : 'REJECTED',
    creditSummary,
  });

  const text =
    `${buildHeader(isApprove ? '✅' : '❌', `REFERRAL REVIEW ${isApprove ? 'APPROVED' : 'REJECTED'}`)}\n` +
    `🆔 <b>Review ID:</b> <code>${escapeHtml(review.id)}</code>\n` +
    `👤 <b>Referred User:</b> <code>${escapeHtml(review.referredUserId)}</code>\n` +
    `👑 <b>Referrer:</b> <code>${escapeHtml(review.referrerId)}</code>\n` +
    `💰 <b>Outcome:</b> ${creditSummary}\n` +
    `👮 <b>Reviewed By:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🧾 <b>Audit ID:</b> <code>${escapeHtml(res.auditId)}</code>`;

  await editOrSend(env, chatId, msgId, text, {
    reply_markup: adminActionKeyboard([
      [{ text: '📋 Back to Pending Reviews', callback_data: 'adm:dv:reviews:1' }],
      [{ text: '🛡️ Device Verification Overview', callback_data: 'adm:dv:menu' }],
    ]),
  });
}

/**
 * Paginated viewer of duplicate-device clusters (2+ Telegram accounts sharing a strict fingerprint)
 */
export async function handleAdminDeviceClustersList(env, adminId, chatId, page = 1, messageId = null) {
  if (!(await hasAdminPermission(adminId, 'manageDeviceVerify', env))) {
    await sendMessage(env, chatId, '🚫 Permission denied.');
    return;
  }

  const pageData = await getSuspiciousDeviceClustersPage(env, page, 5);
  let text =
    `${buildHeader('📱', 'SUSPICIOUS DEVICE CLUSTERS')}\n` +
    `🔎 <b>Multi-Account Clusters:</b> <b>${pageData.total}</b> (Page ${pageData.page}/${pageData.totalPages})\n` +
    `${DIVIDER}\n`;

  const SIGNAL_LABELS = {
    install_token: '🔑 Install Token',
    strict_fp: '🧬 Strict FP',
    render_core: '🎨 Render Core',
    tg_biometric_id: '🪪 Biometric ID',
  };

  if (!pageData.items.length) {
    text += `✅ <i>No duplicate device clusters detected across multiple accounts.</i>`;
  } else {
    for (let i = 0; i < pageData.items.length; i++) {
      const c = pageData.items[i];
      const ids = c.userIds
        .slice(0, 8)
        .map((id) => `<code>${escapeHtml(id)}</code>`)
        .join(', ');
      const sigLabel = SIGNAL_LABELS[c.signalType] || '🧬 Device Signal';
      const refTag = c.hasReferralLink ? '🔗 Referral Linked' : 'ℹ️ Non-Referral Cluster';
      text +=
        `${i + 1}. <b>${sigLabel}</b> <code>${escapeHtml(c.fingerprintHash.slice(0, 14))}…</code> — <b>${c.accountCount} accounts</b> (Max Risk: ${c.maxRiskScore}/100)\n` +
        `   👥 IDs: ${ids}${c.userIds.length > 8 ? ` +${c.userIds.length - 8} more` : ''}\n` +
        `   📌 ${refTag} | 🕒 Last seen: ${formatIST(c.lastSeenAt, env)}\n\n`;
    }
  }

  const rows = [];
  if (pageData.totalPages > 1) {
    rows.push(paginationRow('adm:dv:clusters', pageData.page, pageData.totalPages));
  }
  rows.push([
    { text: '🔄 Refresh', callback_data: `adm:dv:clusters:${pageData.page}` },
    { text: '⬅️ Back', callback_data: 'adm:dv:menu' },
  ]);

  await editOrSend(env, chatId, messageId, text, {
    reply_markup: adminActionKeyboard(rows),
  });
}
