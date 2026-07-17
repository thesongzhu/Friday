/**
 * SEC-EVENT-REDACTION-001 / PRIV-UNICODE-REDACTION-001 -- deterministic,
 * owner-scoped, keyed IDENTIFIER PSEUDONYM for the realtime event plane.
 *
 * Raw identifier values (executionId / runId / streamId id-parts / correlationId /
 * every "*Id"-shaped field) can carry sensitive bytes (a user may put an email in
 * an executionId), which would otherwise persist verbatim in realtime_events
 * (stream_id + payload_json), the run-timeline, the agent-event log, and audit
 * resourceId/details. The fix replaces each raw identifier value with a keyed MAC
 * so no raw sensitive bytes reach any sink.
 *
 * Pseudonym = HMAC-SHA256(key, DOMAIN_TAG + lenPrefix(ownerId) + rawValue),
 * truncated, rendered as `o<keyVersion>_<hex>`. Properties:
 *   - Deterministic: the same raw value always maps to the same pseudonym, so benign
 *     identifiers stay usable (distinct + stable) and mappings survive restart with
 *     nothing raw stored.
 *   - Distinct raw values -> distinct pseudonyms (HMAC collision-resistance).
 *   - Non-reversible: the pseudonym reveals no raw bytes.
 *   - Owner-scoped and domain-separated: a LENGTH-PREFIXED ownerId plus a fixed
 *     domain tag are folded into the MAC input, so the same raw value under a
 *     different owner maps differently and there is no owner/value boundary
 *     ambiguity (an ASCII length prefix, never a raw separator byte).
 *
 * SYMMETRIC application (why clients need no change): the pseudonym is applied on
 * the WRITE path (the persisted stream_id + payload id fields are pseudonyms) AND on
 * the READ-RESOLUTION path (a client subscribes/pulls with a raw-constructed
 * streamId like `run:${rawRunId}`; the server pseudonymizes it the SAME way before
 * the store's exact-match). Both sides land on the identical opaque value; nothing
 * raw is persisted; clients keep constructing raw streamIds.
 *
 * NON-FORGEABLE (no shape trust): there is NO "already-opaque, pass it through"
 * branch. The read path ALWAYS re-keys the client-supplied identifier. An attacker
 * who supplies a forged `o1_<hex>` therefore gets it HMAC'd like any other raw value
 * -> the result does not match any real stream (owner-scoped key required), so the
 * forgery is denied and cannot collide across owners. Correctness relies on the
 * pseudonym being applied EXACTLY ONCE per value (write: the persistence sink;
 * read: the subscription resolver) -- never composed.
 *
 * @module api/realtime
 */

import * as crypto from "node:crypto";

import { FridayDomainError } from "#errors";

/**
 * Current pseudonymization key version. The opaque form is `o<VERSION>_<hex>`; a
 * future dedicated-key rotation increments this and the read path can dual-read
 * across versions. (Key SOURCE lifecycle is tracked separately -- see the caller.)
 *
 * Exported as {@link FRIDAY_REALTIME_PSEUDONYM_KEY_VERSION} so the persistence sink
 * and the durable legacy-rewrite provenance column (realtime_events.identifier_epoch)
 * stamp the SAME version — a single source of truth for "opaque under key version N".
 */
const KEY_VERSION = 1;
export const FRIDAY_REALTIME_PSEUDONYM_KEY_VERSION = KEY_VERSION;
const OPAQUE_PREFIX = `o${KEY_VERSION}_`;
const OPAQUE_HASH_LEN = 40; // hex chars (160-bit HMAC-SHA256 prefix)
/** Fixed domain-separation tag (never collides with real identifier content). */
const DOMAIN_TAG = "friday.realtime.identifier.pseudonym.v1\n";

/**
 * HKDF info tag for deriving the dedicated realtime pseudonymization subkey from the
 * durable master key. Shared by every consumer (api-runtime runtime writes/reads AND
 * the v106 legacy-rewrite migration) so they all derive the IDENTICAL keyspace.
 */
export const FRIDAY_REALTIME_PSEUDONYM_KDF_INFO = "friday-realtime-identifier-pseudonym-kdf-v1";

/**
 * Derive the dedicated realtime pseudonymization key (hex) from the durable master
 * key via HKDF-SHA256, domain-separated by {@link FRIDAY_REALTIME_PSEUDONYM_KDF_INFO}.
 * The master key is a non-rotating encryption root, so the derived pseudonym key is
 * stable across restarts and token rotation (SEC-EVENT-REDACTION-001 / P1-D).
 */
export function deriveFridayRealtimePseudonymKey(masterKey: Uint8Array): string {
  const okm = crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), FRIDAY_REALTIME_PSEUDONYM_KDF_INFO, 32);
  return Buffer.from(okm).toString("hex");
}

function macIdentifier(rawValue: string, ownerId: string, key: string): string {
  // Length-prefix the ownerId (ASCII decimal + ':') so the owner/value boundary is
  // unambiguous without any raw separator byte -- keeps this source pure text and
  // prevents owner||value ambiguity across different (owner, value) splits.
  const mac = crypto
    .createHmac("sha256", key)
    .update(DOMAIN_TAG)
    .update(`${ownerId.length}:${ownerId}`)
    .update(rawValue)
    .digest("hex");
  return `${OPAQUE_PREFIX}${mac.slice(0, OPAQUE_HASH_LEN)}`;
}

export interface FridayRealtimePseudonymizer {
  /** Whether pseudonymization is active (owner + key both resolvable). */
  readonly active: boolean;
  /**
   * Pseudonymize a raw identifier VALUE. ALWAYS re-keys (no shape trust); no-op only
   * when inactive. MUST be applied exactly once per value (never composed).
   */
  value(rawValue: string): string;
  /**
   * Pseudonymize a streamId, preserving the topic PREFIX (up to and including the
   * first colon, which drives topic authz) and re-keying only the id-part. Applied
   * exactly once per streamId. No-op when inactive.
   */
  streamId(streamId: string): string;
}

export interface CreateFridayRealtimePseudonymizerDeps {
  /**
   * Resolve the canonical hub owner id the pseudonym is scoped to. All realtime
   * events are owned by this single owner, so the same owner is used on the write
   * and read-resolution paths (keeping them symmetric). Nullish/blank -> inactive.
   */
  resolveOwnerId: () => string | null | undefined;
  /**
   * Durable pseudonymization key. Should be a DEDICATED, versioned key domain (NOT
   * a rotating auth secret) so authorized token rotation cannot orphan durable
   * streams -- see the caller. Blank/undefined -> inactive.
   */
  key: string | undefined;
  /**
   * Behaviour when the pseudonymizer is INACTIVE (owner or key unresolvable):
   *   - "identity" (DEFAULT): `value`/`streamId` are byte-identical no-ops. This is
   *     the legacy/test-safe path for direct constructions that never persist raw
   *     realtime identifiers to a durable sink.
   *   - "fail-closed": `value`/`streamId` THROW a typed {@link FridayDomainError}
   *     instead of returning a raw value. The PRODUCTION persistence sink uses this
   *     so a missing durable key can NEVER cause raw identifiers to be written at
   *     rest — it fails the publish rather than degrading to identity passthrough.
   * The factory default stays "identity" for backward compatibility; the runtime
   * sink opts into "fail-closed" explicitly (unreachable identity from default prod).
   */
  onInactive?: "identity" | "fail-closed";
}

/** Thrown when a fail-closed pseudonymizer is asked to transform a value while inactive. */
function realtimePseudonymUnavailableError(): FridayDomainError {
  return new FridayDomainError(
    "VALIDATION_ERROR",
    "Realtime identifier pseudonymization is unavailable (no durable master key / owner resolvable). " +
      "Refusing to persist realtime events with raw identifiers (fail-closed). Provision FRIDAY_MASTER_KEY (hex), " +
      "FRIDAY_MASTER_KEY_SOURCE=keychain, or an existing ~/.friday/master.key.",
    { httpStatus: 503 },
  );
}

/**
 * Construct the realtime identifier pseudonymizer. When either the owner or the key
 * cannot be resolved, ALL methods are identity no-ops (active === false) -- so
 * legacy/test constructions that do not wire these deps keep raw behavior and are
 * byte-identical to before. Production wiring makes it active; the write sink and
 * the read resolver share the SAME instance, so they stay symmetric.
 */
export function createFridayRealtimePseudonymizer(
  deps: CreateFridayRealtimePseudonymizerDeps,
): FridayRealtimePseudonymizer {
  function resolveOwner(): string | null {
    let owner: string | null | undefined;
    try {
      owner = deps.resolveOwnerId();
    } catch {
      owner = null;
    }
    return typeof owner === "string" && owner.trim().length > 0 ? owner : null;
  }

  const key = typeof deps.key === "string" && deps.key.length > 0 ? deps.key : null;
  const failClosed = deps.onInactive === "fail-closed";

  return {
    get active() {
      return key !== null && resolveOwner() !== null;
    },

    value(rawValue) {
      const owner = key === null ? null : resolveOwner();
      if (key === null || owner === null) {
        // INACTIVE: fail closed (never leak raw to a durable sink) or identity no-op.
        if (failClosed) throw realtimePseudonymUnavailableError();
        return rawValue;
      }
      return macIdentifier(rawValue, owner, key);
    },

    streamId(streamId) {
      const owner = key === null ? null : resolveOwner();
      if (key === null || owner === null) {
        if (failClosed) throw realtimePseudonymUnavailableError();
        return streamId;
      }
      const colon = streamId.indexOf(":");
      if (colon < 0) return macIdentifier(streamId, owner, key);
      const prefix = streamId.slice(0, colon + 1);
      const idPart = streamId.slice(colon + 1);
      return `${prefix}${macIdentifier(idPart, owner, key)}`;
    },
  };
}
