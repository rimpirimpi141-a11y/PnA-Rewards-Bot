// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Cloudflare Workers Telegram Webhook Entrypoint
// ============================================================================

import { BOT_BRAND, MENU_BUTTONS, getWebhookPath } from './config.js';
import {
  claimUpdateId,
  clearUserState,
  getForceChannels,
  getUser,
  getUserState,
  isAdmin,
  markUserBlocked,
  saveUser,
} from './database.js';
import {
  handleAdminCallback,
  handleAdminPanel,
  handleAdminStateInput,
} from './handlers/admin.js';
import {
  handleDailyBonusClaimCallback,
  handleDailyBonusHistoryCallback,
  handleDailyBonusView,
} from './handlers/bonus.js';
import { handleReferralListView, handleReferralView } from './handlers/referral.js';
import {
  ensureUserAccess,
  handleStartCommand,
  handleVerifyForceJoinCallback,
  sendMainMenu,
} from './handlers/start.js';
import {
  handleBalanceView,
  handleProfileView,
  handleSupportView,
  handleUpdateChannelView,
  handleUserHistoryView,
} from './handlers/user.js';
import {
  handleWithdrawCategorySelect,
  handleWithdrawConfirm,
  handleWithdrawMenu,
} from './handlers/withdrawal.js';
import {
  answerCallbackQuery,
  sendMessage,
  verifyWebhookSecret,
} from './telegram.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Handle membership changes when a user blocks/unblocks the bot in private chat.
 */
async function handleMyChatMemberUpdate(env, update) {
  const mcm = update.my_chat_member;
  if (!mcm || mcm.chat?.type !== 'private') return;
  const userId = String(mcm.from?.id || mcm.chat?.id || '');
  if (!userId) return;

  const newStatus = mcm.new_chat_member?.status;
  if (newStatus === 'kicked' || newStatus === 'left') {
    await markUserBlocked(env, userId);
  } else if (newStatus === 'member') {
    const user = await getUser(env, userId);
    if (user && user.status === 'blocked_bot') {
      user.status = 'active';
      user.lastActiveAt = Date.now();
      await saveUser(env, user);
    }
  }
}

/**
 * Sync force-join verified status if Telegram emits a chat_member leave event
 * on one of the configured force-join channels.
 */
async function handleChatMemberUpdate(env, update) {
  const cm = update.chat_member;
  if (!cm || !cm.chat?.id || !cm.new_chat_member?.user?.id) return;

  const newStatus = cm.new_chat_member.status;
  if (newStatus === 'left' || newStatus === 'kicked') {
    const channels = await getForceChannels(env);
    const matchesForceChannel = channels.some(
      (c) => String(c.chatId) === String(cm.chat.id)
    );
    if (matchesForceChannel) {
      const user = await getUser(env, cm.new_chat_member.user.id);
      if (user && user.forceJoinVerified) {
        user.forceJoinVerified = false;
        await saveUser(env, user);
      }
    }
  }
}

/**
 * Route all Telegram callback_query updates. Every callback pattern has a handler.
 */
async function handleCallbackQuery(env, callbackQuery, ctx) {
  const data = String(callbackQuery.data || '');
  const tgUser = callbackQuery.from;
  const chatId = callbackQuery.message?.chat?.id || tgUser.id;
  const msgId = callbackQuery.message?.message_id;

  if (data === 'noop') {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  // Force-join verification
  if (data === 'fj:verify') {
    await handleVerifyForceJoinCallback(env, callbackQuery);
    return;
  }

  // Admin panel & admin workflows
  if (data.startsWith('adm:')) {
    await handleAdminCallback(env, callbackQuery, ctx);
    return;
  }

  // User navigation callbacks
  if (data === 'usr:home') {
    await clearUserState(env, tgUser.id);
    await answerCallbackQuery(env, callbackQuery.id);
    const access = await ensureUserAccess(env, tgUser, chatId);
    if (access.allowed) {
      await sendMainMenu(env, chatId, access.user, access.isAdminUser);
    }
    return;
  }

  if (data === 'usr:balance') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleBalanceView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'usr:refer') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleReferralView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'usr:ref_list') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleReferralListView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'usr:bonus') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleDailyBonusView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'usr:profile') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleProfileView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'usr:history') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleUserHistoryView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'usr:withdraw') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleWithdrawMenu(env, tgUser, chatId, msgId);
    return;
  }

  // Daily bonus callbacks
  if (data === 'bonus:claim') {
    await handleDailyBonusClaimCallback(env, callbackQuery);
    return;
  }

  if (data === 'bonus:refresh') {
    await answerCallbackQuery(env, callbackQuery.id, '🔄 Countdown refreshed');
    await handleDailyBonusView(env, tgUser, chatId, msgId);
    return;
  }

  if (data === 'bonus:history') {
    await handleDailyBonusHistoryCallback(env, callbackQuery);
    return;
  }

  // Withdrawal callbacks
  if (data.startsWith('wd:cat:')) {
    await handleWithdrawCategorySelect(env, callbackQuery, data.slice('wd:cat:'.length));
    return;
  }

  if (data.startsWith('wd:confirm:')) {
    await handleWithdrawConfirm(env, callbackQuery, data.slice('wd:confirm:'.length));
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, 'Action expired or unrecognized.');
}

/**
 * Route all private Telegram message updates (commands, buttons, media, states).
 */
async function handleMessage(env, message) {
  if (!message?.from || !message?.chat) return;
  // Operate strictly in private direct messages with the bot
  if (message.chat.type !== 'private') return;

  const tgUser = message.from;
  const userId = String(tgUser.id);
  const chatId = message.chat.id;
  const text = String(message.text || '').trim();

  // Handle /start (with optional referral parameter)
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const payload = parts.length > 1 ? parts[1].trim() : '';
    await handleStartCommand(env, message, payload);
    return;
  }

  // Handle global Cancel / Main Menu escapes cleanly from any state
  if (text === '/cancel' || text === MENU_BUTTONS.CANCEL || text === MENU_BUTTONS.MAIN_MENU || text === '/menu') {
    await clearUserState(env, userId);
    const access = await ensureUserAccess(env, tgUser, chatId);
    if (access.allowed) {
      await sendMainMenu(env, chatId, access.user, access.isAdminUser);
    }
    return;
  }

  // Handle /admin or 👑 Admin Panel button
  if (text === '/admin' || text === MENU_BUTTONS.ADMIN_PANEL) {
    await handleAdminPanel(env, tgUser, chatId);
    return;
  }

  // Check active multi-step conversation state (e.g., admin voucher upload, broadcast media, settings)
  const state = await getUserState(env, userId);
  if (state) {
    if (state.type?.startsWith('admin_')) {
      const handled = await handleAdminStateInput(env, message, state);
      if (handled) return;
    }
    // Stale/unrecognized state: clear safely
    await clearUserState(env, userId);
  }

  // Main menu ReplyKeyboard & slash command routing
  switch (text) {
    case MENU_BUTTONS.BALANCE:
    case '/balance':
      await handleBalanceView(env, tgUser, chatId);
      return;

    case MENU_BUTTONS.REFER:
    case '/refer':
      await handleReferralView(env, tgUser, chatId);
      return;

    case MENU_BUTTONS.WITHDRAW:
    case '/withdraw':
      await handleWithdrawMenu(env, tgUser, chatId);
      return;

    case MENU_BUTTONS.DAILY_BONUS:
    case '/bonus':
      await handleDailyBonusView(env, tgUser, chatId);
      return;

    case MENU_BUTTONS.PROFILE:
    case '/profile':
      await handleProfileView(env, tgUser, chatId);
      return;

    case MENU_BUTTONS.SUPPORT:
    case '/support':
      await handleSupportView(env, tgUser, chatId);
      return;

    case MENU_BUTTONS.UPDATE_CHANNEL:
    case '/channel':
      await handleUpdateChannelView(env, tgUser, chatId);
      return;

    default: {
      // Handle unexpected input gracefully without crashing
      const access = await ensureUserAccess(env, tgUser, chatId);
      if (!access.allowed) return;
      const adminFlag = await isAdmin(userId, env);
      await sendMainMenu(
        env,
        chatId,
        access.user,
        adminFlag,
        `ℹ️ <b>Unrecognized Input</b>\nPlease use the menu buttons below to navigate <b>${BOT_BRAND}</b>.`
      );
    }
  }
}

/**
 * Process a single Telegram Update safely with full exception isolation.
 */
async function processTelegramUpdate(env, update, ctx) {
  try {
    // Deduplicate retried webhook deliveries
    const claimed = await claimUpdateId(env, update.update_id);
    if (!claimed) return;

    if (update.my_chat_member) {
      await handleMyChatMemberUpdate(env, update);
      return;
    }

    if (update.chat_member) {
      await handleChatMemberUpdate(env, update);
      return;
    }

    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query, ctx);
      return;
    }

    if (update.message) {
      await handleMessage(env, update.message);
      return;
    }
  } catch (err) {
    // Log sanitized runtime error without leaking tokens or voucher codes
    console.error('Telegram update processing error:', err?.message || String(err));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const webhookPath = getWebhookPath(env);

    // Lightweight non-sensitive health endpoint
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return jsonResponse({
        ok: true,
        service: BOT_BRAND,
        runtime: 'cloudflare-workers',
        storage: 'cloudflare-kv',
      });
    }

    // Telegram Webhook endpoint
    if (request.method === 'POST' && url.pathname === webhookPath) {
      const secretValid = await verifyWebhookSecret(request, env);
      if (!secretValid) {
        return jsonResponse({ ok: false, error: 'Unauthorized webhook request' }, 401);
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid JSON payload' }, 400);
      }

      if (!update || typeof update !== 'object') {
        return jsonResponse({ ok: false, error: 'Invalid Telegram update object' }, 400);
      }

      // Execute update processing in waitUntil so Telegram always receives
      // a prompt 200 OK response and avoids unnecessary webhook retries.
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(processTelegramUpdate(env, update, ctx));
      } else {
        await processTelegramUpdate(env, update, ctx);
      }

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: 'Not Found' }, 404);
  },
};
