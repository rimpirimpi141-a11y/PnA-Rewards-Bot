// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Voucher Inventory, Bulk Upload & Low-Stock Alert Service (D1)
// ============================================================================

import {
  ACTIVITY_ACTIONS,
  generateId,
  getCategoryMeta,
  normalizeVoucherCode,
} from '../config.js';
import {
  atomicReserveAvailableVoucher,
  bulkInsertVouchers,
  countAvailableVouchersByCategory,
  disableAvailableVoucherRow,
  getAllCategoryStockSummary,
  getSettings,
  getVoucher,
  hashVoucherCode,
  releaseReservedVoucherRow,
  updateSettings,
} from '../database.js';
import { logAdminActivity } from './activity-log.js';
import { notifyAdminsLowStock } from './notifications.js';
import { logVoucherBatchAddedEvent, logVoucherDisabledEvent } from './secretary.js';

/**
 * Bulk-upload multiline voucher codes into a category in one D1 batch workflow.
 * - Trims whitespace & ignores empty lines
 * - Prevents duplicates globally across all categories (UNIQUE normalized_code & code_hash)
 * - Resets low-stock alert flag automatically if stock rises above threshold
 */
export async function bulkAddVouchers(env, { category, rawText, valuePaise, adminId }) {
  const catMeta = getCategoryMeta(category);
  if (!catMeta) {
    return { ok: false, error: 'Invalid voucher category selected.' };
  }

  const settings = await getSettings(env);
  const effectiveValuePaise =
    Number.isFinite(Number(valuePaise)) && Number(valuePaise) > 0
      ? Math.round(Number(valuePaise))
      : settings.defaultVoucherValuePaise;

  const lines = String(rawText || '').split(/\r?\n/);
  const seenInBatch = new Set();
  const candidates = [];
  let inBatchDuplicates = 0;
  let emptyCount = 0;
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
      inBatchDuplicates++;
      continue;
    }
    seenInBatch.add(norm);

    const codeHash = await hashVoucherCode(norm);
    candidates.push({
      id: generateId('VCH'),
      code: cleaned,
      normalizedCode: norm,
      codeHash,
      category,
      valuePaise: effectiveValuePaise,
      addedAt: now,
      addedBy: String(adminId),
    });
  }

  const insertRes = await bulkInsertVouchers(env, candidates);
  const totalDuplicates = inBatchDuplicates + insertRes.duplicateCount;
  const currentStock = await countAvailableVouchersByCategory(env, category);

  if (insertRes.addedCount > 0) {
    // Reset low-stock alert flag if stock is now strictly above threshold
    const threshold = Number(settings.lowStockThresholds?.[category] ?? 5);
    if (currentStock > threshold && settings.lowStockAlertSent?.[category]) {
      await updateSettings(env, {
        lowStockAlertSent: { [category]: false },
      });
    }

    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.VOUCHER_ADDED,
      `Added ${insertRes.addedCount} ${catMeta.shortName} voucher(s) (Duplicates skipped: ${totalDuplicates}). Stock now: ${currentStock}`
    );

    await logVoucherBatchAddedEvent(env, {
      adminId,
      category,
      addedCount: insertRes.addedCount,
      duplicateCount: totalDuplicates,
      valuePaise: effectiveValuePaise,
      currentStock,
    });
  }

  return {
    ok: true,
    category,
    categoryName: catMeta.name,
    addedCount: insertRes.addedCount,
    duplicateCount: totalDuplicates,
    emptyCount,
    currentStock,
    valuePaise: effectiveValuePaise,
  };
}

/**
 * Atomically reserve one genuinely available voucher from a category using D1
 * `UPDATE ... RETURNING *` so no voucher is ever issued twice.
 */
export async function reserveAvailableVoucher(env, category, userId, withdrawalRequestId) {
  const reserved = await atomicReserveAvailableVoucher(
    env,
    category,
    userId,
    withdrawalRequestId
  );

  if (!reserved) {
    return { ok: false, error: 'Out of stock for this voucher category.' };
  }

  const remainingStock = await countAvailableVouchersByCategory(env, category);
  return {
    ok: true,
    voucher: reserved,
    remainingStock,
  };
}

/**
 * Roll back a reserved voucher back to available if an approval aborts before completion.
 */
export async function releaseReservedVoucher(env, voucher) {
  if (!voucher?.id) return;
  await releaseReservedVoucherRow(env, voucher.id);
}

/**
 * Disable an unused voucher (admin moderation action).
 */
export async function disableAvailableVoucher(env, voucherId, adminId) {
  const existing = await getVoucher(env, voucherId);
  if (!existing) {
    return { ok: false, error: 'Voucher not found.' };
  }
  if (existing.status !== 'available') {
    return { ok: false, error: `Cannot disable voucher with status "${existing.status}".` };
  }

  const disabled = await disableAvailableVoucherRow(env, voucherId, adminId);
  if (!disabled) {
    return { ok: false, error: 'Voucher is no longer available to disable.' };
  }

  const remainingStock = await countAvailableVouchersByCategory(env, disabled.category);

  await logAdminActivity(
    env,
    adminId,
    ACTIVITY_ACTIONS.VOUCHER_DISABLED,
    `Disabled voucher ${disabled.id} (${disabled.category}). Stock now: ${remainingStock}`
  );

  await logVoucherDisabledEvent(env, {
    adminId,
    voucher: disabled,
    remainingStock,
  });

  await checkAndTriggerLowStockAlert(env, disabled.category, remainingStock);
  return { ok: true, voucher: disabled, remainingStock };
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
    remaining = await countAvailableVouchersByCategory(env, category);
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
