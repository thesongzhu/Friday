import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  createFridayApiTokenRepository,
  createFridaySatelliteCapabilityRepository,
  createFridaySatellitePairingRequestRepository,
  createFridaySatellitePairingService,
  createFridaySatelliteRepository,
  createFridayStreamCheckpointRepository,
} from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for satellite pairing
 * (orphan off-route leak audit, 2026-06-10 defense-in-depth).
 *
 * approvePairing/rejectPairing/completeHandshake/revokeSatellite were ROUTE-only-
 * guarded. These prove each method now fail-closes by default (flag unset) BEFORE
 * reading or mutating any pairing/token/satellite state. With the test-oracle flag
 * the guard is open (the methods then reach their normal not-found path).
 */

const RETIRED_CODE = "TS_RUNTIME_SATELLITE_PAIRING_RETIRED";
const NOW = "2026-06-10T00:00:00.000Z";

describe("FridaySatellitePairingService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlySatellitePairingExecution?: boolean) {
    return createFridaySatellitePairingService({
      db,
      satelliteRepo: createFridaySatelliteRepository(),
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      apiTokenRepo: createFridayApiTokenRepository(),
      checkpointRepo: createFridayStreamCheckpointRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      tokenSecret: "test-token-secret", // pragma: allowlist secret
      ...(allowTestOnlySatellitePairingExecution === undefined
        ? {}
        : { allowTestOnlySatellitePairingExecution }),
    });
  }

  it("all four pairing mutations fail closed by default with 503 fail_closed", () => {
    const service = buildService();
    const calls: Array<() => unknown> = [
      () => service.approvePairing({ requestId: "r-1", satelliteId: "s-1", resolverUserId: "u-1", scopes: ["satellite.write"] }),
      () => service.rejectPairing({ requestId: "r-1", satelliteId: "s-1", resolverUserId: "u-1" }),
      () => service.completeHandshake({
        satelliteId: "s-1",
        token: "tok",
        signedChallenge: "sig",
        challengeNonce: "nonce",
        clientEphemeralPublicKey: "pub",
        supportedAlgorithms: [],
      }),
      () => service.revokeSatellite({ satelliteId: "s-1" }),
    ];
    for (const call of calls) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FridayDomainError);
      expect((caught as FridayDomainError).code).toBe(RETIRED_CODE);
      expect((caught as FridayDomainError).httpStatus).toBe(503);
    }
  });

  it("also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() => service.revokeSatellite({ satelliteId: "s-1" })).toThrow(
      expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }),
    );
  });

  it("passes the guard (reaches the normal not-found path) when the test-oracle flag is enabled", () => {
    const service = buildService(true);
    // The guard is open; approvePairing now reaches its real logic and fails with
    // the domain not-found error (NOT the retirement 503), proving the guard no
    // longer blocks the legacy path.
    expect(() =>
      service.approvePairing({ requestId: "missing", satelliteId: "s-1", resolverUserId: "u-1", scopes: ["satellite.write"] }),
    ).toThrow(expect.objectContaining({ code: "PAIRING_REQUEST_NOT_FOUND" }));
  });
});
