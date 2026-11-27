// ============================================================================
// Same-Origin HTTPS API Client for Cloud Run Verification BFF (`/api/verify/*`)
// ============================================================================

import type { DeviceFingerprintSignals } from './fingerprint';

export interface VerifySessionResponse {
  ok: boolean;
  alreadyVerified?: boolean;
  status?: string;
  challengeNonce?: string;
  expiresAt?: number;
  reviewId?: string | null;
  verificationToken?: string;
  expired?: boolean;
  code?: string;
  error?: string;
  user?: {
    id: string;
    firstName: string;
    username: string;
  };
}

export interface VerifySubmitResponse {
  ok: boolean;
  alreadyVerified?: boolean;
  verdict?: 'verified' | 'pending_review' | 'rejected' | 'grandfathered';
  verificationId?: string;
  reviewId?: string | null;
  verificationToken?: string;
  referralCredited?: boolean;
  canRetry?: boolean;
  expired?: boolean;
  code?: string;
  message?: string;
  error?: string;
}

export interface VerifyStatusResponse {
  ok: boolean;
  status?: string;
  forceJoinVerified?: boolean;
  verifiedAt?: number | null;
  latestVerificationId?: string | null;
  reviewId?: string | null;
  reviewStatus?: string | null;
  error?: string;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({
    ok: false,
    error: 'Unexpected response from server.',
  }))) as T;
  return data;
}

export function requestVerificationSession(initData: string): Promise<VerifySessionResponse> {
  return postJson<VerifySessionResponse>('/api/verify/session', { initData });
}

export function submitDeviceVerification(params: {
  initData: string;
  challengeNonce: string;
  signals: DeviceFingerprintSignals;
}): Promise<VerifySubmitResponse> {
  return postJson<VerifySubmitResponse>('/api/verify/submit', params);
}

export function fetchVerificationStatus(initData: string): Promise<VerifyStatusResponse> {
  return postJson<VerifyStatusResponse>('/api/verify/status', { initData });
}
