// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Cloudflare D1 SQLite Storage Layer (env.DB ONLY)
// ============================================================================
// Single source of truth on Cloudflare D1 (`binding = "DB"`).
// All SQL statements use parameterized prepared statements and atomic batches.
// Monetary values are strictly INTEGER paise; Telegram IDs are TEXT.
// ============================================================================

import {
  ACTIVE_WINDOW_MS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_SETTINGS,
  MAX_MANUAL_BALANCE_ADJUSTMENT_PAISE,
  OWNER_PERMISSIONS,
  VOUCHER_CATEGORY_LIST,
  generateId,
  getConfiguredLogChannelId,
  getOwnerId,
  normalizeVoucherCode,
} from './config.js';

export function assertDB(env) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') {
    throw new Error(
      'Cloudflare D1 database binding "DB" is not configured. Ensure [[d1_databases]] binding = "DB" is set in wrangler.toml.'
    );
  }
  return env.DB;
}

function safeJsonParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function toInt(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function toNonNegInt(val) {
  return Math.max(0, toInt(val, 0));
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: String(row.telegram_id),
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    username: row.username || '',
    joinedAt: toInt(row.joined_at),
    lastActiveAt: toInt(row.last_active_at),
    status: row.status || 'active',
    balancePaise: toNonNegInt(row.balance_paise),
    totalEarnedPaise: toNonNegInt(row.total_earned_paise),
    referralEarningsPaise: toNonNegInt(row.referral_earnings_paise),
    dailyBonusEarningsPaise: toNonNegInt(row.daily_bonus_earnings_paise),
    totalWithdrawnPaise: toNonNegInt(row.total_withdrawn_paise),
    pendingWithdrawalPaise: toNonNegInt(row.pending_withdrawal_paise),
    totalReferrals: toNonNegInt(row.total_referrals),
    referredBy: row.referred_by ? String(row.referred_by) : null,
    pendingReferrerId: row.pending_referrer_id ? String(row.pending_referrer_id) : null,
    referralCredited: Boolean(row.referral_credited),
    lastDailyClaimAt:
      row.last_daily_claim_at !== null && row.last_daily_claim_at !== undefined
        ? toInt(row.last_daily_claim_at)
        : null,
    dailyBonusCount: toNonNegInt(row.daily_bonus_count),
    lastApprovedWithdrawalAt:
      row.last_approved_withdrawal_at !== null && row.last_approved_withdrawal_at !== undefined
        ? toInt(row.last_approved_withdrawal_at)
        : null,
    activePendingWithdrawalId: row.active_pending_withdrawal_id || null,
    forceJoinVerified: Boolean(row.force_join_verified),
    withdrawalCount: toNonNegInt(row.withdrawal_count),
    lastVerifiedGeneration: toNonNegInt(row.last_verified_generation),
    customMinWithdrawalPaise:
      row.custom_min_withdrawal_paise !== null && row.custom_min_withdrawal_paise !== undefined
        ? toInt(row.custom_min_withdrawal_paise)
        : null,
    deviceVerificationStatus: row.device_verification_status
      ? String(row.device_verification_status)
      : 'grandfathered',
    deviceVerifiedAt:
      row.device_verified_at !== null && row.device_verified_at !== undefined
        ? toInt(row.device_verified_at)
        : null,
    deviceRiskScore: toNonNegInt(row.device_risk_score),
    deviceFingerprintHash: row.device_fingerprint_hash
      ? String(row.device_fingerprint_hash)
      : null,
    deviceVerificationRequired:
      row.device_verification_required !== undefined &&
      row.device_verification_required !== null
        ? Boolean(row.device_verification_required)
        : false,
  };
}

function mapVoucherRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code),
    normalizedCode: String(row.normalized_code),
    category: String(row.category),
    valuePaise: toNonNegInt(row.value_paise),
    status: String(row.status),
    addedAt: toInt(row.added_at),
    addedBy: String(row.added_by),
    assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
    withdrawalRequestId: row.withdrawal_request_id || null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    deliveredAt:
      row.delivered_at !== null && row.delivered_at !== undefined ? toInt(row.delivered_at) : null,
    disabledAt:
      row.disabled_at !== null && row.disabled_at !== undefined ? toInt(row.disabled_at) : null,
    disabledBy: row.disabled_by ? String(row.disabled_by) : null,
  };
}

function mapVoucherHistoryRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    voucherId: String(row.voucher_id),
    code: String(row.code),
    category: String(row.category),
    valuePaise: toNonNegInt(row.value_paise),
    userId: String(row.user_id),
    username: row.username || '',
    userName: row.user_name || '',
    withdrawalRequestId: String(row.withdrawal_request_id),
    approvedBy: String(row.approved_by),
    deliveredAt: toInt(row.delivered_at),
  };
}

function mapWithdrawalRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    username: row.username || '',
    userName: row.user_name || '',
    amountPaise: toNonNegInt(row.amount_paise),
    category: String(row.category),
    status: String(row.status),
    createdAt: toInt(row.created_at),
    processedAt:
      row.processed_at !== null && row.processed_at !== undefined ? toInt(row.processed_at) : null,
    processedBy: row.processed_by ? String(row.processed_by) : null,
    rejectionReason: row.rejection_reason || '',
    voucherId: row.voucher_id || null,
    voucherCode: row.voucher_code || null,
    userBalanceSnapshotPaise: toNonNegInt(row.user_balance_snapshot_paise),
  };
}

function mapForceChannelRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    username: row.username || '',
    title: row.title || String(row.chat_id),
    inviteLink: row.invite_link || '',
    isPrivate: Boolean(row.is_private),
    isRequestToJoin: Boolean(row.is_request_to_join),
    addedBy: row.added_by || '',
    addedAt: toInt(row.added_at),
  };
}

function mapBroadcastRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    adminId: String(row.admin_id),
    sourceChatId: String(row.source_chat_id),
    sourceMessageId: toInt(row.source_message_id),
    mediaType: String(row.media_type),
    previewSummary: row.preview_summary || '',
    totalRecipients: toNonNegInt(row.total_recipients),
    skippedBlocked: toNonNegInt(row.skipped_blocked),
    sentCount: toNonNegInt(row.sent_count),
    failedCount: toNonNegInt(row.failed_count),
    newlyBlockedCount: toNonNegInt(row.newly_blocked_count),
    status: String(row.status),
    createdAt: toInt(row.created_at),
    completedAt:
      row.completed_at !== null && row.completed_at !== undefined ? toInt(row.completed_at) : null,
  };
}

function mapActivityLogRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    adminId: String(row.admin_id),
    action: String(row.action),
    details: row.details || '',
    timestamp: toInt(row.created_at),
  };
}

function mapLedgerRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    entryType: String(row.entry_type),
    direction: String(row.direction),
    amountPaise: toNonNegInt(row.amount_paise),
    balanceBeforePaise: toNonNegInt(row.balance_before_paise),
    balanceAfterPaise: toNonNegInt(row.balance_after_paise),
    referenceType: String(row.reference_type),
    referenceId: String(row.reference_id),
    description: row.description || '',
    createdAt: toInt(row.created_at),
  };
}

// ----------------------------------------------------------------------------
// D1 Connectivity Health Check
// ----------------------------------------------------------------------------

export async function checkDatabaseConnection(env) {
  const db = assertDB(env);
  const row = await db.prepare('SELECT 1 AS ok').first();
  return Boolean(row && Number(row.ok) === 1);
}

// ----------------------------------------------------------------------------
// Telegram Update Deduplication (`processed_updates`)
// ----------------------------------------------------------------------------

/**
 * Atomically claim a Telegram update_id using PRIMARY KEY uniqueness.
 * Returns true if newly claimed, false if already processed.
 */
export async function claimUpdateId(env, updateId) {
  if (updateId === undefined || updateId === null) return true;
  const db = assertDB(env);
  const id = String(updateId);
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO processed_updates (update_id, processed_at, expires_at)
       VALUES (?, ?, ?)`
    )
    .bind(id, now, expiresAt)
    .run();

  const changes = Number(res?.meta?.changes ?? 0);
  if (changes === 0) return false;

  // Opportunistic lightweight cleanup of expired update IDs (~1 in 25 updates)
  if (Number(updateId) % 25 === 0) {
    await db
      .prepare('DELETE FROM processed_updates WHERE expires_at < ?')
      .bind(now)
      .run()
      .catch(() => {});
  }

  return true;
}

// ----------------------------------------------------------------------------
// Cached Bot Metadata (Stored in `settings` table)
// ----------------------------------------------------------------------------

export async function getCachedBotUsername(env) {
  if (env?.BOT_USERNAME && String(env.BOT_USERNAME).trim()) {
    return String(env.BOT_USERNAME).trim().replace(/^@/, '');
  }
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT value_json, updated_at FROM settings WHERE key = ?')
    .bind('bot_username')
    .first();
  if (!row) return '';
  if (Date.now() - toInt(row.updated_at) > 24 * 60 * 60 * 1000) return '';
  const val = safeJsonParse(row.value_json, '');
  return val ? String(val).replace(/^@/, '') : '';
}

export async function setCachedBotUsername(env, username) {
  if (!username) return;
  const db = assertDB(env);
  const clean = String(username).replace(/^@/, '');
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .bind('bot_username', JSON.stringify(clean), Date.now())
    .run();
}

export async function getCachedBotId(env) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT value_json, updated_at FROM settings WHERE key = ?')
    .bind('bot_id')
    .first();
  if (!row) return '';
  if (Date.now() - toInt(row.updated_at) > 24 * 60 * 60 * 1000) return '';
  const val = safeJsonParse(row.value_json, '');
  return val ? String(val).trim() : '';
}

export async function setCachedBotId(env, botId) {
  if (!botId) return;
  const db = assertDB(env);
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .bind('bot_id', JSON.stringify(String(botId).trim()), Date.now())
    .run();
}

// ----------------------------------------------------------------------------
// Global Settings (`settings` table)
// ----------------------------------------------------------------------------

export async function getSettings(env) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .bind('global')
    .first();

  const stored = row ? safeJsonParse(row.value_json, null) : null;
  const envSupport = env?.SUPPORT_USERNAME || DEFAULT_SETTINGS.supportUsername;
  const envChannel = env?.UPDATE_CHANNEL_URL || DEFAULT_SETTINGS.updateChannelUrl;

  if (!stored) {
    return {
      ...DEFAULT_SETTINGS,
      supportUsername: envSupport,
      updateChannelUrl: envChannel,
      lowStockThresholds: { ...DEFAULT_SETTINGS.lowStockThresholds },
      lowStockAlertSent: { ...DEFAULT_SETTINGS.lowStockAlertSent },
    };
  }

  return {
    ...DEFAULT_SETTINGS,
    supportUsername: envSupport,
    updateChannelUrl: envChannel,
    ...stored,
    lowStockThresholds: {
      ...DEFAULT_SETTINGS.lowStockThresholds,
      ...(stored.lowStockThresholds || {}),
    },
    lowStockAlertSent: {
      ...DEFAULT_SETTINGS.lowStockAlertSent,
      ...(stored.lowStockAlertSent || {}),
    },
  };
}

export async function saveSettings(env, settings) {
  const db = assertDB(env);
  const now = Date.now();
  const payload = {
    ...settings,
    updatedAt: now,
  };
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .bind('global', JSON.stringify(payload), now)
    .run();
  return payload;
}

export async function updateSettings(env, patch) {
  const current = await getSettings(env);
  const merged = {
    ...current,
    ...patch,
    lowStockThresholds: {
      ...current.lowStockThresholds,
      ...(patch.lowStockThresholds || {}),
    },
    lowStockAlertSent: {
      ...current.lowStockAlertSent,
      ...(patch.lowStockAlertSent || {}),
    },
  };
  return saveSettings(env, merged);
}

// ----------------------------------------------------------------------------
// Users Collection (`users` table)
// ----------------------------------------------------------------------------

export async function getUser(env, telegramId) {
  if (!telegramId) return null;
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .bind(String(telegramId))
    .first();
  return mapUserRow(row);
}

export async function saveUser(env, user) {
  if (!user?.id) throw new Error('Cannot save user without id');
  const db = assertDB(env);
  const now = Date.now();
  const normalized = {
    id: String(user.id),
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    username: user.username || '',
    joinedAt: toInt(user.joinedAt, now),
    lastActiveAt: toInt(user.lastActiveAt, now),
    status: user.status || 'active',
    balancePaise: toNonNegInt(user.balancePaise),
    totalEarnedPaise: toNonNegInt(user.totalEarnedPaise),
    referralEarningsPaise: toNonNegInt(user.referralEarningsPaise),
    dailyBonusEarningsPaise: toNonNegInt(user.dailyBonusEarningsPaise),
    totalWithdrawnPaise: toNonNegInt(user.totalWithdrawnPaise),
    pendingWithdrawalPaise: toNonNegInt(user.pendingWithdrawalPaise),
    totalReferrals: toNonNegInt(user.totalReferrals),
    referredBy: user.referredBy ? String(user.referredBy) : null,
    pendingReferrerId: user.pendingReferrerId ? String(user.pendingReferrerId) : null,
    referralCredited: Boolean(user.referralCredited),
    lastDailyClaimAt:
      user.lastDailyClaimAt !== null && user.lastDailyClaimAt !== undefined
        ? toInt(user.lastDailyClaimAt)
        : null,
    dailyBonusCount: toNonNegInt(user.dailyBonusCount),
    lastApprovedWithdrawalAt:
      user.lastApprovedWithdrawalAt !== null && user.lastApprovedWithdrawalAt !== undefined
        ? toInt(user.lastApprovedWithdrawalAt)
        : null,
    activePendingWithdrawalId: user.activePendingWithdrawalId || null,
    forceJoinVerified: Boolean(user.forceJoinVerified),
    withdrawalCount: toNonNegInt(user.withdrawalCount),
  };

  await db
    .prepare(
      `INSERT INTO users (
        telegram_id, first_name, last_name, username, joined_at, last_active_at, status,
        balance_paise, total_earned_paise, referral_earnings_paise, daily_bonus_earnings_paise,
        total_withdrawn_paise, pending_withdrawal_paise, total_referrals,
        referred_by, pending_referrer_id, referral_credited,
        last_daily_claim_at, daily_bonus_count, last_approved_withdrawal_at,
        active_pending_withdrawal_id, force_join_verified, withdrawal_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        username = excluded.username,
        last_active_at = excluded.last_active_at,
        status = excluded.status,
        balance_paise = excluded.balance_paise,
        total_earned_paise = excluded.total_earned_paise,
        referral_earnings_paise = excluded.referral_earnings_paise,
        daily_bonus_earnings_paise = excluded.daily_bonus_earnings_paise,
        total_withdrawn_paise = excluded.total_withdrawn_paise,
        pending_withdrawal_paise = excluded.pending_withdrawal_paise,
        total_referrals = excluded.total_referrals,
        referred_by = excluded.referred_by,
        pending_referrer_id = excluded.pending_referrer_id,
        referral_credited = excluded.referral_credited,
        last_daily_claim_at = excluded.last_daily_claim_at,
        daily_bonus_count = excluded.daily_bonus_count,
        last_approved_withdrawal_at = excluded.last_approved_withdrawal_at,
        active_pending_withdrawal_id = excluded.active_pending_withdrawal_id,
        force_join_verified = excluded.force_join_verified,
        withdrawal_count = excluded.withdrawal_count`
    )
    .bind(
      normalized.id,
      normalized.firstName,
      normalized.lastName,
      normalized.username,
      normalized.joinedAt,
      normalized.lastActiveAt,
      normalized.status,
      normalized.balancePaise,
      normalized.totalEarnedPaise,
      normalized.referralEarningsPaise,
      normalized.dailyBonusEarningsPaise,
      normalized.totalWithdrawnPaise,
      normalized.pendingWithdrawalPaise,
      normalized.totalReferrals,
      normalized.referredBy,
      normalized.pendingReferrerId,
      normalized.referralCredited ? 1 : 0,
      normalized.lastDailyClaimAt,
      normalized.dailyBonusCount,
      normalized.lastApprovedWithdrawalAt,
      normalized.activePendingWithdrawalId,
      normalized.forceJoinVerified ? 1 : 0,
      normalized.withdrawalCount
    )
    .run();

  return normalized;
}

export async function getUserIds(env) {
  const db = assertDB(env);
  const res = await db
    .prepare('SELECT telegram_id FROM users ORDER BY joined_at DESC')
    .all();
  return (res.results || []).map((r) => String(r.telegram_id));
}

export async function getBroadcastAudienceCounts(env) {
  const db = assertDB(env);
  const row = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN status <> 'blocked_bot' THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN status = 'blocked_bot' THEN 1 ELSE 0 END) AS blocked
       FROM users`
    )
    .first();
  return {
    eligibleCount: toNonNegInt(row?.eligible),
    skippedBlocked: toNonNegInt(row?.blocked),
  };
}

export async function getBroadcastEligibleUserIds(env) {
  const db = assertDB(env);
  const res = await db
    .prepare("SELECT telegram_id FROM users WHERE status <> 'blocked_bot' ORDER BY joined_at DESC")
    .all();
  return (res.results || []).map((r) => String(r.telegram_id));
}

export async function createOrUpdateUserFromTelegram(env, tgUser) {
  const db = assertDB(env);
  const id = String(tgUser.id);
  const now = Date.now();
  const firstName = tgUser.first_name || '';
  const lastName = tgUser.last_name || '';
  const username = tgUser.username || '';

  // Atomic insert-if-new so concurrent /start requests cannot overwrite an existing user
  const insertRes = await db
    .prepare(
      `INSERT OR IGNORE INTO users (
        telegram_id, first_name, last_name, username, joined_at, last_active_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
    .bind(id, firstName, lastName, username, now, now)
    .run();

  const isNew = Number(insertRes?.meta?.changes ?? 0) > 0;

  if (!isNew) {
    await db
      .prepare(
        `UPDATE users
         SET first_name = CASE WHEN ? <> '' THEN ? ELSE first_name END,
             last_name = ?,
             username = ?,
             last_active_at = ?,
             status = CASE WHEN status = 'blocked_bot' THEN 'active' ELSE status END
         WHERE telegram_id = ?`
      )
      .bind(firstName, firstName, lastName, username, now, id)
      .run();
  }

  const user = await getUser(env, id);
  return { user, isNew };
}

export async function markUserBlocked(env, telegramId) {
  const db = assertDB(env);
  await db
    .prepare(
      `UPDATE users
       SET status = 'blocked_bot'
       WHERE telegram_id = ? AND status <> 'banned'`
    )
    .bind(String(telegramId))
    .run();
}

export async function updateUserForceJoinVerified(env, telegramId, verified) {
  const db = assertDB(env);
  await db
    .prepare('UPDATE users SET force_join_verified = ? WHERE telegram_id = ?')
    .bind(verified ? 1 : 0, String(telegramId))
    .run();
}

export async function updateUserStatus(env, telegramId, status) {
  const db = assertDB(env);
  await db
    .prepare('UPDATE users SET status = ? WHERE telegram_id = ?')
    .bind(String(status), String(telegramId))
    .run();
}

export async function setUserPendingReferrer(env, telegramId, referrerId) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `UPDATE users
       SET pending_referrer_id = ?
       WHERE telegram_id = ?
         AND referred_by IS NULL
         AND referral_credited = 0
         AND pending_referrer_id IS NULL`
    )
    .bind(String(referrerId), String(telegramId))
    .run();
  return Number(res?.meta?.changes ?? 0) > 0;
}

export async function clearUserPendingReferrer(env, telegramId) {
  const db = assertDB(env);
  await db
    .prepare('UPDATE users SET pending_referrer_id = NULL WHERE telegram_id = ?')
    .bind(String(telegramId))
    .run();
}

export async function getUsersPage(env, page = 1, pageSize = 10) {
  const db = assertDB(env);
  const countRow = await db.prepare('SELECT COUNT(*) AS total FROM users').first();
  const total = toNonNegInt(countRow?.total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (safePage - 1) * pageSize;

  const res = await db
    .prepare('SELECT * FROM users ORDER BY joined_at DESC LIMIT ? OFFSET ?')
    .bind(pageSize, offset)
    .all();

  return {
    users: (res.results || []).map(mapUserRow),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export async function countActiveUsers(env) {
  const db = assertDB(env);
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS total_users,
        SUM(CASE WHEN status = 'active' AND last_active_at >= ? THEN 1 ELSE 0 END) AS active_users
       FROM users`
    )
    .bind(cutoff)
    .first();

  return {
    totalUsers: toNonNegInt(row?.total_users),
    activeUsers: toNonNegInt(row?.active_users),
  };
}

// ----------------------------------------------------------------------------
// Conversation States (`user_states` table)
// ----------------------------------------------------------------------------

export async function getUserState(env, telegramId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT payload_json, expires_at FROM user_states WHERE user_id = ?')
    .bind(String(telegramId))
    .first();
  if (!row) return null;
  if (toInt(row.expires_at) < Date.now()) {
    await clearUserState(env, telegramId);
    return null;
  }
  return safeJsonParse(row.payload_json, null);
}

export async function setUserState(env, telegramId, state) {
  const db = assertDB(env);
  const now = Date.now();
  const expiresAt = now + 30 * 60 * 1000; // 30 minutes
  const payload = { ...state, updatedAt: now };
  await db
    .prepare(
      `INSERT INTO user_states (user_id, state_type, payload_json, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         state_type = excluded.state_type,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`
    )
    .bind(String(telegramId), String(state?.type || 'unknown'), JSON.stringify(payload), now, expiresAt)
    .run();
}

export async function clearUserState(env, telegramId) {
  const db = assertDB(env);
  await db
    .prepare('DELETE FROM user_states WHERE user_id = ?')
    .bind(String(telegramId))
    .run();
}

// ----------------------------------------------------------------------------
// Financial Ledger Queries (`ledger` table)
// ----------------------------------------------------------------------------

export async function getUserLedger(env, telegramId, limit = 50) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM ledger
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(String(telegramId), Math.max(1, toInt(limit, 50)))
    .all();
  return (res.results || []).map(mapLedgerRow);
}

// ----------------------------------------------------------------------------
// Referrals & Atomic Referral Credit Transaction (`referral_claims`, `referrals`, `ledger`)
// ----------------------------------------------------------------------------

export async function getReferralClaim(env, referredUserId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM referral_claims WHERE referred_user_id = ?')
    .bind(String(referredUserId))
    .first();
  if (!row) return null;
  return {
    referredUserId: String(row.referred_user_id),
    referrerId: String(row.referrer_id),
    amountPaise: toNonNegInt(row.amount_paise),
    creditedAt: toInt(row.credited_at),
  };
}

export async function getUserReferrals(env, referrerId, limit = 50) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM referrals
       WHERE referrer_id = ?
       ORDER BY credited_at DESC
       LIMIT ?`
    )
    .bind(String(referrerId), Math.max(1, toInt(limit, 50)))
    .all();
  return (res.results || []).map((row) => ({
    id: String(row.id),
    referrerId: String(row.referrer_id),
    referredUserId: String(row.referred_user_id),
    referredName: row.referred_name || '',
    referredUsername: row.referred_username || '',
    amountPaise: toNonNegInt(row.amount_paise),
    creditedAt: toInt(row.credited_at),
  }));
}

/**
 * Atomically credit a referral reward inside a single D1 transaction batch:
 *   1. INSERT INTO referral_claims (PRIMARY KEY referred_user_id prevents duplicates)
 *   2. INSERT INTO referrals (UNIQUE referred_user_id)
 *   3. UPDATE referred user (referred_by, pending_referrer_id = NULL, referral_credited = 1)
 *   4. UPDATE referrer balance & referral totals
 *   5. INSERT INTO ledger (atomic credit audit entry)
 */
export async function executeReferralCreditTransaction(
  env,
  { referrerId, referredUserId, referredName, referredUsername, amountPaise, creditedAt = Date.now() }
) {
  const db = assertDB(env);
  const safeAmount = toNonNegInt(amountPaise);
  const refId = String(referrerId);
  const uid = String(referredUserId);
  const referralRowId = generateId('REF');
  const ledgerId = generateId('LDG');

  const statements = [
    db
      .prepare(
        `INSERT INTO referral_claims (referred_user_id, referrer_id, amount_paise, credited_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(uid, refId, safeAmount, creditedAt),

    db
      .prepare(
        `INSERT INTO referrals (id, referrer_id, referred_user_id, referred_name, referred_username, amount_paise, credited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(referralRowId, refId, uid, String(referredName || ''), String(referredUsername || ''), safeAmount, creditedAt),

    db
      .prepare(
        `UPDATE users
         SET referred_by = ?, pending_referrer_id = NULL, referral_credited = 1
         WHERE telegram_id = ?`
      )
      .bind(refId, uid),

    db
      .prepare(
        `UPDATE users
         SET balance_paise = balance_paise + ?,
             total_earned_paise = total_earned_paise + ?,
             referral_earnings_paise = referral_earnings_paise + ?,
             total_referrals = total_referrals + 1
         WHERE telegram_id = ?`
      )
      .bind(safeAmount, safeAmount, safeAmount, refId),
  ];

  if (safeAmount > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ledger (
            id, user_id, entry_type, direction, amount_paise,
            balance_before_paise, balance_after_paise,
            reference_type, reference_id, description, created_at
          )
          SELECT ?, telegram_id, 'referral_credit', 'credit', ?,
                 balance_paise - ?, balance_paise,
                 'referral', ?, ?, ?
          FROM users
          WHERE telegram_id = ?`
        )
        .bind(
          ledgerId,
          safeAmount,
          safeAmount,
          uid,
          `Referral reward for inviting user ${uid}`,
          creditedAt,
          refId
        )
    );
  }

  try {
    await db.batch(statements);
    const updatedReferrer = await getUser(env, refId);
    return { ok: true, referrer: updatedReferrer };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY') || msg.includes('CONSTRAINT')) {
      return { ok: false, duplicate: true, error: 'Referral already claimed.' };
    }
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Daily Bonus Claims & Atomic Claim Transaction (`daily_claims`, `users`, `ledger`)
// ----------------------------------------------------------------------------

export async function getDailyBonusHistory(env, telegramId, limit = 180) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM daily_claims
       WHERE user_id = ?
       ORDER BY claimed_at DESC
       LIMIT ?`
    )
    .bind(String(telegramId), Math.max(1, toInt(limit, 180)))
    .all();
  return (res.results || []).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    amountPaise: toNonNegInt(row.amount_paise),
    istDate: String(row.ist_date),
    claimedAt: toInt(row.claimed_at),
  }));
}

/**
 * Atomically claim a daily bonus inside ONE D1 transaction batch:
 *   1. INSERT INTO daily_claims (protected by UNIQUE(user_id, ist_date) AND trg_daily_claims_24h_guard)
 *   2. UPDATE users (balance_paise, total_earned_paise, daily_bonus_earnings_paise, last_daily_claim_at, daily_bonus_count)
 *   3. INSERT INTO ledger (atomic credit audit entry)
 */
export async function executeDailyBonusClaimTransaction(
  env,
  { userId, amountPaise, istDate, claimedAt = Date.now() }
) {
  const db = assertDB(env);
  const uid = String(userId);
  const safeAmount = Math.max(1, toInt(amountPaise, 25));
  const claimId = generateId('DBN');
  const ledgerId = generateId('LDG');

  const statements = [
    db
      .prepare(
        `INSERT INTO daily_claims (id, user_id, amount_paise, ist_date, claimed_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(claimId, uid, safeAmount, String(istDate), claimedAt),

    db
      .prepare(
        `UPDATE users
         SET balance_paise = balance_paise + ?,
             total_earned_paise = total_earned_paise + ?,
             daily_bonus_earnings_paise = daily_bonus_earnings_paise + ?,
             last_daily_claim_at = ?,
             daily_bonus_count = daily_bonus_count + 1
         WHERE telegram_id = ?`
      )
      .bind(safeAmount, safeAmount, safeAmount, claimedAt, uid),

    db
      .prepare(
        `INSERT INTO ledger (
          id, user_id, entry_type, direction, amount_paise,
          balance_before_paise, balance_after_paise,
          reference_type, reference_id, description, created_at
        )
        SELECT ?, telegram_id, 'daily_bonus_credit', 'credit', ?,
               balance_paise - ?, balance_paise,
               'daily_claim', ?, ?, ?
        FROM users
        WHERE telegram_id = ?`
      )
      .bind(
        ledgerId,
        safeAmount,
        safeAmount,
        claimId,
        `Daily bonus claim (${istDate})`,
        claimedAt,
        uid
      ),
  ];

  try {
    await db.batch(statements);
    const updatedUser = await getUser(env, uid);
    return {
      ok: true,
      claim: { id: claimId, userId: uid, amountPaise: safeAmount, istDate, claimedAt },
      user: updatedUser,
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('DAILY_CLAIM_COOLDOWN') ||
      msg.includes('UNIQUE') ||
      msg.includes('CONSTRAINT')
    ) {
      return { ok: false, alreadyClaimed: true, error: 'Daily bonus already claimed.' };
    }
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Vouchers Inventory (`vouchers` table — Global UNIQUE duplicate prevention)
// ----------------------------------------------------------------------------

export async function hashVoucherCode(normalizedCode) {
  const data = new TextEncoder().encode(normalizedCode);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getVoucherIdByCode(env, code) {
  const db = assertDB(env);
  const normalized = normalizeVoucherCode(code);
  const row = await db
    .prepare('SELECT id FROM vouchers WHERE normalized_code = ?')
    .bind(normalized)
    .first();
  return row ? String(row.id) : null;
}

export async function getVoucher(env, voucherId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM vouchers WHERE id = ?')
    .bind(String(voucherId))
    .first();
  return mapVoucherRow(row);
}

export async function getAvailableVouchersByCategory(env, category, limit = 10) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM vouchers
       WHERE category = ? AND status = 'available'
       ORDER BY added_at ASC, id ASC
       LIMIT ?`
    )
    .bind(String(category), Math.max(1, toInt(limit, 10)))
    .all();
  return (res.results || []).map(mapVoucherRow);
}

export async function countAvailableVouchersByCategory(env, category) {
  const db = assertDB(env);
  const row = await db
    .prepare("SELECT COUNT(*) AS cnt FROM vouchers WHERE category = ? AND status = 'available'")
    .bind(String(category))
    .first();
  return toNonNegInt(row?.cnt);
}

/**
 * Bulk-insert normalized voucher rows with INSERT OR IGNORE on global UNIQUE(normalized_code, code_hash).
 * Uses chunked D1 batches for speed and atomicity.
 */
export async function bulkInsertVouchers(env, records) {
  const db = assertDB(env);
  if (!records.length) return { addedCount: 0, duplicateCount: 0 };

  let addedCount = 0;
  let duplicateCount = 0;
  const CHUNK_SIZE = 40;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const statements = chunk.map((v) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO vouchers (
            id, code, normalized_code, code_hash, category, value_paise,
            status, added_at, added_by
          ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`
        )
        .bind(
          v.id,
          v.code,
          v.normalizedCode,
          v.codeHash,
          v.category,
          toNonNegInt(v.valuePaise),
          toInt(v.addedAt),
          String(v.addedBy)
        )
    );

    const results = await db.batch(statements);
    for (const res of results) {
      if (Number(res?.meta?.changes ?? 0) > 0) {
        addedCount++;
      } else {
        duplicateCount++;
      }
    }
  }

  return { addedCount, duplicateCount };
}

/**
 * Atomically reserve ONE genuinely available voucher in a single SQL statement.
 * Prevents double-issuance across concurrent admin approvals.
 */
export async function atomicReserveAvailableVoucher(env, category, userId, withdrawalRequestId) {
  const db = assertDB(env);
  const row = await db
    .prepare(
      `UPDATE vouchers
       SET status = 'reserved',
           assigned_user_id = ?,
           withdrawal_request_id = ?
       WHERE id = (
         SELECT id FROM vouchers
         WHERE category = ? AND status = 'available'
         ORDER BY added_at ASC, id ASC
         LIMIT 1
       )
       AND status = 'available'
       RETURNING *`
    )
    .bind(String(userId), String(withdrawalRequestId), String(category))
    .first();

  if (!row) return null;
  return mapVoucherRow(row);
}

/**
 * Release a reserved voucher back to available if approval aborts before completion.
 */
export async function releaseReservedVoucherRow(env, voucherId) {
  if (!voucherId) return;
  const db = assertDB(env);
  await db
    .prepare(
      `UPDATE vouchers
       SET status = 'available',
           assigned_user_id = NULL,
           withdrawal_request_id = NULL
       WHERE id = ? AND status = 'reserved'`
    )
    .bind(String(voucherId))
    .run();
}

/**
 * Atomically disable an available voucher.
 */
export async function disableAvailableVoucherRow(env, voucherId, adminId, disabledAt = Date.now()) {
  const db = assertDB(env);
  const row = await db
    .prepare(
      `UPDATE vouchers
       SET status = 'disabled',
           disabled_at = ?,
           disabled_by = ?
       WHERE id = ? AND status = 'available'
       RETURNING *`
    )
    .bind(disabledAt, String(adminId), String(voucherId))
    .first();
  return mapVoucherRow(row);
}

export async function getAllCategoryStockSummary(env) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT
        category,
        COUNT(*) AS total_added,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_count,
        SUM(CASE WHEN status = 'available' THEN value_paise ELSE 0 END) AS available_value_paise
       FROM vouchers
       GROUP BY category`
    )
    .all();

  const byCat = new Map();
  for (const row of res.results || []) {
    byCat.set(String(row.category), row);
  }

  const summary = {};
  let totalAvailable = 0;
  let totalValuePaise = 0;

  for (const cat of VOUCHER_CATEGORY_LIST) {
    const row = byCat.get(cat.key);
    const availableCount = toNonNegInt(row?.available_count);
    const totalAddedCount = toNonNegInt(row?.total_added);
    const catValuePaise = toNonNegInt(row?.available_value_paise);

    summary[cat.key] = {
      ...cat,
      availableCount,
      totalAddedCount,
      inStock: availableCount > 0,
      valuePaise: catValuePaise,
    };
    totalAvailable += availableCount;
    totalValuePaise += catValuePaise;
  }

  return {
    categories: summary,
    totalAvailable,
    totalValuePaise,
  };
}

// ----------------------------------------------------------------------------
// Voucher History Collection (`voucher_history` table)
// ----------------------------------------------------------------------------

export async function getVoucherHistoryRecord(env, historyId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM voucher_history WHERE id = ?')
    .bind(String(historyId))
    .first();
  return mapVoucherHistoryRow(row);
}

export async function getVoucherHistoryPage(env, page = 1, pageSize = 5) {
  const db = assertDB(env);
  const countRow = await db.prepare('SELECT COUNT(*) AS total FROM voucher_history').first();
  const total = toNonNegInt(countRow?.total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (safePage - 1) * pageSize;

  const res = await db
    .prepare('SELECT * FROM voucher_history ORDER BY delivered_at DESC LIMIT ? OFFSET ?')
    .bind(pageSize, offset)
    .all();

  return {
    items: (res.results || []).map(mapVoucherHistoryRow),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export async function getUserVoucherHistory(env, telegramId, limit = 15) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM voucher_history
       WHERE user_id = ?
       ORDER BY delivered_at DESC
       LIMIT ?`
    )
    .bind(String(telegramId), Math.max(1, toInt(limit, 15)))
    .all();
  // Strict per-user ownership isolation
  return (res.results || [])
    .map(mapVoucherHistoryRow)
    .filter((item) => String(item.userId) === String(telegramId));
}

// ----------------------------------------------------------------------------
// Withdrawals & Atomic Financial Lifecycle (`withdrawals`, `users`, `vouchers`, `voucher_history`, `ledger`)
// ----------------------------------------------------------------------------

export async function getWithdrawal(env, requestId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM withdrawals WHERE id = ?')
    .bind(String(requestId))
    .first();
  return mapWithdrawalRow(row);
}

export async function countPendingWithdrawals(env) {
  const db = assertDB(env);
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM withdrawals WHERE status = 'pending'")
    .first();
  return toNonNegInt(row?.total);
}

export async function getPendingWithdrawalIds(env) {
  const db = assertDB(env);
  const res = await db
    .prepare("SELECT id FROM withdrawals WHERE status = 'pending' ORDER BY created_at DESC")
    .all();
  return (res.results || []).map((r) => String(r.id));
}

export async function getPendingWithdrawalsPage(env, page = 1, pageSize = 5) {
  const db = assertDB(env);
  const total = await countPendingWithdrawals(env);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (safePage - 1) * pageSize;

  const res = await db
    .prepare(
      "SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .bind(pageSize, offset)
    .all();

  return {
    items: (res.results || []).map(mapWithdrawalRow),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export async function getUserWithdrawals(env, telegramId, limit = 15) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM withdrawals
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(String(telegramId), Math.max(1, toInt(limit, 15)))
    .all();
  return (res.results || [])
    .map(mapWithdrawalRow)
    .filter((w) => String(w.userId) === String(telegramId));
}

export async function getUserActivePendingWithdrawal(env, telegramId) {
  const db = assertDB(env);
  const row = await db
    .prepare("SELECT * FROM withdrawals WHERE user_id = ? AND status = 'pending' LIMIT 1")
    .bind(String(telegramId))
    .first();
  return mapWithdrawalRow(row);
}

/**
 * Atomically reserve user balance, create a pending withdrawal, and write a ledger entry.
 * Enforced by:
 *   - CHECK (balance_paise >= 0) -> aborts if concurrent debit would make balance negative
 *   - Partial UNIQUE index on withdrawals(user_id) WHERE status = 'pending' -> aborts duplicate pending requests
 *   - UNIQUE(entry_type, reference_type, reference_id) on ledger
 */
export async function executeCreateWithdrawalTransaction(env, withdrawal) {
  const db = assertDB(env);
  const safeAmount = toNonNegInt(withdrawal.amountPaise);
  const uid = String(withdrawal.userId);
  const ledgerId = generateId('LDG');

  const statements = [
    db
      .prepare(
        `UPDATE users
         SET balance_paise = balance_paise - ?,
             pending_withdrawal_paise = pending_withdrawal_paise + ?,
             active_pending_withdrawal_id = ?
         WHERE telegram_id = ?`
      )
      .bind(safeAmount, safeAmount, withdrawal.id, uid),

    db
      .prepare(
        `INSERT INTO withdrawals (
          id, user_id, username, user_name, amount_paise, category, status,
          created_at, user_balance_snapshot_paise
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        withdrawal.id,
        uid,
        String(withdrawal.username || ''),
        String(withdrawal.userName || ''),
        safeAmount,
        String(withdrawal.category),
        toInt(withdrawal.createdAt),
        toNonNegInt(withdrawal.userBalanceSnapshotPaise)
      ),

    db
      .prepare(
        `INSERT INTO ledger (
          id, user_id, entry_type, direction, amount_paise,
          balance_before_paise, balance_after_paise,
          reference_type, reference_id, description, created_at
        )
        SELECT ?, telegram_id, 'withdrawal_reserve', 'reserve', ?,
               balance_paise + ?, balance_paise,
               'withdrawal', ?, ?, ?
        FROM users
        WHERE telegram_id = ?`
      )
      .bind(
        ledgerId,
        safeAmount,
        safeAmount,
        withdrawal.id,
        `Reserved balance for withdrawal ${withdrawal.id} (${withdrawal.category})`,
        toInt(withdrawal.createdAt),
        uid
      ),
  ];

  try {
    await db.batch(statements);
    const updatedUser = await getUser(env, uid);
    return { ok: true, withdrawal, user: updatedUser };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('balance_paise') || msg.includes('CHECK')) {
      return { ok: false, error: 'Insufficient available balance.' };
    }
    if (msg.includes('UNIQUE') || msg.includes('idx_withdrawals_one_pending_per_user')) {
      return {
        ok: false,
        error: '⏳ You already have a pending withdrawal request. Please wait for admin review.',
      };
    }
    throw err;
  }
}

/**
 * Atomically approve a pending withdrawal, finalize reserved voucher delivery,
 * insert permanent voucher_history, finalize user balance & 24h cooldown, and write ledger.
 */
export async function executeApproveWithdrawalTransaction(
  env,
  { withdrawal, voucher, adminId, processedAt = Date.now(), historyId }
) {
  const db = assertDB(env);
  const safeAmount = toNonNegInt(withdrawal.amountPaise);
  const uid = String(withdrawal.userId);
  const aid = String(adminId);
  const hId = historyId || generateId('VH');
  const ledgerId = generateId('LDG');

  const statements = [
    // Trigger `trg_withdrawals_only_pending_transition` aborts atomically if status != 'pending'
    db
      .prepare(
        `UPDATE withdrawals
         SET status = 'approved',
             processed_at = ?,
             processed_by = ?,
             voucher_id = ?,
             voucher_code = ?
         WHERE id = ?`
      )
      .bind(processedAt, aid, voucher.id, voucher.code, withdrawal.id),

    db
      .prepare(
        `UPDATE vouchers
         SET status = 'delivered',
             approved_by = ?,
             delivered_at = ?,
             assigned_user_id = ?,
             withdrawal_request_id = ?
         WHERE id = ? AND status = 'reserved'`
      )
      .bind(aid, processedAt, uid, withdrawal.id, voucher.id),

    db
      .prepare(
        `INSERT INTO voucher_history (
          id, voucher_id, code, category, value_paise, user_id,
          username, user_name, withdrawal_request_id, approved_by, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        hId,
        voucher.id,
        voucher.code,
        voucher.category,
        toNonNegInt(voucher.valuePaise),
        uid,
        String(withdrawal.username || ''),
        String(withdrawal.userName || ''),
        withdrawal.id,
        aid,
        processedAt
      ),

    db
      .prepare(
        `UPDATE users
         SET pending_withdrawal_paise = pending_withdrawal_paise - ?,
             total_withdrawn_paise = total_withdrawn_paise + ?,
             withdrawal_count = withdrawal_count + 1,
             last_approved_withdrawal_at = ?,
             active_pending_withdrawal_id = CASE
               WHEN active_pending_withdrawal_id = ? THEN NULL
               ELSE active_pending_withdrawal_id
             END
         WHERE telegram_id = ?`
      )
      .bind(safeAmount, safeAmount, processedAt, withdrawal.id, uid),

    db
      .prepare(
        `INSERT INTO ledger (
          id, user_id, entry_type, direction, amount_paise,
          balance_before_paise, balance_after_paise,
          reference_type, reference_id, description, created_at
        )
        SELECT ?, telegram_id, 'withdrawal_finalize', 'debit', ?,
               balance_paise, balance_paise,
               'withdrawal', ?, ?, ?
        FROM users
        WHERE telegram_id = ?`
      )
      .bind(
        ledgerId,
        safeAmount,
        withdrawal.id,
        `Approved withdrawal ${withdrawal.id} — delivered voucher ${voucher.id}`,
        processedAt,
        uid
      ),
  ];

  try {
    await db.batch(statements);
    const [updatedWithdrawal, updatedVoucher, updatedUser] = await Promise.all([
      getWithdrawal(env, withdrawal.id),
      getVoucher(env, voucher.id),
      getUser(env, uid),
    ]);
    return {
      ok: true,
      withdrawal: updatedWithdrawal,
      voucher: updatedVoucher,
      user: updatedUser,
      historyId: hId,
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('WITHDRAWAL_ALREADY_PROCESSED') ||
      msg.includes('UNIQUE') ||
      msg.includes('CONSTRAINT')
    ) {
      return {
        ok: false,
        alreadyProcessed: true,
        error: `Request ${withdrawal.id} has already been processed.`,
      };
    }
    throw err;
  }
}

/**
 * Atomically reject a pending withdrawal, refund 100% of reserved paise back to
 * available balance, clear pending pointer, and record a ledger refund entry.
 */
export async function executeRejectWithdrawalTransaction(
  env,
  { withdrawal, adminId, reason = '', processedAt = Date.now() }
) {
  const db = assertDB(env);
  const safeAmount = toNonNegInt(withdrawal.amountPaise);
  const uid = String(withdrawal.userId);
  const aid = String(adminId);
  const cleanReason = String(reason || '').trim().slice(0, 250);
  const ledgerId = generateId('LDG');

  const statements = [
    // Trigger `trg_withdrawals_only_pending_transition` aborts atomically if status != 'pending'
    db
      .prepare(
        `UPDATE withdrawals
         SET status = 'rejected',
             processed_at = ?,
             processed_by = ?,
             rejection_reason = ?
         WHERE id = ?`
      )
      .bind(processedAt, aid, cleanReason, withdrawal.id),

    db
      .prepare(
        `UPDATE users
         SET pending_withdrawal_paise = pending_withdrawal_paise - ?,
             balance_paise = balance_paise + ?,
             active_pending_withdrawal_id = CASE
               WHEN active_pending_withdrawal_id = ? THEN NULL
               ELSE active_pending_withdrawal_id
             END
         WHERE telegram_id = ?`
      )
      .bind(safeAmount, safeAmount, withdrawal.id, uid),

    db
      .prepare(
        `INSERT INTO ledger (
          id, user_id, entry_type, direction, amount_paise,
          balance_before_paise, balance_after_paise,
          reference_type, reference_id, description, created_at
        )
        SELECT ?, telegram_id, 'withdrawal_refund', 'release', ?,
               balance_paise - ?, balance_paise,
               'withdrawal', ?, ?, ?
        FROM users
        WHERE telegram_id = ?`
      )
      .bind(
        ledgerId,
        safeAmount,
        safeAmount,
        withdrawal.id,
        `Refunded rejected withdrawal ${withdrawal.id}${cleanReason ? `: ${cleanReason}` : ''}`,
        processedAt,
        uid
      ),
  ];

  try {
    await db.batch(statements);
    const [updatedWithdrawal, updatedUser] = await Promise.all([
      getWithdrawal(env, withdrawal.id),
      getUser(env, uid),
    ]);
    return {
      ok: true,
      withdrawal: updatedWithdrawal,
      user: updatedUser,
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('WITHDRAWAL_ALREADY_PROCESSED') ||
      msg.includes('UNIQUE') ||
      msg.includes('CONSTRAINT')
    ) {
      return {
        ok: false,
        alreadyProcessed: true,
        error: `Request ${withdrawal.id} has already been processed.`,
      };
    }
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Admins Collection & Permission Checks (`admins` table)
// ----------------------------------------------------------------------------

export function isOwner(userId, env) {
  if (!userId) return false;
  return String(userId) === getOwnerId(env);
}

export async function getAdminsMap(env) {
  const db = assertDB(env);
  const res = await db.prepare('SELECT * FROM admins WHERE active = 1 ORDER BY added_at ASC').all();
  const map = {};
  for (const row of res.results || []) {
    const id = String(row.telegram_id);
    map[id] = {
      id,
      name: row.name || `Admin ${id}`,
      username: row.username || '',
      role: row.role || 'admin',
      active: Boolean(row.active),
      addedBy: row.added_by || '',
      addedAt: toInt(row.added_at),
      permissions: {
        ...DEFAULT_ADMIN_PERMISSIONS,
        ...safeJsonParse(row.permissions_json, {}),
        manageAdmins: false,
      },
    };
  }
  return map;
}

export async function upsertAdminRecord(env, record) {
  const db = assertDB(env);
  const now = Date.now();
  const id = String(record.id);
  const perms = {
    ...DEFAULT_ADMIN_PERMISSIONS,
    ...(record.permissions || {}),
    manageSecretary: false,
    manageAdmins: false,
  };
  await db
    .prepare(
      `INSERT INTO admins (
        telegram_id, name, username, role, permissions_json, active, added_by, added_at, updated_at
      ) VALUES (?, ?, ?, 'admin', ?, 1, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        name = excluded.name,
        username = excluded.username,
        permissions_json = excluded.permissions_json,
        active = 1,
        updated_at = excluded.updated_at`
    )
    .bind(
      id,
      String(record.name || `Admin ${id}`),
      String(record.username || ''),
      JSON.stringify(perms),
      String(record.addedBy || ''),
      toInt(record.addedAt, now),
      now
    )
    .run();
}

export async function removeAdminRecord(env, telegramId) {
  const db = assertDB(env);
  const res = await db
    .prepare('DELETE FROM admins WHERE telegram_id = ?')
    .bind(String(telegramId))
    .run();
  return Number(res?.meta?.changes ?? 0) > 0;
}

export async function getAdminRecord(env, userId) {
  const id = String(userId);
  if (isOwner(id, env)) {
    return {
      id,
      role: 'owner',
      permissions: { ...OWNER_PERMISSIONS },
    };
  }

  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM admins WHERE telegram_id = ? AND active = 1')
    .bind(id)
    .first();
  if (!row) return null;

  return {
    id,
    name: row.name || `Admin ${id}`,
    username: row.username || '',
    role: 'admin',
    active: true,
    addedBy: row.added_by || '',
    addedAt: toInt(row.added_at),
    permissions: {
      ...DEFAULT_ADMIN_PERMISSIONS,
      ...safeJsonParse(row.permissions_json, {}),
      manageSecretary: false, // Owner-only configuration
      manageAdmins: false, // Owner-only enforcement
    },
  };
}

export async function isAdmin(userId, env) {
  const rec = await getAdminRecord(env, userId);
  return Boolean(rec);
}

export async function hasAdminPermission(userId, permission, env) {
  const rec = await getAdminRecord(env, userId);
  if (!rec) return false;
  if (rec.role === 'owner') return true;
  if (permission === 'manageAdmins') return false;
  return Boolean(rec.permissions?.[permission]);
}

export async function getAllAdminIds(env) {
  const ownerId = getOwnerId(env);
  const db = assertDB(env);
  const res = await db.prepare('SELECT telegram_id FROM admins WHERE active = 1').all();
  const ids = new Set([ownerId]);
  for (const row of res.results || []) {
    ids.add(String(row.telegram_id));
  }
  return Array.from(ids);
}

// ----------------------------------------------------------------------------
// Force-Join Channels & Pending Join Requests (`force_join_channels`, `pending_join_requests`)
// ----------------------------------------------------------------------------

export async function getForceChannels(env) {
  const db = assertDB(env);
  const res = await db
    .prepare('SELECT * FROM force_join_channels ORDER BY added_at ASC')
    .all();
  return (res.results || []).map(mapForceChannelRow);
}

export async function upsertForceChannel(env, channel) {
  const db = assertDB(env);
  const now = Date.now();
  const id = String(channel.id || generateId('FJ'));
  const chatId = String(channel.chatId);

  await db
    .prepare(
      `INSERT INTO force_join_channels (
        id, chat_id, username, title, invite_link, is_private, is_request_to_join, added_by, added_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = excluded.username,
        title = excluded.title,
        invite_link = excluded.invite_link,
        is_private = excluded.is_private,
        is_request_to_join = excluded.is_request_to_join,
        added_by = excluded.added_by`
    )
    .bind(
      id,
      chatId,
      String(channel.username || ''),
      String(channel.title || chatId),
      String(channel.inviteLink || ''),
      channel.isPrivate ? 1 : 0,
      channel.isRequestToJoin ? 1 : 0,
      String(channel.addedBy || ''),
      toInt(channel.addedAt, now)
    )
    .run();

  const row = await db
    .prepare('SELECT * FROM force_join_channels WHERE chat_id = ?')
    .bind(chatId)
    .first();
  return mapForceChannelRow(row);
}

export async function deleteForceChannel(env, channelId) {
  const db = assertDB(env);
  const existing = await db
    .prepare('SELECT * FROM force_join_channels WHERE id = ?')
    .bind(String(channelId))
    .first();
  if (!existing) return null;

  await db
    .prepare('DELETE FROM force_join_channels WHERE id = ?')
    .bind(String(channelId))
    .run();
  return mapForceChannelRow(existing);
}

export async function saveForceChannels(env, channels) {
  const db = assertDB(env);
  const list = Array.isArray(channels) ? channels : [];
  const statements = [db.prepare('DELETE FROM force_join_channels')];
  for (const ch of list) {
    statements.push(
      db
        .prepare(
          `INSERT INTO force_join_channels (
            id, chat_id, username, title, invite_link, is_private, is_request_to_join, added_by, added_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          String(ch.id || generateId('FJ')),
          String(ch.chatId),
          String(ch.username || ''),
          String(ch.title || ch.chatId),
          String(ch.inviteLink || ''),
          ch.isPrivate ? 1 : 0,
          ch.isRequestToJoin ? 1 : 0,
          String(ch.addedBy || ''),
          toInt(ch.addedAt, Date.now())
        )
    );
  }
  await db.batch(statements);
}

export async function recordPendingJoinRequest(env, chatId, userId, details = {}) {
  const db = assertDB(env);
  const now = Date.now();
  const expiresAt = now + 14 * 24 * 60 * 60 * 1000;
  const cid = String(chatId);
  const uid = String(userId);
  const inviteLink = String(details.inviteLink || '');

  await db
    .prepare(
      `INSERT INTO pending_join_requests (chat_id, user_id, invite_link, status, requested_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET
         invite_link = excluded.invite_link,
         status = 'pending',
         requested_at = excluded.requested_at,
         expires_at = excluded.expires_at`
    )
    .bind(cid, uid, inviteLink, now, expiresAt)
    .run();

  return { chatId: cid, userId: uid, inviteLink, requestedAt: now, status: 'pending' };
}

export async function getPendingJoinRequest(env, chatId, userId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM pending_join_requests WHERE chat_id = ? AND user_id = ?')
    .bind(String(chatId), String(userId))
    .first();
  if (!row) return null;
  if (toInt(row.expires_at) < Date.now()) {
    await clearPendingJoinRequest(env, chatId, userId);
    return null;
  }
  return {
    chatId: String(row.chat_id),
    userId: String(row.user_id),
    inviteLink: row.invite_link || '',
    requestedAt: toInt(row.requested_at),
    status: row.status || 'pending',
  };
}

export async function clearPendingJoinRequest(env, chatId, userId) {
  const db = assertDB(env);
  await db
    .prepare('DELETE FROM pending_join_requests WHERE chat_id = ? AND user_id = ?')
    .bind(String(chatId), String(userId))
    .run();
}

// ----------------------------------------------------------------------------
// Tasks & User Tasks (`tasks`, `user_tasks`, `ledger`)
// ----------------------------------------------------------------------------

export async function getActiveTasks(env) {
  const db = assertDB(env);
  const res = await db
    .prepare("SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at DESC")
    .all();
  return (res.results || []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    description: row.description || '',
    taskType: row.task_type || 'link',
    targetUrl: row.target_url || '',
    rewardPaise: toNonNegInt(row.reward_paise),
    status: String(row.status),
    createdBy: row.created_by || '',
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  }));
}

export async function createTaskRecord(env, task) {
  const db = assertDB(env);
  const now = Date.now();
  const id = String(task.id || generateId('TSK'));
  await db
    .prepare(
      `INSERT INTO tasks (id, title, description, task_type, target_url, reward_paise, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .bind(
      id,
      String(task.title),
      String(task.description || ''),
      String(task.taskType || 'link'),
      String(task.targetUrl || ''),
      toNonNegInt(task.rewardPaise),
      String(task.createdBy || ''),
      now,
      now
    )
    .run();
  return { id, ...task, createdAt: now, updatedAt: now };
}

export async function completeUserTaskTransaction(env, { taskId, userId, rewardPaise, completedAt = Date.now() }) {
  const db = assertDB(env);
  const uid = String(userId);
  const tid = String(taskId);
  const safeReward = toNonNegInt(rewardPaise);
  const userTaskId = generateId('UTSK');
  const ledgerId = generateId('LDG');

  const statements = [
    db
      .prepare(
        `INSERT INTO user_tasks (id, task_id, user_id, status, reward_paise, completed_at, rewarded_at)
         VALUES (?, ?, ?, 'completed', ?, ?, ?)`
      )
      .bind(userTaskId, tid, uid, safeReward, completedAt, safeReward > 0 ? completedAt : null),
  ];

  if (safeReward > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE users
           SET balance_paise = balance_paise + ?,
               total_earned_paise = total_earned_paise + ?
           WHERE telegram_id = ?`
        )
        .bind(safeReward, safeReward, uid),
      db
        .prepare(
          `INSERT INTO ledger (
            id, user_id, entry_type, direction, amount_paise,
            balance_before_paise, balance_after_paise,
            reference_type, reference_id, description, created_at
          )
          SELECT ?, telegram_id, 'task_credit', 'credit', ?,
                 balance_paise - ?, balance_paise,
                 'task', ?, ?, ?
          FROM users
          WHERE telegram_id = ?`
        )
        .bind(
          ledgerId,
          safeReward,
          safeReward,
          `${tid}:${uid}`,
          `Completed task ${tid}`,
          completedAt,
          uid
        )
    );
  }

  try {
    await db.batch(statements);
    return { ok: true, userTaskId, user: await getUser(env, uid) };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE') || msg.includes('CONSTRAINT')) {
      return { ok: false, duplicate: true, error: 'Task already completed.' };
    }
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Admin Activity Logs (`activity_logs` table)
// ----------------------------------------------------------------------------

export async function appendActivityLog(env, entry) {
  const db = assertDB(env);
  const id = String(entry.id || generateId('LOG'));
  const createdAt = toInt(entry.timestamp, Date.now());
  await db
    .prepare(
      `INSERT INTO activity_logs (id, admin_id, action, details, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, String(entry.adminId), String(entry.action), String(entry.details || '').slice(0, 500), createdAt)
    .run();
  return { ...entry, id, timestamp: createdAt };
}

export async function getActivityLogsPage(env, page = 1, pageSize = 8) {
  const db = assertDB(env);
  const countRow = await db.prepare('SELECT COUNT(*) AS total FROM activity_logs').first();
  const total = toNonNegInt(countRow?.total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (safePage - 1) * pageSize;

  const res = await db
    .prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(pageSize, offset)
    .all();

  return {
    logs: (res.results || []).map(mapActivityLogRow),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

// ----------------------------------------------------------------------------
// Broadcast Records (`broadcasts` table)
// ----------------------------------------------------------------------------

export async function saveBroadcastRecord(env, record) {
  const db = assertDB(env);
  await db
    .prepare(
      `INSERT INTO broadcasts (
        id, admin_id, source_chat_id, source_message_id, media_type, preview_summary,
        total_recipients, skipped_blocked, sent_count, failed_count, newly_blocked_count,
        status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_recipients = excluded.total_recipients,
        skipped_blocked = excluded.skipped_blocked,
        sent_count = excluded.sent_count,
        failed_count = excluded.failed_count,
        newly_blocked_count = excluded.newly_blocked_count,
        status = excluded.status,
        completed_at = excluded.completed_at`
    )
    .bind(
      String(record.id),
      String(record.adminId),
      String(record.sourceChatId),
      toInt(record.sourceMessageId),
      String(record.mediaType || 'text'),
      String(record.previewSummary || ''),
      toNonNegInt(record.totalRecipients),
      toNonNegInt(record.skippedBlocked),
      toNonNegInt(record.sentCount),
      toNonNegInt(record.failedCount),
      toNonNegInt(record.newlyBlockedCount),
      String(record.status || 'draft'),
      toInt(record.createdAt, Date.now()),
      record.completedAt !== null && record.completedAt !== undefined
        ? toInt(record.completedAt)
        : null
    )
    .run();

  return record;
}

export async function getBroadcastRecord(env, id) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM broadcasts WHERE id = ?')
    .bind(String(id))
    .first();
  return mapBroadcastRow(row);
}

// ----------------------------------------------------------------------------
// Live Global Statistics (Computed directly from D1 SQL tables — single source of truth)
// ----------------------------------------------------------------------------

export async function getGlobalStats(env) {
  const db = assertDB(env);
  const [refRow, dailyRow, wdRow, vhRow] = await db.batch([
    db.prepare(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_paise), 0) AS sum_paise FROM referrals'
    ),
    db.prepare(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_paise), 0) AS sum_paise FROM daily_claims'
    ),
    db.prepare(
      `SELECT
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_cnt,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_cnt,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_paise ELSE 0 END), 0) AS withdrawn_paise
       FROM withdrawals`
    ),
    db.prepare('SELECT COUNT(*) AS cnt FROM voucher_history'),
  ]);

  const ref = refRow?.results?.[0] || {};
  const daily = dailyRow?.results?.[0] || {};
  const wd = wdRow?.results?.[0] || {};
  const vh = vhRow?.results?.[0] || {};

  return {
    totalReferrals: toNonNegInt(ref.cnt),
    totalReferralRewardsPaise: toNonNegInt(ref.sum_paise),
    totalDailyBonusesCount: toNonNegInt(daily.cnt),
    totalDailyBonusPaise: toNonNegInt(daily.sum_paise),
    totalApprovedWithdrawals: toNonNegInt(wd.approved_cnt),
    totalRejectedWithdrawals: toNonNegInt(wd.rejected_cnt),
    totalWithdrawnPaise: toNonNegInt(wd.withdrawn_paise),
    totalVouchersDelivered: toNonNegInt(vh.cnt),
  };
}

// ----------------------------------------------------------------------------
// Manual Admin Balance Adjustments (`balance_adjustments` + `users` + `ledger`)
// ----------------------------------------------------------------------------

function mapBalanceAdjustmentRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    adminId: String(row.admin_id),
    targetUserId: String(row.target_user_id),
    action: String(row.action),
    amountPaise: toNonNegInt(row.amount_paise),
    balanceBeforePaise: toNonNegInt(row.balance_before_paise),
    balanceAfterPaise: toNonNegInt(row.balance_after_paise),
    reason: row.reason || '',
    createdAt: toInt(row.created_at),
  };
}

export async function getBalanceAdjustmentById(env, operationId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM balance_adjustments WHERE id = ?')
    .bind(String(operationId))
    .first();
  return mapBalanceAdjustmentRow(row);
}

export async function getUserBalanceAdjustments(env, telegramId, limit = 20) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM balance_adjustments
       WHERE target_user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(String(telegramId), Math.max(1, toInt(limit, 20)))
    .all();
  return (res.results || []).map(mapBalanceAdjustmentRow);
}

/**
 * Atomically add or deduct a user's balance inside ONE Cloudflare D1 batch:
 *   1. UPDATE users (enforcing CHECK balance_paise >= 0 on DEDUCT)
 *   2. INSERT INTO balance_adjustments (PRIMARY KEY operationId prevents duplicate execution)
 *   3. INSERT INTO ledger (immutable audit entry with UNIQUE reference)
 */
export async function executeManualBalanceAdjustmentTransaction(
  env,
  { operationId, adminId, targetUserId, action, amountPaise, reason = '', createdAt = Date.now() }
) {
  const db = assertDB(env);
  const opId = String(operationId || '').trim();
  const aid = String(adminId || '').trim();
  const uid = String(targetUserId || '').trim();
  const act = String(action || '').toUpperCase();
  const safeAmount = Math.round(Number(amountPaise));
  const cleanReason = String(reason || '').trim().slice(0, 250);

  if (!opId) {
    return { ok: false, error: 'Missing operation ID.' };
  }
  if (act !== 'ADD' && act !== 'DEDUCT') {
    return { ok: false, error: 'Invalid balance action. Expected ADD or DEDUCT.' };
  }
  if (
    !Number.isSafeInteger(safeAmount) ||
    safeAmount <= 0 ||
    safeAmount > MAX_MANUAL_BALANCE_ADJUSTMENT_PAISE
  ) {
    return { ok: false, error: 'Invalid balance adjustment amount.' };
  }

  const targetUser = await getUser(env, uid);
  if (!targetUser) {
    return { ok: false, notFound: true, error: 'Target user not found.' };
  }
  if (act === 'DEDUCT' && targetUser.balancePaise < safeAmount) {
    return {
      ok: false,
      insufficientBalance: true,
      error: 'Insufficient user balance: negative balance is not allowed.',
    };
  }

  const ledgerId = generateId('LDG');
  const ledgerDesc = cleanReason
    ? `Admin ${act === 'ADD' ? 'credit' : 'deduction'} (${aid}): ${cleanReason}`
    : `Admin ${act === 'ADD' ? 'credit' : 'deduction'} (${aid})`;

  const statements =
    act === 'ADD'
      ? [
          db
            .prepare(
              `UPDATE users
               SET balance_paise = balance_paise + ?,
                   total_earned_paise = total_earned_paise + ?
               WHERE telegram_id = ?`
            )
            .bind(safeAmount, safeAmount, uid),
          db
            .prepare(
              `INSERT INTO balance_adjustments (
                id, admin_id, target_user_id, action, amount_paise,
                balance_before_paise, balance_after_paise, reason, created_at
              )
              SELECT ?, ?, telegram_id, 'ADD', ?, balance_paise - ?, balance_paise, ?, ?
              FROM users
              WHERE telegram_id = ?`
            )
            .bind(opId, aid, safeAmount, safeAmount, cleanReason, createdAt, uid),
          db
            .prepare(
              `INSERT INTO ledger (
                id, user_id, entry_type, direction, amount_paise,
                balance_before_paise, balance_after_paise,
                reference_type, reference_id, description, created_at
              )
              SELECT ?, telegram_id, 'admin_balance_add', 'credit', ?,
                     balance_paise - ?, balance_paise,
                     'balance_adjustment', ?, ?, ?
              FROM users
              WHERE telegram_id = ?`
            )
            .bind(ledgerId, safeAmount, safeAmount, opId, ledgerDesc, createdAt, uid),
        ]
      : [
          db
            .prepare(
              `UPDATE users
               SET balance_paise = balance_paise - ?
               WHERE telegram_id = ?`
            )
            .bind(safeAmount, uid),
          db
            .prepare(
              `INSERT INTO balance_adjustments (
                id, admin_id, target_user_id, action, amount_paise,
                balance_before_paise, balance_after_paise, reason, created_at
              )
              SELECT ?, ?, telegram_id, 'DEDUCT', ?, balance_paise + ?, balance_paise, ?, ?
              FROM users
              WHERE telegram_id = ?`
            )
            .bind(opId, aid, safeAmount, safeAmount, cleanReason, createdAt, uid),
          db
            .prepare(
              `INSERT INTO ledger (
                id, user_id, entry_type, direction, amount_paise,
                balance_before_paise, balance_after_paise,
                reference_type, reference_id, description, created_at
              )
              SELECT ?, telegram_id, 'admin_balance_deduct', 'debit', ?,
                     balance_paise + ?, balance_paise,
                     'balance_adjustment', ?, ?, ?
              FROM users
              WHERE telegram_id = ?`
            )
            .bind(ledgerId, safeAmount, safeAmount, opId, ledgerDesc, createdAt, uid),
        ];

  try {
    await db.batch(statements);
    const [adjustment, updatedUser] = await Promise.all([
      getBalanceAdjustmentById(env, opId),
      getUser(env, uid),
    ]);
    if (!adjustment) {
      return { ok: false, error: 'Balance adjustment did not commit.' };
    }
    return {
      ok: true,
      adjustment,
      user: updatedUser,
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return {
        ok: false,
        duplicate: true,
        error: 'Duplicate balance operation rejected: this action was already executed.',
      };
    }
    if (msg.includes('CHECK') || msg.includes('balance_paise')) {
      return {
        ok: false,
        insufficientBalance: true,
        error: 'Insufficient user balance: negative balance is not allowed.',
      };
    }
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Task Approval / Rejection Review (`user_tasks` + atomic reward credit)
// ----------------------------------------------------------------------------

export async function reviewUserTaskTransaction(
  env,
  { userTaskId, status, adminId, reviewNote = '', reviewedAt = Date.now() }
) {
  const db = assertDB(env);
  const utId = String(userTaskId);
  const targetStatus = status === 'approved' ? 'approved' : 'rejected';
  const aid = String(adminId);
  const note = String(reviewNote || '').trim().slice(0, 250);

  const existing = await db
    .prepare('SELECT * FROM user_tasks WHERE id = ?')
    .bind(utId)
    .first();
  if (!existing) {
    return { ok: false, error: 'User task submission not found.' };
  }
  if (existing.status !== 'pending') {
    return { ok: false, alreadyReviewed: true, error: `Task submission is already ${existing.status}.` };
  }

  const rewardPaise = toNonNegInt(existing.reward_paise);
  const uid = String(existing.user_id);
  const statements = [
    db
      .prepare(
        `UPDATE user_tasks
         SET status = ?,
             rewarded_at = CASE WHEN ? = 'approved' THEN ? ELSE rewarded_at END,
             reviewed_by = ?,
             reviewed_at = ?,
             review_note = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(targetStatus, targetStatus, reviewedAt, aid, reviewedAt, note, utId),
  ];

  if (targetStatus === 'approved' && rewardPaise > 0) {
    const ledgerId = generateId('LDG');
    statements.push(
      db
        .prepare(
          `UPDATE users
           SET balance_paise = balance_paise + ?,
               total_earned_paise = total_earned_paise + ?
           WHERE telegram_id = ?`
        )
        .bind(rewardPaise, rewardPaise, uid),
      db
        .prepare(
          `INSERT INTO ledger (
            id, user_id, entry_type, direction, amount_paise,
            balance_before_paise, balance_after_paise,
            reference_type, reference_id, description, created_at
          )
          SELECT ?, telegram_id, 'task_credit', 'credit', ?,
                 balance_paise - ?, balance_paise,
                 'task_approval', ?, ?, ?
          FROM users
          WHERE telegram_id = ?`
        )
        .bind(
          ledgerId,
          rewardPaise,
          rewardPaise,
          utId,
          `Approved task ${existing.task_id}`,
          reviewedAt,
          uid
        )
    );
  }

  await db.batch(statements);
  return {
    ok: true,
    userTask: {
      id: utId,
      taskId: String(existing.task_id),
      userId: uid,
      status: targetStatus,
      rewardPaise,
      reviewedBy: aid,
      reviewedAt,
      reviewNote: note,
    },
    user: await getUser(env, uid),
  };
}

// ----------------------------------------------------------------------------
// Secretary Mode Config & Delivery Log Storage (`settings`, `secretary_logs`)
// ----------------------------------------------------------------------------

const SECRETARY_CONFIG_KEY = 'secretary_config';

export async function getSecretaryConfig(env) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .bind(SECRETARY_CONFIG_KEY)
    .first();
  const saved = safeJsonParse(row?.value_json, {}) || {};
  const envChannel = getConfiguredLogChannelId(env);

  return {
    enabled: Boolean(saved.enabled),
    manuallyDisabled: Boolean(saved.manuallyDisabled),
    channelInput: String(saved.channelInput || envChannel || '').trim(),
    resolvedChatId: String(saved.resolvedChatId || '').trim(),
    channelTitle: String(saved.channelTitle || 'PnA X Logs'),
    channelUsername: String(saved.channelUsername || '').trim(),
    verifiedAdmin: Boolean(saved.verifiedAdmin),
    verifiedAt: saved.verifiedAt ? toInt(saved.verifiedAt) : null,
    lastVerifyAttemptAt: saved.lastVerifyAttemptAt ? toInt(saved.lastVerifyAttemptAt) : null,
    lastError: String(saved.lastError || ''),
  };
}

export async function saveSecretaryConfig(env, patch) {
  const db = assertDB(env);
  const current = await getSecretaryConfig(env);
  const merged = {
    ...current,
    ...patch,
  };
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .bind(SECRETARY_CONFIG_KEY, JSON.stringify(merged), now)
    .run();
  return merged;
}

export async function claimSecretaryLogEntry(
  env,
  { id, dedupKey, eventType, channelId = '', messageText, createdAt = Date.now() }
) {
  const db = assertDB(env);
  const logId = String(id || generateId('SEC'));
  const dKey = String(dedupKey);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO secretary_logs (
        id, dedup_key, event_type, channel_id, message_text,
        status, attempts, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, '', ?, ?)`
    )
    .bind(logId, dKey, String(eventType), String(channelId), String(messageText), createdAt, createdAt)
    .run();

  if (Number(res?.meta?.changes ?? 0) > 0) {
    return { claimed: true, id: logId, existingStatus: null };
  }

  const existing = await db
    .prepare('SELECT id, status FROM secretary_logs WHERE dedup_key = ?')
    .bind(dKey)
    .first();
  return {
    claimed: false,
    id: existing ? String(existing.id) : logId,
    existingStatus: existing ? String(existing.status) : 'unknown',
  };
}

export async function markSecretaryLogSent(
  env,
  logId,
  { channelId = '', telegramMessageId = null, sentAt = Date.now() } = {}
) {
  const db = assertDB(env);
  await db
    .prepare(
      `UPDATE secretary_logs
       SET status = 'sent',
           channel_id = CASE WHEN ? <> '' THEN ? ELSE channel_id END,
           attempts = attempts + 1,
           telegram_message_id = ?,
           last_error = '',
           sent_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(String(channelId), String(channelId), telegramMessageId, sentAt, sentAt, String(logId))
    .run();
}

export async function markSecretaryLogFailed(
  env,
  logId,
  { channelId = '', errorMessage = 'Delivery failed', now = Date.now() } = {}
) {
  const db = assertDB(env);
  await db
    .prepare(
      `UPDATE secretary_logs
       SET status = 'failed',
           channel_id = CASE WHEN ? <> '' THEN ? ELSE channel_id END,
           attempts = attempts + 1,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      String(channelId),
      String(channelId),
      String(errorMessage || 'Delivery failed').slice(0, 400),
      now,
      String(logId)
    )
    .run();
}

export async function markSecretaryLogSkipped(env, logId, reason = 'Secretary Mode disabled') {
  const db = assertDB(env);
  const now = Date.now();
  await db
    .prepare(
      `UPDATE secretary_logs
       SET status = 'skipped',
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(String(reason || '').slice(0, 300), now, String(logId))
    .run();
}

export async function getFailedSecretaryLogs(env, limit = 10) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT * FROM secretary_logs
       WHERE status = 'failed'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(Math.max(1, toInt(limit, 10)))
    .all();
  return (res.results || []).map((row) => ({
    id: String(row.id),
    dedupKey: String(row.dedup_key),
    eventType: String(row.event_type),
    channelId: row.channel_id || '',
    messageText: row.message_text || '',
    status: String(row.status),
    attempts: toNonNegInt(row.attempts),
    lastError: row.last_error || '',
    createdAt: toInt(row.created_at),
  }));
}

export async function getSecretaryLogStats(env) {
  const db = assertDB(env);
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_cnt,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_cnt,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_cnt
       FROM secretary_logs`
    )
    .first();
  return {
    total: toNonNegInt(row?.total),
    sent: toNonNegInt(row?.sent_cnt),
    failed: toNonNegInt(row?.failed_cnt),
    skipped: toNonNegInt(row?.skipped_cnt),
  };
}

// ============================================================================
// TELEGRAM MINI APP DEVICE VERIFICATION, CLUSTERS & REFERRAL REVIEWS (D1)
// ============================================================================

function mapDeviceVerificationRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    telegramAuthDate: toInt(row.telegram_auth_date),
    initDataHash: String(row.init_data_hash),
    strictFpHash: String(row.strict_fp_hash),
    fuzzyFpHash: String(row.fuzzy_fp_hash),
    signalHashes: safeJsonParse(row.signal_hashes_json, {}),
    ipHash: row.ip_hash || '',
    ipSubnetHash: row.ip_subnet_hash || '',
    countryCode: row.country_code || '',
    asn: row.asn || '',
    asnOrg: row.asn_org || '',
    proxyVpnFlag: Boolean(row.proxy_vpn_flag),
    datacenterFlag: Boolean(row.datacenter_flag),
    riskScore: toNonNegInt(row.risk_score),
    riskReasons: safeJsonParse(row.risk_reasons_json, []),
    verdict: String(row.verdict),
    verifiedTokenJti: row.verified_token_jti || null,
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  };
}

function mapReferralReviewRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    referredUserId: String(row.referred_user_id),
    referrerId: String(row.referrer_id),
    verificationId: String(row.verification_id),
    clusterFpHash: row.cluster_fp_hash || '',
    matchedUserIds: safeJsonParse(row.matched_user_ids_json, []),
    riskScore: toNonNegInt(row.risk_score),
    riskReasons: safeJsonParse(row.risk_reasons_json, []),
    status: String(row.status),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewedAt:
      row.reviewed_at !== null && row.reviewed_at !== undefined
        ? toInt(row.reviewed_at)
        : null,
    reviewNote: row.review_note || '',
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  };
}

export async function createVerificationChallenge(
  env,
  { nonceHash, userId, ipHash = '', expiresAt, createdAt = Date.now() }
) {
  const db = assertDB(env);
  await db
    .prepare(
      `INSERT INTO verification_challenges (nonce_hash, user_id, ip_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    .bind(String(nonceHash), String(userId), String(ipHash), toInt(expiresAt), toInt(createdAt))
    .run();
}

/**
 * Atomically consume a single-use challenge nonce for the given user if unexpired and unused.
 */
export async function consumeVerificationChallenge(env, nonceHash, userId, now = Date.now()) {
  const db = assertDB(env);
  const res = await db
    .prepare(
      `UPDATE verification_challenges
       SET used_at = ?
       WHERE nonce_hash = ?
         AND user_id = ?
         AND used_at IS NULL
         AND expires_at >= ?`
    )
    .bind(toInt(now), String(nonceHash), String(userId), toInt(now))
    .run();
  return Number(res?.meta?.changes ?? 0) > 0;
}

export async function countRecentVerificationAttemptsByUser(env, userId, sinceMs) {
  const db = assertDB(env);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM device_verifications
       WHERE user_id = ? AND created_at >= ?`
    )
    .bind(String(userId), toInt(sinceMs))
    .first();
  return toNonNegInt(row?.cnt);
}

export async function countRecentDistinctUsersByIp(env, ipHash, sinceMs, excludeUserId) {
  if (!ipHash) return 0;
  const db = assertDB(env);
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) AS cnt FROM device_verifications
       WHERE ip_hash = ? AND created_at >= ? AND user_id <> ?`
    )
    .bind(String(ipHash), toInt(sinceMs), String(excludeUserId))
    .first();
  return toNonNegInt(row?.cnt);
}

export async function findOtherUsersByFingerprint(env, fingerprintType, fingerprintHash, excludeUserId) {
  if (!fingerprintHash) return [];
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT user_id, first_seen_at, last_seen_at, seen_count
       FROM device_fingerprint_accounts
       WHERE fingerprint_type = ? AND fingerprint_hash = ? AND user_id <> ?
       ORDER BY last_seen_at DESC
       LIMIT 25`
    )
    .bind(String(fingerprintType), String(fingerprintHash), String(excludeUserId))
    .all();
  return (res.results || []).map((r) => ({
    userId: String(r.user_id),
    firstSeenAt: toInt(r.first_seen_at),
    lastSeenAt: toInt(r.last_seen_at),
    seenCount: toNonNegInt(r.seen_count),
  }));
}

export async function findOtherUsersBySignal(env, signalType, signalHash, excludeUserId) {
  if (!signalType || !signalHash) return [];
  const db = assertDB(env);
  try {
    const res = await db
      .prepare(
        `SELECT user_id, first_seen_at, last_seen_at, seen_count
         FROM device_signal_links
         WHERE signal_type = ? AND signal_hash = ? AND user_id <> ?
         ORDER BY last_seen_at DESC
         LIMIT 25`
      )
      .bind(String(signalType), String(signalHash), String(excludeUserId))
      .all();
    return (res.results || []).map((r) => ({
      userId: String(r.user_id),
      firstSeenAt: toInt(r.first_seen_at),
      lastSeenAt: toInt(r.last_seen_at),
      seenCount: toNonNegInt(r.seen_count),
    }));
  } catch (err) {
    // Graceful backward compatibility if migration 0003 has not been applied yet
    if (String(err?.message || '').includes('no such table')) {
      return [];
    }
    throw err;
  }
}

export async function getUserDeviceSignalSummary(env, userId) {
  const db = assertDB(env);
  const summary = {
    installTokens: new Set(),
    strictFps: new Set(),
    renderCores: new Set(),
    hardwareCores: new Set(),
    biometricIds: new Set(),
    accountStorageIds: new Set(),
  };
  try {
    const res = await db
      .prepare(
        `SELECT signal_type, signal_hash
         FROM device_signal_links
         WHERE user_id = ?
         ORDER BY last_seen_at DESC
         LIMIT 100`
      )
      .bind(String(userId))
      .all();
    for (const r of res.results || []) {
      const t = String(r.signal_type || '');
      const h = String(r.signal_hash || '');
      if (!h) continue;
      if (t === 'install_token') summary.installTokens.add(h);
      else if (t === 'strict_fp') summary.strictFps.add(h);
      else if (t === 'render_core') summary.renderCores.add(h);
      else if (t === 'hardware_core') summary.hardwareCores.add(h);
      else if (t === 'tg_biometric_id') summary.biometricIds.add(h);
      else if (t === 'account_storage_id') summary.accountStorageIds.add(h);
    }
  } catch (err) {
    if (!String(err?.message || '').includes('no such table')) {
      throw err;
    }
  }
  return summary;
}

export async function findOtherUsersByIpSubnet(env, ipSubnetHash, excludeUserId, sinceMs) {
  if (!ipSubnetHash) return [];
  const db = assertDB(env);
  const res = await db
    .prepare(
      `SELECT DISTINCT user_id FROM device_verifications
       WHERE ip_subnet_hash = ? AND user_id <> ? AND created_at >= ?
       LIMIT 25`
    )
    .bind(String(ipSubnetHash), String(excludeUserId), toInt(sinceMs))
    .all();
  return (res.results || []).map((r) => String(r.user_id));
}

export async function getDeviceVerificationByInitDataHash(env, initDataHash) {
  if (!initDataHash) return null;
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM device_verifications WHERE init_data_hash = ?')
    .bind(String(initDataHash))
    .first();
  return mapDeviceVerificationRow(row);
}

export async function getLatestUserDeviceVerification(env, userId) {
  const db = assertDB(env);
  const row = await db
    .prepare(
      `SELECT * FROM device_verifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(String(userId))
    .first();
  return mapDeviceVerificationRow(row);
}

export async function getUserReferralReview(env, referredUserId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM referral_reviews WHERE referred_user_id = ?')
    .bind(String(referredUserId))
    .first();
  return mapReferralReviewRow(row);
}

export async function getReferralReviewById(env, reviewId) {
  const db = assertDB(env);
  const row = await db
    .prepare('SELECT * FROM referral_reviews WHERE id = ?')
    .bind(String(reviewId))
    .first();
  return mapReferralReviewRow(row);
}

/**
 * Observation-only atomic persistence for grandfathered, verified, and admin accounts.
 * Records cross-account device associations into `device_signal_links`,
 * `device_fingerprint_accounts`, and `verification_audit_logs` WITHOUT EVER
 * changing `users.device_verification_status`, balances, referrals, or access.
 */
export async function recordDeviceObservationAtomic(
  env,
  {
    userId,
    strictFpHash = '',
    fuzzyFpHash = '',
    signalLinks = [],
    ipHash = '',
    countryCode = '',
    observedStatus = 'grandfathered',
    details = {},
    now = Date.now(),
  }
) {
  const db = assertDB(env);
  const uid = String(userId);
  const auditId = generateId('VAUD');
  const statements = [];

  if (strictFpHash) {
    statements.push(
      db
        .prepare(
          `INSERT INTO device_fingerprint_accounts (
            fingerprint_type, fingerprint_hash, user_id, first_seen_at, last_seen_at, seen_count
          ) VALUES ('strict', ?, ?, ?, ?, 1)
          ON CONFLICT(fingerprint_type, fingerprint_hash, user_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            seen_count = device_fingerprint_accounts.seen_count + 1`
        )
        .bind(String(strictFpHash), uid, now, now)
    );
  }

  if (fuzzyFpHash) {
    statements.push(
      db
        .prepare(
          `INSERT INTO device_fingerprint_accounts (
            fingerprint_type, fingerprint_hash, user_id, first_seen_at, last_seen_at, seen_count
          ) VALUES ('fuzzy', ?, ?, ?, ?, 1)
          ON CONFLICT(fingerprint_type, fingerprint_hash, user_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            seen_count = device_fingerprint_accounts.seen_count + 1`
        )
        .bind(String(fuzzyFpHash), uid, now, now)
    );
  }

  const dedupedLinks = [];
  const seenKey = new Set();
  for (const item of signalLinks || []) {
    if (!item?.signalType || !item?.signalHash) continue;
    const k = `${item.signalType}:${item.signalHash}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    dedupedLinks.push(item);
  }

  for (const item of dedupedLinks) {
    statements.push(
      db
        .prepare(
          `INSERT INTO device_signal_links (
            signal_type, signal_hash, user_id, first_seen_at, last_seen_at, seen_count
          ) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(signal_type, signal_hash, user_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            seen_count = device_signal_links.seen_count + 1`
        )
        .bind(String(item.signalType), String(item.signalHash), uid, now, now)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO verification_audit_logs (
          id, event_type, user_id, actor_id, verification_id, review_id,
          verdict, risk_score, details_json, created_at
        ) VALUES (?, 'DEVICE_OBSERVED', ?, 'system', NULL, NULL, ?, 0, ?, ?)`
      )
      .bind(
        auditId,
        uid,
        String(observedStatus || 'grandfathered'),
        JSON.stringify({
          observeOnly: true,
          signalTypes: dedupedLinks.map((x) => x.signalType),
          hasIpHash: Boolean(ipHash),
          countryCode: String(countryCode || ''),
          ...(details || {}),
        }),
        now
      )
  );

  try {
    await db.batch(statements);
    return { ok: true, auditId, recordedSignals: dedupedLinks.length };
  } catch (err) {
    // Fallback if migration 0003 table does not exist yet: still write legacy tables + audit
    if (String(err?.message || '').includes('no such table') && dedupedLinks.length > 0) {
      const fallbackStmts = statements.filter(
        (_, idx) => idx < (strictFpHash ? 1 : 0) + (fuzzyFpHash ? 1 : 0) || idx === statements.length - 1
      );
      await db.batch(fallbackStmts);
      return { ok: true, auditId, recordedSignals: 0, legacyFallback: true };
    }
    throw err;
  }
}

/**
 * Atomically persist a device verification attempt, update fingerprint & multi-signal
 * cluster mappings, update the user's verification status, enqueue a suspicious referral
 * review if applicable, and append an immutable verification audit log entry.
 */
export async function recordDeviceVerificationAtomic(
  env,
  {
    verificationId,
    userId,
    telegramAuthDate,
    initDataHash,
    strictFpHash,
    fuzzyFpHash,
    signalLinks = [],
    signalHashes = {},
    ipHash = '',
    ipSubnetHash = '',
    countryCode = '',
    asn = '',
    asnOrg = '',
    proxyVpnFlag = false,
    datacenterFlag = false,
    riskScore = 0,
    riskReasons = [],
    verdict,
    referralDecision = 'no_referrer',
    holdReferralReview = false,
    verifiedTokenJti = null,
    pendingReferrerId = null,
    matchedUserIds = [],
    matchedSignalTypes = [],
    now = Date.now(),
  }
) {
  const db = assertDB(env);
  const uid = String(userId);
  const safeScore = Math.max(0, Math.min(100, toInt(riskScore, 0)));
  const verifiedAt = verdict === 'verified' ? now : null;
  const auditId = generateId('VAUD');
  const shouldCreateReview =
    Boolean(pendingReferrerId) &&
    (Boolean(holdReferralReview) || verdict === 'pending_review' || verdict === 'rejected');
  const reviewId = shouldCreateReview ? generateId('RREV') : null;

  const dedupedLinks = [];
  const seenKey = new Set();
  for (const item of signalLinks || []) {
    if (!item?.signalType || !item?.signalHash) continue;
    const k = `${item.signalType}:${item.signalHash}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    dedupedLinks.push(item);
  }

  const baseStatements = [
    db
      .prepare(
        `INSERT INTO device_verifications (
          id, user_id, telegram_auth_date, init_data_hash, strict_fp_hash, fuzzy_fp_hash,
          signal_hashes_json, ip_hash, ip_subnet_hash, country_code, asn, asn_org,
          proxy_vpn_flag, datacenter_flag, risk_score, risk_reasons_json,
          verdict, verified_token_jti, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        String(verificationId),
        uid,
        toInt(telegramAuthDate),
        String(initDataHash),
        String(strictFpHash),
        String(fuzzyFpHash),
        JSON.stringify(signalHashes || {}),
        String(ipHash),
        String(ipSubnetHash),
        String(countryCode).slice(0, 16),
        String(asn).slice(0, 32),
        String(asnOrg).slice(0, 120),
        proxyVpnFlag ? 1 : 0,
        datacenterFlag ? 1 : 0,
        safeScore,
        JSON.stringify(riskReasons || []),
        String(verdict),
        verifiedTokenJti ? String(verifiedTokenJti) : null,
        now,
        now
      ),

    db
      .prepare(
        `INSERT INTO device_fingerprint_accounts (
          fingerprint_type, fingerprint_hash, user_id, first_seen_at, last_seen_at, seen_count
        ) VALUES ('strict', ?, ?, ?, ?, 1)
        ON CONFLICT(fingerprint_type, fingerprint_hash, user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          seen_count = device_fingerprint_accounts.seen_count + 1`
      )
      .bind(String(strictFpHash), uid, now, now),

    db
      .prepare(
        `INSERT INTO device_fingerprint_accounts (
          fingerprint_type, fingerprint_hash, user_id, first_seen_at, last_seen_at, seen_count
        ) VALUES ('fuzzy', ?, ?, ?, ?, 1)
        ON CONFLICT(fingerprint_type, fingerprint_hash, user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          seen_count = device_fingerprint_accounts.seen_count + 1`
      )
      .bind(String(fuzzyFpHash), uid, now, now),

    db
      .prepare(
        `UPDATE users
         SET device_verification_status = ?,
             device_verified_at = CASE WHEN ? IS NOT NULL THEN ? ELSE device_verified_at END,
             device_risk_score = ?,
             device_fingerprint_hash = ?
         WHERE telegram_id = ?
           AND device_verification_status NOT IN ('verified', 'grandfathered')`
      )
      .bind(String(verdict), verifiedAt, verifiedAt, safeScore, String(strictFpHash), uid),
  ];

  const signalStatements = dedupedLinks.map((item) =>
    db
      .prepare(
        `INSERT INTO device_signal_links (
          signal_type, signal_hash, user_id, first_seen_at, last_seen_at, seen_count
        ) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(signal_type, signal_hash, user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          seen_count = device_signal_links.seen_count + 1`
      )
      .bind(String(item.signalType), String(item.signalHash), uid, now, now)
  );

  const tailStatements = [];

  if (verdict === 'verified' && !shouldCreateReview) {
    tailStatements.push(
      db
        .prepare(
          `UPDATE referral_reviews
           SET status = 'approved',
               reviewed_by = 'system_retry',
               reviewed_at = ?,
               review_note = 'Auto-cleared after clean retry verification',
               updated_at = ?
           WHERE referred_user_id = ? AND status = 'pending'`
        )
        .bind(now, now, uid)
    );
  }

  if (reviewId && pendingReferrerId) {
    tailStatements.push(
      db
        .prepare(
          `INSERT INTO referral_reviews (
            id, referred_user_id, referrer_id, verification_id, cluster_fp_hash,
            matched_user_ids_json, risk_score, risk_reasons_json, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(referred_user_id) DO UPDATE SET
            verification_id = excluded.verification_id,
            cluster_fp_hash = excluded.cluster_fp_hash,
            matched_user_ids_json = excluded.matched_user_ids_json,
            risk_score = excluded.risk_score,
            risk_reasons_json = excluded.risk_reasons_json,
            updated_at = excluded.updated_at
          WHERE referral_reviews.status = 'pending'`
        )
        .bind(
          reviewId,
          uid,
          String(pendingReferrerId),
          String(verificationId),
          String(strictFpHash),
          JSON.stringify(matchedUserIds || []),
          safeScore,
          JSON.stringify(riskReasons || []),
          now,
          now
        )
    );
  }

  tailStatements.push(
    db
      .prepare(
        `INSERT INTO verification_audit_logs (
          id, event_type, user_id, actor_id, verification_id, review_id,
          verdict, risk_score, details_json, created_at
        ) VALUES (?, ?, ?, 'system', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        auditId,
        `DEVICE_VERIFY_${String(verdict).toUpperCase()}`,
        uid,
        String(verificationId),
        reviewId,
        String(verdict),
        safeScore,
        JSON.stringify({
          reasons: riskReasons || [],
          referralDecision: String(referralDecision || 'no_referrer'),
          matchedUserCount: Array.isArray(matchedUserIds) ? matchedUserIds.length : 0,
          matchedSignalTypes: Array.isArray(matchedSignalTypes) ? matchedSignalTypes : [],
          countryCode: String(countryCode || ''),
          proxyVpnFlag: Boolean(proxyVpnFlag),
          datacenterFlag: Boolean(datacenterFlag),
        }),
        now
      )
  );

  try {
    await db.batch([...baseStatements, ...signalStatements, ...tailStatements]);
    return { ok: true, verificationId, reviewId, auditId };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE') && msg.includes('init_data_hash')) {
      return { ok: false, replay: true, error: 'Duplicate or replayed Telegram verification payload.' };
    }
    if (msg.includes('no such table') && signalStatements.length > 0) {
      await db.batch([...baseStatements, ...tailStatements]);
      return { ok: true, verificationId, reviewId, auditId, legacyFallback: true };
    }
    throw err;
  }
}

/**
 * Atomically resolve a pending referral review (`approved` or `rejected`) inside ONE single
 * Cloudflare D1 transaction batch (`db.batch()`):
 *   - On `approved`: updates `referral_reviews`, verifies user, and (if eligible) atomically
 *     inserts `referral_claims`, `referrals`, credits referrer balance & referral totals,
 *     appends immutable `ledger` entry, and appends immutable `verification_audit_logs`.
 *   - On `rejected`: updates `referral_reviews`, marks user `'rejected'`, clears
 *     `pending_referrer_id`, and appends immutable `verification_audit_logs`.
 */
export async function resolveReferralReviewAtomic(
  env,
  { reviewId, decision, adminId, note = '', rewardPaise = null, now = Date.now() }
) {
  const db = assertDB(env);
  const review = await getReferralReviewById(env, reviewId);
  if (!review) {
    return { ok: false, error: 'Referral review record not found.' };
  }
  if (review.status !== 'pending') {
    return { ok: false, alreadyProcessed: true, review, error: `Review is already ${review.status}.` };
  }

  const normalizedDecision = decision === 'approved' ? 'approved' : 'rejected';
  const nextUserStatus = normalizedDecision === 'approved' ? 'verified' : 'rejected';
  const verifiedAt = normalizedDecision === 'approved' ? now : null;
  const auditId = generateId('VAUD');

  const [referredUser, referrerUser, existingClaim, settings] = await Promise.all([
    getUser(env, review.referredUserId),
    getUser(env, review.referrerId),
    getReferralClaim(env, review.referredUserId),
    rewardPaise === null ? getSettings(env) : Promise.resolve(null),
  ]);

  const safeRewardPaise =
    rewardPaise !== null
      ? toNonNegInt(rewardPaise)
      : toNonNegInt(settings?.referralRewardPaise ?? 300);

  const shouldCreditReferral =
    normalizedDecision === 'approved' &&
    Boolean(referredUser) &&
    Boolean(referrerUser) &&
    referrerUser.status !== 'banned' &&
    review.referrerId !== review.referredUserId &&
    !referredUser.referralCredited &&
    !referredUser.referredBy &&
    !existingClaim;

  const statements = [
    db
      .prepare(
        `UPDATE referral_reviews
         SET status = ?,
             reviewed_by = ?,
             reviewed_at = ?,
             review_note = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(
        normalizedDecision,
        String(adminId),
        now,
        String(note || '').slice(0, 300),
        now,
        String(reviewId)
      ),
  ];

  if (shouldCreditReferral) {
    const referralRowId = generateId('REF');
    const ledgerId = generateId('LDG');
    const referredName =
      [referredUser.firstName || '', referredUser.lastName || ''].join(' ').trim() ||
      'Telegram User';
    const referredUsername = referredUser.username || '';

    statements.push(
      db
        .prepare(
          `INSERT INTO referral_claims (referred_user_id, referrer_id, amount_paise, credited_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(review.referredUserId, review.referrerId, safeRewardPaise, now),

      db
        .prepare(
          `INSERT INTO referrals (id, referrer_id, referred_user_id, referred_name, referred_username, amount_paise, credited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          referralRowId,
          review.referrerId,
          review.referredUserId,
          referredName,
          referredUsername,
          safeRewardPaise,
          now
        ),

      db
        .prepare(
          `UPDATE users
           SET device_verification_status = 'verified',
               device_verified_at = ?,
               referred_by = ?,
               pending_referrer_id = NULL,
               referral_credited = 1
           WHERE telegram_id = ?`
        )
        .bind(now, review.referrerId, review.referredUserId),

      db
        .prepare(
          `UPDATE users
           SET balance_paise = balance_paise + ?,
               total_earned_paise = total_earned_paise + ?,
               referral_earnings_paise = referral_earnings_paise + ?,
               total_referrals = total_referrals + 1
           WHERE telegram_id = ?`
        )
        .bind(safeRewardPaise, safeRewardPaise, safeRewardPaise, review.referrerId)
    );

    if (safeRewardPaise > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO ledger (
              id, user_id, entry_type, direction, amount_paise,
              balance_before_paise, balance_after_paise,
              reference_type, reference_id, description, created_at
            )
            SELECT ?, telegram_id, 'referral_credit', 'credit', ?,
                   balance_paise - ?, balance_paise,
                   'referral', ?, ?, ?
            FROM users
            WHERE telegram_id = ?`
          )
          .bind(
            ledgerId,
            safeRewardPaise,
            safeRewardPaise,
            review.referredUserId,
            `Referral reward (admin approved review ${review.id}) for user ${review.referredUserId}`,
            now,
            review.referrerId
          )
      );
    }
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE users
           SET device_verification_status = ?,
               device_verified_at = CASE WHEN ? IS NOT NULL THEN ? ELSE device_verified_at END,
               pending_referrer_id = CASE WHEN ? = 'rejected' THEN NULL ELSE pending_referrer_id END
           WHERE telegram_id = ?`
        )
        .bind(nextUserStatus, verifiedAt, verifiedAt, normalizedDecision, review.referredUserId)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO verification_audit_logs (
          id, event_type, user_id, actor_id, verification_id, review_id,
          verdict, risk_score, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        auditId,
        normalizedDecision === 'approved' ? 'REFERRAL_REVIEW_APPROVED' : 'REFERRAL_REVIEW_REJECTED',
        review.referredUserId,
        String(adminId),
        review.verificationId,
        review.id,
        nextUserStatus,
        review.riskScore,
        JSON.stringify({
          referrerId: review.referrerId,
          referralCredited: shouldCreditReferral,
          amountPaise: shouldCreditReferral ? safeRewardPaise : 0,
          note: String(note || '').slice(0, 300),
          matchedUserIds: review.matchedUserIds,
        }),
        now
      )
  );

  let batchRes;
  try {
    batchRes = await db.batch(statements);
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY') || msg.includes('CONSTRAINT')) {
      return { ok: false, alreadyProcessed: true, error: 'Referral was already claimed or processed concurrently.' };
    }
    throw err;
  }

  const reviewUpdated = Number(batchRes?.[0]?.meta?.changes ?? 0) > 0;
  if (!reviewUpdated) {
    return { ok: false, alreadyProcessed: true, error: 'Review was already resolved concurrently.' };
  }

  const [updatedReview, updatedUser, updatedReferrer] = await Promise.all([
    getReferralReviewById(env, reviewId),
    getUser(env, review.referredUserId),
    getUser(env, review.referrerId),
  ]);

  return {
    ok: true,
    review: updatedReview,
    user: updatedUser,
    referrer: updatedReferrer,
    referralCredited: shouldCreditReferral,
    amountPaise: shouldCreditReferral ? safeRewardPaise : 0,
    auditId,
  };
}

export async function getDeviceVerificationStats(env) {
  const db = assertDB(env);
  const [userCounts, reviewCounts, attemptsRow] = await Promise.all([
    db
      .prepare(
        `SELECT
          SUM(CASE WHEN device_verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_cnt,
          SUM(CASE WHEN device_verification_status = 'grandfathered' THEN 1 ELSE 0 END) AS grandfathered_cnt,
          SUM(CASE WHEN device_verification_status = 'unverified' THEN 1 ELSE 0 END) AS unverified_cnt,
          SUM(CASE WHEN device_verification_status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review_cnt,
          SUM(CASE WHEN device_verification_status = 'rejected' THEN 1 ELSE 0 END) AS rejected_cnt
         FROM users`
      )
      .first(),
    db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_cnt,
          SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_cnt
         FROM referral_reviews`
      )
      .first(),
    db.prepare('SELECT COUNT(*) AS attempts_cnt FROM device_verifications').first(),
  ]);

  let duplicateClusters = 0;
  try {
    const clusterRow = await db
      .prepare(
        `SELECT COUNT(*) AS cluster_cnt FROM (
          SELECT signal_type, signal_hash
          FROM device_signal_links
          WHERE signal_type IN ('install_token', 'strict_fp', 'render_core', 'tg_biometric_id')
          GROUP BY signal_type, signal_hash
          HAVING COUNT(DISTINCT user_id) > 1
          UNION
          SELECT 'strict_fp' AS signal_type, fingerprint_hash AS signal_hash
          FROM device_fingerprint_accounts
          WHERE fingerprint_type = 'strict'
          GROUP BY fingerprint_hash
          HAVING COUNT(DISTINCT user_id) > 1
        )`
      )
      .first();
    duplicateClusters = toNonNegInt(clusterRow?.cluster_cnt);
  } catch (err) {
    if (String(err?.message || '').includes('no such table')) {
      const legacyRow = await db
        .prepare(
          `SELECT COUNT(*) AS cluster_cnt FROM (
            SELECT fingerprint_hash
            FROM device_fingerprint_accounts
            WHERE fingerprint_type = 'strict'
            GROUP BY fingerprint_hash
            HAVING COUNT(DISTINCT user_id) > 1
          )`
        )
        .first();
      duplicateClusters = toNonNegInt(legacyRow?.cluster_cnt);
    } else {
      throw err;
    }
  }

  return {
    verifiedUsers: toNonNegInt(userCounts?.verified_cnt),
    grandfatheredUsers: toNonNegInt(userCounts?.grandfathered_cnt),
    unverifiedUsers: toNonNegInt(userCounts?.unverified_cnt),
    pendingReviewUsers: toNonNegInt(userCounts?.pending_review_cnt),
    rejectedUsers: toNonNegInt(userCounts?.rejected_cnt),
    pendingReferralReviews: toNonNegInt(reviewCounts?.pending_cnt),
    approvedReferralReviews: toNonNegInt(reviewCounts?.approved_cnt),
    rejectedReferralReviews: toNonNegInt(reviewCounts?.rejected_cnt),
    duplicateDeviceClusters: duplicateClusters,
    totalAttempts: toNonNegInt(attemptsRow?.attempts_cnt),
  };
}

export async function getPendingReferralReviewsPage(env, page = 1, pageSize = 5) {
  const db = assertDB(env);
  const countRow = await db
    .prepare("SELECT COUNT(*) AS cnt FROM referral_reviews WHERE status = 'pending'")
    .first();
  const total = toNonNegInt(countRow?.cnt);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(toInt(page, 1), totalPages));
  const offset = (safePage - 1) * pageSize;

  const res = await db
    .prepare(
      `SELECT * FROM referral_reviews
       WHERE status = 'pending'
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(pageSize, offset)
    .all();

  return {
    total,
    totalPages,
    page: safePage,
    items: (res.results || []).map(mapReferralReviewRow),
  };
}

export async function getSuspiciousDeviceClustersPage(env, page = 1, pageSize = 5) {
  const db = assertDB(env);

  try {
    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM (
          SELECT signal_type, signal_hash
          FROM device_signal_links
          WHERE signal_type IN ('install_token', 'strict_fp', 'render_core', 'tg_biometric_id')
          GROUP BY signal_type, signal_hash
          HAVING COUNT(DISTINCT user_id) > 1
          UNION
          SELECT 'strict_fp' AS signal_type, fingerprint_hash AS signal_hash
          FROM device_fingerprint_accounts
          WHERE fingerprint_type = 'strict'
          GROUP BY fingerprint_hash
          HAVING COUNT(DISTINCT user_id) > 1
        )`
      )
      .first();

    const total = toNonNegInt(countRow?.cnt);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(toInt(page, 1), totalPages));
    const offset = (safePage - 1) * pageSize;

    const res = await db
      .prepare(
        `WITH combined_links AS (
          SELECT signal_type, signal_hash, user_id, last_seen_at
          FROM device_signal_links
          WHERE signal_type IN ('install_token', 'strict_fp', 'render_core', 'tg_biometric_id')
          UNION
          SELECT 'strict_fp' AS signal_type, fingerprint_hash AS signal_hash, user_id, last_seen_at
          FROM device_fingerprint_accounts
          WHERE fingerprint_type = 'strict'
        )
        SELECT
          cl.signal_type,
          cl.signal_hash AS fingerprint_hash,
          COUNT(DISTINCT cl.user_id) AS account_count,
          GROUP_CONCAT(DISTINCT cl.user_id) AS user_ids,
          MAX(cl.last_seen_at) AS last_seen_at,
          MAX(COALESCE(u.device_risk_score, 0)) AS max_risk_score,
          SUM(CASE WHEN u.referred_by IS NOT NULL OR u.pending_referrer_id IS NOT NULL THEN 1 ELSE 0 END) AS referred_member_cnt
        FROM combined_links cl
        LEFT JOIN users u ON u.telegram_id = cl.user_id
        GROUP BY cl.signal_type, cl.signal_hash
        HAVING COUNT(DISTINCT cl.user_id) > 1
        ORDER BY
          CASE cl.signal_type
            WHEN 'install_token' THEN 1
            WHEN 'strict_fp' THEN 2
            WHEN 'render_core' THEN 3
            ELSE 4
          END ASC,
          account_count DESC,
          last_seen_at DESC
        LIMIT ? OFFSET ?`
      )
      .bind(pageSize, offset)
      .all();

    return {
      total,
      totalPages,
      page: safePage,
      items: (res.results || []).map((row) => ({
        signalType: String(row.signal_type || 'strict_fp'),
        fingerprintHash: String(row.fingerprint_hash),
        accountCount: toNonNegInt(row.account_count),
        userIds: String(row.user_ids || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        lastSeenAt: toInt(row.last_seen_at),
        maxRiskScore: toNonNegInt(row.max_risk_score),
        hasReferralLink: toNonNegInt(row.referred_member_cnt) > 0,
      })),
    };
  } catch (err) {
    if (!String(err?.message || '').includes('no such table')) {
      throw err;
    }

    // Backward-compatible fallback if migration 0003 has not been applied yet
    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM (
          SELECT fingerprint_hash
          FROM device_fingerprint_accounts
          WHERE fingerprint_type = 'strict'
          GROUP BY fingerprint_hash
          HAVING COUNT(DISTINCT user_id) > 1
        )`
      )
      .first();
    const total = toNonNegInt(countRow?.cnt);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(toInt(page, 1), totalPages));
    const offset = (safePage - 1) * pageSize;

    const res = await db
      .prepare(
        `SELECT
          dfa.fingerprint_hash,
          COUNT(DISTINCT dfa.user_id) AS account_count,
          GROUP_CONCAT(dfa.user_id, ',') AS user_ids,
          MAX(dfa.last_seen_at) AS last_seen_at,
          MAX(COALESCE(u.device_risk_score, 0)) AS max_risk_score,
          SUM(CASE WHEN u.referred_by IS NOT NULL OR u.pending_referrer_id IS NOT NULL THEN 1 ELSE 0 END) AS referred_member_cnt
         FROM device_fingerprint_accounts dfa
         LEFT JOIN users u ON u.telegram_id = dfa.user_id
         WHERE dfa.fingerprint_type = 'strict'
         GROUP BY dfa.fingerprint_hash
         HAVING COUNT(DISTINCT dfa.user_id) > 1
         ORDER BY account_count DESC, last_seen_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(pageSize, offset)
      .all();

    return {
      total,
      totalPages,
      page: safePage,
      items: (res.results || []).map((row) => ({
        signalType: 'strict_fp',
        fingerprintHash: String(row.fingerprint_hash),
        accountCount: toNonNegInt(row.account_count),
        userIds: String(row.user_ids || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        lastSeenAt: toInt(row.last_seen_at),
        maxRiskScore: toNonNegInt(row.max_risk_score),
        hasReferralLink: toNonNegInt(row.referred_member_cnt) > 0,
      })),
    };
  }
}


