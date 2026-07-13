import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

import type { FridaySqliteLayer } from "#state";
import { createFridaySatellitePairingRequestRepository } from "#satellites";
import { createTestDb } from "../_helpers/create-test-db.helper.js";
import { resetMasterKeyCache } from "../../../../src/security/friday-secret-crypto.js";

// SEC-CREDENTIAL-INGRESS: the 6-digit operator pairing-confirmation `code` must
// NOT be persisted as plaintext in satellite_pairing_requests.code. It is stored
// as an inline encrypted envelope in the existing TEXT column and decrypted on
// read (mirroring oauth_credentials.*_encrypted / the MCP config-store slice).
// NOTE: the canary below is a synthetic test value, never a real credential.
const PAIRING_CODE_CANARY = "424242"; // pragma: allowlist secret
const PUBLIC_NONCE = "public-challenge-nonce-abc123";

const MASTER_KEY = randomBytes(32);

let layer: FridaySqliteLayer;

function seedSatellite(id: string): void {
  layer.writer
    .prepare(
      `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
       VALUES (?, ?, 'phone', 'pending', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
    )
    .run(id, `Satellite ${id}`, "2026-07-12T00:00:00.000Z", "2026-07-12T00:00:00.000Z");
}

beforeEach(() => {
  layer = createTestDb();
  // satellite_pairing_requests.satellite_id is an enforced FK → seed the parents.
  seedSatellite("sat-1");
  seedSatellite("sat-legacy");
});

afterEach(() => {
  layer.close();
});

function insertInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    satelliteId: "sat-1",
    code: PAIRING_CODE_CANARY,
    nonce: PUBLIC_NONCE,
    expiresAt: "2099-01-01T00:00:00.000Z",
    nowIso: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function rawColumn(id: string, column: "code" | "nonce"): string | undefined {
  const row = layer.writer
    .prepare(`SELECT ${column} AS v FROM satellite_pairing_requests WHERE id = ?`)
    .get(id) as { v: string } | undefined;
  return row?.v;
}

describe("FridaySatellitePairingRequestRepository pairing-code-at-rest encryption", () => {
  it("does not persist the pairing code as plaintext (inline encrypted envelope at rest)", () => {
    const repo = createFridaySatellitePairingRequestRepository({ masterKey: MASTER_KEY });
    layer.withWriteTransaction((db) => repo.insertRequest(db, insertInput()));

    const raw = rawColumn("req-1", "code");
    expect(raw).toBeDefined();
    // BEHAVIORAL RED (fails pre-fix): today the column IS the plaintext canary.
    expect(raw!).not.toContain(PAIRING_CODE_CANARY);
    // It is an opaque AES-256-GCM envelope (ciphertext / iv / tag), not the code.
    const envelope = JSON.parse(raw!) as Record<string, unknown>;
    expect(typeof envelope.ciphertext).toBe("string");
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.tag).toBe("string");
  });

  it("round-trips the real code on getRequest / getRequestBySatelliteId", () => {
    const repo = createFridaySatellitePairingRequestRepository({ masterKey: MASTER_KEY });
    layer.withWriteTransaction((db) => repo.insertRequest(db, insertInput()));

    const byId = layer.withReadConnection((db) => repo.getRequest(db, "req-1"));
    expect(byId?.code).toBe(PAIRING_CODE_CANARY);

    const bySat = layer.withReadConnection((db) =>
      repo.getRequestBySatelliteId(db, "sat-1", "pending"),
    );
    expect(bySat?.code).toBe(PAIRING_CODE_CANARY);

    // The `nonce` is a PUBLIC challenge — it MUST stay plaintext at rest and be
    // returned byte-identical (never encrypted).
    expect(rawColumn("req-1", "nonce")).toBe(PUBLIC_NONCE);
    expect(byId?.nonce).toBe(PUBLIC_NONCE);
  });

  it("fail-closed: refuses to insert (never writes plaintext) when no master key is available", () => {
    const savedEnvKey = process.env.FRIDAY_MASTER_KEY;
    const savedEnvSource = process.env.FRIDAY_MASTER_KEY_SOURCE;
    delete process.env.FRIDAY_MASTER_KEY;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
    try {
      // No injected key → falls back to the real fail-closed hub resolver.
      const repo = createFridaySatellitePairingRequestRepository();
      expect(() =>
        layer.withWriteTransaction((db) => repo.insertRequest(db, insertInput())),
      ).toThrow();

      // Critical: it threw BEFORE the INSERT — no row (and no plaintext) persisted.
      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM satellite_pairing_requests")
        .get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      if (savedEnvKey !== undefined) process.env.FRIDAY_MASTER_KEY = savedEnvKey;
      if (savedEnvSource !== undefined) process.env.FRIDAY_MASTER_KEY_SOURCE = savedEnvSource;
      resetMasterKeyCache();
    }
  });

  it("PRODUCTION default path (no injected key, only FRIDAY_MASTER_KEY) encrypts + round-trips", () => {
    // Proves the default resolver is getStrictMasterKey(): with NO options and
    // only the persistent hub key configured (as prod does), the code is still
    // encrypted at rest and decrypts on read.
    const savedEnvKey = process.env.FRIDAY_MASTER_KEY;
    const savedEnvSource = process.env.FRIDAY_MASTER_KEY_SOURCE;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    process.env.FRIDAY_MASTER_KEY = MASTER_KEY.toString("hex");
    resetMasterKeyCache();
    try {
      const repo = createFridaySatellitePairingRequestRepository(); // no options
      layer.withWriteTransaction((db) => repo.insertRequest(db, insertInput()));

      expect(rawColumn("req-1", "code")).not.toContain(PAIRING_CODE_CANARY);
      const got = layer.withReadConnection((db) => repo.getRequest(db, "req-1"));
      expect(got?.code).toBe(PAIRING_CODE_CANARY);
    } finally {
      if (savedEnvKey !== undefined) process.env.FRIDAY_MASTER_KEY = savedEnvKey;
      else delete process.env.FRIDAY_MASTER_KEY;
      if (savedEnvSource !== undefined) process.env.FRIDAY_MASTER_KEY_SOURCE = savedEnvSource;
      resetMasterKeyCache();
    }
  });

  it("tolerates legacy plaintext code, reports residue, and does not rewrite it on read", () => {
    // Pre-seed a row exactly as a pre-encryption insert would (plaintext code).
    layer.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests
           (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('legacy-1', 'sat-legacy', ?, ?, 'pending', '2099-01-01T00:00:00.000Z', ?, ?)`,
      )
      .run(PAIRING_CODE_CANARY, PUBLIC_NONCE, "2026-07-12T00:00:00.000Z", "2026-07-12T00:00:00.000Z");

    const residue: Array<{ requestId: string; reason: string }> = [];
    const repo = createFridaySatellitePairingRequestRepository({
      masterKey: MASTER_KEY,
      onSecretResidue: (entry) => residue.push(entry),
    });

    const got = layer.withReadConnection((db) => repo.getRequest(db, "legacy-1"));
    // Legacy plaintext is returned as-is so the request stays usable...
    expect(got?.code).toBe(PAIRING_CODE_CANARY);
    // ...and the residue is reported (legacy-plaintext) for audit / re-encryption.
    expect(residue.some((r) => r.requestId === "legacy-1" && r.reason === "legacy-plaintext")).toBe(
      true,
    );
    // FAIL-SAFE: a read never mutates — the row stays as-is (flagged, not silently
    // re-encrypted); it is re-encrypted only on the next insertRequest.
    expect(rawColumn("legacy-1", "code")).toBe(PAIRING_CODE_CANARY);
  });
});
