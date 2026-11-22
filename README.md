# 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Reward & Voucher Bot (Cloudflare Workers + KV)

A production-ready Telegram rewards and voucher distribution bot built exclusively for **Cloudflare Workers** using **JavaScript (ES Modules)**, **Telegram Webhooks**, and **Cloudflare Workers KV (`env.DB`)** as the sole persistent storage layer.

---

## Core Configuration

| Setting | Default Value | Configurable? |
|---|---|---|
| **Bot Brand** | `𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒` | `src/config.js` |
| **Owner Telegram ID** | `8838351233` | `wrangler.toml` (`OWNER_ID`) |
| **Support Handle** | `@Pritam_power` | Admin Panel → `⚙️ Settings` & `wrangler.toml` |
| **Update Channel** | `https://t.me/pnarewards` | Admin Panel → `⚙️ Settings` & `wrangler.toml` |
| **Referral Reward** | `₹3.00` | Admin Panel → `⚙️ Settings` |
| **Daily Bonus** | `₹0.25` (decimal `< ₹1`) | Admin Panel → `⚙️ Settings` |
| **Minimum Withdrawal** | `₹10.00` | Admin Panel → `⚙️ Settings` |
| **Voucher Value** | `₹10.00` (50 × ₹10 = ₹500 stock model) | Admin Panel → `⚙️ Settings` |
| **Timezone** | `Asia/Kolkata` (IST) | `wrangler.toml` (`TIMEZONE`) |

---

## Project Structure

```text
├── wrangler.toml                 # Cloudflare Worker + KV binding configuration
├── package.json                  # Build, lint, deploy & webhook scripts
├── scripts/
│   ├── check-syntax.js           # JS ES Module syntax verification
│   ├── set-webhook.js            # Telegram webhook registration helper
│   └── webhook-info.js           # Telegram webhook inspection helper
└── src/
    ├── index.js                  # Cloudflare Worker fetch entrypoint & webhook router
    ├── config.js                 # Constants, currency (paise/INR), IST formatting, validators
    ├── telegram.js               # Telegram Bot API client & constant-time secret verification
    ├── database.js               # Cloudflare KV storage layer (env.DB only)
    ├── keyboards.js              # ReplyKeyboard & InlineKeyboard layouts
    ├── animations.js             # Welcome animations, progress bars & loaders
    ├── handlers/
    │   ├── start.js              # /start, welcome animation, force-join gate, access guard
    │   ├── user.js               # Balance, profile, user history, support, update channel
    │   ├── referral.js           # Referral link, stats, referral history
    │   ├── bonus.js              # Daily bonus claim, 24h IST countdown & history
    │   ├── withdrawal.js         # Stock display, withdrawal confirmation & request submission
    │   ├── admin.js              # 13-section Admin Panel, approvals, users, settings, logs
    │   ├── voucher.js            # Bulk voucher upload, stock view, disable, history, low-stock
    │   ├── forcejoin.js          # Add/remove/test force-join channels
    │   ├── broadcast.js          # Rate-limited text/photo/video/media broadcast
    │   └── statistics.js         # Comprehensive bot & inventory statistics
    └── services/
        ├── balance.js            # Exact integer paise ledger (credit, reserve, finalize, refund)
        ├── referral-service.js   # Anti-self-referral & idempotent referral crediting
        ├── voucher-service.js    # Bulk parser, global dedup, KV locks & low-stock alerts
        ├── withdrawal-service.js # Manual approval lifecycle, 24h limit & voucher delivery
        ├── membership.js         # Telegram getChatMember verification
        ├── notifications.js      # Admin & user Telegram notification templates
        └── activity-log.js       # Permanent admin audit trail
```

---

## Cloudflare KV Key Architecture (`env.DB`)

All data lives exclusively inside the single Cloudflare KV namespace bound as `env.DB`:

- `settings:global` — Configurable referral reward, daily bonus, minimum withdrawal, voucher value, maintenance mode, support handle, update channel, and per-category low-stock thresholds & alert flags.
- `user:<telegramId>` — User profile, exact paise balances (`balancePaise`, `totalEarnedPaise`, `referralEarningsPaise`, `dailyBonusEarningsPaise`, `totalWithdrawnPaise`, `pendingWithdrawalPaise`), referral metadata, daily bonus timestamp, 24h withdrawal cooldown timestamp, and account status.
- `users:index` — Ordered array of registered Telegram IDs for 10/page pagination and broadcasts.
- `state:<telegramId>` — Expiring (30m TTL) multi-step input state for admin workflows.
- `ref_claim:<referredUserId>` — Permanent idempotency record guaranteeing one Telegram account can only ever be referred once.
- `referrals:<referrerId>` — List of valid referrals credited to each referrer.
- `daily_claims:<telegramId>` — Per-user daily bonus claim history (IST dates & amounts).
- `voucher:<voucherId>` — Individual voucher record (`id`, `code`, `category`, `valuePaise`, `status`, `addedAt`, `assignedUserId`, `withdrawalRequestId`, `approvedBy`, `deliveredAt`).
- `vcode:<sha256>` — Global duplicate-code prevention index across all categories.
- `vouchers:cat:<category>` — Per-category `availableIds` and `allIds` indexes (`amazon`, `google_play`, `other`).
- `vhist:<id>`, `voucher_history:index`, `user_vhist:<telegramId>` — Permanent delivered voucher audit trail & strictly isolated user voucher history.
- `withdrawal:<requestId>`, `withdrawals:pending`, `withdrawals:all`, `user_withdrawals:<telegramId>` — Withdrawal lifecycle records.
- `admins:list` — Authorized admin IDs and permissions (Owner is protected via `OWNER_ID`).
- `force_channels:list` — Configured public/private force-join channels.
- `activity_logs:list` — Admin activity log entries.
- `broadcast:<id>` — Broadcast job records & delivery counters.
- `stats:global` — Global aggregated counters.
- `upd:<updateId>` — Short-TTL webhook update deduplication key.
- `lock:<scope>` — Short-TTL KV reservation lock with token verification for withdrawal creation, admin approvals, voucher reservation, daily bonus claims, and referral crediting.

> **KV Consistency Note:** Cloudflare KV is eventually consistent and does not provide strict multi-key atomic compare-and-swap transactions. This bot mitigates concurrent races using short-lived token-verified reservation locks (`lock:*`), status re-reads before mutation, permanent idempotency keys (`ref_claim:*`, `vcode:*`, `upd:*`), and rollback/recovery logic on interrupted operations.

---

## Step 1: Create the Cloudflare KV Namespace

Authenticate with Wrangler and create your production (and optional preview) KV namespace:

```bash
npx wrangler login
npx wrangler kv namespace create DB
npx wrangler kv namespace create DB --preview
```

Wrangler will print two namespace IDs (`id` and `preview_id`). Open `wrangler.toml` and replace the placeholders:

```toml
[[kv_namespaces]]
binding = "DB"
id = "your_production_kv_namespace_id"
preview_id = "your_preview_kv_namespace_id"
```

Verify `[vars]` in `wrangler.toml`:

```toml
[vars]
OWNER_ID = "8838351233"
SUPPORT_USERNAME = "@Pritam_power"
UPDATE_CHANNEL_URL = "https://t.me/pnarewards"
TIMEZONE = "Asia/Kolkata"
WEBHOOK_PATH = "/webhook"
BOT_USERNAME = "" # Optional: your bot username without @
```

---

## Step 2: Configure Cloudflare Worker Secrets

Never hardcode tokens in `wrangler.toml` or source code. Upload secrets directly to Cloudflare:

```bash
# 1. Your Telegram Bot Token from @BotFather
npx wrangler secret put BOT_TOKEN

# 2. A strong random webhook secret (32+ alphanumeric/underscore/hyphen characters)
#    Generate one locally with: openssl rand -hex 24
npx wrangler secret put WEBHOOK_SECRET
```

---

## Step 3: Build & Deploy to Cloudflare Workers

Verify the bundle and deploy:

```bash
npm run lint
npm run build
npx wrangler deploy
```

Wrangler outputs your live Worker URL, for example:
`https://pna-rewards-bot.<your-subdomain>.workers.dev`

Verify the health endpoint:
```bash
curl https://pna-rewards-bot.<your-subdomain>.workers.dev/health
```

---

## Step 4: Register the Telegram Webhook

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
    "allowed_updates": ["message", "callback_query", "my_chat_member", "chat_member"]
  }'
```

### Verify Webhook Status

```bash
BOT_TOKEN="YOUR_BOT_TOKEN" npm run webhook:info
```

Confirm `"url"` matches your Worker `/webhook` URL and `"last_error_message"` is absent.

---

## Admin Usage Guide (Inside Telegram Only)

Open the bot as Owner (`8838351233`) or an authorized Admin and send `/admin` (or tap **👑 Admin Panel**).

1. **➕ Add Voucher (Bulk Upload)**
   - Select category (`Amazon Gift Vouchers`, `Google Play Redeem Codes`, or `Other Redeem Codes`).
   - Paste up to dozens of codes in a single message (one per line).
   - Whitespace and blank lines are stripped automatically; global duplicates across all categories are rejected automatically; updated category stock is shown immediately.
2. **📋 Pending Requests**
   - Review all pending withdrawals or act directly on instant withdrawal alert messages.
   - **✅ APPROVE**: Locks request & 1 unused voucher, delivers the code privately to the user, updates balances & 24h cooldown, writes permanent Voucher History, and checks Low Stock Alerts.
   - **❌ REJECT**: Reject immediately or enter a custom rejection reason; automatically refunds 100% of reserved balance to the user.
3. **📢 Force Channels**
   - Add public (`@channel`) or private (`-100...`) channels with custom invite links.
   - Add the bot as an **Admin** in each required channel, then tap **🩺 Test Channel Permissions** to confirm connectivity.
4. **⚙️ Settings**
   - Dynamically update Referral Reward (₹), Daily Bonus (decimal ₹, e.g. `0.20`), Minimum Withdrawal (₹), Default Voucher Value (₹), Support Handle, and Update Channel URL.
5. **👥 Users List**
   - Browse 10 users per page (`⬅️ Previous | Next ➡️`), search any user by Telegram ID, inspect full balance/referral/withdrawal history, or Ban/Unban an account.
6. **👑 Manage Admins (Owner Only)**
   - Add or remove administrators by Telegram ID and inspect permissions. Only the Owner can modify admins, and the Owner account is permanently protected.
7. **📊 Bot Statistics**
   - Live metrics for total/active users, referrals & rewards, daily bonuses, pending/approved/rejected withdrawals, per-category voucher stock, and total vouchers delivered.
8. **📣 Broadcast**
   - Send text, photos, videos, animations, or documents with captions. Displays recipient count (skipping blocked users) and confirmation before streaming with safe rate limits and live progress updates.
9. **📦 Voucher Stock**
   - View live `🟢 IN STOCK` / `🔴 OUT OF STOCK` counts and total inventory value per category, or disable mistaken unused codes.
10. **📝 Voucher History**
    - Paginated permanent audit record of every delivered voucher (code, category, value, recipient ID/username, request ID, approving admin ID, IST timestamp).
11. **🚨 Low Stock Settings**
    - Configure independent alert thresholds per voucher category (Amazon, Google Play, Other). Alerts fire once when stock drops to or below threshold and auto-reset when restocked above threshold.
12. **🔧 Maintenance Mode**
    - Enable/disable maintenance mode or customize the user maintenance notice. Admins continue operating normally while user balances and vouchers remain untouched.
13. **📜 Admin Activity Logs**
    - Paginated audit trail of every administrative change with Admin ID, action type, details, and IST timestamp.

---

## Pre-Launch Testing Checklist

- [ ] **Start Flow**: Send `/start` → verify multi-step welcome animation and Main Menu keyboard appear.
- [ ] **Force Join**: Add a channel in Admin Panel → send `/start` from a non-member test account → verify access is blocked until joining and clicking `✅ JOINED - VERIFY`.
- [ ] **Referral Tracking**: Open `/start <userA_id>` from a brand-new account (`userB`) → verify `userA` receives `₹3.00`, referral count increments, and `userA` gets notified.
- [ ] **Duplicate & Self-Referral Protection**: Re-send `/start <userA_id>` from `userB`, and `/start <userA_id>` from `userA` → verify zero extra credit is awarded.
- [ ] **Daily Bonus**: Claim bonus → verify decimal credit (e.g. `₹0.25`), 24h IST countdown appears, second immediate claim is blocked, and entry appears in Daily Bonus History.
- [ ] **Balance Calculations**: Confirm Available, Total Earned, Referral Earnings, Daily Bonus Earnings, Total Withdrawn, and Pending Withdrawal sum accurately in INR.
- [ ] **Bulk Voucher Upload**: Paste 5 codes including 1 duplicate and 1 blank line → verify 4 added, 1 duplicate rejected, 1 empty ignored, and category stock shows `🟢 IN STOCK (4)`.
- [ ] **Duplicate Voucher Protection**: Attempt to upload an already-used or existing code in a *different* category → verify it is rejected globally.
- [ ] **Stock Display**: Open `💸 Withdraw` → verify `🟢 IN STOCK` / `🔴 OUT OF STOCK` counts match inventory.
- [ ] **Withdrawal Request**: Submit a withdrawal when balance ≥ minimum → verify balance moves to Pending, duplicate submission is blocked, and exact user confirmation message appears.
- [ ] **Admin Approval & Voucher Delivery**: Click `✅ APPROVE` → verify unused voucher is DM'd to user, stock drops by 1, pending clears, total withdrawn increases, and 24h withdrawal cooldown activates.
- [ ] **Admin Rejection & Refund**: Submit another user's withdrawal → click `❌ REJECT` with a reason → verify full reserved balance is refunded and user receives rejection reason.
- [ ] **Voucher History Isolation**: Check `👤 My Profile → 🎟️ My Vouchers` on two accounts → verify each user sees ONLY their own delivered voucher codes.
- [ ] **User Pagination & Search**: Check `👥 Users List` pagination (10/page) and search by Telegram ID.
- [ ] **Admin Management**: Add and remove a test admin as Owner; confirm non-owner admin cannot add/remove admins or touch Owner.
- [ ] **Broadcast**: Send a text and a photo+caption broadcast → confirm preview, confirmation screen, progress updates, and final delivery report.
- [ ] **Low Stock Alerts**: Set Amazon threshold to current stock minus 1, approve 1 Amazon withdrawal → confirm automatic `🚨 LOW STOCK ALERT` fires once and does not spam repeatedly.
- [ ] **Maintenance Mode**: Toggle Maintenance ON → verify normal user receives maintenance notice while `/admin` still works for admins; toggle OFF.
- [ ] **Admin Activity Logs**: Inspect `📜 Admin Activity Logs` → verify all actions above are logged with Admin ID and IST timestamp.
