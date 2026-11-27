-- ============================================================================
-- 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Migration 0002: Telegram Mini App Device Verification
-- ============================================================================
-- Strictly additive migration on existing Cloudflare D1 (`pna-rewards-db`).
-- Safety guarantees:
--   1. Zero table drops or destructive resets.
--   2. Zero modifications to existing user balances, referrals, vouchers, or ledger.
--   3. All pre-existing users are safely grandfathered (`grandfathered`) so their
--      access and balances remain 100% uninterrupted.
--   4. All newly registered users created AFTER this migration default to
--      `device_verification_status = 'unverified'` and must verify via the
--      Telegram Mini App before unlocking the bot menu or crediting referrals.
-- ============================================================================

-- 1. Extend existing `users` table with device verification columns
ALTER TABLE users ADD COLUMN device_verification_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (device_verification_status IN ('unverified', 'verified', 'pending_review', 'rejected', 'grandfathered'));

ALTER TABLE users ADD COLUMN device_verified_at INTEGER;

ALTER TABLE users ADD COLUMN device_risk_score INTEGER NOT NULL DEFAULT 0
  CHECK (device_risk_score >= 0 AND device_risk_score <= 100);

ALTER TABLE users ADD COLUMN device_fingerprint_hash TEXT;

ALTER TABLE users ADD COLUMN device_verification_required INTEGER NOT NULL DEFAULT 1
  CHECK (device_verification_required IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_users_device_status ON users(device_verification_status);
CREATE INDEX IF NOT EXISTS idx_users_device_fp ON users(device_fingerprint_hash);

-- 2. Safe grandfathering backfill for ALL pre-existing users (balances untouched)
UPDATE users
SET device_verification_status = 'grandfathered',
    device_verification_required = 0
WHERE device_verification_status = 'unverified';

-- 3. Verification Challenges (short-lived single-use nonces & velocity checks)
CREATE TABLE IF NOT EXISTS verification_challenges (
  nonce_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  ip_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verif_challenges_user ON verification_challenges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verif_challenges_ip ON verification_challenges(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verif_challenges_exp ON verification_challenges(expires_at);

-- 4. Device Verifications (full per-attempt record + replay protection via UNIQUE init_data_hash)
CREATE TABLE IF NOT EXISTS device_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  telegram_auth_date INTEGER NOT NULL,
  init_data_hash TEXT NOT NULL UNIQUE,
  strict_fp_hash TEXT NOT NULL,
  fuzzy_fp_hash TEXT NOT NULL,
  signal_hashes_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT NOT NULL DEFAULT '',
  ip_subnet_hash TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  asn TEXT NOT NULL DEFAULT '',
  asn_org TEXT NOT NULL DEFAULT '',
  proxy_vpn_flag INTEGER NOT NULL DEFAULT 0 CHECK (proxy_vpn_flag IN (0, 1)),
  datacenter_flag INTEGER NOT NULL DEFAULT 0 CHECK (datacenter_flag IN (0, 1)),
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_reasons_json TEXT NOT NULL DEFAULT '[]',
  verdict TEXT NOT NULL CHECK (verdict IN ('verified', 'pending_review', 'rejected')),
  verified_token_jti TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_verif_user_created ON device_verifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_verif_strict_fp ON device_verifications(strict_fp_hash);
CREATE INDEX IF NOT EXISTS idx_dev_verif_fuzzy_fp ON device_verifications(fuzzy_fp_hash);
CREATE INDEX IF NOT EXISTS idx_dev_verif_ip_created ON device_verifications(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_verif_subnet ON device_verifications(ip_subnet_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_verif_verdict ON device_verifications(verdict, created_at DESC);

-- 5. Device Fingerprint <-> Account Cluster Index (O(1) multi-account detection)
CREATE TABLE IF NOT EXISTS device_fingerprint_accounts (
  fingerprint_type TEXT NOT NULL CHECK (fingerprint_type IN ('strict', 'fuzzy')),
  fingerprint_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (fingerprint_type, fingerprint_hash, user_id)
);

CREATE INDEX IF NOT EXISTS idx_fp_accounts_lookup ON device_fingerprint_accounts(fingerprint_type, fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_fp_accounts_user ON device_fingerprint_accounts(user_id);

-- 6. Suspicious Referral Review Queue (manual admin approve / reject workflow)
CREATE TABLE IF NOT EXISTS referral_reviews (
  id TEXT PRIMARY KEY,
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(telegram_id) ON DELETE RESTRICT,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  verification_id TEXT NOT NULL REFERENCES device_verifications(id) ON DELETE RESTRICT,
  cluster_fp_hash TEXT NOT NULL DEFAULT '',
  matched_user_ids_json TEXT NOT NULL DEFAULT '[]',
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ref_reviews_status_created ON referral_reviews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ref_reviews_referrer ON referral_reviews(referrer_id);
CREATE INDEX IF NOT EXISTS idx_ref_reviews_cluster ON referral_reviews(cluster_fp_hash);

-- 7. Immutable Device Verification Audit Logs (database-enforced append-only trail)
CREATE TABLE IF NOT EXISTS verification_audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT 'system',
  verification_id TEXT,
  review_id TEXT,
  verdict TEXT NOT NULL DEFAULT '',
  risk_score INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verif_audit_user ON verification_audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verif_audit_created ON verification_audit_logs(created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_verification_audit_no_update
BEFORE UPDATE ON verification_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'VERIFICATION_AUDIT_IMMUTABLE_UPDATE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_verification_audit_no_delete
BEFORE DELETE ON verification_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'VERIFICATION_AUDIT_IMMUTABLE_DELETE_FORBIDDEN');
END;

-- Record Migration Version 0002
INSERT OR IGNORE INTO migration_metadata (version, name, description, applied_at)
VALUES (
  '0002',
  'device_verification',
  'Telegram Mini App device verification, probabilistic fingerprint cluster tracking, referral review queue, safe grandfathering of existing users, and immutable verification audit logs',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
