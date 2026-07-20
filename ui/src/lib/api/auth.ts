import { apiClient } from "./client";
import { authStorage } from "@/lib/storage/auth-storage";
import type { DeviceClaimProof } from "@/lib/auth/device-key";
import type {
  AuthBootstrapChallengeResponse,
  AuthBootstrapResponse,
  AuthBootstrapStatusResponse,
  AuthDeviceClaimResponse,
  AuthLoginChallengeResponse,
  LoginResponse,
  MeResponse,
} from "./types";

export interface BootstrapLocalPassphraseInput {
  passphrase: string;
}

export interface LoginInput {
  localPassphrase?: string;
  email?: string;
  password?: string;
}

// ─── SEC-SETUP-BOOTSTRAP-001 (CR-1): device-bound owner claim client fns ───

export interface BootstrapChallengeInput {
  installId: string;
  osUser: string;
  origin: string;
  action?: string;
}

export interface DeviceClaimInput {
  nonce: string;
  devicePublicKey: string;
  deviceId: string;
  origin: string;
  installId: string;
  osUser: string;
  deviceClaimProof: DeviceClaimProof;
}

export interface DeviceKeyLoginInput {
  devicePublicKey: string;
  deviceId: string;
  origin: string;
  deviceLoginProof: DeviceClaimProof;
}

export interface LoginChallengeInput {
  installId: string;
  osUser: string;
  origin: string;
  deviceId: string;
  devicePublicKey: string;
  action?: string;
}

/** Mint a single-use install nonce (challenge) for a device-bound owner claim. */
export async function postBootstrapChallenge(
  input: BootstrapChallengeInput,
): Promise<AuthBootstrapChallengeResponse> {
  return apiClient.post<BootstrapChallengeInput, AuthBootstrapChallengeResponse>(
    "/v1/auth/bootstrap/challenge",
    input,
  );
}

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1): mint a single-use device-key LOGIN challenge
 * bound to this device + key + origin. The device signs the returned nonce into a
 * fresh owner-login transcript so the login proof-of-possession is not replayable.
 */
export async function postLoginChallenge(
  input: LoginChallengeInput,
): Promise<AuthLoginChallengeResponse> {
  return apiClient.post<LoginChallengeInput, AuthLoginChallengeResponse>(
    "/v1/auth/login/challenge",
    input,
  );
}

/**
 * Atomically claim the local owner slot with a device public key + proof-of-
 * possession. The backend is loopback-only, origin-bound, replay-protected.
 */
export async function postDeviceClaim(
  input: DeviceClaimInput,
): Promise<AuthDeviceClaimResponse> {
  return apiClient.post<DeviceClaimInput, AuthDeviceClaimResponse>(
    "/v1/auth/bootstrap/device-claim",
    input,
  );
}

/**
 * Log in with a device-key proof-of-possession (a fresh `owner-login` transcript
 * signed by the bound device key). On success stores the session, mirroring
 * `login()`. NOTE: the backend mints a session ONLY when device-owner authority is
 * enabled (native-IPC attestation) — otherwise it fails closed and the caller
 * falls back to the passphrase path.
 */
export async function deviceKeyLogin(input: DeviceKeyLoginInput): Promise<LoginResponse> {
  const data = await apiClient.post<DeviceKeyLoginInput, LoginResponse>(
    "/v1/auth/login",
    input,
  );
  authStorage.setTokens(data.accessToken, data.refreshToken, data.expiresInSec);
  authStorage.setUser(data.user);
  return data;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const data = await apiClient.post<LoginInput, LoginResponse>(
    "/v1/auth/login",
    input,
  );

  authStorage.setTokens(data.accessToken, data.refreshToken, data.expiresInSec);
  authStorage.setUser(data.user);

  return data;
}

export async function fetchMe(): Promise<MeResponse> {
  return apiClient.get<MeResponse>("/v1/auth/me");
}

export async function getBootstrapStatus(): Promise<AuthBootstrapStatusResponse> {
  return apiClient.get<AuthBootstrapStatusResponse>("/v1/auth/bootstrap/status");
}

/**
 * First-boot only: set the local passphrase for this machine's Friday. The backend
 * enforces loopback-only + first-boot-only (returns 409 if already bootstrapped).
 * On success the caller should immediately `login({ localPassphrase })`.
 */
export async function postBootstrapLocalPassphrase(
  input: BootstrapLocalPassphraseInput,
): Promise<AuthBootstrapResponse> {
  return apiClient.post<BootstrapLocalPassphraseInput, AuthBootstrapResponse>(
    "/v1/auth/bootstrap/local-passphrase",
    input,
  );
}

export async function logout(): Promise<void> {
  const refreshToken = authStorage.getRefreshToken();
  try {
    await apiClient.post("/v1/auth/logout", { refreshToken });
  } catch {
    // Best-effort
  }
  authStorage.clear();
}
