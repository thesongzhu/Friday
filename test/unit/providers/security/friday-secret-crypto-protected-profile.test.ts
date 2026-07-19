import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { getMasterKey, resetMasterKeyCache } from "#providers";

/**
 * ART-NONPROD-001 (P0) — the test-only master-key GENERATION escape hatch
 * `FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION=1` must NOT be activatable in a
 * protected profile (NODE_ENV=production or FRIDAY_RELEASE_TAG set). In a release
 * build it must FAIL CLOSED (throw) rather than mint a fresh encryption root.
 */

describe("getMasterKey test-only generation protected-profile gate", () => {
  const KEYS = [
    "FRIDAY_MASTER_KEY",
    "FRIDAY_MASTER_KEY_SOURCE",
    "FRIDAY_MASTER_KEY_FILE",
    "FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION",
    "NODE_ENV",
    "FRIDAY_RELEASE_TAG",
  ] as const;

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    resetMasterKeyCache();
    // Start from a clean slate: no key material, no profile markers.
    for (const k of KEYS) delete process.env[k];
    // Point at a guaranteed-missing key file so the generation path is reached.
    process.env.FRIDAY_MASTER_KEY_FILE = path.join(
      os.tmpdir(),
      `friday-art-nonprod-${crypto.randomUUID()}`,
      "master.key",
    );
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMasterKeyCache();
  });

  it("throws when generation is enabled with NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    process.env.FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION = "1";
    expect(() => getMasterKey()).toThrow(/FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION/);
    expect(() => getMasterKey()).toThrow(/cannot be enabled in production\/release profiles/);
  });

  it("throws when generation is enabled with a release tag", () => {
    process.env.FRIDAY_RELEASE_TAG = "v1.2.3";
    process.env.FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION = "1";
    expect(() => getMasterKey()).toThrow(/cannot be enabled in production\/release profiles/);
  });

  it("still generates a key when the escape hatch is set in a non-protected (dev/test) profile", () => {
    delete process.env.NODE_ENV;
    delete process.env.FRIDAY_RELEASE_TAG;
    process.env.FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION = "1";
    const key = getMasterKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("targeted gate: a real FRIDAY_MASTER_KEY is still honored in production even if the hatch is set (generation path never reached)", () => {
    const real = crypto.randomBytes(32);
    process.env.NODE_ENV = "production";
    process.env.FRIDAY_MASTER_KEY = real.toString("hex");
    process.env.FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION = "1";
    // The env-key path returns before the generation hatch is honored, so the
    // gate is correctly scoped to the generation path and does not throw here.
    expect(getMasterKey()).toEqual(real);
  });
});
