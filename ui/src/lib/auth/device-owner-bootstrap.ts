// ─── SEC-SETUP-BOOTSTRAP-001 · CR-1 — device-owner bootstrap orchestration (UI) ───
//
// Ties the device-key seam to the three backend legs for a first-run device-bound
// owner: challenge → device-claim → device-key login. Pure orchestration with
// INJECTED api callables + device-key provider so it is unit-testable end-to-end
// against the real server verifier (see test/unit/ui/device-owner-bootstrap.test.ts).
//
// It fabricates NOTHING: the transcripts are signed by a real device key, and the
// final login mints a session ONLY if the backend's native-IPC attestation
// precondition is enabled (else the login call fails closed and this rejects — the
// caller must then fall back to the passphrase path, NOT to a fabricated identity).

import {
  DeviceKeyUnavailableError,
  type DeviceClaimProof,
  type DeviceClaimTranscript,
  type DeviceKeyProvider,
} from "./device-key";
import type {
  AuthBootstrapChallengeResponse,
  AuthDeviceClaimResponse,
  LoginResponse,
} from "../api/types";

/** The transport leg — real implementations are the `@/lib/api/auth` client fns. */
export interface DeviceOwnerBootstrapApi {
  issueChallenge(input: {
    installId: string;
    osUser: string;
    origin: string;
  }): Promise<AuthBootstrapChallengeResponse>;
  claim(input: {
    nonce: string;
    devicePublicKey: string;
    deviceId: string;
    origin: string;
    installId: string;
    osUser: string;
    deviceClaimProof: DeviceClaimProof;
  }): Promise<AuthDeviceClaimResponse>;
  login(input: {
    devicePublicKey: string;
    deviceId: string;
    origin: string;
    deviceLoginProof: DeviceClaimProof;
  }): Promise<LoginResponse>;
}

export interface DeviceOwnerBootstrapContext {
  /** Loopback origin (window.location.origin in the browser). */
  origin: string;
  /** Best-effort install id (stable per install). */
  installId: string;
  /**
   * Best-effort OS user LABEL. The browser cannot authoritatively know the OS
   * user — the trusted caller-identity binding is the native-IPC leaf — so this is
   * only echoed into the (signed, but not server-cross-checked) transcript.
   */
  osUser: string;
  /** Deterministic clock override (tests). Defaults to Date.now. */
  nowMs?: () => number;
  /** Deterministic login-nonce override (tests). Defaults to a random value. */
  randomNonce?: () => string;
  /** Login transcript TTL (ms); MUST be <= the server login TTL clamp (300s). */
  loginTranscriptTtlMs?: number;
}

const TRANSCRIPT_CHANNEL = "ui-loopback";
const DEFAULT_LOGIN_TTL_MS = 120_000;

function defaultRandomNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `login-${c.randomUUID()}`;
  const rnd = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(rnd);
  let hex = "";
  for (let i = 0; i < rnd.length; i += 1) hex += rnd[i].toString(16).padStart(2, "0");
  return `login-${hex}`;
}

/**
 * Run the full device-owner first-run: generate/get the device key, claim the
 * owner slot, then log in with a device-key proof-of-possession. Returns the
 * minted session. Fails closed (throws) when the device-key capability is
 * unavailable OR when the backend refuses to mint (device authority disabled).
 */
export async function runDeviceOwnerBootstrap(
  provider: DeviceKeyProvider,
  api: DeviceOwnerBootstrapApi,
  ctx: DeviceOwnerBootstrapContext,
): Promise<LoginResponse> {
  if (!provider.isAvailable()) {
    throw new DeviceKeyUnavailableError();
  }
  const key = await provider.getOrCreateDeviceKey();

  // 1) Mint a single-use install challenge.
  const challenge = await api.issueChallenge({
    installId: ctx.installId,
    osUser: ctx.osUser,
    origin: ctx.origin,
  });

  // 2) Sign the canonical owner-claim transcript bound to the challenge + claim it.
  const claimTranscript: DeviceClaimTranscript = {
    transcriptVersion: "friday-owner-claim-v1",
    algorithm: "ECDSA_P256_SHA256",
    kind: "install_owner_claim",
    hubId: challenge.hubId,
    installId: challenge.installId,
    osUser: challenge.osUser,
    deviceId: key.deviceId,
    action: challenge.action,
    origin: challenge.origin,
    channel: TRANSCRIPT_CHANNEL,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    devicePublicKeyHash: key.devicePublicKeyHash,
  };
  const claimSignature = await provider.signTranscript(claimTranscript);
  await api.claim({
    nonce: challenge.nonce,
    devicePublicKey: key.devicePublicKeySpkiBase64,
    deviceId: key.deviceId,
    origin: challenge.origin,
    installId: challenge.installId,
    osUser: challenge.osUser,
    deviceClaimProof: { transcript: claimTranscript, signature: claimSignature },
  });

  // 3) Sign a FRESH owner-login transcript and mint a session by proving possession.
  const nowMs = (ctx.nowMs ?? (() => Date.now()))();
  const ttlMs = ctx.loginTranscriptTtlMs ?? DEFAULT_LOGIN_TTL_MS;
  const loginTranscript: DeviceClaimTranscript = {
    transcriptVersion: "friday-owner-claim-v1",
    algorithm: "ECDSA_P256_SHA256",
    kind: "install_owner_claim",
    hubId: challenge.hubId,
    installId: challenge.installId,
    osUser: challenge.osUser,
    deviceId: key.deviceId,
    action: "owner-login",
    origin: ctx.origin,
    channel: TRANSCRIPT_CHANNEL,
    nonce: (ctx.randomNonce ?? defaultRandomNonce)(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    devicePublicKeyHash: key.devicePublicKeyHash,
  };
  const loginSignature = await provider.signTranscript(loginTranscript);
  return api.login({
    devicePublicKey: key.devicePublicKeySpkiBase64,
    deviceId: key.deviceId,
    origin: ctx.origin,
    deviceLoginProof: { transcript: loginTranscript, signature: loginSignature },
  });
}
