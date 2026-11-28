-- ============================================================================
-- 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Read-Only Cloudflare D1 Data Integrity Snapshot Query
-- ============================================================================
-- Safe read-only query to run BEFORE and AFTER applying migration 0002.
-- Does NOT modify, delete, or alter any data.
-- Usage:
--   npx wrangler d1 execute pna-rewards-db --remote --file=scripts/d1-integrity-check.sql
-- ============================================================================

SELECT
  (SELECT COUNT(*) FROM users) AS total_users,
  (SELECT COALESCE(SUM(balance_paise), 0) FROM users) AS total_balance_paise,
  (SELECT COALESCE(SUM(referral_earnings_paise), 0) FROM users) AS total_referral_earnings_paise,
  (SELECT COUNT(*) FROM referrals) AS total_referral_records,
  (SELECT COUNT(*) FROM referral_claims) AS total_referral_claims,
  (SELECT COUNT(*) FROM withdrawals) AS total_withdrawals,
  (SELECT COUNT(*) FROM voucher_history) AS total_voucher_history,
  (SELECT COUNT(*) FROM vouchers) AS total_vouchers,
  (SELECT COUNT(*) FROM tasks) AS total_tasks,
  (SELECT COUNT(*) FROM user_tasks) AS total_user_tasks,
  (SELECT COUNT(*) FROM ledger) AS total_ledger_entries;

SELECT version, name, applied_at FROM migration_metadata ORDER BY version ASC;

SELECT name FROM pragma_table_info('users') WHERE name LIKE 'device_%' ORDER BY name ASC;

SELECT name FROM sqlite_master
WHERE type = 'table'
  AND name IN (
    'verification_challenges',
    'device_verifications',
    'device_fingerprint_accounts',
    'device_signal_links',
    'referral_reviews',
    'verification_audit_logs'
  )
ORDER BY name ASC;
