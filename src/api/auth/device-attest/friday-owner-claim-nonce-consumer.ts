// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a ───
//
// REFERENCE in-memory single-use nonce consumer.
//
// TRUTH LABEL: this is a reference / test implementation only. It is NOT the
// production single-use store. Production replay/expiry/single-use enforcement
// is the durable, atomic, DB-backed nonce repository already shipped in Slice 1
// (`friday-setup-bootstrap-nonce-repository`), which the S3 integration wires
// into the `OwnerClaimNonceConsumer` seam. This reference impl exists so the
// verifier seam can be exercised and so replay + restart-survival are provable at
// this layer via an explicit persisted-snapshot round-trip.

import type {
  OwnerClaimNonceConsumeOutcome,
  OwnerClaimNonceConsumer,
} from "./friday-owner-claim-transcript.types.js";

export interface InMemoryOwnerClaimNonceConsumer extends OwnerClaimNonceConsumer {
  /**
   * Export the set of already-consumed nonces. Simulates the durable state a
   * restart would re-read; feed it back into the factory to model a restart.
   */
  snapshot(): string[];
}

/**
 * Build a reference single-use nonce consumer. Pass a prior `snapshot` to model a
 * restart that re-reads persisted consumed state — replays are still rejected
 * across the restart boundary.
 */
export function createInMemoryOwnerClaimNonceConsumer(
  snapshot?: readonly string[],
): InMemoryOwnerClaimNonceConsumer {
  const consumed = new Set<string>(snapshot ?? []);

  return {
    consume(nonce: string): OwnerClaimNonceConsumeOutcome {
      if (consumed.has(nonce)) return "replayed";
      consumed.add(nonce);
      return "fresh";
    },
    snapshot(): string[] {
      return [...consumed];
    },
  };
}
