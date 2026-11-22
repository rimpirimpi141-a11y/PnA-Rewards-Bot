/**
 * Fetches current Telegram Bot Webhook status.
 *
 * Usage:
 *   BOT_TOKEN="..." npm run webhook:info
 */

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!data.ok) {
  process.exit(1);
}
