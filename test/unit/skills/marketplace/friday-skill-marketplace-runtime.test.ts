import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySkillMarketplaceRuntime } from "#skills";
import { createTestDb, createTestIdGenerator, NOW } from "./marketplace.helper.js";
import type { FetchFn } from "#skills";
import type { FridaySkillRegistry } from "#skills";

describe("FridaySkillMarketplaceRuntime", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createMockFetch(): FetchFn {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({ generatedAt: NOW, skills: [] }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
  }

  function createRuntime() {
    const registry: FridaySkillRegistry = {
      list: () => [],
      get: () => null,
      resolveByIntent: () => null,
      validateAll: () => [],
      reload: async () => {},
      refresh: async () => {},
      isCompatible: () => ({ compatible: true, reasons: [] }),
      startWatching: async () => {},
      stopWatching: async () => {},
      close: async () => {},
    };

    return createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
      hubVersion: "0.3.1",
      supportedApiVersions: ["1"],
      registry,
    });
  }

  it("creates runtime with all services wired", () => {
    const runtime = createRuntime();

    expect(runtime.sources).toBeDefined();
    expect(runtime.discovery).toBeDefined();
    expect(runtime.cache).toBeDefined();
    expect(runtime.sync).toBeDefined();
    expect(runtime.versions).toBeDefined();
    expect(runtime.installations).toBeDefined();
    expect(runtime.lifecycle).toBeDefined();
    expect(runtime.verify).toBeDefined();
    expect(runtime.trust).toBeDefined();
    expect(runtime.syncJob).toBeDefined();
  });

  it("source service works through runtime", () => {
    const runtime = createRuntime();

    const source = runtime.sources.addSource({
      name: "Test Source",
      baseUrl: "https://test.dev",
      trustPolicy: "warn",
      pinnedKeyIds: [],
    });

    expect(source.name).toBe("Test Source");
    expect(source.enabled).toBe(true);

    const sources = runtime.sources.listSources();
    expect(sources).toHaveLength(1);
  });

  it("sync service works through runtime", async () => {
    const runtime = createRuntime();

    // Add a source first
    runtime.sources.addSource({
      name: "Empty Source",
      baseUrl: "https://empty.dev",
      trustPolicy: "permissive",
      pinnedKeyIds: [],
    });

    const results = await runtime.sync.syncAllSources();
    expect(results).toHaveLength(1);
    expect(results[0].errors).toHaveLength(0);
  });

  it("trust scoring service works through runtime", () => {
    const runtime = createRuntime();

    const score = runtime.trust.computeScore({
      verification: { integrityValid: true, signatureValid: true, checks: ["integrity:pass", "signature:pass"] },
      trustPolicy: "strict",
      hasPinnedKeys: false,
      keyPinningPassed: false,
      publisherInstallCount: 5,
      indexedAt: NOW,
      nowIso: NOW,
      cacheTtlHours: 6,
    });

    expect(score.total).toBeGreaterThan(0);
    expect(score.signature).toBe(40);
  });

  it("verify service works through runtime", () => {
    const runtime = createRuntime();

    const buf = Buffer.from("test data");
    const checksum = runtime.verify.computeChecksum(buf);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);

    const result = runtime.verify.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "s1",
      version: "1.0.0",
    });
    expect(result.integrityValid).toBe(true);
  });

  it("syncJob can start and stop", () => {
    const runtime = createRuntime();

    expect(runtime.syncJob.isRunning()).toBe(false);
    runtime.syncJob.start();
    expect(runtime.syncJob.isRunning()).toBe(true);
    runtime.syncJob.stop();
    expect(runtime.syncJob.isRunning()).toBe(false);
  });

  it("accepts optional publishEvent", () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
      hubVersion: "0.3.1",
      supportedApiVersions: ["1"],
      registry: {
        list: () => [],
        get: () => null,
        resolveByIntent: () => null,
        validateAll: () => [],
        reload: async () => {},
        refresh: async () => {},
        isCompatible: () => ({ compatible: true, reasons: [] }),
        startWatching: async () => {},
        stopWatching: async () => {},
        close: async () => {},
      },
      publishEvent: async (event, payload) => {
        events.push({ event, payload });
      },
    });

    expect(runtime).toBeDefined();
  });
});
