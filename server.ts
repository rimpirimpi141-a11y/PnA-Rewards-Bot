// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Google Cloud Run Telegram Mini App Server & Signed HTTPS BFF
// ============================================================================
// Hosts the React Telegram Mini App SPA on PORT=3000 and proxies verification
// API calls over authenticated HMAC-SHA256 HTTPS to the existing Cloudflare
// Worker + Cloudflare D1 (`pna-rewards-db`) backend.
//
// Security guarantees:
//  • Zero database credentials and zero BOT_TOKEN in this server or frontend.
//  • Extracts real client IP via Express `trust proxy` (`X-Forwarded-For`).
//  • Issues & verifies server-signed opaque WebView installation tokens
//    (`pna_inst_v1.<id>.<hmac>`) via HttpOnly; Secure; SameSite=None cookie
//    with redundant client WebView origin-storage fallback.
//  • Never trusts unsigned or client-generated installation IDs.
//  • Per-IP sliding-window rate limiting on all `/api/verify/*` endpoints.
//  • Strict same-origin / allowlisted CORS and security headers.
//  • Every Worker bridge call is HMAC-SHA256 signed with timestamp + nonce.
// ============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const DIST_DIR = path.resolve(__dirname, 'dist-miniapp');
const INSTALL_COOKIE_NAME = 'pna_inst';
const INSTALL_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60; // 1 year

// Sliding-window in-memory IP rate limiter (Cloud Run instance scope)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 35;
const ipHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const key = ip || 'unknown';
  const prev = ipHits.get(key) || [];
  const recent = prev.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    ipHits.set(key, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(key, recent);
  if (ipHits.size > 5000) {
    for (const [k, list] of ipHits.entries()) {
      if (!list.some((ts) => now - ts < RATE_LIMIT_WINDOW_MS)) {
        ipHits.delete(k);
      }
    }
  }
  return false;
}

function extractClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0]?.trim() || '';
    if (first) return first.replace(/^::ffff:/, '');
  }
  const direct = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return direct;
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const envOrigins = [
    process.env.APP_URL,
    process.env.MINIAPP_URL,
    ...(process.env.MINIAPP_ALLOWED_ORIGINS || '').split(','),
    'https://p-a-rewards.ai.studio',
    'https://ais-pre-5anw25hqtptdicmzho3ex7-704214232389.asia-east1.run.app',
    'https://ais-dev-5anw25hqtptdicmzho3ex7-704214232389.asia-east1.run.app',
  ];
  for (const item of envOrigins) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    try {
      origins.add(new URL(clean).origin);
    } catch {
      // ignore invalid URL
    }
  }
  return origins;
}

function getWorkerConfig() {
  const rawUrl = String(process.env.CLOUDFLARE_WORKER_URL || '').trim().replace(/\/+$/, '');
  const bridgeSecret = String(process.env.MINIAPP_BRIDGE_SECRET || '').trim();
  let validUrl = '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' || (!IS_PROD && parsed.protocol === 'http:')) {
        validUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
      }
    } catch {
      validUrl = '';
    }
  }
  return { workerUrl: validUrl, bridgeSecret };
}

// ----------------------------------------------------------------------------
// Server-Signed WebView Installation Token (`pna_inst_v1.<id>.<hmac>`)
// ----------------------------------------------------------------------------
// Uses a domain-separated key derived from MINIAPP_BRIDGE_SECRET so BOTH
// Cloud Run and Cloudflare Worker independently verify every token signature.
// Unsigned, forged, or client-generated tokens are NEVER accepted.
// ----------------------------------------------------------------------------

function deriveInstallTokenKey(bridgeSecret: string): Buffer {
  return crypto
    .createHmac('sha256', bridgeSecret)
    .update('pna-rewards:install-token-key:v1')
    .digest();
}

export function mintSignedInstallToken(bridgeSecret: string): string {
  const tokenId = crypto.randomBytes(16).toString('hex');
  const key = deriveInstallTokenKey(bridgeSecret);
  const sig = crypto
    .createHmac('sha256', key)
    .update(`pna_inst_v1.${tokenId}`)
    .digest('hex');
  return `pna_inst_v1.${tokenId}.${sig}`;
}

export function verifySignedInstallToken(
  rawToken: unknown,
  bridgeSecret: string
): { valid: boolean; tokenId: string; token: string } {
  const clean = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!clean || !bridgeSecret) return { valid: false, tokenId: '', token: '' };
  const match = clean.match(/^pna_inst_v1\.([a-f0-9]{24,64})\.([a-f0-9]{64})$/i);
  if (!match) return { valid: false, tokenId: '', token: '' };
  const tokenId = match[1].toLowerCase();
  const providedSigHex = match[2].toLowerCase();
  const key = deriveInstallTokenKey(bridgeSecret);
  const expectedSig = crypto
    .createHmac('sha256', key)
    .update(`pna_inst_v1.${tokenId}`)
    .digest();
  const providedSig = Buffer.from(providedSigHex, 'hex');
  if (
    expectedSig.length !== providedSig.length ||
    !crypto.timingSafeEqual(expectedSig, providedSig)
  ) {
    return { valid: false, tokenId: '', token: '' };
  }
  return { valid: true, tokenId, token: `pna_inst_v1.${tokenId}.${providedSigHex}` };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function setInstallCookie(req: Request, res: Response, signedToken: string): void {
  const isHttps =
    IS_PROD ||
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      ?.trim() === 'https';

  const parts = [
    `${INSTALL_COOKIE_NAME}=${encodeURIComponent(signedToken)}`,
    'Path=/',
    `Max-Age=${INSTALL_COOKIE_MAX_AGE_SEC}`,
    'HttpOnly',
  ];
  if (isHttps) {
    parts.push('Secure', 'SameSite=None');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
  res.setHeader('Cache-Control', 'no-store, private');
}

interface ResolvedInstallAnchor {
  cookieToken: string;
  storageToken: string;
  canonicalToken: string;
  tamperedCookieToken: boolean;
  tamperedStorageToken: boolean;
  wasNewlyMinted: boolean;
}

function resolveInstallationAnchor(
  req: Request,
  res: Response,
  bridgeSecret: string,
  rawStorageToken: unknown
): ResolvedInstallAnchor {
  const cookies = parseCookies(req.headers.cookie);
  const rawCookie = String(cookies[INSTALL_COOKIE_NAME] || '').trim();
  const rawStorage = typeof rawStorageToken === 'string' ? rawStorageToken.trim() : '';

  const cookieCheck = verifySignedInstallToken(rawCookie, bridgeSecret);
  const storageCheck = verifySignedInstallToken(rawStorage, bridgeSecret);

  const tamperedCookieToken = Boolean(rawCookie && !cookieCheck.valid);
  const tamperedStorageToken = Boolean(rawStorage && !storageCheck.valid);

  let canonicalToken = '';
  let wasNewlyMinted = false;

  if (cookieCheck.valid) {
    canonicalToken = cookieCheck.token;
  } else if (storageCheck.valid) {
    canonicalToken = storageCheck.token;
  } else {
    canonicalToken = mintSignedInstallToken(bridgeSecret);
    wasNewlyMinted = true;
  }

  // Always refresh HttpOnly cookie so cleared cookies self-heal from valid WebView storage
  setInstallCookie(req, res, canonicalToken);

  return {
    cookieToken: cookieCheck.valid ? cookieCheck.token : '',
    storageToken: storageCheck.valid ? storageCheck.token : '',
    canonicalToken,
    tamperedCookieToken,
    tamperedStorageToken,
    wasNewlyMinted,
  };
}

function buildBridgeHeaders(
  method: string,
  targetPath: string,
  rawBody: string,
  bridgeSecret: string,
  originHeader: string
): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${method.toUpperCase()}\n${targetPath}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = crypto
    .createHmac('sha256', bridgeSecret)
    .update(canonical)
    .digest('hex');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-PnA-Timestamp': timestamp,
    'X-PnA-Nonce': nonce,
    'X-PnA-Signature': signature,
  };
  if (originHeader) {
    headers['X-PnA-Origin'] = originHeader;
  }
  return headers;
}

async function forwardToWorker(
  req: Request,
  res: Response,
  workerPath: string,
  payloadBuilder: (
    body: Record<string, unknown>,
    clientNetwork: Record<string, unknown>,
    installAnchor: ResolvedInstallAnchor
  ) => Record<string, unknown>
) {
  const clientIp = extractClientIp(req);
  if (isRateLimited(clientIp)) {
    res.status(429).json({
      ok: false,
      code: 'RATE_LIMITED',
      error: 'Too many requests from this network. Please wait a minute and retry.',
    });
    return;
  }

  const { workerUrl, bridgeSecret } = getWorkerConfig();
  if (!workerUrl || !bridgeSecret || bridgeSecret.length < 16) {
    res.status(503).json({
      ok: false,
      code: 'BRIDGE_NOT_CONFIGURED',
      error:
        'Verification backend bridge is not configured yet. Set CLOUDFLARE_WORKER_URL and MINIAPP_BRIDGE_SECRET on Cloud Run.',
    });
    return;
  }

  const incomingBody =
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

  const installAnchor = resolveInstallationAnchor(
    req,
    res,
    bridgeSecret,
    incomingBody.storageInstallToken
  );

  const countryCode = String(
    req.headers['x-appengine-country'] || req.headers['cf-ipcountry'] || ''
  ).slice(0, 16);
  const viaHeader = String(req.headers['via'] || '').trim();
  const forwardedHeader = String(req.headers['forwarded'] || '').trim();

  const clientNetwork = {
    ip: clientIp,
    countryCode,
    proxyHint:
      Boolean(viaHeader && /proxy|squid|tor/i.test(viaHeader)) ||
      /for=unknown/i.test(forwardedHeader),
  };

  const outboundPayload = payloadBuilder(incomingBody, clientNetwork, installAnchor);
  const rawBody = JSON.stringify(outboundPayload);
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const targetUrl = `${workerUrl}${workerPath}`;
  const targetPathname = new URL(targetUrl).pathname;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: buildBridgeHeaders('POST', targetPathname, rawBody, bridgeSecret, originHeader),
      body: rawBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const text = await upstream.text();
    let json: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { ok: false };
    } catch {
      json = { ok: false, error: 'Invalid response from verification backend.' };
    }
    if (upstream.ok) {
      json.issuedInstallToken = installAnchor.canonicalToken;
    }
    res.status(upstream.status).json(json);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    res.status(502).json({
      ok: false,
      code: isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      error: isAbort
        ? 'Verification backend timed out. Please retry.'
        : 'Could not reach the verification backend. Please retry shortly.',
    });
  }
}

async function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const allowedOrigins = getAllowedOrigins();

  // Security headers & strict CORS for API routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const hostOrigin = req.headers.host ? `${req.protocol}://${req.headers.host}` : '';
    if (origin && (origin === hostOrigin || allowedOrigins.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // Health endpoint for Cloud Run readiness probes
  app.get('/api/health', (_req: Request, res: Response) => {
    const { workerUrl, bridgeSecret } = getWorkerConfig();
    res.setHeader('Cache-Control', 'no-store, private');
    res.json({
      ok: true,
      service: 'pna-rewards-miniapp',
      bridgeConfigured: Boolean(workerUrl && bridgeSecret.length >= 16),
    });
  });

  // 1. Issue verification session & single-use challenge nonce
  app.post('/api/verify/session', async (req: Request, res: Response) => {
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    if (!initData) {
      res.status(400).json({ ok: false, error: 'Missing Telegram initData.' });
      return;
    }
    await forwardToWorker(
      req,
      res,
      '/api/internal/device-verify/session',
      (body, clientNetwork, installAnchor) => ({
        initData: body.initData,
        clientNetwork,
        installAnchor,
      })
    );
  });

  // 2. Submit browser/device fingerprint + signed Telegram initData + nonce
  app.post('/api/verify/submit', async (req: Request, res: Response) => {
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    const challengeNonce =
      typeof req.body?.challengeNonce === 'string' ? req.body.challengeNonce : '';
    if (!initData || !challengeNonce) {
      res.status(400).json({ ok: false, error: 'Missing required verification payload.' });
      return;
    }
    await forwardToWorker(
      req,
      res,
      '/api/internal/device-verify/submit',
      (body, clientNetwork, installAnchor) => ({
        initData: body.initData,
        challengeNonce: body.challengeNonce,
        signals: body.signals && typeof body.signals === 'object' ? body.signals : {},
        clientNetwork,
        installAnchor,
      })
    );
  });

  // 3. Observation-only device association recording for grandfathered/admin/verified users
  app.post('/api/verify/observe', async (req: Request, res: Response) => {
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    if (!initData) {
      res.status(400).json({ ok: false, error: 'Missing Telegram initData.' });
      return;
    }
    await forwardToWorker(
      req,
      res,
      '/api/internal/device-verify/observe',
      (body, clientNetwork, installAnchor) => ({
        initData: body.initData,
        signals: body.signals && typeof body.signals === 'object' ? body.signals : {},
        clientNetwork,
        installAnchor,
      })
    );
  });

  // 4. Poll authoritative verification status from Cloudflare D1
  app.post('/api/verify/status', async (req: Request, res: Response) => {
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    if (!initData) {
      res.status(400).json({ ok: false, error: 'Missing Telegram initData.' });
      return;
    }
    await forwardToWorker(
      req,
      res,
      '/api/internal/device-verify/status',
      (body, _clientNetwork, installAnchor) => ({
        initData: body.initData,
        installAnchor,
      })
    );
  });

  // Serve Mini App frontend: Vite dev middleware in dev, compiled dist-miniapp in prod
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(
      express.static(DIST_DIR, {
        index: false,
        maxAge: '1h',
      })
    );
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  return app;
}

createApp()
  .then((app) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`P^A REWARDS Mini App server listening on http://0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start Mini App server:', err);
    process.exit(1);
  });
