// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Force-Join & Request-to-Join Membership Verification Service
// ============================================================================

import {
  clearPendingJoinRequest,
  getCachedBotId,
  getForceChannels,
  getPendingJoinRequest,
  isAdmin,
  recordPendingJoinRequest,
  setCachedBotId,
  setCachedBotUsername,
} from '../database.js';
import { getChat, getChatMember, getMe } from '../telegram.js';

const ACTIVE_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
const ADMIN_STATUSES = new Set(['creator', 'administrator']);

/**
 * Strictly evaluate Telegram ChatMember object per Telegram Bot API rules:
 * Accepted:
 *   - creator
 *   - administrator
 *   - member
 *   - restricted with is_member === true
 * Rejected:
 *   - left
 *   - kicked
 *   - restricted with is_member !== true
 *   - any missing/unknown status
 */
export function isActiveChannelMember(memberObj) {
  if (!memberObj || typeof memberObj.status !== 'string') return false;
  if (ACTIVE_MEMBER_STATUSES.has(memberObj.status)) return true;
  if (memberObj.status === 'restricted' && memberObj.is_member === true) return true;
  return false;
}

/**
 * Resolve and cache the bot's own Telegram numeric ID via getMe.
 */
export async function resolveBotId(env) {
  const cached = await getCachedBotId(env);
  if (cached) return cached;

  const me = await getMe(env);
  if (me.ok && me.result?.id) {
    const id = String(me.result.id);
    await setCachedBotId(env, id);
    if (me.result.username) {
      await setCachedBotUsername(env, me.result.username);
    }
    return id;
  }
  return '';
}

/**
 * Normalize channel chat_id target for Telegram Bot API calls.
 * Always prefers the stored numeric chatId (-100...), falling back to @username.
 * Never uses an invite URL as a chatId.
 */
export function resolveChannelTarget(channel) {
  if (!channel) return '';
  const rawId = String(channel.chatId || '').trim();
  if (/^-?\d+$/.test(rawId)) return rawId;
  if (/^@[a-zA-Z0-9_]{4,32}$/.test(rawId)) return rawId;
  const rawUser = String(channel.username || '').trim();
  if (rawUser) {
    return rawUser.startsWith('@') ? rawUser : `@${rawUser}`;
  }
  return rawId;
}

/**
 * Check if a channel's stored chatId matches an incoming Telegram chat object.
 */
export function matchesConfiguredChannel(channel, incomingChat) {
  if (!channel || !incomingChat) return false;
  const incomingId = incomingChat.id !== undefined ? String(incomingChat.id) : '';
  if (incomingId && String(channel.chatId) === incomingId) return true;

  const incomingUser = incomingChat.username
    ? `@${String(incomingChat.username).replace(/^@/, '').toLowerCase()}`
    : '';
  const storedUser = channel.username
    ? `@${String(channel.username).replace(/^@/, '').toLowerCase()}`
    : String(channel.chatId || '').startsWith('@')
    ? String(channel.chatId).toLowerCase()
    : '';

  return Boolean(incomingUser && storedUser && incomingUser === storedUser);
}

/**
 * Handle incoming Telegram `chat_join_request` update.
 * Records the pending join request in D1 for status feedback ONLY.
 * CRITICAL: NEVER marks the user as joined and NEVER grants bot access here!
 */
export async function handleIncomingJoinRequest(env, chatJoinRequest) {
  if (!chatJoinRequest?.chat?.id || !chatJoinRequest?.from?.id) {
    return { recorded: false, reason: 'invalid_payload' };
  }

  const channels = await getForceChannels(env);
  const matched = channels.find((ch) => matchesConfiguredChannel(ch, chatJoinRequest.chat));
  if (!matched) {
    return { recorded: false, reason: 'untracked_channel' };
  }

  const chatId = String(chatJoinRequest.chat.id);
  const userId = String(chatJoinRequest.from.id);

  await recordPendingJoinRequest(env, chatId, userId, {
    inviteLink: chatJoinRequest.invite_link?.invite_link || matched.inviteLink || '',
  });

  // Also index under matched.chatId if it was stored as @username
  if (String(matched.chatId) !== chatId) {
    await recordPendingJoinRequest(env, matched.chatId, userId, {
      inviteLink: chatJoinRequest.invite_link?.invite_link || matched.inviteLink || '',
    });
  }

  return { recorded: true, channelId: matched.id, chatId, userId };
}

/**
 * Verify whether a Telegram user is an actual confirmed member of EVERY configured
 * force-join channel via Telegram `getChatMember`.
 *
 * Rules enforced:
 * - Never bypasses force join for normal users under any circumstances.
 * - Never treats a pending join request as completed membership.
 * - Categorizes each missing channel as `pending_request`, `not_joined`, or `bot_error`
 *   so the user gets clear instructions and can retry verification after approval.
 */
export async function verifyUserForceJoin(env, userId, { bypassForAdmin = true } = {}) {
  const uid = String(userId);
  const channels = await getForceChannels(env);
  if (!channels.length) {
    return {
      joinedAll: true,
      joinedChannels: [],
      missingChannels: [],
      pendingChannels: [],
      notJoinedChannels: [],
      permissionErrorChannels: [],
      channels: [],
    };
  }

  if (bypassForAdmin && (await isAdmin(uid, env))) {
    return {
      joinedAll: true,
      joinedChannels: channels,
      missingChannels: [],
      pendingChannels: [],
      notJoinedChannels: [],
      permissionErrorChannels: [],
      channels,
    };
  }

  const joinedChannels = [];
  const missingChannels = [];
  const pendingChannels = [];
  const notJoinedChannels = [];
  const permissionErrorChannels = [];

  for (const ch of channels) {
    const target = resolveChannelTarget(ch);
    const res = await getChatMember(env, target, uid);

    if (!res.ok) {
      const desc = String(res.description || 'Telegram API error');
      const lower = desc.toLowerCase();
      const isBotPermissionIssue =
        lower.includes('chat not found') ||
        lower.includes('member list is inaccessible') ||
        lower.includes('not enough rights') ||
        lower.includes('bot was kicked') ||
        lower.includes('bot is not a member') ||
        lower.includes('administrator rights');

      const pendingReq = await getPendingJoinRequest(env, target, uid);

      if (isBotPermissionIssue) {
        permissionErrorChannels.push({ channel: ch, error: desc });
      } else if (pendingReq) {
        pendingChannels.push({ channel: ch, pendingRequest: pendingReq });
      } else {
        notJoinedChannels.push({ channel: ch, memberStatus: 'unknown' });
      }

      missingChannels.push(ch);
      continue;
    }

    const memberObj = res.result;
    if (isActiveChannelMember(memberObj)) {
      joinedChannels.push(ch);
      // Clear any leftover pending join request now that membership is officially confirmed
      await clearPendingJoinRequest(env, target, uid);
      continue;
    }

    // User is NOT an active member (left / kicked / restricted with is_member=false)
    // Check if we recorded a pending chat_join_request for this user & channel
    const pendingReq = await getPendingJoinRequest(env, target, uid);
    if (pendingReq) {
      pendingChannels.push({
        channel: ch,
        memberStatus: memberObj?.status || 'left',
        pendingRequest: pendingReq,
      });
    } else {
      notJoinedChannels.push({
        channel: ch,
        memberStatus: memberObj?.status || 'left',
      });
    }

    missingChannels.push(ch);
  }

  return {
    joinedAll: missingChannels.length === 0,
    joinedChannels,
    missingChannels,
    pendingChannels,
    notJoinedChannels,
    permissionErrorChannels,
    channels,
  };
}

/**
 * Full channel connectivity + Bot Administrator permission diagnostic.
 * Checks BOTH getChat AND getChatMember(botId) so admins immediately see if the bot
 * lacks administrator rights required for membership verification and chat_join_request.
 */
export async function inspectChannelForAdmin(env, chatIdOrUsername) {
  const target = String(chatIdOrUsername || '').trim();
  const chatRes = await getChat(env, target);
  if (!chatRes.ok) {
    return {
      ok: false,
      connected: false,
      isBotAdmin: false,
      botStatus: 'unknown',
      canInviteUsers: false,
      error:
        chatRes.description ||
        'Could not reach channel. Add the bot as an Administrator in the channel first.',
      fixHint:
        'Open Channel Settings → Administrators → Add Admin → add this bot with "Invite Users via Link" enabled.',
    };
  }

  const chat = chatRes.result;
  const numericChatId = String(chat.id);
  const botId = await resolveBotId(env);

  let isBotAdmin = false;
  let botStatus = 'unknown';
  let canInviteUsers = false;
  let botCheckError = '';

  if (botId) {
    const botMemberRes = await getChatMember(env, numericChatId, botId);
    if (botMemberRes.ok && botMemberRes.result) {
      botStatus = String(botMemberRes.result.status || 'unknown');
      isBotAdmin = ADMIN_STATUSES.has(botStatus);
      canInviteUsers =
        botStatus === 'creator' || Boolean(botMemberRes.result.can_invite_users);
    } else {
      botCheckError = botMemberRes.description || 'Could not inspect bot admin status.';
    }
  } else {
    botCheckError = 'Could not resolve bot ID via getMe.';
  }

  const isPrivate = !chat.username;
  const fixHint = !isBotAdmin
    ? 'Bot is NOT an Administrator in this channel! Go to Channel Settings → Administrators → Add this bot as Admin (enable "Invite Users via Link" for Request-to-Join channels).'
    : !canInviteUsers
    ? 'Bot is Admin, but "Invite Users via Link" permission is OFF. Enable it so Telegram delivers chat_join_request updates for Request-to-Join links.'
    : '';

  return {
    ok: true,
    connected: true,
    isBotAdmin,
    botStatus,
    canInviteUsers,
    botCheckError,
    fixHint,
    chat: {
      chatId: numericChatId,
      title: chat.title || chat.username || numericChatId,
      username: chat.username ? `@${chat.username}` : '',
      type: chat.type || 'channel',
      isPrivate,
      inviteLink: chat.invite_link || (chat.username ? `https://t.me/${chat.username}` : ''),
    },
  };
}
