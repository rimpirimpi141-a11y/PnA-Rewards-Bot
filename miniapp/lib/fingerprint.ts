// ============================================================================
// Privacy-Conscious Probabilistic Browser/WebView Fingerprint Collector
// ============================================================================
// Collects ONLY standard web/WebView characteristics and hashes rendering
// signals client-side with SHA-256 before transmission.
//
// IMPORTANT TRANSPARENCY NOTE:
// Browser/WebView fingerprinting is probabilistic and can be spoofed by
// determined adversaries. This collector NEVER claims access to hardware
// IMEI, Android ID, SIM data, contacts, or local files.
// ============================================================================

export interface DeviceFingerprintSignals {
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  webglParamsHash: string;
  audioHash: string;
  fontMetricsHash: string;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  devicePixelRatio: number;
  timezone: string;
  timezoneOffset: number;
  language: string;
  languagesCount: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  platform: string;
  telegramPlatform: string;
  userAgentFamily: string;
  webdriver: boolean;
  automationSignals: string[];
}

async function sha256Hex(text: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    // Deterministic fallback hash if WebCrypto is unavailable
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

async function collectCanvasHash(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 240, 64);

    const grad = ctx.createLinearGradient(0, 0, 240, 64);
    grad.addColorStop(0, '#10b981');
    grad.addColorStop(1, '#3b82f6');
    ctx.fillStyle = grad;
    ctx.fillRect(6, 6, 228, 22);

    ctx.font = '600 15px "Plus Jakarta Sans", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('PnA-Verify-v1 #98765', 12, 10);

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
    ctx.beginPath();
    ctx.arc(46, 46, 12, 0, Math.PI * 1.65);
    ctx.stroke();

    const dataUrl = canvas.toDataURL('image/png');
    return await sha256Hex(dataUrl);
  } catch {
    return '';
  }
}

async function collectWebGLInfo(): Promise<{
  vendor: string;
  renderer: string;
  paramsHash: string;
}> {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: '', renderer: '', paramsHash: '' };

    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugExt
      ? String(gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) || '')
      : String(gl.getParameter(gl.VENDOR) || '');
    const renderer = debugExt
      ? String(gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) || '')
      : String(gl.getParameter(gl.RENDERER) || '');

    const params = [
      vendor,
      renderer,
      gl.getParameter(gl.VERSION),
      gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      gl.getParameter(gl.MAX_TEXTURE_SIZE),
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      (gl.getSupportedExtensions() || []).slice(0, 20).join(','),
    ].join('|');

    return {
      vendor: vendor.slice(0, 100),
      renderer: renderer.slice(0, 140),
      paramsHash: await sha256Hex(params),
    };
  } catch {
    return { vendor: '', renderer: '', paramsHash: '' };
  }
}

async function collectAudioHash(): Promise<string> {
  try {
    const OfflineCtx =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;
    if (!OfflineCtx) return '';

    const ctx = new OfflineCtx(1, 4096, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(10000, ctx.currentTime);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-50, ctx.currentTime);
    compressor.knee.setValueAtTime(40, ctx.currentTime);
    compressor.ratio.setValueAtTime(12, ctx.currentTime);
    compressor.attack.setValueAtTime(0, ctx.currentTime);
    compressor.release.setValueAtTime(0.25, ctx.currentTime);

    osc.connect(compressor);
    compressor.connect(ctx.destination);
    osc.start(0);

    const rendered = await Promise.race([
      ctx.startRendering(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 700)),
    ]);

    if (!rendered) return '';
    const channel = rendered.getChannelData(0);
    let acc = '';
    for (let i = 1000; i < 1200; i += 4) {
      acc += Math.round(channel[i] * 100000).toString(36) + ',';
    }
    return await sha256Hex(acc);
  } catch {
    return '';
  }
}

async function collectFontMetricsHash(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const sample = 'mmmmmmmmmmlli0123456789₹';
    const families = ['sans-serif', 'serif', 'monospace', 'Arial', 'Roboto', 'Helvetica Neue', 'Georgia'];
    const widths: string[] = [];
    for (const family of families) {
      ctx.font = `16px "${family}", sans-serif`;
      widths.push(`${family}:${Math.round(ctx.measureText(sample).width * 10)}`);
    }
    return await sha256Hex(widths.join('|'));
  } catch {
    return '';
  }
}

function detectAutomationSignals(): string[] {
  const signals: string[] = [];
  const win = window as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;

  if (nav.webdriver === true) signals.push('navigator_webdriver');
  if ('_phantom' in win || 'callPhantom' in win) signals.push('phantom');
  if ('__nightmare' in win) signals.push('nightmare');
  if ('__puppeteer_evaluation_script__' in win) signals.push('puppeteer');
  if ('__playwright' in win || '__pw_manual' in win) signals.push('playwright');
  if (typeof navigator.userAgent === 'string' && /HeadlessChrome/i.test(navigator.userAgent)) {
    signals.push('headless_ua');
  }
  return signals;
}

function parseUserAgentFamily(): string {
  const ua = String(navigator.userAgent || '');
  const parts: string[] = [];
  if (/Android/i.test(ua)) parts.push('Android');
  else if (/iPhone|iPad|iPod/i.test(ua)) parts.push('iOS');
  else if (/Windows/i.test(ua)) parts.push('Windows');
  else if (/Mac OS X/i.test(ua)) parts.push('macOS');
  else if (/Linux/i.test(ua)) parts.push('Linux');
  else parts.push('OtherOS');

  if (/Telegram/i.test(ua)) parts.push('TelegramWebView');
  if (/Chrome\//i.test(ua)) parts.push('Chromium');
  else if (/Safari\//i.test(ua)) parts.push('WebKit');
  else if (/Firefox\//i.test(ua)) parts.push('Gecko');
  return parts.join('/');
}

export async function collectDeviceFingerprint(
  telegramPlatform: string
): Promise<DeviceFingerprintSignals> {
  const [canvasHash, webgl, audioHash, fontMetricsHash] = await Promise.all([
    collectCanvasHash(),
    collectWebGLInfo(),
    collectAudioHash(),
    collectFontMetricsHash(),
  ]);

  const nav = navigator as Navigator & { deviceMemory?: number };
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();

  const automationSignals = detectAutomationSignals();

  return {
    canvasHash,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    webglParamsHash: webgl.paramsHash,
    audioHash,
    fontMetricsHash,
    screenWidth: Number(window.screen?.width || 0),
    screenHeight: Number(window.screen?.height || 0),
    colorDepth: Number(window.screen?.colorDepth || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    timezone: tz,
    timezoneOffset: new Date().getTimezoneOffset(),
    language: String(navigator.language || ''),
    languagesCount: Array.isArray(navigator.languages) ? navigator.languages.length : 0,
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    deviceMemory: Number(nav.deviceMemory || 0),
    maxTouchPoints: Number(navigator.maxTouchPoints || 0),
    platform: String(navigator.platform || ''),
    telegramPlatform: String(telegramPlatform || 'unknown'),
    userAgentFamily: parseUserAgentFamily(),
    webdriver: Boolean(navigator.webdriver),
    automationSignals,
  };
}
