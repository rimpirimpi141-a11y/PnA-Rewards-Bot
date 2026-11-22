// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Voucher Inventory, Bulk Upload & Low-Stock Alert Service
// ============================================================================

import {
  ACTIVITY_ACTIONS,
  generateId,
  getCategoryMeta,
  normalizeVoucherCode,
} from '../config.js';
import {
  acquireLock,
  getAllCategoryStockSummary,
  getCategoryIndex,
  getSettings,
  getVoucher,
  getVoucherIdByCode,
  registerVoucherCodeIndex,
  releaseLock,
  saveCategoryIndex,
  saveVoucher,
  updateSettings,
} from '../database.js';
import { logAdminActivity } from './activity-log.js';
import { notifyAdminsLowStock } from './notifications.js';

/**
 * Bulk-upload multiline voucher codes into a category in one operation.
 * - Trims whitespace & ignores empty lines
 * - Prevents duplicates globally across all categories & within the same batch
 * - Resets low-stock alert flag automatically if stock rises above threshold
 */
export async function bulkAddVouchers(env, { category, rawText, valuePaise, adminId }) {
  const catMeta = getCategoryMeta(category);
  if (!catMeta) {
    return { ok: false, error: 'Invalid voucher category selected.' };
  }

  const lockScope = `voucher_cat:${category}`;
  const lockToken = await acquireLock(env, lockScope, 60);
  if (!lockToken) {
    return { ok: false, error: 'Another voucher upload is currently in progress. Please retry.' };
  }

  try {
    const settings = await getSettings(env);
    const effectiveValuePaise =
      Number.isFinite(Number(valuePaise)) && Number(valuePaise) > 0
        ? Math.round(Number(valuePaise))
        : settings.defaultVoucherValuePaise;

    const lines = String(rawText || '').split(/\r?\n/);
    const seenInBatch = new Set();
    const added = [];
    const duplicates = [];
    let emptyCount = 0;

    const catIndex = await getCategoryIndex(env, category);
    const now = Date.now();

    for (const rawLine of lines) {
      const cleaned = rawLine.trim();
      if (!cleaned) {
        emptyCount++;
        continue;
      }

      const norm = normalizeVoucherCode(cleaned);
      if (!norm) {
        emptyCount++;
        continue;
      }

      if (seenInBatch.has(norm)) {
        duplicates.push(cleaned);
        continue;
      }
      seenInBatch.add(norm);

      // Check global duplicate index across ALL categories
      const existingVoucherId = await getVoucherIdByCode(env, norm);
      if (existingVoucherId) {
        duplicates.push(cleaned);
        continue;
      }

      const voucherId = generateId('VCH');
      const voucherRecord = {
        id: voucherId,
        code: cleaned,
        normalizedCode: norm,
        category,
        valuePaise: effectiveValuePaise,
        addedAt: now,
        addedBy: String(adminId),
        status: 'available', // available | reserved | delivered | disabled
        assignedUserId: null,
        withdrawalRequestId: null,
        deliveredAt: null,
        approvedBy: null,
      };

      await registerVoucherCodeIndex(env, norm, voucherId);
      await saveVoucher(env, voucherRecord);

      catIndex.availableIds.push(voucherId);
      catIndex.allIds.push(voucherId);
      added.push(voucherRecord);
    }

    if (added.length > 0) {
      await saveCategoryIndex(env, category, catIndex);

      // Reset low-stock alert flag if stock is now strictly above threshold
      const threshold = Number(settings.lowStockThresholds?.[category] ?? 5);
      if (catIndex.availableIds.length > threshold && settings.lowStockAlertSent?.[category]) {
        await updateSettings(env, {
          lowStockAlertSent: { [category]: false },
        });
      }

      await logAdminActivity(
        env,
        adminId,
        ACTIVITY_ACTIONS.VOUCHER_ADDED,
        `Added ${added.length} ${catMeta.shortName} voucher(s) (Duplicates skipped: ${duplicates.length}). Stock now: ${catIndex.availableIds.length}`
      );
    }

    return {
      ok: true,
      category,
      categoryName: catMeta.name,
      addedCount: added.length,
      duplicateCount: duplicates.length,
      emptyCount,
      currentStock: catIndex.availableIds.length,
      valuePaise: effectiveValuePaise,
    };
  } finally {
    await releaseLock(env, lockScope, lockToken);
  }
}

/**
 * Reserve and acquire one genuinely available voucher from a category using
 * KV locking + status re-verification so no voucher is ever issued twice.
 */
export async function reserveAvailableVoucher(env, category, userId, withdrawalRequestId) {
  const catLockScope = `voucher_cat:${category}`;
  const catLockToken = await acquireLock(env, catLockScope, 60);
  if (!catLockToken) {
    return { ok: false, error: 'Voucher vault is busy. Please try approving again in a moment.' };
  }

  try {
    const catIndex = await getCategoryIndex(env, category);
    if (!catIndex.availableIds.length) {
      return { ok: false, error: 'Out of stock for this voucher category.' };
    }

    const cleanedAvailable = [];
    let reservedVoucher = null;

    for (let i = 0; i < catIndex.availableIds.length; i++) {
      const voucherId = catIndex.availableIds[i];

      if (reservedVoucher) {
        cleanedAvailable.push(voucherId);
        continue;
      }

      const voucher = await getVoucher(env, voucherId);
      if (!voucher || voucher.status !== 'available') {
        // Stale index entry; prune it cleanly
        continue;
      }

      const vLock = await acquireLock(env, `voucher:${voucherId}`, 120);
      if (!vLock) {
        cleanedAvailable.push(voucherId);
        continue;
      }

      // Re-read after lock to verify still available
      const fresh = await getVoucher(env, voucherId);
      if (!fresh || fresh.status !== 'available') {
        await releaseLock(env, `voucher:${voucherId}`, vLock);
        continue;
      }

      fresh.status = 'reserved';
      fresh.assignedUserId = String(userId);
      fresh.withdrawalRequestId = String(withdrawalRequestId);
      await saveVoucher(env, fresh);
      await releaseLock(env, `voucher:${voucherId}`, vLock);

      reservedVoucher = fresh;
    }

    catIndex.availableIds = cleanedAvailable;
    await saveCategoryIndex(env, category, catIndex);

    if (!reservedVoucher) {
      return { ok: false, error: 'No available voucher could be reserved in this category.' };
    }

    return {
      ok: true,
      voucher: reservedVoucher,
      remainingStock: catIndex.availableIds.length,
    };
  } finally {
    await releaseLock(env, catLockScope, catLockToken);
  }
}

/**
 * Roll back a reserved voucher back to available if an approval aborts before completion.
 */
export async function releaseReservedVoucher(env, voucher) {
  if (!voucher?.id) return;
  const catLockScope = `voucher_cat:${voucher.category}`;
  const catLockToken = await acquireLock(env, catLockScope, 60);
  try {
    const fresh = await getVoucher(env, voucher.id);
    if (fresh && fresh.status === 'reserved') {
      fresh.status = 'available';
      fresh.assignedUserId = null;
      fresh.withdrawalRequestId = null;
      await saveVoucher(env, fresh);

      const catIndex = await getCategoryIndex(env, fresh.category);
      if (!catIndex.availableIds.includes(fresh.id)) {
        catIndex.availableIds.unshift(fresh.id);
        await saveCategoryIndex(env, fresh.category, catIndex);
      }
    }
  } finally {
    if (catLockToken) {
      await releaseLock(env, catLockScope, catLockToken);
    }
  }
}

/**
 * Mark a reserved voucher permanently delivered.
 */
export async function finalizeVoucherDelivery(env, voucher, adminId, deliveredAt = Date.now()) {
  const fresh = await getVoucher(env, voucher.id);
  if (!fresh) throw new Error('Voucher record missing during finalization.');
  fresh.status = 'delivered';
  fresh.approvedBy = String(adminId);
  fresh.deliveredAt = deliveredAt;
  await saveVoucher(env, fresh);
  return fresh;
}

/**
 * Disable an unused voucher (admin moderation action).
 */
export async function disableAvailableVoucher(env, voucherId, adminId) {
  const voucher = await getVoucher(env, voucherId);
  if (!voucher) {
    return { ok: false, error: 'Voucher not found.' };
  }
  if (voucher.status !== 'available') {
    return { ok: false, error: `Cannot disable voucher with status "${voucher.status}".` };
  }

  const catLockScope = `voucher_cat:${voucher.category}`;
  const catLockToken = await acquireLock(env, catLockScope, 60);
  if (!catLockToken) {
    return { ok: false, error: 'Voucher vault is busy. Try again.' };
  }

  try {
    voucher.status = 'disabled';
    voucher.disabledAt = Date.now();
    voucher.disabledBy = String(adminId);
    await saveVoucher(env, voucher);

    const catIndex = await getCategoryIndex(env, voucher.category);
    catIndex.availableIds = catIndex.availableIds.filter((id) => id !== voucher.id);
    await saveCategoryIndex(env, voucher.category, catIndex);

    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.VOUCHER_DISABLED,
      `Disabled voucher ${voucher.id} (${voucher.category}). Stock now: ${catIndex.availableIds.length}`
    );

    await checkAndTriggerLowStockAlert(env, voucher.category, catIndex.availableIds.length);
    return { ok: true, voucher, remainingStock: catIndex.availableIds.length };
  } finally {
    await releaseLock(env, catLockScope, catLockToken);
  }
}

/**
 * Check low-stock threshold for a category and notify admins once per threshold drop.
 * Resets automatically when stock later exceeds the threshold.
 */
export async function checkAndTriggerLowStockAlert(env, category, currentStock = null) {
  const settings = await getSettings(env);
  const threshold = Number(settings.lowStockThresholds?.[category] ?? 5);
  let remaining = currentStock;

  if (remaining === null || remaining === undefined) {
    const idx = await getCategoryIndex(env, category);
    remaining = idx.availableIds.length;
  }

  const alreadySent = Boolean(settings.lowStockAlertSent?.[category]);

  if (remaining <= threshold && !alreadySent) {
    await updateSettings(env, {
      lowStockAlertSent: { [category]: true },
    });
    await notifyAdminsLowStock(env, category, remaining, threshold);
    return { alerted: true, remaining, threshold };
  }

  if (remaining > threshold && alreadySent) {
    await updateSettings(env, {
      lowStockAlertSent: { [category]: false },
    });
  }

  return { alerted: false, remaining, threshold };
}

export async function getStockOverview(env) {
  return getAllCategoryStockSummary(env);
}
