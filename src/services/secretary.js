// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — 📡 Secretary Mode (PnA X Logs Automatic Channel Logger)
// ============================================================================
// Sends structured, sanitized audit logs to the configured PnA X Logs channel.
// Guarantees:
//   • Verifies bot is an actual channel administrator with posting rights
//     before marking logging active.
//   • Never accepts a private invite link as a chat ID.
//   • Never exposes BOT_TOKEN, WEBHOOK_SECRET, or secret redeem codes.
//   • Deduplicates via D1 UNIQUE dedup_key so retried webhook updates never
//     emit duplicate channel logs.
//   • Never crashes the main bot on Telegram API failure; records failed
//     deliveries safely in D1 for safe retries.
// ============================================================================

import { DIVIDER } from '../animations.js';
import {
  BOT_BRAND,
  escapeHtml,
  formatINR,
  formatIST,
  formatUserName,
  formatUsernameTag,
  generateId,
  getCategoryMeta,
  getConfiguredLogChannelId,
  sleep,
} from '../config.js';
import {
  claimSecretaryLogEntry,
  getCachedBotId,
  getFailedSecretaryLogs,
  getSecretaryConfig,
  markSecretaryLogFailed,
  markSecretaryLogSent,
  markSecretaryLogSkipped,
  saveSecretaryConfig,
  setCachedBotId,
} from '../database.js';
import { getChat, getChatMember, getMe, sendMessage } from '../telegram.js';

const AUTO_VERIFY_THROTTLE_MS = 60 * 1000;

/**
 * Strip any accidental BOT_TOKEN, WEBHOOK_SECRET, or Telegram token pattern
 * before storing or transmitting log text.
 */
export function redactSecrets(rawText, env) {
  let out = String(rawText ?? '');
  const secrets = [
    [env?.BOT_TOKEN, '[REDACTED_BOT_TOKEN]', 8],
    [env?.WEBHOOK_SECRET, '[REDACTED_WEBHOOK_SECRET]', 6],
    [env?.MINIAPP_BRIDGE_SECRET, '[REDACTED_BRIDGE_SECRET]', 8],
    [env?.VERIFICATION_SIGNING_SECRET, '[REDACTED_SIGNING_SECRET]', 8],
  ];

  for (const [val, mask, minLen] of secrets) {
    const clean = val ? String(val).trim() : '';
    if (clean && clean.length >= minLen) {
      out = out.split(clean).join(mask);
    }
  }
  // Also redact generic Telegram bot token patterns
  out = out.replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, '[REDACTED_TOKEN]');
  return out;
}

function isBlockedPublicUpdateChannel(target, env = null) {
  const norm = String(target || '').trim().toLowerCase();
  if (!norm) return false;
  if (norm === '@pnarewards' || norm === 'pnarewards') return true;
  const updateUrl = String(env?.UPDATE_CHANNEL_URL || 'https://t.me/pnarewards').trim();
  try {
    const seg = new URL(updateUrl).pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase() || '';
    if (seg && (norm === `@${seg}` || norm === seg)) return true;
  } catch {
    // ignore malformed URL
  }
  return false;
}

/**
 * Normalize a channel identifier for Telegram Bot API (`@username` or `-100...`).
 * Explicitly rejects private invite links (`t.me/+...`, `joinchat/...`) and
 * hard-blocks the public update channel (`@pnarewards`) so private audit logs
 * can never leak publicly.
 */
export function parseSecretaryChannelInput(rawInput, env = null) {
  const input = String(rawInput || '').trim();
  if (!input) {
    return {
      ok: false,
      error: 'Secretary Mode is inactive. Configure a dedicated private admin channel ID (-100...) in Admin Panel → 📡 Secretary Mode to enable it.',
    };
  }

  // Numeric channel/supergroup ID
  if (/^-100\d{5,20}$/.test(input) || /^-\d{5,20}$/.test(input)) {
    return { ok: true, target: input, isNumeric: true };
  }

  // Public @username (block @pnarewards / public update channel)
  if (/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(input)) {
    if (isBlockedPublicUpdateChannel(input, env)) {
      return {
        ok: false,
        error:
          'Private Secretary Mode logs cannot be sent to the public @pnarewards update channel. Use a dedicated private admin channel numeric ID (-100...).',
      };
    }
    return { ok: true, target: input, isNumeric: false };
  }

  // Telegram URL handling: accept ONLY non-public-update https://t.me/<username>, REJECT invite links
  if (/^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i.test(input)) {
    try {
      const parsed = new URL(input);
      const seg = parsed.pathname.replace(/^\/+/, '').split('/')[0] || '';
      if (!seg || seg.startsWith('+') || seg.toLowerCase() === 'joinchat' || seg.toLowerCase() === 'c') {
        return {
          ok: false,
          isInviteLink: true,
          error:
            'Private invite links (e.g. t.me/+...) are NOT Telegram chat IDs. Add the bot as an Administrator in the private channel, obtain its numeric chat ID (starts with -100...), and enter that numeric ID.',
        };
      }
      if (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(seg)) {
        const atTarget = `@${seg}`;
        if (isBlockedPublicUpdateChannel(atTarget, env)) {
          return {
            ok: false,
            error:
              'Private Secretary Mode logs cannot be sent to the public @pnarewards update channel. Use a dedicated private admin channel numeric ID (-100...).',
          };
        }
        return { ok: true, target: atTarget, isNumeric: false };
      }
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    error:
      'Invalid channel identifier. Provide a private admin channel numeric ID (e.g. -1001234567890).',
  };
}

async function resolveBotId(env) {
  const cached = await getCachedBotId(env);
  if (cached) return cached;
  const me = await getMe(env);
  if (me.ok && me.result?.id) {
    const id = String(me.result.id);
    await setCachedBotId(env, id);
    return id;
  }
  return '';
}

/**
 * Verify via Telegram Bot API (`getChat` + `getChatMember`) that this bot is
 * actually an administrator with posting rights in the configured PnA X Logs
 * channel before marking Secretary Mode active.
 */
export async function verifySecretaryChannel(env, explicitInput = null) {
  const current = await getSecretaryConfig(env);
  const rawInput =
    explicitInput !== null && explicitInput !== undefined
      ? String(explicitInput).trim()
      : current.channelInput || getConfiguredLogChannelId(env);

  const parsed = parseSecretaryChannelInput(rawInput, env);
  const now = Date.now();

  if (!parsed.ok) {
    const updated = await saveSecretaryConfig(env, {
      enabled: false,
      verifiedAdmin: false,
      lastVerifyAttemptAt: now,
      lastError: parsed.error,
    });
    return { ok: false, config: updated, error: parsed.error };
  }

  const chatRes = await getChat(env, parsed.target);
  if (!chatRes.ok || !chatRes.result?.id) {
    const errMsg = redactSecrets(
      `Cannot access channel ${parsed.target}: ${chatRes.description || 'Chat not found'}`,
      env
    );
    const updated = await saveSecretaryConfig(env, {
      enabled: false,
      verifiedAdmin: false,
      channelInput: parsed.target,
      lastVerifyAttemptAt: now,
      lastError: errMsg,
    });
    return {
      ok: false,
      config: updated,
      error: `${errMsg}. Make sure the bot is added as an Administrator in PnA X Logs.`,
    };
  }

  const chat = chatRes.result;
  const resolvedChatId = String(chat.id);
  const channelTitle = chat.title || current.channelTitle || 'PnA X Logs';
  const channelUsername = chat.username ? `@${chat.username}` : '';

  if (isBlockedPublicUpdateChannel(channelUsername, env)) {
    const errMsg =
      'Refused: private Secretary Mode logs cannot be posted to the public @pnarewards update channel.';
    const updated = await saveSecretaryConfig(env, {
      enabled: false,
      verifiedAdmin: false,
      lastVerifyAttemptAt: now,
      lastError: errMsg,
    });
    return { ok: false, config: updated, error: errMsg };
  }

  const botId = await resolveBotId(env);
  if (!botId) {
    const errMsg = 'Could not resolve bot identity via Telegram getMe.';
    const updated = await saveSecretaryConfig(env, {
      enabled: false,
      verifiedAdmin: false,
      channelInput: parsed.target,
      resolvedChatId,
      channelTitle,
      channelUsername,
      lastVerifyAttemptAt: now,
      lastError: errMsg,
    });
    return { ok: false, config: updated, error: errMsg };
  }

  const memberRes = await getChatMember(env, resolvedChatId, botId);
  if (!memberRes.ok || !memberRes.result) {
    const errMsg = redactSecrets(
      `Cannot verify bot admin status in ${channelTitle}: ${memberRes.description || 'Permission denied'}`,
      env
    );
    const updated = await saveSecretaryConfig(env, {
      enabled: false,
      verifiedAdmin: false,
      channelInput: parsed.target,
      resolvedChatId,
      channelTitle,
      channelUsername,
      lastVerifyAttemptAt: now,
      lastError: errMsg,
    });
    return { ok: false, config: updated, error: errMsg };
  }

  const status = String(memberRes.result.status || '');
  const isChannelAdmin = status === 'administrator' || status === 'creator';
  const canPost =
    chat.type !== 'channel' ||
    status === 'creator' ||
    memberRes.result.can_post_messages !== false;

  if (!isChannelAdmin || !canPost) {
    const errMsg = !isChannelAdmin
      ? `Bot is NOT an administrator in "${channelTitle}" (current status: ${status || 'unknown'}). Promote the bot to Administrator with "Post Messages" permission.`
      : `Bot is an administrator in "${channelTitle}" but lacks "Post Messages" permission.`;
    const updated = await saveSecretaryConfig(env, {
      enabled: false,
      verifiedAdmin: false,
      channelInput: parsed.target,
      resolvedChatId,
      channelTitle,
      channelUsername,
      lastVerifyAttemptAt: now,
      lastError: errMsg,
    });
    return { ok: false, config: updated, error: errMsg };
  }

  const updated = await saveSecretaryConfig(env, {
    enabled: true,
    manuallyDisabled: false,
    channelInput: parsed.target,
    resolvedChatId,
    channelTitle,
    channelUsername,
    verifiedAdmin: true,
    verifiedAt: now,
    lastVerifyAttemptAt: now,
    lastError: '',
  });

  return { ok: true, config: updated, error: '' };
}

/**
 * Low-level resilient Telegram channel sender with bounded retry on 429 / 5xx.
 */
async function deliverToChannelWithRetry(env, chatId, text) {
  let res = await sendMessage(env, chatId, text);
  if (!res.ok && res.errorCode === 429 && res.retryAfter > 0 && res.retryAfter <= 3) {
    await sleep(res.retryAfter * 1000 + 100);
    res = await sendMessage(env, chatId, text);
  } else if (!res.ok && res.errorCode >= 500) {
    await sleep(250);
    res = await sendMessage(env, chatId, text);
  }
  return res;
}

/**
 * Core Secretary Mode log dispatcher.
 * - Sanitizes secrets
 * - Deduplicates via D1 `secretary_logs.dedup_key`
 * - Ensures bot is a verified channel administrator before posting
 * - Records failures safely in D1 and NEVER throws to callers
 */
export async function emitSecretaryLog(env, { eventType, dedupKey, text }) {
  try {
    const safeText = redactSecrets(text, env);
    const dKey = String(dedupKey || `${eventType}:${generateId('EVT')}`);
    const now = Date.now();

    let cfg = await getSecretaryConfig(env);
    const targetHint = cfg.resolvedChatId || cfg.channelInput || getConfiguredLogChannelId(env);

    const claim = await claimSecretaryLogEntry(env, {
      id: generateId('SEC'),
      dedupKey: dKey,
      eventType: String(eventType),
      channelId: targetHint,
      messageText: safeText,
      createdAt: now,
    });

    if (!claim.claimed && claim.existingStatus === 'sent') {
      return { ok: true, deduplicated: true, logId: claim.id };
    }

    if (cfg.manuallyDisabled || !cfg.enabled || !cfg.verifiedAdmin || !cfg.resolvedChatId) {
      await markSecretaryLogSkipped(
        env,
        claim.id,
        cfg.manuallyDisabled ? 'Secretary Mode paused by owner' : 'Secretary Mode is inactive'
      );
      return { ok: false, skipped: true, reason: 'secretary_inactive', logId: claim.id };
    }

    if (
      isBlockedPublicUpdateChannel(cfg.channelInput, env) ||
      isBlockedPublicUpdateChannel(cfg.channelUsername, env) ||
      isBlockedPublicUpdateChannel(cfg.resolvedChatId, env)
    ) {
      await markSecretaryLogSkipped(
        env,
        claim.id,
        'Blocked: private Secretary Mode logs cannot be sent to public @pnarewards channel'
      );
      return { ok: false, skipped: true, reason: 'blocked_public_channel', logId: claim.id };
    }

    const sendRes = await deliverToChannelWithRetry(env, cfg.resolvedChatId, safeText);
    if (sendRes.ok) {
      await markSecretaryLogSent(env, claim.id, {
        channelId: cfg.resolvedChatId,
        telegramMessageId: sendRes.result?.message_id ?? null,
        sentAt: Date.now(),
      });
      return { ok: true, logId: claim.id, messageId: sendRes.result?.message_id ?? null };
    }

    const safeErr = redactSecrets(
      `Telegram ${sendRes.errorCode}: ${sendRes.description || 'sendMessage failed'}`,
      env
    );
    await markSecretaryLogFailed(env, claim.id, {
      channelId: cfg.resolvedChatId,
      errorMessage: safeErr,
    });

    // If bot lost admin rights or chat became unreachable, downgrade active status safely
    if (sendRes.errorCode === 401 || sendRes.errorCode === 403 || sendRes.isBlocked) {
      await saveSecretaryConfig(env, {
        enabled: false,
        verifiedAdmin: false,
        lastError: safeErr,
      });
    }

    return { ok: false, error: safeErr, logId: claim.id };
  } catch (err) {
    console.error('Secretary Mode error (isolated):', redactSecrets(err?.message || String(err), env));
    return { ok: false, error: 'Internal secretary error' };
  }
}

/**
 * Retry previously failed Secretary Mode logs once channel permissions are verified.
 */
export async function retryFailedSecretaryLogs(env, limit = 10) {
  const cfg = await getSecretaryConfig(env);
  if (!cfg.enabled || !cfg.verifiedAdmin || !cfg.resolvedChatId) {
    return { ok: false, retried: 0, sent: 0, failed: 0, error: 'Secretary Mode is not active/verified.' };
  }

  const failedRows = await getFailedSecretaryLogs(env, limit);
  let sent = 0;
  let failed = 0;

  for (const row of failedRows) {
    const res = await deliverToChannelWithRetry(env, cfg.resolvedChatId, row.messageText);
    if (res.ok) {
      await markSecretaryLogSent(env, row.id, {
        channelId: cfg.resolvedChatId,
        telegramMessageId: res.result?.message_id ?? null,
        sentAt: Date.now(),
      });
      sent++;
    } else {
      await markSecretaryLogFailed(env, row.id, {
        channelId: cfg.resolvedChatId,
        errorMessage: redactSecrets(`Telegram ${res.errorCode}: ${res.description}`, env),
      });
      failed++;
    }
  }

  return { ok: true, retried: failedRows.length, sent, failed };
}

// ============================================================================
// STRUCTURED EVENT LOGGERS (A through G) -> PnA X Logs
// ============================================================================

/** A. New User Registration Log */
export async function logNewUserEvent(env, { user, referrerId = '' }) {
  const refLine = referrerId
    ? `🔗 <b>Referral Source:</b> <code>${escapeHtml(referrerId)}</code>`
    : `🔗 <b>Referral Source:</b> Direct / Organic`;

  const text =
    `📡 <b>PnA X Logs — 🆕 NEW USER REGISTERED</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Telegram ID:</b> <code>${escapeHtml(user.id)}</code>\n` +
    `👤 <b>First Name:</b> ${escapeHtml(user.firstName || 'N/A')}\n` +
    `🏷️ <b>Username:</b> ${escapeHtml(formatUsernameTag(user.username))}\n` +
    `${refLine}\n` +
    `🕒 <b>Registered At:</b> ${formatIST(user.joinedAt || Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: 'NEW_USER',
    dedupKey: `new_user:${user.id}`,
    text,
  });
}

/** B. Completed Referral Log */
export async function logReferralCompletedEvent(
  env,
  { referrer, referredUser, amountPaise, creditedAt = Date.now() }
) {
  const text =
    `📡 <b>PnA X Logs — 🤝 REFERRAL COMPLETED</b>\n` +
    `${DIVIDER}\n` +
    `👑 <b>Referrer ID:</b> <code>${escapeHtml(referrer.id)}</code> (${escapeHtml(formatUsernameTag(referrer.username))})\n` +
    `👤 <b>Referred User ID:</b> <code>${escapeHtml(referredUser.id)}</code> (${escapeHtml(formatUsernameTag(referredUser.username))})\n` +
    `💰 <b>Referral Reward:</b> <b>+${formatINR(amountPaise)}</b>\n` +
    `🏦 <b>Referrer Updated Balance:</b> <b>${formatINR(referrer.balancePaise)}</b>\n` +
    `📊 <b>Referrer Total Referrals:</b> <b>${referrer.totalReferrals || 0}</b>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(creditedAt, env)}`;

  return emitSecretaryLog(env, {
    eventType: 'REFERRAL_COMPLETED',
    dedupKey: `referral:${referredUser.id}`,
    text,
  });
}

/** C. Withdrawal Request Log (never publishes unnecessary sensitive payment info) */
export async function logWithdrawalRequestedEvent(env, { withdrawal }) {
  const cat = getCategoryMeta(withdrawal.category);
  const methodLabel = cat ? `${cat.emoji} ${cat.name}` : escapeHtml(withdrawal.category);

  const text =
    `📡 <b>PnA X Logs — 💸 WITHDRAWAL REQUESTED</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Withdrawal ID:</b> <code>${escapeHtml(withdrawal.id)}</code>\n` +
    `👤 <b>User ID:</b> <code>${escapeHtml(withdrawal.userId)}</code> (${escapeHtml(formatUsernameTag(withdrawal.username))})\n` +
    `💵 <b>Requested Amount:</b> <b>${formatINR(withdrawal.amountPaise)}</b>\n` +
    `🎟️ <b>Reward Method:</b> ${methodLabel}\n` +
    `📌 <b>Status:</b> <b>PENDING</b>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(withdrawal.createdAt, env)}`;

  return emitSecretaryLog(env, {
    eventType: 'WITHDRAWAL_REQUESTED',
    dedupKey: `wd_req:${withdrawal.id}`,
    text,
  });
}

/** D. Withdrawal Approval Log (never publishes private voucher redeem code in channel) */
export async function logWithdrawalApprovedEvent(env, { withdrawal, voucher, adminId }) {
  const cat = getCategoryMeta(withdrawal.category);
  const catLabel = cat ? `${cat.emoji} ${cat.shortName}` : escapeHtml(withdrawal.category);

  const text =
    `📡 <b>PnA X Logs — ✅ WITHDRAWAL APPROVED</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Withdrawal ID:</b> <code>${escapeHtml(withdrawal.id)}</code>\n` +
    `👤 <b>User ID:</b> <code>${escapeHtml(withdrawal.userId)}</code>\n` +
    `💵 <b>Amount:</b> <b>${formatINR(withdrawal.amountPaise)}</b> (${catLabel})\n` +
    `🎟️ <b>Voucher Redeemed ID:</b> <code>${escapeHtml(voucher?.id || 'N/A')}</code>\n` +
    `👮 <b>Approved By Admin:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `📌 <b>Status:</b> <b>APPROVED</b>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(withdrawal.processedAt || Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: 'WITHDRAWAL_APPROVED',
    dedupKey: `wd_app:${withdrawal.id}`,
    text,
  });
}

/** E. Withdrawal Rejection & Refund Log */
export async function logWithdrawalRejectedEvent(env, { withdrawal, adminId }) {
  const reasonLine = withdrawal.rejectionReason
    ? `📝 <b>Reason:</b> ${escapeHtml(withdrawal.rejectionReason)}\n`
    : `📝 <b>Reason:</b> Not specified\n`;

  const text =
    `📡 <b>PnA X Logs — ❌ WITHDRAWAL REJECTED</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Withdrawal ID:</b> <code>${escapeHtml(withdrawal.id)}</code>\n` +
    `👤 <b>User ID:</b> <code>${escapeHtml(withdrawal.userId)}</code>\n` +
    `💵 <b>Amount:</b> <b>${formatINR(withdrawal.amountPaise)}</b>\n` +
    `♻️ <b>Refund Amount:</b> <b>+${formatINR(withdrawal.amountPaise)}</b>\n` +
    `${reasonLine}` +
    `👮 <b>Rejected By Admin:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `📌 <b>Status:</b> <b>REJECTED</b>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(withdrawal.processedAt || Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: 'WITHDRAWAL_REJECTED',
    dedupKey: `wd_rej:${withdrawal.id}`,
    text,
  });
}

/** F. Manual Balance Adjustment Log */
export async function logManualBalanceEvent(env, { adjustment, targetUser = null }) {
  const isAdd = adjustment.action === 'ADD';
  const sign = isAdd ? '+' : '-';
  const userTag = targetUser ? ` (${escapeHtml(formatUsernameTag(targetUser.username))})` : '';

  const text =
    `📡 <b>PnA X Logs — 💰 MANUAL BALANCE ${isAdd ? 'ADDED' : 'DEDUCTED'}</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Operation ID:</b> <code>${escapeHtml(adjustment.id)}</code>\n` +
    `👮 <b>Admin ID:</b> <code>${escapeHtml(adjustment.adminId)}</code>\n` +
    `👤 <b>Target User ID:</b> <code>${escapeHtml(adjustment.targetUserId)}</code>${userTag}\n` +
    `⚡ <b>Action:</b> <b>${escapeHtml(adjustment.action)}</b>\n` +
    `💵 <b>Amount:</b> <b>${sign}${formatINR(adjustment.amountPaise)}</b>\n` +
    `🏦 <b>Previous Balance:</b> ${formatINR(adjustment.balanceBeforePaise)}\n` +
    `🏦 <b>New Balance:</b> <b>${formatINR(adjustment.balanceAfterPaise)}</b>\n` +
    `📝 <b>Reason:</b> ${escapeHtml(adjustment.reason || 'Not specified')}\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(adjustment.createdAt, env)}`;

  return emitSecretaryLog(env, {
    eventType: 'MANUAL_BALANCE_ADJUSTMENT',
    dedupKey: `bal_adj:${adjustment.id}`,
    text,
  });
}

/** G. Other Important Events */
export async function logUserStatusChangeEvent(env, { adminId, targetUser, newStatus }) {
  const isBanned = newStatus === 'banned';
  const text =
    `📡 <b>PnA X Logs — ${isBanned ? '⛔ USER BANNED' : '✅ USER UNBANNED'}</b>\n` +
    `${DIVIDER}\n` +
    `👤 <b>Target User:</b> ${escapeHtml(formatUserName(targetUser))} [<code>${escapeHtml(targetUser.id)}</code>]\n` +
    `📌 <b>New Status:</b> <b>${escapeHtml(newStatus.toUpperCase())}</b>\n` +
    `👮 <b>Admin ID:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: isBanned ? 'USER_BANNED' : 'USER_UNBANNED',
    dedupKey: `user_status:${targetUser.id}:${newStatus}:${Math.floor(Date.now() / 5000)}`,
    text,
  });
}

export async function logAdminRoleChangeEvent(env, { ownerId, targetAdminId, action }) {
  const isAdd = action === 'ADDED';
  const text =
    `📡 <b>PnA X Logs — ${isAdd ? '👑 ADMIN ADDED' : '🗑️ ADMIN REMOVED'}</b>\n` +
    `${DIVIDER}\n` +
    `🛡️ <b>Target Admin ID:</b> <code>${escapeHtml(targetAdminId)}</code>\n` +
    `👑 <b>Owner ID:</b> <code>${escapeHtml(ownerId)}</code>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: isAdd ? 'ADMIN_ADDED' : 'ADMIN_REMOVED',
    dedupKey: `admin_${action.toLowerCase()}:${targetAdminId}:${Math.floor(Date.now() / 5000)}`,
    text,
  });
}

export async function logVoucherBatchAddedEvent(
  env,
  { adminId, category, addedCount, duplicateCount, valuePaise, currentStock }
) {
  const cat = getCategoryMeta(category);
  const catLabel = cat ? `${cat.emoji} ${cat.name}` : escapeHtml(category);
  const text =
    `📡 <b>PnA X Logs — 🎟️ VOUCHERS CREATED</b>\n` +
    `${DIVIDER}\n` +
    `📦 <b>Category:</b> ${catLabel}\n` +
    `✅ <b>Added:</b> <b>${addedCount}</b> (${formatINR(valuePaise)} each)\n` +
    `♻️ <b>Duplicates Rejected:</b> ${duplicateCount}\n` +
    `📊 <b>Updated Stock:</b> <b>${currentStock}</b>\n` +
    `👮 <b>Admin ID:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: 'VOUCHER_CREATED',
    dedupKey: `vch_add:${adminId}:${category}:${addedCount}:${Date.now()}`,
    text,
  });
}

export async function logVoucherDisabledEvent(env, { adminId, voucher, remainingStock }) {
  const text =
    `📡 <b>PnA X Logs — 🚫 VOUCHER DISABLED</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Voucher ID:</b> <code>${escapeHtml(voucher.id)}</code>\n` +
    `📦 <b>Category:</b> ${escapeHtml(voucher.category)}\n` +
    `📊 <b>Remaining Stock:</b> <b>${remainingStock}</b>\n` +
    `👮 <b>Admin ID:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: 'VOUCHER_DISABLED',
    dedupKey: `vch_dis:${voucher.id}`,
    text,
  });
}

export async function logDailyBonusClaimedEvent(env, { user, claim }) {
  const text =
    `📡 <b>PnA X Logs — 🎁 DAILY BONUS CLAIMED</b>\n` +
    `${DIVIDER}\n` +
    `👤 <b>User ID:</b> <code>${escapeHtml(user.id)}</code> (${escapeHtml(formatUsernameTag(user.username))})\n` +
    `💰 <b>Bonus Amount:</b> <b>+${formatINR(claim.amountPaise)}</b>\n` +
    `🏦 <b>Updated Balance:</b> <b>${formatINR(user.balancePaise)}</b>\n` +
    `📅 <b>IST Date:</b> ${escapeHtml(claim.istDate)}\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(claim.claimedAt, env)}`;

  return emitSecretaryLog(env, {
    eventType: 'DAILY_BONUS_CLAIMED',
    dedupKey: `daily_bonus:${user.id}:${claim.istDate}`,
    text,
  });
}

export async function logTaskEvent(
  env,
  { eventSubType, taskId, taskTitle = '', userId = '', adminId = '', status = '', rewardPaise = 0, note = '', dedupId = '' }
) {
  const lines = [
    `📡 <b>PnA X Logs — 📌 TASK ${escapeHtml(String(eventSubType).toUpperCase())}</b>`,
    DIVIDER,
    `🆔 <b>Task ID:</b> <code>${escapeHtml(taskId)}</code>`,
  ];
  if (taskTitle) lines.push(`📝 <b>Title:</b> ${escapeHtml(taskTitle)}`);
  if (userId) lines.push(`👤 <b>User ID:</b> <code>${escapeHtml(userId)}</code>`);
  if (adminId) lines.push(`👮 <b>Admin ID:</b> <code>${escapeHtml(adminId)}</code>`);
  if (rewardPaise > 0) lines.push(`💰 <b>Reward:</b> <b>${formatINR(rewardPaise)}</b>`);
  if (status) lines.push(`📌 <b>Status:</b> <b>${escapeHtml(status.toUpperCase())}</b>`);
  if (note) lines.push(`💬 <b>Note:</b> ${escapeHtml(note)}`);
  lines.push(`🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`);

  return emitSecretaryLog(env, {
    eventType: `TASK_${String(eventSubType).toUpperCase()}`,
    dedupKey: dedupId || `task:${eventSubType}:${taskId}:${userId || adminId}:${Date.now()}`,
    text: lines.join('\n'),
  });
}

export async function logForceChannelChangeEvent(env, { adminId, action, channel }) {
  const isAdd = action === 'ADDED';
  const mode = channel.isRequestToJoin ? 'Request-to-Join' : 'Normal Join';
  const text =
    `📡 <b>PnA X Logs — 📢 FORCE-JOIN CHANNEL ${isAdd ? 'SAVED' : 'REMOVED'}</b>\n` +
    `${DIVIDER}\n` +
    `📢 <b>Channel:</b> ${escapeHtml(channel.title || channel.chatId)}\n` +
    `🆔 <b>Chat ID:</b> <code>${escapeHtml(channel.chatId)}</code>\n` +
    `🔐 <b>Mode:</b> ${mode}\n` +
    `👮 <b>Admin ID:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: isAdd ? 'FORCE_CHANNEL_ADDED' : 'FORCE_CHANNEL_REMOVED',
    dedupKey: `fj_${action.toLowerCase()}:${channel.id}:${Math.floor(Date.now() / 5000)}`,
    text,
  });
}

export async function logBroadcastEvent(env, { phase, record }) {
  const isStart = phase === 'STARTED';
  const body = isStart
    ? `🆔 <b>Broadcast ID:</b> <code>${escapeHtml(record.id)}</code>\n` +
      `👮 <b>Admin ID:</b> <code>${escapeHtml(record.adminId)}</code>\n` +
      `📦 <b>Media Type:</b> ${escapeHtml(String(record.mediaType || 'text').toUpperCase())}\n` +
      `👥 <b>Target Recipients:</b> <b>${record.totalRecipients || 0}</b>\n` +
      `🕒 <b>Started At:</b> ${formatIST(Date.now(), env)}`
    : `🆔 <b>Broadcast ID:</b> <code>${escapeHtml(record.id)}</code>\n` +
      `👮 <b>Admin ID:</b> <code>${escapeHtml(record.adminId)}</code>\n` +
      `👥 <b>Total:</b> ${record.totalRecipients || 0} | ✅ <b>Sent:</b> ${record.sentCount || 0} | ❌ <b>Failed:</b> ${record.failedCount || 0}\n` +
      `🚫 <b>Newly Blocked:</b> ${record.newlyBlockedCount || 0}\n` +
      `🕒 <b>Completed At:</b> ${formatIST(record.completedAt || Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: isStart ? 'BROADCAST_STARTED' : 'BROADCAST_COMPLETED',
    dedupKey: `bc_${phase.toLowerCase()}:${record.id}`,
    text: `📡 <b>PnA X Logs — 📣 BROADCAST ${isStart ? 'STARTED' : 'COMPLETED'}</b>\n${DIVIDER}\n${body}`,
  });
}

export async function logBotErrorEvent(env, { category = 'BOT_ERROR', summary, context = '', dedupId = '' }) {
  const safeSummary = redactSecrets(summary || 'Unexpected error', env).slice(0, 350);
  const safeContext = redactSecrets(context || '', env).slice(0, 350);
  const text =
    `📡 <b>PnA X Logs — 🚨 ${escapeHtml(category)}</b>\n` +
    `${DIVIDER}\n` +
    `⚠️ <b>Summary:</b> ${escapeHtml(safeSummary)}\n` +
    `${safeContext ? `🔎 <b>Context:</b> <code>${escapeHtml(safeContext)}</code>\n` : ''}` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}\n` +
    `🤖 <b>Service:</b> ${BOT_BRAND}`;

  return emitSecretaryLog(env, {
    eventType: category,
    dedupKey: dedupId || `err:${category}:${Date.now()}`,
    text,
  });
}

export async function logSuspiciousDeviceEvent(
  env,
  {
    user,
    verificationId,
    reviewId = '',
    verdict,
    riskScore,
    reasons = [],
    matchedUserIds = [],
    referrerId = '',
    strictFpPrefix = '',
  }
) {
  const reasonCodes = (reasons || [])
    .slice(0, 4)
    .map((r) => escapeHtml(r.code || String(r)))
    .join(', ');
  const matchedLine = matchedUserIds.length
    ? `👥 <b>Matched Accounts:</b> ${matchedUserIds.slice(0, 6).map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}\n`
    : '';
  const refLine = referrerId
    ? `🔗 <b>Pending Referrer:</b> <code>${escapeHtml(referrerId)}</code> (held for review)\n`
    : '';
  const reviewLine = reviewId ? `🆔 <b>Review ID:</b> <code>${escapeHtml(reviewId)}</code>\n` : '';

  const text =
    `📡 <b>PnA X Logs — 🛡️ SUSPICIOUS DEVICE FLAGGED</b>\n` +
    `${DIVIDER}\n` +
    `👤 <b>User:</b> ${escapeHtml(formatUserName(user))} [<code>${escapeHtml(user?.id || '')}</code>]\n` +
    `📌 <b>Verdict:</b> <b>${escapeHtml(String(verdict || '').toUpperCase())}</b> (Risk: <b>${riskScore}/100</b>)\n` +
    `🧬 <b>Device Hash:</b> <code>${escapeHtml(strictFpPrefix)}…</code>\n` +
    `${matchedLine}` +
    `${refLine}` +
    `${reviewLine}` +
    `⚠️ <b>Signals:</b> ${reasonCodes || 'N/A'}\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: 'SUSPICIOUS_DEVICE_FLAGGED',
    dedupKey: `dev_flag:${verificationId}`,
    text,
  });
}

export async function logReferralReviewDecisionEvent(env, { review, adminId, decision, creditSummary }) {
  const isApproved = String(decision).toUpperCase() === 'APPROVED';
  const text =
    `📡 <b>PnA X Logs — ${isApproved ? '✅ REFERRAL REVIEW APPROVED' : '❌ REFERRAL REVIEW REJECTED'}</b>\n` +
    `${DIVIDER}\n` +
    `🆔 <b>Review ID:</b> <code>${escapeHtml(review.id)}</code>\n` +
    `👤 <b>Referred User:</b> <code>${escapeHtml(review.referredUserId)}</code>\n` +
    `👑 <b>Referrer:</b> <code>${escapeHtml(review.referrerId)}</code>\n` +
    `⚠️ <b>Risk Score:</b> ${review.riskScore}/100\n` +
    `👮 <b>Admin ID:</b> <code>${escapeHtml(adminId)}</code>\n` +
    `📌 <b>Outcome:</b> ${creditSummary}\n` +
    `🕒 <b>Date & Time:</b> ${formatIST(Date.now(), env)}`;

  return emitSecretaryLog(env, {
    eventType: isApproved ? 'REFERRAL_REVIEW_APPROVED' : 'REFERRAL_REVIEW_REJECTED',
    dedupKey: `ref_rev:${review.id}:${String(decision).toLowerCase()}`,
    text,
  });
}

