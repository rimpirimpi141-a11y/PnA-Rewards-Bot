-- ============================================================================
-- 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Cloudflare D1 Initial Schema Migration
-- Migration: 0001_initial_schema.sql
-- Database: pna-rewards-db (SQLite / Cloudflare D1)
-- ============================================================================
-- Financial & Data Integrity Guarantees:
--   • All monetary values stored as INTEGER paise (never floating point).
--   • All Telegram IDs stored as TEXT to avoid 64-bit precision loss.
--   • CHECK constraints prevent negative balances and negative pending totals.
--   • NO cascading deletes on financial or audit history tables (ON DELETE RESTRICT)
--     so user deletion can never silently wipe ledger, withdrawal, referral,
--     voucher history, or balance adjustment records.
--   • Database triggers enforce TRUE ledger & balance_adjustments immutability
--     (blocking any UPDATE or DELETE at the SQLite engine layer).
--   • UNIQUE constraints & partial indexes prevent duplicate referrals,
--     duplicate daily claims, duplicate voucher codes, duplicate voucher
--     deliveries, duplicate pending withdrawals, duplicate balance operations,
--     duplicate Secretary Mode logs, and duplicate Telegram update processing.
--   • SQLite triggers enforce 24-hour daily bonus cooldown and single-use
--     withdrawal state transitions atomically inside D1 batches.
-- ============================================================================

-- 1. Migration Metadata
CREATE TABLE IF NOT EXISTS migration_metadata (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- 2. Users
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'blocked_bot')),
  balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  total_earned_paise INTEGER NOT NULL DEFAULT 0 CHECK (total_earned_paise >= 0),
  referral_earnings_paise INTEGER NOT NULL DEFAULT 0 CHECK (referral_earnings_paise >= 0),
  daily_bonus_earnings_paise INTEGER NOT NULL DEFAULT 0 CHECK (daily_bonus_earnings_paise >= 0),
  total_withdrawn_paise INTEGER NOT NULL DEFAULT 0 CHECK (total_withdrawn_paise >= 0),
  pending_withdrawal_paise INTEGER NOT NULL DEFAULT 0 CHECK (pending_withdrawal_paise >= 0),
  total_referrals INTEGER NOT NULL DEFAULT 0 CHECK (total_referrals >= 0),
  referred_by TEXT REFERENCES users(telegram_id) ON DELETE RESTRICT,
  pending_referrer_id TEXT REFERENCES users(telegram_id) ON DELETE SET NULL,
  referral_credited INTEGER NOT NULL DEFAULT 0 CHECK (referral_credited IN (0, 1)),
  last_daily_claim_at INTEGER,
  daily_bonus_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_bonus_count >= 0),
  last_approved_withdrawal_at INTEGER,
  active_pending_withdrawal_id TEXT,
  force_join_verified INTEGER NOT NULL DEFAULT 0 CHECK (force_join_verified IN (0, 1)),
  withdrawal_count INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_users_joined_at ON users(joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status_active ON users(status, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

-- 3. User Conversation States (Multi-step admin/user flows)
CREATE TABLE IF NOT EXISTS user_states (
  user_id TEXT PRIMARY KEY,
  state_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_states_expires_at ON user_states(expires_at);

-- 4. Tasks (Reward Tasks)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'link',
  target_url TEXT NOT NULL DEFAULT '',
  reward_paise INTEGER NOT NULL DEFAULT 0 CHECK (reward_paise >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);

-- 5. User Tasks (Per-user task completion & reward idempotency; audit preserved via RESTRICT)
CREATE TABLE IF NOT EXISTS user_tasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'approved', 'rejected')),
  reward_paise INTEGER NOT NULL DEFAULT 0 CHECK (reward_paise >= 0),
  completed_at INTEGER NOT NULL,
  rewarded_at INTEGER,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  UNIQUE(task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tasks_user_id ON user_tasks(user_id, completed_at DESC);

-- 6. Referral Claims (Strict 1-referral-per-account idempotency table; audit preserved)
CREATE TABLE IF NOT EXISTS referral_claims (
  referred_user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE RESTRICT,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  credited_at INTEGER NOT NULL,
  CHECK (referred_user_id <> referrer_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer ON referral_claims(referrer_id, credited_at DESC);

-- 7. Referrals (Detailed referrer history; audit preserved)
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(telegram_id) ON DELETE RESTRICT,
  referred_name TEXT NOT NULL DEFAULT '',
  referred_username TEXT NOT NULL DEFAULT '',
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  credited_at INTEGER NOT NULL,
  CHECK (referrer_id <> referred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_time ON referrals(referrer_id, credited_at DESC);

-- 8. Daily Claims (IST calendar date uniqueness + 24h rolling guard trigger; audit preserved)
CREATE TABLE IF NOT EXISTS daily_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  ist_date TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  UNIQUE(user_id, ist_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_claims_user_time ON daily_claims(user_id, claimed_at DESC);

-- Enforce rolling 24-hour daily bonus cooldown at the database layer
CREATE TRIGGER IF NOT EXISTS trg_daily_claims_24h_guard
BEFORE INSERT ON daily_claims
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM users
      WHERE telegram_id = NEW.user_id
        AND last_daily_claim_at IS NOT NULL
        AND (NEW.claimed_at - last_daily_claim_at) < 86400000
    )
    THEN RAISE(ABORT, 'DAILY_CLAIM_COOLDOWN')
  END;
END;

-- 9. Vouchers Inventory (Global duplicate-code protection across all categories)
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('amazon', 'google_play', 'other')),
  value_paise INTEGER NOT NULL CHECK (value_paise > 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'delivered', 'disabled')),
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  assigned_user_id TEXT REFERENCES users(telegram_id) ON DELETE RESTRICT,
  withdrawal_request_id TEXT,
  approved_by TEXT,
  delivered_at INTEGER,
  disabled_at INTEGER,
  disabled_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_vouchers_cat_status_added ON vouchers(category, status, added_at ASC);
CREATE INDEX IF NOT EXISTS idx_vouchers_withdrawal_req ON vouchers(withdrawal_request_id);

-- 10. Withdrawals (Manual-approval payout lifecycle; NEVER cascaded on user delete)
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  username TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT '',
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  category TEXT NOT NULL CHECK (category IN ('amazon', 'google_play', 'other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  processed_by TEXT,
  rejection_reason TEXT NOT NULL DEFAULT '',
  voucher_id TEXT REFERENCES vouchers(id) ON DELETE RESTRICT,
  voucher_code TEXT,
  user_balance_snapshot_paise INTEGER NOT NULL DEFAULT 0 CHECK (user_balance_snapshot_paise >= 0)
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_status_created ON withdrawals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_created ON withdrawals(user_id, created_at DESC);
-- Guarantees at most ONE pending withdrawal per user even under concurrent requests
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_one_pending_per_user
  ON withdrawals(user_id)
  WHERE status = 'pending';

-- Prevent double-processing (a finalized withdrawal can NEVER be processed again)
CREATE TRIGGER IF NOT EXISTS trg_withdrawals_only_pending_transition
BEFORE UPDATE OF status ON withdrawals
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_ALREADY_PROCESSED');
END;

-- Prevent accidental deletion of withdrawal audit records
CREATE TRIGGER IF NOT EXISTS trg_withdrawals_no_delete
BEFORE DELETE ON withdrawals
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_AUDIT_DELETE_FORBIDDEN');
END;

-- 11. Voucher Delivery History (Permanent audit log & strict per-user isolation)
CREATE TABLE IF NOT EXISTS voucher_history (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('amazon', 'google_play', 'other')),
  value_paise INTEGER NOT NULL CHECK (value_paise > 0),
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  username TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT '',
  withdrawal_request_id TEXT NOT NULL UNIQUE REFERENCES withdrawals(id) ON DELETE RESTRICT,
  approved_by TEXT NOT NULL,
  delivered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voucher_history_delivered ON voucher_history(delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_voucher_history_user_delivered ON voucher_history(user_id, delivered_at DESC);

-- 12. Admins & Role Permissions
CREATE TABLE IF NOT EXISTS admins (
  telegram_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin')),
  permissions_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  added_by TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_active ON admins(active);

-- 13. Force-Join Channels (Public, Private & Request-to-Join)
CREATE TABLE IF NOT EXISTS force_join_channels (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  invite_link TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  is_request_to_join INTEGER NOT NULL DEFAULT 0 CHECK (is_request_to_join IN (0, 1)),
  added_by TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_force_channels_added_at ON force_join_channels(added_at ASC);

-- 14. Pending Join Requests (Feedback only; NEVER grants membership)
CREATE TABLE IF NOT EXISTS pending_join_requests (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  invite_link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_join_requests_expires ON pending_join_requests(expires_at);

-- 15. Settings & Bot Runtime Metadata
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 16. Admin Activity Logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);

-- 17. Broadcasts
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  preview_summary TEXT NOT NULL DEFAULT '',
  total_recipients INTEGER NOT NULL DEFAULT 0,
  skipped_blocked INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  newly_blocked_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'completed', 'cancelled')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at DESC);

-- 18. Manual Balance Adjustments (Immutable audit table with PK operation idempotency)
CREATE TABLE IF NOT EXISTS balance_adjustments (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('ADD', 'DEDUCT')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  balance_before_paise INTEGER NOT NULL CHECK (balance_before_paise >= 0),
  balance_after_paise INTEGER NOT NULL CHECK (balance_after_paise >= 0),
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_balance_adj_user_created ON balance_adjustments(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_adj_admin_created ON balance_adjustments(admin_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_balance_adjustments_no_update
BEFORE UPDATE ON balance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_ADJUSTMENT_IMMUTABLE_UPDATE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_balance_adjustments_no_delete
BEFORE DELETE ON balance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_ADJUSTMENT_IMMUTABLE_DELETE_FORBIDDEN');
END;

-- 19. Financial Ledger (TRUE database-enforced immutable append-only audit trail)
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN (
      'referral_credit',
      'daily_bonus_credit',
      'task_credit',
      'withdrawal_reserve',
      'withdrawal_finalize',
      'withdrawal_refund',
      'admin_balance_add',
      'admin_balance_deduct',
      'admin_adjustment'
    )
  ),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit', 'reserve', 'release')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  balance_before_paise INTEGER NOT NULL CHECK (balance_before_paise >= 0),
  balance_after_paise INTEGER NOT NULL CHECK (balance_after_paise >= 0),
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(entry_type, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger(reference_type, reference_id);

-- Enforce strict ledger immutability at the database engine layer
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_update
BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE_UPDATE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete
BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE_DELETE_FORBIDDEN');
END;

-- 20. Secretary Mode Logs (PnA X Logs channel delivery tracking, deduplication & retry queue)
CREATE TABLE IF NOT EXISTS secretary_logs (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  telegram_message_id INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secretary_logs_status_created ON secretary_logs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secretary_logs_event_created ON secretary_logs(event_type, created_at DESC);

-- 21. Processed Telegram Updates (Atomic webhook deduplication)
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_expires ON processed_updates(expires_at);

-- Record Initial Migration Version
INSERT OR IGNORE INTO migration_metadata (version, name, description, applied_at)
VALUES (
  '0001',
  'initial_schema',
  'Production Cloudflare D1 relational schema with immutable ledger triggers, balance adjustments, and Secretary Mode logging',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
