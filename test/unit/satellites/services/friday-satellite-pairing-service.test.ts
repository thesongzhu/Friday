import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatelliteRepository } from "#satellites";
import { createFridaySatellitePairingRequestRepository } from "#satellites";
import { createFridaySatelliteCapabilityRepository } from "#satellites";
import { createFridayApiTokenRepository } from "#satellites";
import { createFridayStreamCheckpointRepository } from "#satellites";
import { createFridaySatelliteRegistrationService } from "#satellites";
import {
  createFridaySatellitePairingService,
  type FridayHandshakeAlgorithm,
} from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

// Generate a deterministic RSA key pair for testing
const TEST_KEY_PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const WRONG_KEY_PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function signChallenge(privateKey: string, nonce: string): string {
  const signer = createSign("SHA256");
  signer.update(nonce);
  signer.end();
  return signer.sign(privateKey, "base64");
}

describe("FridaySatellitePairingService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const LATER = "2025-01-15T10:05:00.000Z";

  const satelliteRepo = createFridaySatelliteRepository();
  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const capabilityRepo = createFridaySatelliteCapabilityRepository();
  const apiTokenRepo = createFridayApiTokenRepository();
  const checkpointRepo = createFridayStreamCheckpointRepository();

  const EPHEMERAL_KEY = { publicKey: "test-server-ephemeral-pub", privateKey: "test-server-ephemeral-priv" };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function registerSatellite(publicKey: string = TEST_KEY_PAIR.publicKey as string) {
    const idGen = createTestIdGenerator();
    const regService = createFridaySatelliteRegistrationService({
      db,
      satelliteRepo,
      pairingRequestRepo,
      capabilityRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      pairingTtlMs: 10 * 60 * 1000,
    });
    return regService.register({
      type: "phone",
      displayName: "Test Phone",
      publicKey,
      runtime: { platform: "linux", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
      transport: "ws",
    });
  }

  function createPairingService(nowIso: string = LATER) {
    return createFridaySatellitePairingService({
      db,
      satelliteRepo,
      pairingRequestRepo,
      apiTokenRepo,
      checkpointRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => nowIso,
      tokenSecret: "test-token-secret", // pragma: allowlist secret
      generateEphemeralKeyPair: () => EPHEMERAL_KEY,
    });
  }

  function buildHandshakeInput(
    satelliteId: string,
    token: string,
    challengeNonce: string,
    privateKey: string = TEST_KEY_PAIR.privateKey as string,
    algorithms: FridayHandshakeAlgorithm[] = ["xchacha20-poly1305", "aes-256-gcm"],
  ) {
    return {
      satelliteId,
      token,
      signedChallenge: signChallenge(privateKey, challengeNonce),
      challengeNonce,
      clientEphemeralPublicKey: "client-ephemeral-pub-key",
      supportedAlgorithms: algorithms,
    };
  }

  it("approves pairing, issues token, updates statuses", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const result = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read", "write"],
    });

    expect(result.token).toBeTruthy();
    expect(result.token.split(".")).toHaveLength(2);
    expect(result.tokenId).toBeTruthy();
    expect(result.tokenVersion).toBe(1);

    // Satellite should be paired
    const sat = db.writer
      .prepare("SELECT pairing_status FROM satellites WHERE id = ?")
      .get(reg.satelliteId) as { pairing_status: string };
    expect(sat.pairing_status).toBe("paired");

    // Request should be approved
    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = ?")
      .get(reg.pairingRequestId) as { status: string };
    expect(req.status).toBe("approved");

    // Token should exist in api_tokens with version in label
    const tokens = db.writer
      .prepare("SELECT * FROM api_tokens WHERE principal_type = 'satellite'")
      .all() as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    expect((tokens[0]! as { label: string }).label).toContain(":v1");
  });

  it("rejects expired pairing request", () => {
    const reg = registerSatellite();
    // Use time after expiry
    const pairing = createPairingService("2025-01-15T20:30:00.000Z");

    expect(() =>
      pairing.approvePairing({
        satelliteId: reg.satelliteId,
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
        scopes: ["read"],
      }),
    ).toThrow("expired");
  });

  it("rejects already-approved request", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    expect(() =>
      pairing.approvePairing({
        satelliteId: reg.satelliteId,
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
        scopes: ["read"],
      }),
    ).toThrow("not pending");
  });

  it("rejects pairing with mismatched satellite ID", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    expect(() =>
      pairing.approvePairing({
        satelliteId: "wrong-satellite-id",
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
        scopes: ["read"],
      }),
    ).toThrow("does not belong");
  });

  it("rejectPairing marks request as rejected", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.rejectPairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      reason: "not authorized",
    });

    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = ?")
      .get(reg.pairingRequestId) as { status: string };
    expect(req.status).toBe("rejected");
  });

  it("rejectPairing rejects mismatched satellite ID", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    expect(() =>
      pairing.rejectPairing({
        satelliteId: "wrong-satellite-id",
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
      }),
    ).toThrow("does not belong");
  });

  it("completeHandshake validates token, challenge, and returns stream info with algorithm", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    const handshake = pairing.completeHandshake(
      buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
    );

    expect(handshake.accepted).toBe(true);
    expect(handshake.streamId).toBeTruthy();
    expect(handshake.epoch).toBeGreaterThanOrEqual(1);
    expect(handshake.algorithm).toBe("xchacha20-poly1305");
    expect(handshake.serverEphemeralPublicKey).toBe("test-server-ephemeral-pub");
  });

  it("completeHandshake negotiates aes-256-gcm when xchacha20 not offered", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    const handshake = pairing.completeHandshake(
      buildHandshakeInput(
        reg.satelliteId,
        approveResult.token,
        reg.challengeNonce,
        TEST_KEY_PAIR.privateKey as string,
        ["aes-256-gcm"],
      ),
    );

    expect(handshake.algorithm).toBe("aes-256-gcm");
  });

  it("completeHandshake rejects invalid token", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, "invalid-token", reg.challengeNonce),
      ),
    ).toThrow("Invalid or revoked token");
  });

  it("revokeSatellite sets status to revoked and revokes tokens", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    pairing.revokeSatellite({ satelliteId: reg.satelliteId });

    const sat = db.writer
      .prepare("SELECT pairing_status, token_version FROM satellites WHERE id = ?")
      .get(reg.satelliteId) as { pairing_status: string; token_version: number };
    expect(sat.pairing_status).toBe("revoked");
    expect(sat.token_version).toBe(2); // incremented

    // Token should be revoked
    const tokens = db.writer
      .prepare("SELECT revoked_at FROM api_tokens WHERE principal_type = 'satellite'")
      .all() as Array<{ revoked_at: string | null }>;
    expect(tokens[0]!.revoked_at).toBeTruthy();
  });

  it("completeHandshake rejects revoked satellite", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    pairing.revokeSatellite({ satelliteId: reg.satelliteId });

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow(); // Token is revoked
  });

  // --- Issue 10: Handshake rejection tests ---

  it("completeHandshake rejects invalid challenge signature", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Sign with wrong key
    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(
          reg.satelliteId,
          approveResult.token,
          reg.challengeNonce,
          WRONG_KEY_PAIR.privateKey as string,
        ),
      ),
    ).toThrow("Challenge signature verification failed");
  });

  it("completeHandshake rejects wrong nonce", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Use a wrong nonce (different from what was issued)
    const wrongNonce = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, wrongNonce),
      ),
    ).toThrow("Challenge nonce does not match issued nonce");
  });

  it("completeHandshake rejects expired token", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    // Approve with a short TTL (1ms)
    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
      tokenTtlMs: 1,
    });

    // Attempt handshake well after token expiry
    const latePairing = createPairingService("2025-01-16T10:00:00.000Z");
    expect(() =>
      latePairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow("Invalid or revoked token");
  });

  it("completeHandshake rejects revoked satellite (explicit revoke check)", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Revoke satellite but keep tokens (revokeTokens: false)
    // Manually set the satellite status to revoked without revoking tokens
    db.writer
      .prepare("UPDATE satellites SET pairing_status = 'revoked', updated_at = ? WHERE id = ?")
      .run(LATER, reg.satelliteId);

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow("Satellite has been revoked");
  });

  it("completeHandshake rejects token version mismatch", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Simulate a token version bump on the satellite (as if tokens were rotated)
    db.writer
      .prepare("UPDATE satellites SET token_version = 99, updated_at = ? WHERE id = ?")
      .run(LATER, reg.satelliteId);

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow("Token version mismatch");
  });
});
