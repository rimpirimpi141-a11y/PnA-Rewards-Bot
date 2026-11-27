import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Fingerprint,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchVerificationStatus,
  requestVerificationSession,
  submitDeviceVerification,
} from './lib/api';
import { collectDeviceFingerprint } from './lib/fingerprint';
import {
  closeTelegramMiniApp,
  initTelegramMiniApp,
  triggerHaptic,
  type TelegramWebAppUser,
} from './lib/telegram';

type ScreenState =
  | 'booting'
  | 'outside_telegram'
  | 'ready'
  | 'verifying'
  | 'verified'
  | 'pending_review'
  | 'rejected'
  | 'error';

type StepStatus = 'idle' | 'active' | 'done' | 'warn';

interface StepItem {
  id: string;
  label: string;
  detail: string;
  status: StepStatus;
}

const INITIAL_STEPS: StepItem[] = [
  {
    id: 'telegram',
    label: 'Telegram Identity Signature',
    detail: 'Validates signed WebApp initData on server',
    status: 'idle',
  },
  {
    id: 'device',
    label: 'Browser & Device Signals',
    detail: 'Creates salted probabilistic fingerprint hash',
    status: 'idle',
  },
  {
    id: 'unlock',
    label: 'Anti-Abuse Check & Unlock',
    detail: 'Saves record in D1 and unlocks bot menu',
    status: 'idle',
  },
];

export default function App() {
  const [screen, setScreen] = useState<ScreenState>('booting');
  const [initData, setInitData] = useState('');
  const [tgUser, setTgUser] = useState<TelegramWebAppUser | null>(null);
  const [tgPlatform, setTgPlatform] = useState('unknown');
  const [steps, setSteps] = useState<StepItem[]>(INITIAL_STEPS);
  const [headlineMessage, setHeadlineMessage] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [checkingStatus, setCheckingStatus] = useState(false);

  const updateStep = useCallback((id: string, status: StepStatus) => {
    setSteps((prev) => prev.map((item) => (item.id === id ? { ...item, status } : item)));
  }, []);

  const bootstrap = useCallback(async () => {
    const tg = initTelegramMiniApp();
    setTgPlatform(tg.platform);
    setTgUser(tg.user);

    if (!tg.isInsideTelegram || !tg.initData) {
      setScreen('outside_telegram');
      return;
    }

    setInitData(tg.initData);

    // Check existing authoritative status first
    const statusRes = await fetchVerificationStatus(tg.initData);
    if (statusRes.ok && (statusRes.status === 'verified' || statusRes.status === 'grandfathered')) {
      setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'done' })));
      setHeadlineMessage('Your device is verified and your 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 menu is unlocked.');
      setReferenceId(statusRes.latestVerificationId || '');
      setScreen('verified');
      return;
    }

    if (statusRes.ok && statusRes.status === 'pending_review') {
      setReferenceId(statusRes.reviewId || statusRes.latestVerificationId || '');
      setHeadlineMessage(
        'Your device check is queued for admin review. You may retry below if you disabled a VPN or temporary browser.'
      );
      setScreen('pending_review');
      return;
    }

    if (statusRes.ok && statusRes.status === 'rejected') {
      setReferenceId(statusRes.reviewId || statusRes.latestVerificationId || '');
      setHeadlineMessage(
        'Automatic verification could not pass due to high duplicate-device or automation signals. Share your reference ID with Support for manual review.'
      );
      setScreen('rejected');
      return;
    }

    setSteps(INITIAL_STEPS);
    setScreen('ready');
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const runVerification = useCallback(async () => {
    if (!initData) {
      setScreen('outside_telegram');
      return;
    }

    triggerHaptic('medium');
    setErrorCode('');
    setHeadlineMessage('');
    setScreen('verifying');
    setSteps([
      { ...INITIAL_STEPS[0], status: 'active' },
      { ...INITIAL_STEPS[1], status: 'idle' },
      { ...INITIAL_STEPS[2], status: 'idle' },
    ]);

    try {
      // Step 1: Validate Telegram initData & obtain single-use server challenge nonce
      const sessionRes = await requestVerificationSession(initData);
      if (!sessionRes.ok) {
        updateStep('telegram', 'warn');
        triggerHaptic('error');
        setErrorCode(sessionRes.code || '');
        setHeadlineMessage(sessionRes.error || 'Could not validate Telegram session.');
        setScreen('error');
        return;
      }

      if (sessionRes.alreadyVerified) {
        setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'done' })));
        triggerHaptic('success');
        setHeadlineMessage('Your device is already verified. Return to the bot to continue.');
        setScreen('verified');
        return;
      }

      if (!sessionRes.challengeNonce) {
        updateStep('telegram', 'warn');
        triggerHaptic('error');
        setHeadlineMessage('Verification challenge was not issued. Please retry.');
        setScreen('error');
        return;
      }

      updateStep('telegram', 'done');
      updateStep('device', 'active');

      // Step 2: Collect privacy-conscious probabilistic browser/WebView fingerprint
      const signals = await collectDeviceFingerprint(tgPlatform);

      updateStep('device', 'done');
      updateStep('unlock', 'active');

      // Step 3: Submit to Cloud Run BFF -> Cloudflare Worker -> Cloudflare D1
      const submitRes = await submitDeviceVerification({
        initData,
        challengeNonce: sessionRes.challengeNonce,
        signals,
      });

      if (!submitRes.ok) {
        updateStep('unlock', 'warn');
        triggerHaptic('error');
        setErrorCode(submitRes.code || '');
        setHeadlineMessage(submitRes.error || 'Device verification failed. Please retry.');
        setScreen('error');
        return;
      }

      setReferenceId(submitRes.reviewId || submitRes.verificationId || '');

      if (submitRes.verdict === 'verified' || submitRes.verdict === 'grandfathered') {
        updateStep('unlock', 'done');
        triggerHaptic('success');
        setHeadlineMessage(
          submitRes.message || 'Device verified! Your bot dashboard is now unlocked.'
        );
        setScreen('verified');
        return;
      }

      if (submitRes.verdict === 'pending_review') {
        updateStep('unlock', 'warn');
        triggerHaptic('warning');
        setHeadlineMessage(
          submitRes.message ||
            'Your verification is queued for administrator review to protect fair rewards.'
        );
        setScreen('pending_review');
        return;
      }

      updateStep('unlock', 'warn');
      triggerHaptic('error');
      setHeadlineMessage(
        submitRes.message || 'Verification could not be completed automatically.'
      );
      setScreen('rejected');
    } catch {
      triggerHaptic('error');
      setHeadlineMessage('Network error during verification. Check your connection and retry.');
      setScreen('error');
    }
  }, [initData, tgPlatform, updateStep]);

  const refreshStatus = useCallback(async () => {
    if (!initData) return;
    setCheckingStatus(true);
    triggerHaptic('light');
    try {
      const res = await fetchVerificationStatus(initData);
      if (res.ok && (res.status === 'verified' || res.status === 'grandfathered')) {
        triggerHaptic('success');
        setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'done' })));
        setHeadlineMessage('Approved! Your device is verified and your bot menu is unlocked.');
        setScreen('verified');
      } else if (res.ok && res.status === 'rejected') {
        setScreen('rejected');
      }
    } finally {
      setCheckingStatus(false);
    }
  }, [initData]);

  const userDisplayName = tgUser?.first_name
    ? `${tgUser.first_name}${tgUser.last_name ? ` ${tgUser.last_name}` : ''}`
    : 'Telegram Member';

  return (
    <div className="min-h-[100dvh] flex flex-col justify-between max-w-md mx-auto px-5 safe-top safe-bottom">
      {/* Top Brand Header */}
      <header className="pt-2 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight leading-tight">
              𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒
            </h1>
            <p className="text-xs font-medium" style={{ color: 'var(--pna-muted)' }}>
              Device Verification
            </p>
          </div>
        </div>

        {tgUser && (
          <div className="text-right">
            <p className="text-xs font-semibold truncate max-w-[130px]">{userDisplayName}</p>
            <p className="text-[11px] font-mono-code" style={{ color: 'var(--pna-muted)' }}>
              ID {tgUser.id}
            </p>
          </div>
        )}
      </header>

      {/* Main Centered Content */}
      <main className="flex-1 flex flex-col justify-center py-2 gap-4">
        {screen === 'booting' && (
          <div
            className="rounded-3xl p-8 border flex flex-col items-center text-center gap-4"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'var(--pna-border)' }}
          >
            <Loader2 className="w-9 h-9 text-emerald-400 animate-spin" />
            <div>
              <h2 className="text-lg font-bold">Connecting to Telegram</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--pna-muted)' }}>
                Checking your secure Mini App session...
              </p>
            </div>
          </div>
        )}

        {screen === 'outside_telegram' && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl p-6 border flex flex-col items-center text-center gap-4"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'var(--pna-border)' }}
          >
            <div className="w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Smartphone className="w-7 h-7" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-bold tracking-tight">Open Inside Telegram</h2>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
                Device verification requires a cryptographically signed Telegram WebApp session.
                Return to the <strong>𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒</strong> bot, verify your required channels, and
                tap <strong>Verify Device</strong> inside Telegram.
              </p>
            </div>
          </motion.section>
        )}

        {(screen === 'ready' || screen === 'verifying') && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {/* Hero Status Card */}
            <div
              className="rounded-3xl p-6 border space-y-5"
              style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'var(--pna-border)' }}
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center text-emerald-400 shrink-0">
                  {screen === 'verifying' ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <Fingerprint className="w-6 h-6" />
                  )}
                </div>
                <div className="space-y-1">
                  <h2 className="text-xl font-extrabold tracking-tight leading-snug">
                    {screen === 'verifying' ? 'Verifying Your Device' : 'Verify Your Device'}
                  </h2>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
                    {screen === 'verifying'
                      ? 'Validating your Telegram session and checking anti-abuse signals...'
                      : 'Complete this quick one-time check to unlock your dashboard and protect genuine referral rewards.'}
                  </p>
                </div>
              </div>

              {/* 3-Step Verification Progress */}
              <div className="space-y-3 pt-1">
                {steps.map((step) => (
                  <div
                    key={step.id}
                    className="flex items-center gap-3.5 p-3 rounded-2xl border transition-colors"
                    style={{
                      backgroundColor: 'var(--pna-surface-2)',
                      borderColor:
                        step.status === 'active'
                          ? 'rgba(16, 185, 129, 0.45)'
                          : 'var(--pna-border)',
                    }}
                  >
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0">
                      {step.status === 'done' && (
                        <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                          <Check className="w-4 h-4 stroke-[2.75]" />
                        </div>
                      )}
                      {step.status === 'active' && (
                        <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                          <Loader2 className="w-4 h-4 animate-spin" />
                        </div>
                      )}
                      {step.status === 'warn' && (
                        <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
                          <AlertTriangle className="w-4 h-4" />
                        </div>
                      )}
                      {step.status === 'idle' && (
                        <div
                          className="w-8 h-8 rounded-xl border flex items-center justify-center"
                          style={{ borderColor: 'var(--pna-border)', color: 'var(--pna-muted)' }}
                        >
                          <Lock className="w-3.5 h-3.5" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold leading-tight">{step.label}</p>
                      <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--pna-muted)' }}>
                        {step.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Honest Privacy & Probabilistic Transparency Disclosure */}
            <div
              className="rounded-2xl p-4 border flex items-start gap-3"
              style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'var(--pna-border)' }}
            >
              <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
                <strong style={{ color: 'var(--pna-text)' }}>Privacy &amp; Fairness Notice:</strong>{' '}
                We evaluate probabilistic browser/WebView characteristics (screen, rendering,
                timezone, and hardware hints) stored as salted hashes. We do not access hardware
                IMEI, Android ID, or private files, and shared Wi-Fi/IP alone never rejects your
                account.
              </p>
            </div>
          </motion.section>
        )}

        {screen === 'verified' && (
          <motion.section
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-3xl p-7 border flex flex-col items-center text-center gap-4"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'rgba(16, 185, 129, 0.35)' }}
          >
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-9 h-9" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-2xl font-extrabold tracking-tight">Device Verified</h2>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
                {headlineMessage}
              </p>
            </div>
            {referenceId && (
              <div
                className="w-full rounded-xl px-4 py-2.5 border flex items-center justify-between text-xs"
                style={{ backgroundColor: 'var(--pna-surface-2)', borderColor: 'var(--pna-border)' }}
              >
                <span style={{ color: 'var(--pna-muted)' }}>Verification ID</span>
                <span className="font-mono-code font-semibold">{referenceId}</span>
              </div>
            )}
          </motion.section>
        )}

        {screen === 'pending_review' && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl p-6 border space-y-4"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'rgba(245, 158, 11, 0.35)' }}
          >
            <div className="flex items-center gap-3.5">
              <div className="w-13 h-13 rounded-2xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center text-amber-400 shrink-0">
                <Clock className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold tracking-tight">Under Security Review</h2>
                <p className="text-xs font-medium text-amber-400 mt-0.5">
                  Manual admin check queued
                </p>
              </div>
            </div>

            <p className="text-sm leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
              {headlineMessage}
            </p>

            {referenceId && (
              <div
                className="rounded-xl px-4 py-3 border flex items-center justify-between text-xs"
                style={{ backgroundColor: 'var(--pna-surface-2)', borderColor: 'var(--pna-border)' }}
              >
                <span style={{ color: 'var(--pna-muted)' }}>Review Reference</span>
                <span className="font-mono-code font-semibold">{referenceId}</span>
              </div>
            )}

            <button
              type="button"
              onClick={refreshStatus}
              disabled={checkingStatus}
              className="w-full h-12 rounded-2xl border font-semibold text-sm flex items-center justify-center gap-2 transition active:scale-[0.99] disabled:opacity-60"
              style={{ backgroundColor: 'var(--pna-surface-2)', borderColor: 'var(--pna-border)' }}
            >
              <RefreshCw className={`w-4 h-4 ${checkingStatus ? 'animate-spin' : ''}`} />
              {checkingStatus ? 'Checking Status...' : 'Check Approval Status'}
            </button>
          </motion.section>
        )}

        {screen === 'rejected' && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl p-6 border space-y-4"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'rgba(239, 68, 68, 0.35)' }}
          >
            <div className="flex items-center gap-3.5">
              <div className="w-13 h-13 rounded-2xl bg-red-500/15 border border-red-500/35 flex items-center justify-center text-red-400 shrink-0">
                <ShieldAlert className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold tracking-tight">Verification Held</h2>
                <p className="text-xs font-medium text-red-400 mt-0.5">
                  Admin review required
                </p>
              </div>
            </div>

            <p className="text-sm leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
              {headlineMessage}
            </p>

            {referenceId && (
              <div
                className="rounded-xl px-4 py-3 border flex items-center justify-between text-xs"
                style={{ backgroundColor: 'var(--pna-surface-2)', borderColor: 'var(--pna-border)' }}
              >
                <span style={{ color: 'var(--pna-muted)' }}>Reference ID</span>
                <span className="font-mono-code font-semibold">{referenceId}</span>
              </div>
            )}
          </motion.section>
        )}

        {screen === 'error' && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl p-6 border space-y-4"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
          >
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold tracking-tight">Verification Interrupted</h2>
                {errorCode && (
                  <p className="text-xs font-mono-code text-red-400 mt-0.5">{errorCode}</p>
                )}
              </div>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--pna-muted)' }}>
              {headlineMessage}
            </p>
          </motion.section>
        )}
      </main>

      {/* Bottom Thumb-Zone Primary Action Bar */}
      <footer className="pt-4">
        {screen === 'ready' && (
          <button
            type="button"
            onClick={runVerification}
            className="w-full h-14 rounded-2xl bg-emerald-500 hover:bg-emerald-600 active:scale-[0.99] text-slate-950 font-bold text-base flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition"
          >
            <ShieldCheck className="w-5 h-5" />
            Verify My Device
            <ArrowRight className="w-4 h-4" />
          </button>
        )}

        {screen === 'verifying' && (
          <button
            type="button"
            disabled
            className="w-full h-14 rounded-2xl bg-emerald-500/25 text-emerald-300 font-bold text-base flex items-center justify-center gap-2.5 cursor-not-allowed"
          >
            <Loader2 className="w-5 h-5 animate-spin" />
            Verifying Securely...
          </button>
        )}

        {screen === 'verified' && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              closeTelegramMiniApp();
            }}
            className="w-full h-14 rounded-2xl bg-emerald-500 hover:bg-emerald-600 active:scale-[0.99] text-slate-950 font-bold text-base flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition"
          >
            Return to Bot Dashboard
            <ArrowRight className="w-5 h-5" />
          </button>
        )}

        {(screen === 'pending_review' || screen === 'error') && (
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={runVerification}
              className="w-full h-14 rounded-2xl bg-emerald-500 hover:bg-emerald-600 active:scale-[0.99] text-slate-950 font-bold text-base flex items-center justify-center gap-2 transition"
            >
              <RefreshCw className="w-5 h-5" />
              Retry Device Verification
            </button>
            <button
              type="button"
              onClick={closeTelegramMiniApp}
              className="w-full h-11 rounded-xl text-sm font-semibold transition"
              style={{ color: 'var(--pna-muted)' }}
            >
              Close &amp; Return to Bot
            </button>
          </div>
        )}

        {screen === 'rejected' && (
          <button
            type="button"
            onClick={closeTelegramMiniApp}
            className="w-full h-14 rounded-2xl border font-bold text-base flex items-center justify-center gap-2 transition"
            style={{ backgroundColor: 'var(--pna-surface)', borderColor: 'var(--pna-border)' }}
          >
            Return to Bot
          </button>
        )}
      </footer>
    </div>
  );
}
