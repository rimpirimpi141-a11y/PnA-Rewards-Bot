// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Force-Join Channel Membership Verification Service
// ============================================================================

import { getForceChannels, isAdmin } from '../database.js';
import { getChat, getChatMember } from '../telegram.js';

const VALID_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

function isActiveMember(memberObj) {
  if (!memberObj || !memberObj.status) return false;
  if (VALID_MEMBER_STATUSES.has(memberObj.status)) return true;
  if (memberObj.status === 'restricted' && memberObj.is_member === true) return true;
  return false;
}

/**
 * Verify whether a Telegram user is a member of all configured force-join channels.
 * Admins/Owner bypass force-join blocking so they can always manage the bot.
 */
export async function verifyUserForceJoin(env, userId, { bypassForAdmin = true } = {}) {
  const channels = await getForceChannels(env);
  if (!channels.length) {
    return { joinedAll: true, missingChannels: [], channels: [], apiWarnings: [] };
  }

  if (bypassForAdmin && (await isAdmin(userId, env))) {
    return { joinedAll: true, missingChannels: [], channels, apiWarnings: [] };
  }

  const missingChannels = [];
  const apiWarnings = [];

  for (const ch of channels) {
    const res = await getChatMember(env, ch.chatId, userId);
    if (!res.ok) {
      // Handle Telegram API permission errors gracefully without crashing the bot
      const desc = (res.description || '').toLowerCase();
      if (
        desc.includes('chat not found') ||
        desc.includes('member list is inaccessible') ||
        desc.includes('not enough rights') ||
        desc.includes('bot was kicked') ||
        desc.includes('bot is not a member')
      ) {
        apiWarnings.push({
          channel: ch,
          error: res.description,
        });
        // Treat misconfigured channel cautiously: mark missing so unauthorized access isn't silently bypassed,
        // unless admin inspects & fixes bot permissions.
        missingChannels.push(ch);
      } else {
        missingChannels.push(ch);
      }
      continue;
    }

    if (!isActiveMember(res.result)) {
      missingChannels.push(ch);
    }
  }

  return {
    joinedAll: missingChannels.length === 0,
    missingChannels,
    channels,
    apiWarnings,
  };
}

/**
 * Inspect a channel ID / @username when admin adds or tests a force-join channel.
 */
export async function inspectChannelForAdmin(env, chatIdOrUsername) {
  const chatRes = await getChat(env, chatIdOrUsername);
  if (!chatRes.ok) {
    return {
      ok: false,
      error: chatRes.description || 'Could not access channel. Ensure the bot is added as an Admin.',
    };
  }

  const chat = chatRes.result;
  return {
    ok: true,
    chat: {
      chatId: String(chat.id),
      title: chat.title || chat.username || String(chat.id),
      username: chat.username || '',
      type: chat.type || 'channel',
      inviteLink: chat.invite_link || (chat.username ? `https://t.me/${chat.username}` : ''),
    },
  };
}
