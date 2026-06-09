/**
 * PROOF-ONLY (Rust-wired), DARK (no production route flips this on) SecureStore
 * X25519-SECRET resolver for the executeRun-replacement TS->Rust agent-run SEALED WS
 * client (sub-slice B1-compose, the composition repoint to the sealed client).
 *
 * ## Why this exists (and why it is NOT the #612 symmetric resolver)
 * The PROVEN sealed client (`friday-rust-hub-agent-run-ws-sealed-client.ts`) speaks the
 * server's REAL ECDH handshake: it holds the client's X25519 SECRET scalar, performs the
 * X25519+HKDF agreement against the server pubkey, and BUILDS the per-request `auth_proof`
 * itself. So — unlike the old plain-WS client, which took a pre-built SYMMETRIC key AS the
 * `authProof` (#612's `resolveRustAgentRunWsSessionKey`) — the composition must resolve a
 * stable 32-byte X25519 SECRET, NOT a symmetric auth-proof key.
 *
 * The pubkey derived from this secret (`deviceKeypairFromSecret(secret).publicKey`, exposed
 * via {@link deriveRustAgentRunWsClientX25519PublicKey}) is EXACTLY what the operator enrolls
 * in the server's SecureStore peer-allowlist at 6b. B1-compose and 6b share this key material:
 * the same SecureStore master key + the same purpose tag deterministically yield the same
 * secret on the API host (the client) and the same pubkey the operator provisions on the Hub.
 *
 * ## Hard contracts enforced here (load-bearing — Directive-0i)
 * 1. **Fail-closed (no weak/zero/predictable key, ever)** — the resolver returns `null` (compose
 *    → today's 503) when: the presence env signal is explicitly off, {@link getMasterKey} THROWS
 *    (misconfig, e.g. an invalid `FRIDAY_MASTER_KEY`), the key is empty, or the derived secret is
 *    not 32 bytes. There is no anonymous / default-key fallback. **IMPORTANT (6b):** `getMasterKey`
 *    AUTO-GENERATES + persists a random key on a fresh host, so a *merely-absent* master key does
 *    NOT fail closed HERE — it yields a valid secret from a random key, and the fail-closed is then
 *    enforced SERVER-side (the derived pubkey is not in the peer-allowlist → no session). So 6b must
 *    enroll the pubkey derived from the prod host's STABLE master key, and RE-ENROLL on key rotation
 *    (a rotated master key changes the derived secret → changes the pubkey → the stale allowlist
 *    entry no longer matches → fail-closed until re-provisioned).
 * 2. **SecureStore-derived, never an env-var key** — the secret is derived through the
 *    keychain-backed {@link getMasterKey} path (the SecureStore root the secret admin uses),
 *    domain-separated with {@link WS_X25519_SECRET_PURPOSE}. An env var may carry only the
 *    OPAQUE presence signal ({@link FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT}); it NEVER
 *    carries key material. The raw master key NEVER crosses the wire.
 * 3. **Never printed / logged** — the secret bytes are returned to the in-process caller only.
 *    This module logs nothing and throws no error carrying the secret; the returned value is an
 *    opaque `Uint8Array`. (`// pragma: allowlist secret` markers below sit on the SecureStore
 *    lookup IDENTIFIERS / domain-separation tag, never on a literal key.)
 *
 * ## Truth labels (read before trusting this)
 * - **DARK substrate**: no production route resolves a real secret here until the composition
 *   is live-flipped (6b, operator gate). Reversible / inert.
 * - **`rust_wired` ceiling**: confers no v1 GO. In tests it is driven by an injected resolver
 *   returning a fixture secret — never a real keychain secret, never a real key.
 */
import { createHash } from "node:crypto";

import { getMasterKey } from "#providers";

import {
  deviceKeypairFromSecret,
  X25519_SECRET_LEN,
} from "./friday-rust-hub-agent-run-ws-sealed-crypto.js";

/**
 * The SecureStore domain-separation tag for the WS X25519 client secret. Derives a secret
 * distinct from the raw master key AND from every other SecureStore-derived purpose (including
 * #612's symmetric `friday.rust.agent_run.ws.session_key.v1`) — so the sealed-client secret can
 * never collide with the old symmetric auth-proof key.
 */
const WS_X25519_SECRET_PURPOSE = "friday.rust.agent_run.ws.x25519_secret.v1"; // pragma: allowlist secret

/**
 * An opt-in presence signal. The composition treats SecureStore as the source of truth; this
 * env var lets a deployment DISABLE the SecureStore lookup (force fail-closed) WITHOUT carrying
 * any key material. Set to exactly `"0"` / `"false"` to force a `null` resolve. It NEVER carries
 * the secret — only a boolean presence intent.
 */
export const FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT =
  "FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT"; // pragma: allowlist secret

/**
 * Resolve the Rust agent-run sealed-WS-client X25519 SECRET scalar from the SecureStore.
 * Returns the opaque 32-byte secret when present + valid, or `null` to fail closed
 * (missing/invalid/disabled).
 *
 * NEVER throws an error that carries the secret; NEVER logs the secret.
 */
export type FridayRustAgentRunWsClientX25519SecretResolver = () => Uint8Array | null;

/**
 * Default SecureStore-backed resolver. Derives a stable 32-byte X25519 SECRET from the keychain
 * master key with a purpose tag (domain separation), so the raw master key never crosses the
 * wire and the same secret is reproduced deterministically on every call (so the derived pubkey
 * the operator enrolls at 6b stays stable). Fails closed (returns `null`) when:
 *   - the presence env signal is explicitly off, or
 *   - the SecureStore master key is unavailable / throws, or
 *   - the derived secret is not exactly 32 bytes (defensive; sha256 is always 32 bytes).
 *
 * NOTE: a sha256 digest is a uniformly-random 32-byte string; X25519 clamps the scalar at use
 * (verified against `deviceKeypairFromSecret`), so any 32-byte digest is a valid X25519 secret.
 */
export function resolveRustAgentRunWsClientX25519Secret(): Uint8Array | null {
  // Read the presence signal via a literal env key (the exported constant names the same var
  // for callers/tests). A static literal avoids the dynamic object-injection lint sink.
  const presence = process.env.FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT;
  if (presence === "0" || presence === "false") {
    // Operator/deployment explicitly disabled the SecureStore lookup → fail closed.
    return null;
  }

  let masterKey: Buffer;
  try {
    // SecureStore root (keychain-backed). NOTE: on a fresh host getMasterKey AUTO-GENERATES +
    // persists a random key — it does NOT throw on a merely-absent key. It throws only on
    // MISCONFIG (e.g. an invalid `FRIDAY_MASTER_KEY`), which this catch fail-closes. A
    // merely-absent key therefore yields a VALID secret from a fresh random key; the resulting
    // pubkey simply will not be in the server peer-allowlist (until 6b enrollment) → no session
    // (fail-closed SERVER-side). The client never opens a weak/zero/predictable-key session.
    masterKey = getMasterKey();
  } catch {
    return null;
  }
  if (!masterKey || masterKey.length === 0) {
    return null;
  }

  // Domain-separated derivation: never expose the raw master key as the X25519 secret.
  const derived = createHash("sha256")
    .update(WS_X25519_SECRET_PURPOSE)
    .update(masterKey)
    .digest();
  if (derived.length !== X25519_SECRET_LEN) {
    return null;
  }
  return new Uint8Array(derived);
}

/**
 * Derive the raw 32-byte X25519 PUBLIC key from a resolved client SECRET. This is the value the
 * operator enrolls in the server's SecureStore peer-allowlist at 6b (the only key material that
 * leaves this host — and it is PUBLIC, never the secret). Does NOT call any server / network.
 *
 * Throws (via `deviceKeypairFromSecret`) on a non-32-byte secret — callers pass a resolved
 * secret, which is always 32 bytes; a malformed secret is a programming error, not a runtime
 * condition (the compose path fails closed on a non-32-byte resolve BEFORE this is reached).
 */
export function deriveRustAgentRunWsClientX25519PublicKey(secret: Uint8Array): Uint8Array {
  return deviceKeypairFromSecret(secret).publicKey;
}
