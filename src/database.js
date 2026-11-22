// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Cloudflare Workers KV Storage Layer (env.DB ONLY)
// ============================================================================
// Logical collections mapped cleanly to KV key prefixes:
//   settings:global               -> Global configurable bot settings
//   user:<telegramId>             -> User profile, balances, referrals, status
//   users:index                   -> Ordered array of registered user IDs
//   state:<telegramId>            -> Short-lived user/admin conversation state
//   ref_claim:<referredId>        -> Idempotency record (1 referral per account)
//   referrals:<referrerId>        -> Array of referrals earned by referrer
//   daily_claims:<telegramId>     -> User daily bonus claim history
//   voucher:<voucherId>           -> Individual voucher record
//   vcode:<hash>                  -> Global duplicate voucher protection index
//   vouchers:cat:<category>       -> Per-category voucher ID index
//   vhist:<historyId>             -> Permanent delivered voucher record
//   voucher_history:index         -> Global delivered voucher ID list
//   user_vhist:<telegramId>       -> Per-user delivered voucher ID list
//   withdrawal:<requestId>        -> Withdrawal request record
//   withdrawals:pending           -> Pending withdrawal IDs
//   withdrawals:all               -> All withdrawal IDs (newest first)
//   user_withdrawals:<telegramId> -> Per-user withdrawal IDs
//   admins:list                   -> Authorized admin map (excluding owner)
//   force_channels:list           -> Configured force-join channels
//   activity_logs:list            -> Admin activity log records
//   broadcast:<broadcastId>       -> Broadcast job metadata & delivery stats
//   stats:global                  -> Global counters
//   upd:<updateId>                -> Short-TTL Telegram update deduplication
//   lock:<scope>                  -> Short-TTL KV reservation lock
//   meta:bot_username             -> Cached Telegram bot username
// ============================================================================

import {
  ACTIVE_WINDOW_MS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_SETTINGS,
  OWNER_PERMISSIONS,
  VOUCHER_CATEGORY_LIST,
  getOwnerId,
  normalizeVoucherCode,
} from './config.js';

function assertKV(env) {
  if (!env?.DB) {
    throw new Error('Cloudflare KV namespace binding "DB" is not configured.');
  }
  return env.DB;
}

export async function kvGetJson(env, key, fallback = null) {
  const kv = assertKV(env);
  try {
    const raw = await kv.get(key, 'json');
    return raw === null || raw === undefined ? fallback : raw;
  } catch {
    return fallback;
  }
}

export async function kvPutJson(env, key, value, options = undefined) {
  const kv = assertKV(env);
  await kv.put(key, JSON.stringify(value), options);
}

export async function kvDelete(env, key) {
  const kv = assertKV(env);
  await kv.delete(key);
}

// ----------------------------------------------------------------------------
// Idempotency & KV-Compatible Reservation Locks
// ----------------------------------------------------------------------------

/**
 * Prevent duplicate processing when Telegram retries webhook delivery.
 * Note: KV is eventually consistent; this provides practical webhook dedup.
 */
export async function claimUpdateId(env, updateId) {
  if (updateId === undefined || updateId === null) return true;
  const key = `upd:${updateId}`;
  const existing = await assertKV(env).get(key);
  if (existing) return false;
  await assertKV(env).put(key, '1', { expirationTtl: 300 });
  return true;
}

/**
 * Best-effort KV reservation lock with token verification.
 * Because Cloudflare KV does not support atomic CAS, we write a unique token
 * and verify ownership after write before proceeding with critical mutations.
 */
export async function acquireLock(env, scope, ttlSeconds = 60) {
  const key = `lock:${scope}`;
  const existing = await kvGetJson(env, key, null);
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    return null;
  }

  const token = crypto.randomUUID();
  const record = { token, createdAt: now, expiresAt: now + ttlSeconds * 1000 };
  await kvPutJson(env, key, record, { expirationTtl: Math.max(60, ttlSeconds) });

  const verify = await kvGetJson(env, key, null);
  if (!verify || verify.token !== token) {
    return null;
  }
  return token;
}

export async function releaseLock(env, scope, token) {
  const key = `lock:${scope}`;
  const existing = await kvGetJson(env, key, null);
  if (existing && existing.token === token) {
    await kvDelete(env, key);
  }
}

// ----------------------------------------------------------------------------
// Cached Bot Metadata
// ----------------------------------------------------------------------------

export async function getCachedBotUsername(env) {
  if (env?.BOT_USERNAME && String(env.BOT_USERNAME).trim()) {
    return String(env.BOT_USERNAME).trim().replace(/^@/, '');
  }
  const cached = await assertKV(env).get('meta:bot_username');
  return cached ? cached.replace(/^@/, '') : '';
}

export async function setCachedBotUsername(env, username) {
  if (!username) return;
  await assertKV(env).put('meta:bot_username', String(username).replace(/^@/, ''), {
    expirationTtl: 86400,
  });
}

// ----------------------------------------------------------------------------
// Global Settings
// ----------------------------------------------------------------------------

export async function getSettings(env) {
  const stored = await kvGetJson(env, 'settings:global', null);
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
  const payload = {
    ...settings,
    updatedAt: Date.now(),
  };
  await kvPutJson(env, 'settings:global', payload);
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
// Users Collection
// ----------------------------------------------------------------------------

export async function getUser(env, telegramId) {
  if (!telegramId) return null;
  return kvGetJson(env, `user:${String(telegramId)}`, null);
}

export async function saveUser(env, user) {
  if (!user?.id) throw new Error('Cannot save user without id');
  const normalized = {
    ...user,
    id: String(user.id),
    balancePaise: Math.max(0, Math.round(Number(user.balancePaise || 0))),
    totalEarnedPaise: Math.max(0, Math.round(Number(user.totalEarnedPaise || 0))),
    referralEarningsPaise: Math.max(0, Math.round(Number(user.referralEarningsPaise || 0))),
    dailyBonusEarningsPaise: Math.max(0, Math.round(Number(user.dailyBonusEarningsPaise || 0))),
    totalWithdrawnPaise: Math.max(0, Math.round(Number(user.totalWithdrawnPaise || 0))),
    pendingWithdrawalPaise: Math.max(0, Math.round(Number(user.pendingWithdrawalPaise || 0))),
    totalReferrals: Math.max(0, Math.round(Number(user.totalReferrals || 0))),
    dailyBonusCount: Math.max(0, Math.round(Number(user.dailyBonusCount || 0))),
    withdrawalCount: Math.max(0, Math.round(Number(user.withdrawalCount || 0))),
  };
  await kvPutJson(env, `user:${normalized.id}`, normalized);
  return normalized;
}

export async function getUserIds(env) {
  const index = await kvGetJson(env, 'users:index', null);
  if (Array.isArray(index)) return index;
  return [];
}

export async function addUserToIndex(env, telegramId) {
  const id = String(telegramId);
  const index = await getUserIds(env);
  if (!index.includes(id)) {
    index.unshift(id);
    await kvPutJson(env, 'users:index', index);
  }
  return index;
}

export async function createOrUpdateUserFromTelegram(env, tgUser) {
  const id = String(tgUser.id);
  const now = Date.now();
  const existing = await getUser(env, id);

  if (existing) {
    const updated = {
      ...existing,
      firstName: tgUser.first_name || existing.firstName || '',
      lastName: tgUser.last_name || '',
      username: tgUser.username || '',
      lastActiveAt: now,
      status: existing.status === 'blocked_bot' ? 'active' : existing.status || 'active',
    };
    await saveUser(env, updated);
    return { user: updated, isNew: false };
  }

  const newUser = {
    id,
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || '',
    username: tgUser.username || '',
    joinedAt: now,
    lastActiveAt: now,
    status: 'active', // active | banned | blocked_bot
    balancePaise: 0,
    totalEarnedPaise: 0,
    referralEarningsPaise: 0,
    dailyBonusEarningsPaise: 0,
    totalWithdrawnPaise: 0,
    pendingWithdrawalPaise: 0,
    totalReferrals: 0,
    referredBy: null,
    pendingReferrerId: null,
    referralCredited: false,
    lastDailyClaimAt: null,
    dailyBonusCount: 0,
    lastApprovedWithdrawalAt: null,
    activePendingWithdrawalId: null,
    forceJoinVerified: false,
    withdrawalCount: 0,
  };

  await saveUser(env, newUser);
  await addUserToIndex(env, id);
  return { user: newUser, isNew: true };
}

export async function markUserBlocked(env, telegramId) {
  const user = await getUser(env, telegramId);
  if (!user) return;
  if (user.status !== 'banned') {
    user.status = 'blocked_bot';
    await saveUser(env, user);
  }
}

export async function getUsersPage(env, page = 1, pageSize = 10) {
  const ids = await getUserIds(env);
  const total = ids.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = ids.slice(start, start + pageSize);
  const users = (await Promise.all(slice.map((id) => getUser(env, id)))).filter(Boolean);

  return {
    users,
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export async function countActiveUsers(env) {
  const ids = await getUserIds(env);
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let active = 0;
  // Batch reads in chunks of 50 to avoid excessive concurrent promises
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const records = await Promise.all(batch.map((id) => getUser(env, id)));
    for (const u of records) {
      if (u && u.status === 'active' && Number(u.lastActiveAt || 0) >= cutoff) {
        active++;
      }
    }
  }
  return { totalUsers: ids.length, activeUsers: active };
}

// ----------------------------------------------------------------------------
// Conversation States
// ----------------------------------------------------------------------------

export async function getUserState(env, telegramId) {
  return kvGetJson(env, `state:${String(telegramId)}`, null);
}

export async function setUserState(env, telegramId, state) {
  await kvPutJson(
    env,
    `state:${String(telegramId)}`,
    { ...state, updatedAt: Date.now() },
    { expirationTtl: 1800 }
  );
}

export async function clearUserState(env, telegramId) {
  await kvDelete(env, `state:${String(telegramId)}`);
}

// ----------------------------------------------------------------------------
// Referrals Collection
// ----------------------------------------------------------------------------

export async function getReferralClaim(env, referredUserId) {
  return kvGetJson(env, `ref_claim:${String(referredUserId)}`, null);
}

export async function saveReferralClaim(env, referredUserId, claimRecord) {
  await kvPutJson(env, `ref_claim:${String(referredUserId)}`, claimRecord);
}

export async function getUserReferrals(env, referrerId) {
  const list = await kvGetJson(env, `referrals:${String(referrerId)}`, []);
  return Array.isArray(list) ? list : [];
}

export async function addUserReferral(env, referrerId, entry) {
  const list = await getUserReferrals(env, referrerId);
  if (!list.some((r) => String(r.referredUserId) === String(entry.referredUserId))) {
    list.unshift(entry);
    await kvPutJson(env, `referrals:${String(referrerId)}`, list);
  }
  return list;
}

// ----------------------------------------------------------------------------
// Daily Bonus Claims Collection
// ----------------------------------------------------------------------------

export async function getDailyBonusHistory(env, telegramId) {
  const list = await kvGetJson(env, `daily_claims:${String(telegramId)}`, []);
  return Array.isArray(list) ? list : [];
}

export async function addDailyBonusClaim(env, telegramId, claim) {
  const list = await getDailyBonusHistory(env, telegramId);
  list.unshift(claim);
  // Keep latest 180 claims per user
  const trimmed = list.slice(0, 180);
  await kvPutJson(env, `daily_claims:${String(telegramId)}`, trimmed);
  return trimmed;
}

// ----------------------------------------------------------------------------
// Vouchers & Global Duplicate Code Index
// ----------------------------------------------------------------------------

async function hashVoucherCode(normalizedCode) {
  const data = new TextEncoder().encode(normalizedCode);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getVoucherCodeKey(code) {
  const normalized = normalizeVoucherCode(code);
  const hash = await hashVoucherCode(normalized);
  return `vcode:${hash}`;
}

export async function getVoucherIdByCode(env, code) {
  const key = await getVoucherCodeKey(code);
  return assertKV(env).get(key);
}

export async function registerVoucherCodeIndex(env, code, voucherId) {
  const key = await getVoucherCodeKey(code);
  await assertKV(env).put(key, String(voucherId));
}

export async function getVoucher(env, voucherId) {
  return kvGetJson(env, `voucher:${String(voucherId)}`, null);
}

export async function saveVoucher(env, voucher) {
  await kvPutJson(env, `voucher:${String(voucher.id)}`, voucher);
  return voucher;
}

export async function getCategoryIndex(env, category) {
  const data = await kvGetJson(env, `vouchers:cat:${category}`, null);
  if (data && Array.isArray(data.availableIds) && Array.isArray(data.allIds)) {
    return data;
  }
  return { availableIds: [], allIds: [] };
}

export async function saveCategoryIndex(env, category, index) {
  await kvPutJson(env, `vouchers:cat:${category}`, {
    availableIds: Array.from(new Set(index.availableIds || [])),
    allIds: Array.from(new Set(index.allIds || [])),
  });
}

export async function getAllCategoryStockSummary(env) {
  const settings = await getSettings(env);
  const summary = {};
  let totalAvailable = 0;
  let totalValuePaise = 0;

  for (const cat of VOUCHER_CATEGORY_LIST) {
    const idx = await getCategoryIndex(env, cat.key);
    const availableCount = idx.availableIds.length;
    // Compute exact available value if small, or sample/sum up to 200
    let catValuePaise = availableCount * settings.defaultVoucherValuePaise;
    if (availableCount > 0 && availableCount <= 100) {
      const records = await Promise.all(idx.availableIds.map((id) => getVoucher(env, id)));
      catValuePaise = records
        .filter((v) => v && v.status === 'available')
        .reduce((acc, v) => acc + Number(v.valuePaise || settings.defaultVoucherValuePaise), 0);
    }
    summary[cat.key] = {
      ...cat,
      availableCount,
      totalAddedCount: idx.allIds.length,
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
// Voucher History Collection (Permanent Delivery Log)
// ----------------------------------------------------------------------------

export async function addVoucherHistory(env, record) {
  await kvPutJson(env, `vhist:${record.id}`, record);

  const globalIndex = await kvGetJson(env, 'voucher_history:index', []);
  globalIndex.unshift(record.id);
  await kvPutJson(env, 'voucher_history:index', globalIndex);

  const userKey = `user_vhist:${String(record.userId)}`;
  const userIndex = await kvGetJson(env, userKey, []);
  userIndex.unshift(record.id);
  await kvPutJson(env, userKey, userIndex);

  return record;
}

export async function getVoucherHistoryRecord(env, historyId) {
  return kvGetJson(env, `vhist:${String(historyId)}`, null);
}

export async function getVoucherHistoryPage(env, page = 1, pageSize = 5) {
  const ids = await kvGetJson(env, 'voucher_history:index', []);
  const total = ids.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = ids.slice(start, start + pageSize);
  const items = (await Promise.all(slice.map((id) => getVoucherHistoryRecord(env, id)))).filter(
    Boolean
  );

  return {
    items,
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export async function getUserVoucherHistory(env, telegramId, limit = 15) {
  const ids = await kvGetJson(env, `user_vhist:${String(telegramId)}`, []);
  const slice = ids.slice(0, limit);
  const items = (await Promise.all(slice.map((id) => getVoucherHistoryRecord(env, id)))).filter(
    Boolean
  );
  // Strict ownership filter so another user's code can NEVER leak
  return items.filter((item) => String(item.userId) === String(telegramId));
}

// ----------------------------------------------------------------------------
// Withdrawals Collection
// ----------------------------------------------------------------------------

export async function getWithdrawal(env, requestId) {
  return kvGetJson(env, `withdrawal:${String(requestId)}`, null);
}

export async function saveWithdrawal(env, withdrawal) {
  await kvPutJson(env, `withdrawal:${String(withdrawal.id)}`, withdrawal);
  return withdrawal;
}

export async function getPendingWithdrawalIds(env) {
  const list = await kvGetJson(env, 'withdrawals:pending', []);
  return Array.isArray(list) ? list : [];
}

export async function addPendingWithdrawalId(env, requestId) {
  const list = await getPendingWithdrawalIds(env);
  if (!list.includes(requestId)) {
    list.unshift(requestId);
    await kvPutJson(env, 'withdrawals:pending', list);
  }
}

export async function removePendingWithdrawalId(env, requestId) {
  const list = await getPendingWithdrawalIds(env);
  const filtered = list.filter((id) => id !== requestId);
  await kvPutJson(env, 'withdrawals:pending', filtered);
}

export async function getAllWithdrawalIds(env) {
  const list = await kvGetJson(env, 'withdrawals:all', []);
  return Array.isArray(list) ? list : [];
}

export async function addAllWithdrawalId(env, requestId) {
  const list = await getAllWithdrawalIds(env);
  if (!list.includes(requestId)) {
    list.unshift(requestId);
    await kvPutJson(env, 'withdrawals:all', list);
  }
}

export async function getUserWithdrawalIds(env, telegramId) {
  const list = await kvGetJson(env, `user_withdrawals:${String(telegramId)}`, []);
  return Array.isArray(list) ? list : [];
}

export async function addUserWithdrawalId(env, telegramId, requestId) {
  const list = await getUserWithdrawalIds(env, telegramId);
  if (!list.includes(requestId)) {
    list.unshift(requestId);
    await kvPutJson(env, `user_withdrawals:${String(telegramId)}`, list);
  }
}

export async function getUserWithdrawals(env, telegramId, limit = 15) {
  const ids = await getUserWithdrawalIds(env, telegramId);
  const slice = ids.slice(0, limit);
  const records = (await Promise.all(slice.map((id) => getWithdrawal(env, id)))).filter(Boolean);
  return records.filter((w) => String(w.userId) === String(telegramId));
}

// ----------------------------------------------------------------------------
// Admins Collection & Permission Checks
// ----------------------------------------------------------------------------

export function isOwner(userId, env) {
  if (!userId) return false;
  return String(userId) === getOwnerId(env);
}

export async function getAdminsMap(env) {
  const map = await kvGetJson(env, 'admins:list', {});
  return map && typeof map === 'object' ? map : {};
}

export async function saveAdminsMap(env, map) {
  await kvPutJson(env, 'admins:list', map || {});
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
  const map = await getAdminsMap(env);
  const rec = map[id];
  if (!rec || rec.active === false) return null;
  return {
    ...rec,
    id,
    role: 'admin',
    permissions: {
      ...DEFAULT_ADMIN_PERMISSIONS,
      ...(rec.permissions || {}),
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
  const map = await getAdminsMap(env);
  const ids = new Set([ownerId]);
  for (const [id, rec] of Object.entries(map)) {
    if (rec && rec.active !== false) {
      ids.add(String(id));
    }
  }
  return Array.from(ids);
}

// ----------------------------------------------------------------------------
// Force-Join Channels Collection
// ----------------------------------------------------------------------------

export async function getForceChannels(env) {
  const list = await kvGetJson(env, 'force_channels:list', []);
  return Array.isArray(list) ? list : [];
}

export async function saveForceChannels(env, channels) {
  await kvPutJson(env, 'force_channels:list', Array.isArray(channels) ? channels : []);
}

// ----------------------------------------------------------------------------
// Admin Activity Logs Collection
// ----------------------------------------------------------------------------

export async function appendActivityLog(env, entry) {
  const logs = await kvGetJson(env, 'activity_logs:list', []);
  logs.unshift(entry);
  // Retain latest 500 activity log entries in KV
  await kvPutJson(env, 'activity_logs:list', logs.slice(0, 500));
  return entry;
}

export async function getActivityLogsPage(env, page = 1, pageSize = 8) {
  const logs = await kvGetJson(env, 'activity_logs:list', []);
  const total = logs.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    logs: logs.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

// ----------------------------------------------------------------------------
// Broadcast Data Collection
// ----------------------------------------------------------------------------

export async function saveBroadcastRecord(env, record) {
  await kvPutJson(env, `broadcast:${record.id}`, record);
  const history = await kvGetJson(env, 'broadcast:index', []);
  if (!history.includes(record.id)) {
    history.unshift(record.id);
    await kvPutJson(env, 'broadcast:index', history.slice(0, 50));
  }
  return record;
}

export async function getBroadcastRecord(env, id) {
  return kvGetJson(env, `broadcast:${id}`, null);
}

// ----------------------------------------------------------------------------
// Global Statistics Counters
// ----------------------------------------------------------------------------

const DEFAULT_STATS = {
  totalReferrals: 0,
  totalReferralRewardsPaise: 0,
  totalDailyBonusesCount: 0,
  totalDailyBonusPaise: 0,
  totalApprovedWithdrawals: 0,
  totalRejectedWithdrawals: 0,
  totalWithdrawnPaise: 0,
  totalVouchersDelivered: 0,
};

export async function getGlobalStats(env) {
  const stored = await kvGetJson(env, 'stats:global', null);
  return {
    ...DEFAULT_STATS,
    ...(stored || {}),
  };
}

export async function incrementGlobalStats(env, deltas) {
  const current = await getGlobalStats(env);
  for (const [key, value] of Object.entries(deltas)) {
    if (key in current) {
      current[key] = Math.max(0, Math.round(Number(current[key] || 0) + Number(value || 0)));
    }
  }
  await kvPutJson(env, 'stats:global', current);
  return current;
}
