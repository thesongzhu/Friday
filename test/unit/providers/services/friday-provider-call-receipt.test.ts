import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import {
  createFridayProviderService,
  resetMasterKeyCache,
  buildProviderCallReceipt,
  verifyProviderCallReceipt,
} from "#providers";
import type { FridayProviderService, FridayLlmUsageRecord } from "#providers";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

// BYOK-PROVIDER-COST-RECEIPT-001 — provider cost/receipt truth.
// These tests round-trip through the REAL provider service + REAL usage repo +
// REAL sqlite (migrations applied), and — for restart — through a fresh store
// instance on the same on-disk DB. No mock stands in for the mechanism.
describe("Provider call receipt + idempotency", () => {
  const NOW = "2026-02-17T10:00:00.000Z";
  const TEST_MASTER_KEY = Buffer.alloc(32, 13).toString("hex");
  const originalFetch = globalThis.fetch;
  let originalMasterKey: string | undefined;

  let db: FridaySqliteLayer;
  let service: FridayProviderService;
  let idGen: () => string;

  async function createOpenAiProvider(svc: FridayProviderService): Promise<string> {
    const profile = await svc.createProvider({
      kind: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      authMode: "api-key",
      api: "openai-completions",
      apiKey: "test-receipt-key", // pragma: allowlist secret
      supportedModels: ["gpt-4o"],
      defaultModel: "gpt-4o",
      validateOnSave: false,
    });
    return profile.id;
  }

  function countRows(layer: FridaySqliteLayer, requestId: string): number {
    return layer.withReadConnection((conn) =>
      (conn.prepare(
        "SELECT COUNT(*) AS n FROM llm_usage_records WHERE request_id = ?",
      ).get(requestId) as { n: number }).n,
    );
  }

  function sumCost(layer: FridaySqliteLayer): number {
    return layer.withReadConnection((conn) =>
      (conn.prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_usage_records",
      ).get() as { s: number }).s,
    );
  }

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    originalMasterKey = process.env.FRIDAY_MASTER_KEY;
    process.env.FRIDAY_MASTER_KEY = TEST_MASTER_KEY;
    resetMasterKeyCache();
    service = createFridayProviderService({ db, idGenerator: idGen, nowIso: () => NOW });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    ) as typeof fetch;
  });

  afterEach(() => {
    db.close();
    if (originalMasterKey === undefined) delete process.env.FRIDAY_MASTER_KEY;
    else process.env.FRIDAY_MASTER_KEY = originalMasterKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    resetMasterKeyCache();
  });

  // ─── No double-count ───

  it("records the same request-id twice as ONE row / ONE charge (idempotent)", async () => {
    const providerId = await createOpenAiProvider(service);
    const requestId = "chatcmpl-DUPLICATE-001";

    const first = await service.recordUsage({
      providerId,
      providerApi: "openai-completions",
      model: "gpt-4o",
      routeStrategy: "configured",
      taskComplexity: "medium",
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
      costUsd: 0.05,
      requestId,
    });
    // A fire-and-forget retry / replay of the SAME provider response.
    const second = await service.recordUsage({
      providerId,
      providerApi: "openai-completions",
      model: "gpt-4o",
      routeStrategy: "configured",
      taskComplexity: "medium",
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
      costUsd: 0.05,
      requestId,
    });

    expect(first.recorded).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.recorded).toBe(false);
    expect(second.duplicate).toBe(true);

    expect(countRows(db, requestId)).toBe(1);
    expect(sumCost(db)).toBeCloseTo(0.05, 10); // NOT 0.10 — no double-count
  });

  // ─── Receipt bound to request-id + tamper detection ───

  it("binds a verifiable receipt to the request-id and detects tamper", async () => {
    const providerId = await createOpenAiProvider(service);
    const requestId = "chatcmpl-RECEIPT-002";

    const res = await service.recordUsage({
      providerId,
      providerApi: "openai-completions",
      model: "gpt-4o",
      routeStrategy: "configured",
      taskComplexity: "medium",
      usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, total: 300 },
      costUsd: 0.02,
      requestId,
    });
    expect(res.receipt).toBeTruthy();

    const lookup = await service.getCallReceipt(requestId);
    expect(lookup).not.toBeNull();
    expect(lookup!.receiptValid).toBe(true);
    expect(lookup!.receipt.requestId).toBe(requestId);
    expect(lookup!.receipt.costUsd).toBeCloseTo(0.02, 10);
    expect(lookup!.receipt.receipt).toBe(res.receipt);

    // Tamper the stored cost directly in the DB — the persisted receipt hash no
    // longer matches a recomputation over the row.
    db.withWriteTransaction((conn) =>
      conn.prepare("UPDATE llm_usage_records SET cost_usd = ? WHERE request_id = ?")
        .run(999.99, requestId),
    );
    const tampered = await service.getCallReceipt(requestId);
    expect(tampered).not.toBeNull();
    expect(tampered!.receiptValid).toBe(false); // tamper detected
  });

  it("records a call WITHOUT a request-id but binds no receipt (missing request-id handled)", async () => {
    const providerId = await createOpenAiProvider(service);
    const res = await service.recordUsage({
      providerId,
      providerApi: "openai-completions",
      model: "gpt-4o",
      routeStrategy: "configured",
      taskComplexity: "medium",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      costUsd: 0.001,
      // no requestId
    });
    expect(res.recorded).toBe(true);
    expect(res.duplicate).toBe(false);
    expect(res.receipt ?? null).toBeNull();

    const row = db.withReadConnection((conn) =>
      conn.prepare(
        "SELECT request_id, receipt FROM llm_usage_records WHERE model = 'gpt-4o' ORDER BY created_at DESC LIMIT 1",
      ).get() as { request_id: string | null; receipt: string | null },
    );
    expect(row.request_id).toBeNull();
    expect(row.receipt).toBeNull();
  });

  it("verifyProviderCallReceipt is false for a record with no request-id/receipt", () => {
    const base: FridayLlmUsageRecord = {
      id: "x",
      occurredAt: NOW,
      usageDay: "2026-02-17",
      usageMonth: "2026-02",
      providerId: "p1",
      providerKind: "openai",
      providerApi: "openai-completions",
      model: "gpt-4o",
      routeStrategy: "configured",
      taskComplexity: "medium",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0.01,
      currency: "USD",
      requestId: null,
      runId: null,
      turnId: null,
      receipt: null,
      metadata: {},
      createdAt: NOW,
    };
    expect(verifyProviderCallReceipt(base)).toBe(false);

    // A well-formed, request-id-bound record verifies true.
    const requestId = "req-pure-verify";
    const receipt = buildProviderCallReceipt({
      requestId,
      providerId: base.providerId,
      providerKind: base.providerKind,
      model: base.model,
      inputTokens: base.inputTokens,
      outputTokens: base.outputTokens,
      totalTokens: base.totalTokens,
      costUsd: base.costUsd,
      occurredAt: base.occurredAt,
    });
    expect(verifyProviderCallReceipt({ ...base, requestId, receipt })).toBe(true);
    // A single field mutation invalidates it.
    expect(verifyProviderCallReceipt({ ...base, requestId, receipt, costUsd: 0.02 })).toBe(false);
  });

  // ─── Restart-survivable readback (fresh store on same on-disk DB) ───

  it("survives a restart: receipt + spend total read back correctly from a new store instance", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-receipt-restart-"));
    const dbPath = path.join(dir, "state.sqlite");
    const requestId = "chatcmpl-RESTART-003";

    function openLayer(): FridaySqliteLayer {
      const raw = new Database(dbPath);
      runFridayMigrations({ db: raw, migrations: FRIDAY_SQLITE_MIGRATIONS });
      return {
        dbPath,
        writer: raw,
        reads: {
          size: 1,
          withReadConnection: (fn) => fn(raw),
          close() {},
        },
        withWriteTransaction: (fn) => raw.transaction(() => fn(raw))(),
        withReadConnection: (fn) => fn(raw),
        checkpoint() {},
        optimize() {},
        close() {
          raw.close();
        },
      } as unknown as FridaySqliteLayer;
    }

    try {
      // ── Session 1: write the record, then "shut down" (close the DB). ──
      const layer1 = openLayer();
      const svc1 = createFridayProviderService({
        db: layer1,
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
      });
      const providerId = await createOpenAiProvider(svc1);
      const written = await svc1.recordUsage({
        providerId,
        providerApi: "openai-completions",
        model: "gpt-4o",
        routeStrategy: "configured",
        taskComplexity: "medium",
        usage: { input: 4000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 5000 },
        costUsd: 0.12,
        requestId,
      });
      expect(written.recorded).toBe(true);
      layer1.close();

      // ── Session 2: brand-new store instance on the same file. ──
      const layer2 = openLayer();
      const svc2 = createFridayProviderService({
        db: layer2,
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
      });

      const lookup = await svc2.getCallReceipt(requestId);
      expect(lookup).not.toBeNull();
      expect(lookup!.receiptValid).toBe(true); // receipt survived + still valid
      expect(lookup!.receipt.costUsd).toBeCloseTo(0.12, 10);
      expect(lookup!.receipt.receipt).toBe(written.receipt);

      const summary = await svc2.getUsageSummary({
        from: "2026-02-01",
        to: "2026-02-17",
        groupBy: "day",
      });
      expect(summary.totals.costUsd).toBeCloseTo(0.12, 10); // spend total durable

      // Idempotency also survives restart: re-recording the same request-id on
      // the fresh store is still a no-op (one row / one charge).
      const replay = await svc2.recordUsage({
        providerId,
        providerApi: "openai-completions",
        model: "gpt-4o",
        routeStrategy: "configured",
        taskComplexity: "medium",
        usage: { input: 4000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 5000 },
        costUsd: 0.12,
        requestId,
      });
      expect(replay.duplicate).toBe(true);
      expect(sumCost(layer2)).toBeCloseTo(0.12, 10);
      layer2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
