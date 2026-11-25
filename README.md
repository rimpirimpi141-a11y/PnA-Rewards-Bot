# 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Reward & Voucher Bot (Cloudflare Workers + D1)

A production-ready Telegram rewards and voucher distribution bot built exclusively for **Cloudflare Workers** using **JavaScript (ES Modules)**, **Telegram Webhooks**, and **Cloudflare D1 SQL (`env.DB`)** as the sole persistent relational database.

---

## Core Configuration

| Setting | Default Value | Configurable? |
|---|---|---|
| **Bot Brand** | `𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒` | `src/config.js` |
| **Owner Telegram ID** | `8838351233` | `wrangler.toml` (`OWNER_ID`) |
| **Support Handle** | `@Pritam_power` | Admin Panel → `⚙️ Settings` & `wrangler.toml` |
| **Update Channel** | `https://t.me/pnarewards` | Admin Panel → `⚙️ Settings` & `wrangler.toml` |
| **Secretary Logs Channel (`PnA X Logs`)** | `@pnarewards` (`PNA_LOG_CHANNEL_ID`) | `wrangler.toml` & Admin Panel → `📡 Secretary Mode` (Owner Only) |
| **Referral Reward** | `₹3.00` | Admin Panel → `⚙️ Settings` |
| **Daily Bonus** | `₹0.25` (decimal `< ₹1`) | Admin Panel → `⚙️ Settings` |
| **Minimum Withdrawal** | `₹10.00` | Admin Panel → `⚙️ Settings` |
| **Voucher Value** | `₹10.00` (50 × ₹10 = ₹500 stock model) | Admin Panel → `⚙️ Settings` |
| **Timezone** | `Asia/Kolkata` (IST) | `wrangler.toml` (`TIMEZONE`) |
| **Database** | `pna-rewards-db` (`058b6c52-f03c-4520-89c7-b04432bfb974`) | `wrangler.toml` (`[[d1_databases]]`, binding `DB`) |

> **Legacy KV Backup Notice:** The previous Cloudflare KV namespace is **not** modified, cleared, or deleted by this codebase. It remains untouched in your Cloudflare account as a read-only backup until you explicitly choose to remove it.

---

## Project Structure

```text
├── wrangler.toml                     # Cloudflare Worker + D1 binding configuration
├── package.json                      # Build, lint, D1 migration, deploy & webhook scripts
├── migrations/
│   └── 0001_initial_schema.sql       # Normalized Cloudflare D1 SQLite schema, indexes & triggers
├── scripts/
│   ├── check-syntax.js               # JS ES Module syntax verification
│   ├── set-webhook.js                # Telegram webhook registration helper
│   └── webhook-info.js               # Telegram webhook inspection helper
└── src/
    ├── index.js                      # Cloudflare Worker fetch entrypoint, /health & webhook router
    ├── config.js                     # Constants, currency (paise/INR), IST formatting, validators
    ├── telegram.js                   # Telegram Bot API client & constant-time secret verification
    ├── database.js                   # Cloudflare D1 SQLite data layer (parameterized queries & atomic batches)
    ├── keyboards.js                  # Colourful ReplyKeyboard & InlineKeyboard layouts
    ├── animations.js                 # Welcome animations, progress bars & loaders
    ├── handlers/
    │   ├── start.js                  # /start, welcome animation, force-join gate, access guard
    │   ├── user.js                   # Balance, profile, ledger transaction history, voucher history, support
    │   ├── referral.js               # Referral link, stats, referral history
    │   ├── bonus.js                  # Daily bonus claim, 24h IST countdown & history
    │   ├── withdrawal.js             # Stock display, withdrawal confirmation & request submission
    │   ├── admin.js                  # Admin Panel, approvals, users, settings, logs & routers
    │   ├── balance-admin.js          # Admin 💰 Manage User Balance (Add / Deduct with confirmation)
    │   ├── secretary.js              # Owner 📡 Secretary Mode (PnA X Logs) verification & controls
    │   ├── voucher.js                # Bulk voucher upload, stock view, disable, history, low-stock
    │   ├── forcejoin.js              # Add/remove/test public, private & Request-to-Join channels
    │   ├── broadcast.js              # Rate-limited text/photo/video/media broadcast
    │   └── statistics.js             # Comprehensive live SQL bot & inventory statistics
    └── services/
        ├── balance.js                # Exact integer paise balance, ledger & manual adjustment service
        ├── referral-service.js       # Anti-self-referral & atomic one-time referral crediting
        ├── voucher-service.js        # Bulk parser, global UNIQUE dedup, atomic reservation & low-stock alerts
        ├── withdrawal-service.js     # Manual approval lifecycle, 24h cooldown & voucher delivery
        ├── task-service.js           # Reward task creation, completion & review with audit/channel logs
        ├── secretary.js              # Automatic PnA X Logs background dispatcher, redaction & retry engine
        ├── membership.js             # Telegram getChatMember & chat_join_request verification
        ├── notifications.js          # Admin & user Telegram notification templates
        └── activity-log.js           # Permanent admin audit trail
```

---

## Cloudflare D1 Relational Schema (`env.DB`)

All application state is stored in normalized SQLite tables managed via `migrations/0001_initial_schema.sql`:

- `users` — User accounts with `TEXT` Telegram IDs, exact `INTEGER` paise balances, `CHECK (balance_paise >= 0)` & `CHECK (pending_withdrawal_paise >= 0)` constraints, referral metadata, daily bonus timestamp, 24h withdrawal cooldown, and account status.
- `user_states` — Multi-step admin/user conversation state with automatic expiration (`expires_at`).
- `tasks` & `user_tasks` — Normalized reward tasks catalog and per-user completion tracking (`UNIQUE(task_id, user_id)`).
- `referrals` & `referral_claims` — Permanent referral history plus primary-key idempotency (`referred_user_id PRIMARY KEY`) guaranteeing every Telegram account can only ever be referred once.
- `daily_claims` — Per-user daily bonus records protected by `UNIQUE(user_id, ist_date)` and the `trg_daily_claims_24h_guard` trigger enforcing the 24-hour cooldown atomically.
- `vouchers` — Inventory table with `code_hash TEXT NOT NULL UNIQUE` for global duplicate rejection across all categories, plus `status` lifecycle (`available` → `reserved` → `used` / `disabled`).
- `voucher_history` — Permanent delivered voucher audit trail (`voucher_id UNIQUE`, `withdrawal_request_id UNIQUE`) and strictly user-isolated `My Vouchers` lookups.
- `withdrawals` — Full withdrawal lifecycle with partial unique index `idx_withdrawals_one_pending_per_user` (preventing concurrent duplicate pending requests), `trg_withdrawals_only_pending_transition` (preventing double approval/rejection), and `trg_withdrawals_no_delete` (preventing deletion of withdrawal history).
- `balance_adjustments` — Permanent audit trail for every manual admin Add/Deduct balance operation (`id PRIMARY KEY` prevents duplicate replay; protected by `trg_balance_adjustments_no_update` and `trg_balance_adjustments_no_delete`).
- `ledger` — Immutable append-only financial audit ledger recording every credit, reserve, debit, refund, and manual admin adjustment with `balance_before_paise` and `balance_after_paise` (enforced at the database level via `trg_ledger_no_update`, `trg_ledger_no_delete`, and `ON DELETE RESTRICT` foreign keys).
- `admins` — Role-based administrator records and JSON permissions (Bot Owner protected via `OWNER_ID`).
- `force_join_channels` & `pending_join_requests` — Public, private, and Request-to-Join force channels with separate `chat_id` and `invite_link` columns.
- `settings` — Key-value application settings store (JSON-encoded values for referral reward, daily bonus, minimum withdrawal, maintenance mode, Secretary Mode config, low-stock thresholds, etc.).
- `activity_logs` — Permanent paginated admin audit log.
- `secretary_logs` — Deduplicated (`dedup_key UNIQUE`) delivery & failure-retry queue for **📡 Secretary Mode (`PnA X Logs`)**.
- `broadcasts` — Broadcast drafts, delivery progress, and completion metrics.
- `processed_updates` — Atomic Telegram `update_id` deduplication table (`PRIMARY KEY`).
- `migration_metadata` — Schema version tracking table.

All financial operations execute inside atomic Cloudflare D1 `env.DB.batch([...])` transactions with parameterized SQL statements (`?` bindings), `ON DELETE RESTRICT` financial foreign keys, and automatic rollback on any constraint violation.

---

## Step 1: Verify `wrangler.toml` D1 Binding

Confirm `wrangler.toml` points to your fresh D1 database:

```toml
[[d1_databases]]
binding = "DB"
database_name = "pna-rewards-db"
database_id = "058b6c52-f03c-4520-89c7-b04432bfb974"
migrations_dir = "migrations"
```

Verify `[vars]` in `wrangler.toml`:

```toml
[vars]
OWNER_ID = "8838351233"
SUPPORT_USERNAME = "@Pritam_power"
UPDATE_CHANNEL_URL = "https://t.me/pnarewards"
PNA_LOG_CHANNEL_ID = "@pnarewards"
TIMEZONE = "Asia/Kolkata"
WEBHOOK_PATH = "/webhook"
BOT_USERNAME = ""
```

---

## Step 2: Apply Cloudflare D1 Migrations

Authenticate with Wrangler and apply `migrations/0001_initial_schema.sql`:

```bash
npx wrangler login

# Apply to local Wrangler D1 emulation (optional local dev check)
npm run db:migrate:local
# Equivalent: npx wrangler d1 migrations apply pna-rewards-db --local

# Apply to production Cloudflare D1 database
npm run db:migrate:remote
# Equivalent: npx wrangler d1 migrations apply pna-rewards-db --remote

# Verify applied migrations
npm run db:list:remote
```

---

## Step 3: Configure Cloudflare Worker Secrets

Never hardcode tokens in `wrangler.toml` or source code. Upload secrets directly to Cloudflare:

```bash
# 1. Your Telegram Bot Token from @BotFather
npx wrangler secret put BOT_TOKEN

# 2. A strong random webhook secret (32+ alphanumeric/underscore/hyphen characters)
#    Generate one locally with: openssl rand -hex 24
npx wrangler secret put WEBHOOK_SECRET
```

---

## Step 4: Build & Deploy to Cloudflare Workers

Verify the bundle and deploy:

```bash
npm run lint
npm run build
npx wrangler deploy
```

Verify the health endpoint (confirms live D1 connectivity):

```bash
curl https://pna-rewards-bot.<your-subdomain>.workers.dev/health
```

Expected response:
```json
{"ok":true,"service":"𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒","runtime":"cloudflare-workers","storage":"cloudflare-d1","database":"connected"}
```

---

## Step 5: Register the Telegram Webhook

### Option A — Using the included Node script

```bash
BOT_TOKEN="YOUR_BOT_TOKEN" \
WEBHOOK_URL="https://pna-rewards-bot.<your-subdomain>.workers.dev/webhook" \
WEBHOOK_SECRET="YOUR_EXACT_WEBHOOK_SECRET" \
npm run webhook:set
```

### Option B — Using `curl`

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://pna-rewards-bot.<your-subdomain>.workers.dev/webhook",
    "secret_token": "<YOUR_EXACT_WEBHOOK_SECRET>",
    "drop_pending_updates": true,
    "allowed_updates": ["message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"]
  }'
```

### Verify Webhook Status

```bash
BOT_TOKEN="YOUR_BOT_TOKEN" npm run webhook:info
```

---

## Admin Usage Guide (Inside Telegram Only)

Open the bot as Owner (`8838351233`) or an authorized Admin and send `/admin` (or tap **👑 Admin Panel**).

1. **➕ Add Voucher (Bulk Upload)** — Select category (`Amazon`, `Google Play`, or `Other`), paste multiline codes, automatic whitespace cleanup & global `UNIQUE` duplicate rejection.
2. **📋 Pending Requests** — Review pending withdrawals, **✅ APPROVE** (atomic voucher assignment, ledger entry, 24h cooldown, DM delivery & low-stock check) or **❌ REJECT** (optional reason + atomic 100% refund & ledger entry).
3. **📢 Force Channels** — Configure public, private, and Request-to-Join channels with separate Channel ID and Invite URL storage, plus live **🩺 Test Channels & Bot Admin Status** diagnostics.
4. **⚙️ Settings** — Dynamically update Referral Reward, Daily Bonus (decimal ₹), Minimum Withdrawal, Default Voucher Value, Support Handle, and Update Channel URL.
5. **👥 Users List** — Paginated user directory (10/page), search by Telegram ID, full user ledger/withdrawal details, and Ban/Unban controls.
6. **👑 Manage Admins (Owner Only)** — Add or remove admins by Telegram ID; Owner account is permanently protected.
7. **📊 Bot Statistics** — Live SQL metrics for users, referrals, daily bonuses, withdrawals, and per-category voucher stock.
8. **📣 Broadcast** — Text, photo, video, GIF, audio, and document broadcasts with recipient counts, confirmation screen, rate limiting, and blocked-user tracking.
9. **📦 Voucher Stock** — Live `🟢 IN STOCK` / `🔴 OUT OF STOCK` counts and ability to disable unused codes.
10. **📝 Voucher History** — Paginated permanent audit record of every delivered voucher.
11. **🚨 Low Stock Settings** — Independent per-category alert thresholds with automatic arm/reset.
12. **🔧 Maintenance Mode** — Toggle maintenance mode and customize the maintenance notice while preserving admin access.
13. **📜 Admin Activity Logs** — Permanent paginated admin action audit trail.
14. **💰 Manage User Balance** — Search user by Telegram ID, inspect profile/balance, Add or Deduct INR with strict validation (never negative), optional reason, mandatory confirmation screen, atomic D1 ledger/audit update, user DM, and PnA X Logs notification.
15. **📡 Secretary Mode (`PnA X Logs`)** — Owner-controlled automatic background channel logging. Add the bot as Administrator (with **Post Messages**) in `PnA X Logs`, then tap **✅ Verify Bot Admin & Activate** and **🧪 Send Test Log**. Supports public `@username` or private numeric `-100...` chat IDs (private invite links `t.me/+...` are rejected). Failed deliveries are saved in `secretary_logs` and can be retried with **🔁 Retry Failed**.
