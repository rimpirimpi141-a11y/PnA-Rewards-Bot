-- ============================================================================
-- 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Migration 0003: Cross-Account Device Reputation Signal Links
-- ============================================================================
-- Strictly additive migration on existing Cloudflare D1 (`pna-rewards-db`).
--
-- NON-NEGOTIABLE DATA SAFETY GUARANTEES:
--   1. Zero table drops, zero table recreations, zero ALTER TABLE statements.
--   2. Does NOT touch, modify, or rerun migration 0001 or migration 0002.
--   3. Zero modifications to users, balances, referrals, withdrawals,
--      vouchers, tasks, ledger, device_verifications, device_fingerprint_accounts,
--      referral_reviews, or verification_audit_logs.
--   4. Creates ONLY the new `device_signal_links` table + indexes so the
--      backend can link multiple Telegram user IDs across server-signed
--      WebView installation tokens, strict fingerprints, rendering cores,
--      hardware cores, optional Telegram BiometricManager deviceIds, and
--      per-account continuity IDs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_signal_links (
  signal_type TEXT NOT NULL CHECK (
    signal_type IN (
      'install_token',
      'strict_fp',
      'render_core',
      'hardware_core',
      'tg_biometric_id',
      'account_storage_id'
    )
  ),
  signal_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (signal_type, signal_hash, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dev_sig_links_lookup
  ON device_signal_links(signal_type, signal_hash);

CREATE INDEX IF NOT EXISTS idx_dev_sig_links_user
  ON device_signal_links(user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_dev_sig_links_recent
  ON device_signal_links(last_seen_at DESC);

-- Record Migration Version 0003 (schema verified: version, name, description, applied_at)
INSERT OR IGNORE INTO migration_metadata (version, name, description, applied_at)
VALUES (
  '0003',
  'device_reputation_signals',
  'Strictly additive cross-account device signal association table (install_token, strict_fp, render_core, hardware_core, tg_biometric_id, account_storage_id)',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
