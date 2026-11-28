-- ============================================================================
-- 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Migration 0004: V4 Production Upgrades
-- ============================================================================
-- Strictly additive migration on existing Cloudflare D1 (`pna-rewards-db`).
-- Adds:
--   1. User-specific custom withdrawal limit (`custom_min_withdrawal_paise`).
--   2. User fresh verification generation tracking (`last_verified_generation`).
--   3. User-to-user balance transfers table (`user_transfers`).
--   4. Referral activity alerts log (`referral_activity_alerts`).
--   5. Updates default settings generation to require fresh verification for all users.
-- ============================================================================

-- 1. Extend users table for V4 features
ALTER TABLE users ADD COLUMN last_verified_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN custom_min_withdrawal_paise INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_verif_gen ON users(last_verified_generation);

-- 2. User-to-User Balance Transfers table
CREATE TABLE IF NOT EXISTS user_transfers (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  receiver_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 300 AND amount_paise <= 2000),
  fee_paise INTEGER NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  created_at INTEGER NOT NULL,
  CHECK (sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_user_transfers_sender ON user_transfers(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_transfers_receiver ON user_transfers(receiver_id, created_at DESC);

-- 3. Referral Activity Alerts log
CREATE TABLE IF NOT EXISTS referral_activity_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  alert_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ref_alerts_user ON referral_activity_alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ref_alerts_type_created ON referral_activity_alerts(alert_type, created_at DESC);

-- Record Migration Version 0004
INSERT OR IGNORE INTO migration_metadata (version, name, description, applied_at)
VALUES (
  '0004',
  'v4_production_upgrades',
  'V4 production upgrades: user custom withdrawal limits, fresh verification generation tracking, user-to-user balance transfers, and automated referral activity alerts',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
