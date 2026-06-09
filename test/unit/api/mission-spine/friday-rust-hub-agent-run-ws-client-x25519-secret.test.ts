import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveRustAgentRunWsClientX25519PublicKey,
  FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT,
  resolveRustAgentRunWsClientX25519Secret,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js";
import { deviceKeypairFromSecret } from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-crypto.js";
import { resetMasterKeyCache } from "../../../../src/security/friday-secret-crypto.js";

// execrun B1-compose (DARK): the SecureStore-backed X25519 client-SECRET resolver for the PROVEN
// sealed WS client (the ECDH model — REPLACES #612's symmetric session-key resolver). Fail-closed
// contract: a MISSING / disabled / short SecureStore secret resolves to `null` so the composition
// never opens an unauthenticated WS connection. The secret is NEVER logged. The pubkey helper
// derives the value 6b enrolls in the server peer-allowlist.

const SAVED_PRESENCE = process.env[FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT];
const SAVED_MASTER_KEY = process.env.FRIDAY_MASTER_KEY;
// A deterministic 32-byte hex master key so getMasterKey() returns a known value in-process.
const FIXTURE_MASTER_KEY_HEX = "11".repeat(32); // pragma: allowlist secret

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}

describe("resolveRustAgentRunWsClientX25519Secret (B1-compose, dark, SecureStore-backed)", () => {
  beforeEach(() => {
    delete process.env[FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT];
    // Hermetic: clear any inherited/leaked master-key env so each test controls it explicitly.
    delete process.env.FRIDAY_MASTER_KEY;
    // getMasterKey() caches the master key for a TTL; reset it so a per-test FRIDAY_MASTER_KEY
    // takes effect deterministically (and the suite never inherits a real provisioned key).
    resetMasterKeyCache();
  });

  afterEach(() => {
    restoreEnv(FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT, SAVED_PRESENCE);
    restoreEnv("FRIDAY_MASTER_KEY", SAVED_MASTER_KEY);
    resetMasterKeyCache();
    vi.restoreAllMocks();
  });

  it("explicit disable via the presence env signal → fail closed (null), no SecureStore read", () => {
    process.env[FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT] = "0";
    expect(resolveRustAgentRunWsClientX25519Secret()).toBeNull();
    process.env[FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT] = "false"; // pragma: allowlist secret
    expect(resolveRustAgentRunWsClientX25519Secret()).toBeNull();
  });

  it("never throws an error that carries the secret, and never logs", () => {
    // The presence signal off forces the no-read path; assert no console output leaks.
    process.env[FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT] = "0";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => resolveRustAgentRunWsClientX25519Secret()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("when the SecureStore master key is unavailable → fail closed (null), never a throw", () => {
    // With no keychain master key + no master-key env provisioned, the SecureStore lookup either
    // throws internally (→ null) or yields a key; in BOTH cases the resolver never throws and never
    // returns a short/invalid value.
    delete process.env.FRIDAY_MASTER_KEY;
    const result = resolveRustAgentRunWsClientX25519Secret();
    if (result !== null) {
      expect(result.length).toBe(32);
    } else {
      expect(result).toBeNull();
    }
  });

  it("derives a STABLE 32-byte secret from a fixture master key (idempotent across calls)", () => {
    process.env.FRIDAY_MASTER_KEY = FIXTURE_MASTER_KEY_HEX;
    const a = resolveRustAgentRunWsClientX25519Secret();
    const b = resolveRustAgentRunWsClientX25519Secret();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.length).toBe(32);
    // Same SecureStore master key + same purpose tag ⇒ same secret on every call (so the derived
    // pubkey the operator enrolls at 6b is stable).
    expect(Buffer.from(a!).equals(Buffer.from(b!))).toBe(true);
  });

  it("is domain-separated: a DIFFERENT master key yields a DIFFERENT secret", () => {
    process.env.FRIDAY_MASTER_KEY = FIXTURE_MASTER_KEY_HEX;
    const first = resolveRustAgentRunWsClientX25519Secret();
    process.env.FRIDAY_MASTER_KEY = "22".repeat(32); // pragma: allowlist secret
    resetMasterKeyCache(); // drop the cached first key so the new master key takes effect.
    const second = resolveRustAgentRunWsClientX25519Secret();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Buffer.from(first!).equals(Buffer.from(second!))).toBe(false);
  });

  it("derived secret is a valid X25519 scalar (deviceKeypairFromSecret accepts it; 32B pubkey)", () => {
    process.env.FRIDAY_MASTER_KEY = FIXTURE_MASTER_KEY_HEX;
    const secret = resolveRustAgentRunWsClientX25519Secret();
    expect(secret).not.toBeNull();
    const keypair = deviceKeypairFromSecret(secret!);
    expect(keypair.publicKey.length).toBe(32);
  });
});

describe("deriveRustAgentRunWsClientX25519PublicKey (the 6b peer-allowlist enrollment value)", () => {
  const SECRET_A = new Uint8Array(32).fill(7);
  const SECRET_B = new Uint8Array(32).fill(9);

  it("derives a STABLE 32-byte pubkey from a secret (matches deviceKeypairFromSecret)", () => {
    const pub = deriveRustAgentRunWsClientX25519PublicKey(SECRET_A);
    expect(pub.length).toBe(32);
    // Identical to the sealed-crypto keypair derivation (the value the server allowlist holds).
    const direct = deviceKeypairFromSecret(SECRET_A).publicKey;
    expect(Buffer.from(pub).equals(Buffer.from(direct))).toBe(true);
    // Stable across calls.
    const again = deriveRustAgentRunWsClientX25519PublicKey(SECRET_A);
    expect(Buffer.from(pub).equals(Buffer.from(again))).toBe(true);
  });

  it("distinct secrets yield distinct pubkeys", () => {
    const pubA = deriveRustAgentRunWsClientX25519PublicKey(SECRET_A);
    const pubB = deriveRustAgentRunWsClientX25519PublicKey(SECRET_B);
    expect(Buffer.from(pubA).equals(Buffer.from(pubB))).toBe(false);
  });

  it("throws on a non-32-byte secret (programming-error guard; compose fails closed before this)", () => {
    expect(() => deriveRustAgentRunWsClientX25519PublicKey(new Uint8Array(16))).toThrow();
  });
});
