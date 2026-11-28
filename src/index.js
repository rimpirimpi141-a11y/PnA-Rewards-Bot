// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Cloudflare Workers Telegram Webhook Entrypoint
// ============================================================================

import { ADMIN_BUTTONS, BOT_BRAND, MENU_BUTTONS, getWebhookPath } from './config.js';
import {
  checkDatabaseConnection,
  claimUpdateId,
  clearPendingJoinRequest,
  clearUserState,
  getForceChannels,
  getUser,
  getUserState,
  isAdmin,
  markUserBlocked,
  updateUserForceJoinVerified,
  updateUserStatus,
} from './database.js';
import {
  handleAdminActivityLogs,
  handleAdminCallback,
  handleAdminMaintenanceMenu,
  handleAdminManagementMenu,
  handleAdminPanel,
  handleAdminPendingRequests,
  handleAdminSettingsMenu,
  handleAdminStateInput,
  handleAdminUsersList,
} from './handlers/admin.js';
import { handleAdminManageBalanceStart } from './handlers/balance-admin.js';
import {
  handleDailyBonusClaimCallback,
  handleDailyBonusHistoryCallback,
  handleDailyBonusView,
} from './handlers/bonus.js';
import { handleAdminBroadcastStart } from './handlers/broadcast.js';
import { handleAdminDeviceVerifyMenu } from './handlers/device-admin.js';
import { handleAdminForceChannelsMenu } from './handlers/forcejoin.js';
import { handleReferralListView, handleReferralView } from './handlers/referral.js';
import { handleAdminSecretaryMenu } from './handlers/secretary.js';
import {
  ensureUserAccess,
  handleDeviceVerifyStatusCallback,
  handleStartCommand,
  handleVerifyForceJoinCallback,
  sendMainMenu,
} from './handlers/start.js';
import { handleAdminStatistics } from './handlers/statistics.js';
import {
  handleBalanceView,
  handleProfileView,
  handleSupportView,
  handleUpdateChannelView,
  handleUserHistoryView,
  handleUserLedgerView,
} from './handlers/user.js';
import {
  handleAdminAddVoucherMenu,
  handleAdminLowStockMenu,
  handleAdminVoucherHistory,
  handleAdminVoucherStock,
} from './handlers/voucher.js';
import {
  handleWithdrawCategorySelect,
  handleWithdrawConfirm,
  handleWithdrawMenu,
} from './handlers/withdrawal.js';
import { adminReplyKeyboard } from './keyboards.js';
import {
  handleDeviceVerifyObserve,
  handleDeviceVerifySession,
  handleDeviceVerifyStatus,
  handleDeviceVerifySubmit,
} from './services/device-verification.js';
import {
  handleIncomingJoinRequest,
  isActiveChannelMember,
  matchesConfiguredChannel,
} from './services/membership.js';
import { logBotErrorEvent } from './services/secretary.js';
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
      await updateUserStatus(env, userId, 'active');
    }
  }
}

/**
 * Sync force-join status and pending join-request records when Telegram emits
 * a `chat_member` event on a configured force-join channel (e.g., approved or left).
 */
async function handleChatMemberUpdate(env, update) {
  const cm = update.chat_member;
  if (!cm || !cm.chat?.id || !cm.new_chat_member?.user?.id) return;

  const channels = await getForceChannels(env);
  const matched = channels.find((c) => matchesConfiguredChannel(c, cm.chat));
  if (!matched) return;

  const targetUserId = String(cm.new_chat_member.user.id);
  const incomingChatId = String(cm.chat.id);

  if (isActiveChannelMember(cm.new_chat_member)) {
    // Request approved or user joined -> clear any pending join request marker
    await clearPendingJoinRequest(env, incomingChatId, targetUserId);
    if (String(matched.chatId) !== incomingChatId) {
      await clearPendingJoinRequest(env, matched.chatId, targetUserId);
    }
    return;
  }

  // User left, was kicked, or was restricted without membership
  await clearPendingJoinRequest(env, incomingChatId, targetUserId);
  if (String(matched.chatId) !== incomingChatId) {
    await clearPendingJoinRequest(env, matched.chatId, targetUserId);
  }

  const user = await getUser(env, targetUserId);
  if (user && user.forceJoinVerified) {
    await updateUserForceJoinVerified(env, targetUserId, false);
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

  // Device verification status check
  if (data === 'dv:status') {
    await handleDeviceVerifyStatusCallback(env, callbackQuery);
    return;
  }

  // Admin workflows & item actions
  if (data.startsWith('adm:')) {
    await handleAdminCallback(env, callbackQuery, ctx);
    return;
  }

  // User secondary callbacks
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

  if (data === 'usr:ledger') {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleUserLedgerView(env, tgUser, chatId, msgId);
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
 * Route all 13 Admin Panel persistent ReplyKeyboard buttons (strictly admin-verified).
 */
async function tryHandleAdminReplyButton(env, tgUser, chatId, text) {
  const adminValues = Object.values(ADMIN_BUTTONS);
  if (!adminValues.includes(text)) return false;

  const userId = String(tgUser.id);
  if (!(await isAdmin(userId, env))) {
    await sendMessage(env, chatId, '🚫 Access denied. Authorized administrators only.');
    return true;
  }

  await clearUserState(env, userId);

  switch (text) {
    case ADMIN_BUTTONS.ADD_VOUCHER:
      await handleAdminAddVoucherMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.PENDING_REQUESTS:
      await handleAdminPendingRequests(env, userId, chatId, 1);
      return true;
    case ADMIN_BUTTONS.FORCE_CHANNELS:
      await handleAdminForceChannelsMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.SETTINGS:
      await handleAdminSettingsMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.USERS_LIST:
      await handleAdminUsersList(env, userId, chatId, 1);
      return true;
    case ADMIN_BUTTONS.ADD_ADMIN:
      await handleAdminManagementMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.STATISTICS:
      await handleAdminStatistics(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.BROADCAST:
      await handleAdminBroadcastStart(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.VOUCHER_STOCK:
      await handleAdminVoucherStock(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.VOUCHER_HISTORY:
      await handleAdminVoucherHistory(env, userId, chatId, 1);
      return true;
    case ADMIN_BUTTONS.LOW_STOCK:
      await handleAdminLowStockMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.MAINTENANCE:
      await handleAdminMaintenanceMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.ACTIVITY_LOGS:
      await handleAdminActivityLogs(env, userId, chatId, 1);
      return true;
    case ADMIN_BUTTONS.MANAGE_BALANCE:
      await handleAdminManageBalanceStart(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.DEVICE_VERIFY:
      await handleAdminDeviceVerifyMenu(env, userId, chatId);
      return true;
    case ADMIN_BUTTONS.SECRETARY_MODE:
      await handleAdminSecretaryMenu(env, userId, chatId);
      return true;
    default:
      return false;
  }
}

/**
 * Route all private Telegram message updates (commands, colourful ReplyKeyboards, media, states).
 */
async function handleMessage(env, message) {
  if (!message?.from || !message?.chat) return;
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

  // Handle /admin or 👑 Admin Panel button
  if (text === '/admin' || text === MENU_BUTTONS.ADMIN_PANEL) {
    await handleAdminPanel(env, tgUser, chatId);
    return;
  }

  // Handle global Cancel escape cleanly (restoring Admin keyboard if cancelling an admin input)
  if (text === '/cancel' || text === MENU_BUTTONS.CANCEL) {
    const prevState = await getUserState(env, userId);
    await clearUserState(env, userId);
    if (prevState?.type?.startsWith('admin_') && (await isAdmin(userId, env))) {
      await sendMessage(env, chatId, '❌ Action cancelled. Returned to Admin Panel.', {
        reply_markup: adminReplyKeyboard(),
      });
      return;
    }
    const access = await ensureUserAccess(env, tgUser, chatId);
    if (access.allowed) {
      await sendMainMenu(env, chatId, access.user, access.isAdminUser);
    }
    return;
  }

  // Handle Return to User Main Menu
  if (text === MENU_BUTTONS.MAIN_MENU || text === '/menu') {
    await clearUserState(env, userId);
    const access = await ensureUserAccess(env, tgUser, chatId);
    if (access.allowed) {
      await sendMainMenu(env, chatId, access.user, access.isAdminUser);
    }
    return;
  }

  // Route Admin Panel bottom ReplyKeyboard buttons
  if (await tryHandleAdminReplyButton(env, tgUser, chatId, text)) {
    return;
  }

  // Check active multi-step conversation state (e.g., bulk vouchers, broadcast, force-join setup)
  const state = await getUserState(env, userId);
  if (state) {
    if (state.type?.startsWith('admin_')) {
      const handled = await handleAdminStateInput(env, message, state);
      if (handled) return;
    }
    await clearUserState(env, userId);
  }

  // Main User Menu ReplyKeyboard & slash command routing
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

    // Handle Request-to-Join updates (records pending status; NEVER marks user joined)
    if (update.chat_join_request) {
      await handleIncomingJoinRequest(env, update.chat_join_request);
      return;
    }

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
    console.error('Telegram update processing error:', err?.message || String(err));
    try {
      await logBotErrorEvent(env, {
        category: 'BOT_ERROR',
        summary: err?.message || String(err),
        context: `update_id=${update?.update_id ?? 'unknown'}`,
        dedupId: `bot_err:${update?.update_id ?? Date.now()}`,
      });
    } catch {
      // Never allow error logging to throw
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const webhookPath = getWebhookPath(env);

    // Lightweight non-sensitive health endpoint with live D1 connectivity check
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      let dbConnected = false;
      try {
        dbConnected = await checkDatabaseConnection(env);
      } catch {
        dbConnected = false;
      }
      return jsonResponse(
        {
          ok: dbConnected,
          service: BOT_BRAND,
          runtime: 'cloudflare-workers',
          storage: 'cloudflare-d1',
          database: dbConnected ? 'connected' : 'error',
        },
        dbConnected ? 200 : 503
      );
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

      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(processTelegramUpdate(env, update, ctx));
      } else {
        await processTelegramUpdate(env, update, ctx);
      }

      return jsonResponse({ ok: true });
    }

    // Internal HMAC-authenticated Mini App Device Verification API (called by Cloud Run BFF)
    if (request.method === 'POST' && url.pathname === '/api/internal/device-verify/session') {
      return handleDeviceVerifySession(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/internal/device-verify/submit') {
      return handleDeviceVerifySubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/internal/device-verify/observe') {
      return handleDeviceVerifyObserve(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/internal/device-verify/status') {
      return handleDeviceVerifyStatus(request, env);
    }

    return jsonResponse({ ok: false, error: 'Not Found' }, 404);
  },
};
