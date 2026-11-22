/**
 * Registers the Telegram Bot Webhook with Cloudflare Workers.
 *
 * Usage:
 *   BOT_TOKEN="..." WEBHOOK_URL="https://pna-rewards-bot.<subdomain>.workers.dev/webhook" WEBHOOK_SECRET="..." npm run webhook:set
 */

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN environment variable is required.');
  process.exit(1);
}
if (!WEBHOOK_URL || !WEBHOOK_URL.startsWith('https://')) {
  console.error('Error: WEBHOOK_URL must be an HTTPS URL (e.g. https://pna-rewards-bot.<sub-domain>.workers.dev/webhook).');
  process.exit(1);
}
if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length < 16) {
  console.error('Error: WEBHOOK_SECRET (at least 16 chars, matching `wrangler secret put WEBHOOK_SECRET`) is required.');
  process.exit(1);
}

const payload = {
  url: WEBHOOK_URL,
  secret_token: WEBHOOK_SECRET,
  drop_pending_updates: true,
  allowed_updates: ['message', 'callback_query', 'my_chat_member', 'chat_member'],
};

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!data.ok) {
  process.exit(1);
}
