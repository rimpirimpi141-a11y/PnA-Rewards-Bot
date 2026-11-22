// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Telegram Bot API Client & Webhook Security
// ============================================================================

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Constant-time string comparison using Web Crypto HMAC digests so lengths
 * and characters do not leak via timing differences.
 */
export async function verifyWebhookSecret(request, env) {
  const configuredSecret = env?.WEBHOOK_SECRET ? String(env.WEBHOOK_SECRET).trim() : '';
  if (!configuredSecret) {
    // Allow explicit opt-in ONLY for local wrangler dev; fail closed in production.
    return env?.ALLOW_UNSAFE_DEV_WEBHOOK === 'true';
  }

  const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!provided) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(configuredSecret)),
    crypto.subtle.sign('HMAC', key, enc.encode(provided)),
  ]);
  const a = new Uint8Array(sigA);
  const b = new Uint8Array(sigB);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Low-level Telegram Bot API request wrapper.
 * Never logs BOT_TOKEN and always returns a structured response object.
 */
export async function telegramApi(env, method, payload = {}) {
  const token = env?.BOT_TOKEN ? String(env.BOT_TOKEN).trim() : '';
  if (!token) {
    return {
      ok: false,
      errorCode: 500,
      description: 'BOT_TOKEN secret is not configured in Cloudflare Workers.',
      isBlocked: false,
      retryAfter: 0,
    };
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => null);
    if (!data) {
      return {
        ok: false,
        errorCode: response.status,
        description: `Invalid JSON response from Telegram (${response.status})`,
        isBlocked: false,
        retryAfter: 0,
      };
    }

    if (data.ok) {
      return {
        ok: true,
        result: data.result,
        errorCode: 200,
        description: '',
        isBlocked: false,
        retryAfter: 0,
      };
    }

    const desc = String(data.description || 'Telegram API error');
    const code = Number(data.error_code || response.status || 400);
    const lower = desc.toLowerCase();
    const isBlocked =
      code === 403 ||
      lower.includes('bot was blocked') ||
      lower.includes('user is deactivated') ||
      lower.includes('chat not found');
    const retryAfter = Number(data.parameters?.retry_after || 0);

    return {
      ok: false,
      result: null,
      errorCode: code,
      description: desc,
      isBlocked,
      retryAfter,
    };
  } catch (err) {
    return {
      ok: false,
      result: null,
      errorCode: 503,
      description: err?.message || 'Network error calling Telegram API',
      isBlocked: false,
      retryAfter: 0,
    };
  }
}

export async function sendMessage(env, chatId, text, extra = {}) {
  return telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function editMessageText(env, chatId, messageId, text, extra = {}) {
  const res = await telegramApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });

  // Treat "message is not modified" as benign success
  if (!res.ok && res.description?.toLowerCase().includes('message is not modified')) {
    return { ...res, ok: true, notModified: true };
  }
  return res;
}

export async function deleteMessage(env, chatId, messageId) {
  return telegramApi(env, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function answerCallbackQuery(env, callbackQueryId, text = '', showAlert = false) {
  return telegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ? String(text).slice(0, 195) : undefined,
    show_alert: Boolean(showAlert),
  });
}

export async function getChatMember(env, chatId, userId) {
  return telegramApi(env, 'getChatMember', {
    chat_id: chatId,
    user_id: Number(userId),
  });
}

export async function getChat(env, chatId) {
  return telegramApi(env, 'getChat', {
    chat_id: chatId,
  });
}

export async function getMe(env) {
  return telegramApi(env, 'getMe', {});
}

export async function sendChatAction(env, chatId, action = 'typing') {
  return telegramApi(env, 'sendChatAction', {
    chat_id: chatId,
    action,
  });
}

export async function sendPhoto(env, chatId, photo, caption = '', extra = {}) {
  return telegramApi(env, 'sendPhoto', {
    chat_id: chatId,
    photo,
    caption: caption || undefined,
    parse_mode: caption ? 'HTML' : undefined,
    ...extra,
  });
}

export async function sendVideo(env, chatId, video, caption = '', extra = {}) {
  return telegramApi(env, 'sendVideo', {
    chat_id: chatId,
    video,
    caption: caption || undefined,
    parse_mode: caption ? 'HTML' : undefined,
    ...extra,
  });
}

export async function sendDocument(env, chatId, document, caption = '', extra = {}) {
  return telegramApi(env, 'sendDocument', {
    chat_id: chatId,
    document,
    caption: caption || undefined,
    parse_mode: caption ? 'HTML' : undefined,
    ...extra,
  });
}

export async function sendAnimation(env, chatId, animation, caption = '', extra = {}) {
  return telegramApi(env, 'sendAnimation', {
    chat_id: chatId,
    animation,
    caption: caption || undefined,
    parse_mode: caption ? 'HTML' : undefined,
    ...extra,
  });
}

export async function copyMessage(env, chatId, fromChatId, messageId, extra = {}) {
  return telegramApi(env, 'copyMessage', {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
}

/**
 * Smart edit-or-send helper for callback interactions.
 */
export async function editOrSend(env, chatId, messageId, text, extra = {}) {
  if (messageId) {
    const edited = await editMessageText(env, chatId, messageId, text, extra);
    if (edited.ok) return edited;
  }
  return sendMessage(env, chatId, text, extra);
}
