/**
 * PROOF-ONLY (Rust-wired), DARK (no production route flips this on) SecureStore
 * SESSION-KEY resolver for the executeRun-replacement TS->Rust agent-run WS client
 * (sub-slice S-F-compose, the composition).
 *
 * ## Why this exists (operator decision)
 * The composition routes a qualifying production agent-run over the long-lived Rust
 * agent-run WS server. Before the TS client may open that socket and dispatch a run, it
 * must hold the WS SESSION KEY — the sealed `authProof` bytes the Rust auth sub-slice
 * (S-C) verifies against the session. The operator decision: that key is obtained via the
 * SecureStore path (the keychain-backed master-key store), NOT an unguarded env var that
 * a misconfigured process could leak. A MISSING / invalid key MUST fail CLOSED: the
 * composition never opens an UNAUTHENTICATED WS connection — it falls to today's 503.
 *
 * ## Hard contracts enforced here (load-bearing)
 * 1. **Fail-closed on missing/invalid** — `resolveRustAgentRunWsSessionKey` returns
 *    `null` when the SecureStore has no key, the key is empty, or it is shorter than the
 *    floor below. The caller treats `null` as "do not route to Rust" (503), and NEVER
 *    opens a WS connection without a key. There is no anonymous / default fallback.
 * 2. **Never printed / logged** — the key bytes are returned to the in-process caller
 *    only. This module throws no error carrying the key, logs nothing, and the returned
 *    value is opaque `Uint8Array`. (`// pragma: allowlist secret` markers below sit on
 *    the SecureStore lookup IDENTIFIERS, never on a literal key.)
 * 3. **SecureStore-only source** — the key is read through the keychain-backed
 *    {@link getMasterKey} path (the same SecureStore root the secret admin service uses),
 *    derived deterministically for this WS purpose. There is no plaintext env-var key
 *    path: an env var may carry the OPAQUE SecureStore presence signal (see
 *    {@link FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT}) but never the key material.
 *
 * ## Truth labels (read before trusting this)
 * - **DARK substrate**: no production route resolves a real key here until the
 *   composition slice is live-flipped (slice 6, operator gate). Reversible / inert.
 * - **`rust_wired` ceiling**: confers no v1 GO. In tests it is driven by an injected
 *   resolver returning a fixture key — never a real keychain secret, never a real key.
 */
import { createHash } from "node:crypto";

import { getMasterKey } from "#providers";

/**
 * The minimum acceptable derived-key length (bytes). A key shorter than this is treated
 * as invalid → fail closed. 32 bytes (a sha256 digest) is the floor.
 */
const MIN_SESSION_KEY_LEN = 32;

/**
 * The SecureStore lookup label for this WS purpose. Used as a domain-separation tag when
 * deriving the WS session key from the SecureStore master key, so the WS key is never the
 * raw master key and never collides with another SecureStore-derived purpose.
 */
const WS_SESSION_KEY_PURPOSE = "friday.rust.agent_run.ws.session_key.v1"; // pragma: allowlist secret

/**
 * An opt-in presence signal. The composition treats SecureStore as the source of truth;
 * this env var lets a deployment DISABLE the SecureStore lookup (force fail-closed) WITHOUT
 * carrying any key material. Set to exactly `"0"` / `"false"` to force a `null` resolve.
 * It NEVER carries the key — only a boolean presence intent.
 */
export const FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT =
  "FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT"; // pragma: allowlist secret

/**
 * Resolve the Rust agent-run WS session key from the SecureStore. Returns the opaque
 * key bytes when present + valid, or `null` to fail closed (missing/invalid/disabled).
 *
 * NEVER throws an error that carries the key; NEVER logs the key.
 */
export type FridayRustAgentRunWsSessionKeyResolver = () => Uint8Array | null;

/**
 * Default SecureStore-backed resolver. Derives the WS session key from the keychain master
 * key with a purpose tag (domain separation) so the raw master key never crosses the wire.
 * Fails closed (returns `null`) when:
 *   - the presence env signal is explicitly off, or
 *   - the SecureStore master key is unavailable / throws, or
 *   - the derived key is shorter than the floor (defensive; sha256 is always 32 bytes).
 */
export function resolveRustAgentRunWsSessionKey(): Uint8Array | null {
  // Read the presence signal via a literal env key (the exported constant names the same
  // var for callers/tests). A static literal avoids the dynamic object-injection lint sink.
  const presence = process.env.FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT;
  if (presence === "0" || presence === "false") {
    // Operator/deployment explicitly disabled the SecureStore lookup → fail closed.
    return null;
  }

  let masterKey: Buffer;
  try {
    // SecureStore root (keychain-backed). Throws when no key is provisioned → fail closed.
    masterKey = getMasterKey();
  } catch {
    return null;
  }
  if (!masterKey || masterKey.length === 0) {
    return null;
  }

  // Domain-separated derivation: never expose the raw master key as the WS auth proof.
  const derived = createHash("sha256")
    .update(WS_SESSION_KEY_PURPOSE)
    .update(masterKey)
    .digest();
  if (derived.length < MIN_SESSION_KEY_LEN) {
    return null;
  }
  return new Uint8Array(derived);
}
