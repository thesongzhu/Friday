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
  AuthLoginChallengeResponse,
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
  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1 · Advisor #1628 finding #2): mint a server-issued
   * single-use login challenge bound to this device + key + origin. Its nonce is the
   * ONLY value the backend accepts in the owner-login transcript, which makes the
   * login proof non-replayable.
   */
  issueLoginChallenge(input: {
    installId: string;
    osUser: string;
    origin: string;
    deviceId: string;
    devicePublicKey: string;
  }): Promise<AuthLoginChallengeResponse>;
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
}

const TRANSCRIPT_CHANNEL = "ui-loopback";

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

  // 3) Mint a SERVER-ISSUED single-use login challenge (Advisor #1628 finding #2):
  //    the login nonce is chosen by the SERVER, not the client, so a captured
  //    owner-login transcript cannot be replayed to mint a second session. The
  //    challenge is bound to this device + key + origin; its nonce + expiry govern
  //    the login transcript (the client no longer self-generates either).
  const loginChallenge = await api.issueLoginChallenge({
    installId: ctx.installId,
    osUser: ctx.osUser,
    origin: ctx.origin,
    deviceId: key.deviceId,
    devicePublicKey: key.devicePublicKeySpkiBase64,
  });

  // 4) Sign a FRESH owner-login transcript over the server nonce and mint a session
  //    by proving possession.
  const loginTranscript: DeviceClaimTranscript = {
    transcriptVersion: "friday-owner-claim-v1",
    algorithm: "ECDSA_P256_SHA256",
    kind: "install_owner_claim",
    hubId: loginChallenge.hubId,
    installId: loginChallenge.installId,
    osUser: loginChallenge.osUser,
    deviceId: key.deviceId,
    action: "owner-login",
    origin: loginChallenge.origin,
    channel: TRANSCRIPT_CHANNEL,
    nonce: loginChallenge.nonce,
    expiresAt: loginChallenge.expiresAt,
    devicePublicKeyHash: key.devicePublicKeyHash,
  };
  const loginSignature = await provider.signTranscript(loginTranscript);
  return api.login({
    devicePublicKey: key.devicePublicKeySpkiBase64,
    deviceId: key.deviceId,
    origin: loginChallenge.origin,
    deviceLoginProof: { transcript: loginTranscript, signature: loginSignature },
  });
}
