import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type { FridaySatelliteRegistrationInput } from "#satellites";
import {
  createFridaySatelliteCapabilityRepository,
  createFridaySatellitePairingRequestRepository,
  createFridaySatelliteRegistrationService,
  createFridaySatelliteRepository,
} from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for satellite registration
 * (orphan off-route leak audit, 2026-06-10 defense-in-depth).
 *
 * `register` was ROUTE-only-guarded (friday-satellite-pairing-routes asserts
 * `allowTestOnlySatellitePairingExecution` before the register route). This
 * proves the guard now lives on the METHOD: in default/live config (flag unset)
 * `register` fails closed BEFORE any satellite/pairing-request row write; with
 * the explicit test-oracle flag it still works.
 */

const RETIRED_CODE = "TS_RUNTIME_SATELLITE_PAIRING_RETIRED";
const NOW = "2026-06-10T00:00:00.000Z";
// SEC-CREDENTIAL-INGRESS: insertRequest fail-closes without a master key; inject
// a fixed test key via the repo's additive `options.masterKey` seam so the
// legacy-path-preserved register() case can encrypt the pairing code at rest.
const TEST_MASTER_KEY = randomBytes(32);

const baseInput: FridaySatelliteRegistrationInput = {
  type: "phone",
  displayName: "My Phone",
  publicKey: "pk-abc123",
  runtime: { platform: "darwin", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
  transport: "ws",
};

describe("FridaySatelliteRegistrationService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlySatellitePairingExecution?: boolean) {
    return createFridaySatelliteRegistrationService({
      db,
      satelliteRepo: createFridaySatelliteRepository(),
      pairingRequestRepo: createFridaySatellitePairingRequestRepository({ masterKey: TEST_MASTER_KEY }),
      capabilityRepo: createFridaySatelliteCapabilityRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      ...(allowTestOnlySatellitePairingExecution === undefined
        ? {}
        : { allowTestOnlySatellitePairingExecution }),
    });
  }

  function countSatelliteRows(): number {
    return db.withReadConnection((reader) =>
      (reader.prepare("SELECT COUNT(*) AS c FROM satellites").get() as { c: number }).c,
    );
  }

  it("register fails closed by default: throws 503 fail_closed and writes no satellite row", () => {
    const service = buildService();
    let caught: unknown;
    try {
      service.register(baseInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({ classification: "fail_closed" });
    expect(countSatelliteRows()).toBe(0);
  });

  it("register also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() => service.register(baseInput)).toThrow(
      expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }),
    );
    expect(countSatelliteRows()).toBe(0);
  });

  it("register runs when the test-oracle flag is enabled (legacy path preserved)", () => {
    const service = buildService(true);
    const result = service.register(baseInput);
    expect(result.pairingStatus).toBe("pending");
    expect(countSatelliteRows()).toBe(1);
  });
});
