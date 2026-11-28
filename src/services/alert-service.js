// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Automatic Referral Activity Alert Service
// ============================================================================
// Monitors referral milestones and velocity, sending alerts to admins
// when users cross configured thresholds or earn rapidly.
// ============================================================================

import { DIVIDER } from '../animations.js';
import { BOT_BRAND, escapeHtml, formatINR, formatUsernameTag } from '../config.js';
import { assertDB, getSettings, getUser, getUserReferrals } from '../database.js';
import { sendMessage } from '../telegram.js';

export async function checkAndTriggerReferralActivityAlerts(env, referrerId) {
  const db = assertDB(env);
  const settings = await getSettings(env);
  if (!settings.referralAlertsEnabled) return;

  const referrer = await getUser(env, referrerId);
  if (!referrer) return;

  const threshold = Number(settings.referralAlertThreshold || 10);
  const earningsThreshold = Number(settings.referralAlertEarningsPaise || 3000); // ₹30

  const totalRefs = referrer.totalReferrals;
  const totalEarnings = referrer.referralEarningsPaise;

  const crossedCount = totalRefs >= threshold && totalRefs % threshold === 0;
  const crossedEarnings = totalEarnings >= earningsThreshold && Math.floor(totalEarnings / earningsThreshold) > 0;

  if (!crossedCount && !crossedEarnings) return;

  // Check deduplication in referral_activity_alerts table (prevent duplicate alerts for same milestone within 24h)
  const alertType = crossedCount ? 'REFERRAL_COUNT_MILESTONE' : 'REFERRAL_EARNINGS_MILESTONE';
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const recentAlert = await db
    .prepare(
      `SELECT 1 FROM referral_activity_alerts
       WHERE user_id = ? AND alert_type = ? AND created_at >= ?`
    )
    .bind(String(referrerId), alertType, dayAgo)
    .first();

  if (recentAlert) return; // Already alerted recently

  const alertId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  await db
    .prepare(
      `INSERT INTO referral_activity_alerts (id, user_id, alert_type, details_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(alertId, String(referrerId), alertType, JSON.stringify({ totalRefs, totalEarnings }), now)
    .run();

  // Notify owner and admins
  const ownerId = env?.OWNER_ID || '8838351233';
  const adminsRes = await db.prepare('SELECT telegram_id FROM admins WHERE active = 1').all();
  const adminIds = new Set((adminsRes.results || []).map((r) => String(r.telegram_id)));
  adminIds.add(ownerId);

  const recentRefs = await getUserReferrals(env, referrerId, 5);
  const recentList = recentRefs
    .map((r) => `• ${escapeHtml(r.referredName)} (${formatINR(r.amountPaise)})`)
    .join('\n') || 'None';

  const alertText =
    `🚨 <b>AUTOMATED REFERRAL ACTIVITY ALERT</b>\n` +
    `${DIVIDER}\n` +
    `👤 <b>User:</b> ${escapeHtml(referrer.firstName)} (${escapeHtml(formatUsernameTag(referrer.username))}) [<code>${referrer.id}</code>]\n` +
    `🏆 <b>Total Referrals:</b> <b>${totalRefs}</b>\n` +
    `💰 <b>Referral Earnings:</b> <b>${formatINR(totalEarnings)}</b>\n` +
    `🏦 <b>Current Balance:</b> <b>${formatINR(referrer.balancePaise)}</b>\n\n` +
    `📌 <b>Recent Referrals (Last 5):</b>\n${recentList}\n\n` +
    `⚠️ <i>Milestone crossed: ${crossedCount ? `>= ${totalRefs} referrals` : `>= ${formatINR(totalEarnings)} referral earnings`} within 24h. Inspect account for safety.</i>`;

  const inspectKeyboard = {
    inline_keyboard: [
      [{ text: '🔍 Inspect User Account', callback_data: `adm:user:${referrer.id}` }],
    ],
  };

  for (const admId of adminIds) {
    try {
      await sendMessage(env, admId, alertText, { reply_markup: inspectKeyboard });
    } catch {}
  }
}
