import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFridayRetentionSettingsRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
} from "#jobs";
import type { FridayRetentionSettingsStore } from "#jobs";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-07-15T10:00:00.000Z";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { userId: "owner-a" } as never,
    ...overrides,
  };
}

describe("friday-retention-settings-routes (RETENTION-R3a)", () => {
  let db: FridaySqliteLayer;
  let store: FridayRetentionSettingsStore;
  let routes: ReturnType<typeof createFridayRetentionSettingsRoutes>;

  let idCounter = 0;

  function getRoute() {
    return routes.find((r) => r.operationId === "uix.retention.policy.get")!;
  }
  function putRoute() {
    return routes.find((r) => r.operationId === "uix.retention.policy.update")!;
  }

  function rowsFor(principalId: string): Array<{ content_category: string; after_days: number }> {
    return db.writer
      .prepare(
        "SELECT content_category, after_days FROM friday_retention_settings WHERE principal_id = ? ORDER BY content_category",
      )
      .all(principalId) as Array<{ content_category: string; after_days: number }>;
  }

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    store = createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
    });
    routes = createFridayRetentionSettingsRoutes({ store });
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. AUTH: synthetic-public / anonymous principal is refused on GET + PUT ──
  it("GET rejects the synthetic public principal with 401", async () => {
    await expect(
      getRoute().handler(makeCtx({ principal: createFridayDefaultPublicHttpPrincipal() })),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("GET rejects a null (unauthenticated) principal with 401", async () => {
    await expect(
      getRoute().handler(makeCtx({ principal: null })),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("PUT rejects the synthetic public principal with 401 (nothing persisted)", async () => {
    await expect(
      putRoute().handler(
        makeCtx({
          principal: createFridayDefaultPublicHttpPrincipal(),
          body: { policy: { auditLogs: { mode: "after_days", days: 30 } } },
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 401 });
    // The synthetic public user id must not have persisted anything.
    expect(rowsFor("00000000-0000-0000-0000-000000000001")).toHaveLength(0);
  });

  // ── 2. CROSS-OWNER ISOLATION (the class missed in #1606) ──────────────────
  it("owner A's PUT is invisible to owner B's GET; B sees only defaults", async () => {
    await putRoute().handler(
      makeCtx({
        principal: { userId: "owner-a" } as never,
        body: { policy: { auditLogs: { mode: "after_days", days: 30 } } },
      }),
    );

    // Owner B reads: every category permanent (no leakage of A's opt-in).
    const bResult = (await getRoute().handler(
      makeCtx({ principal: { userId: "owner-b" } as never }),
    )) as { policy: Record<string, { mode: string; days?: number }> };
    for (const [, retention] of Object.entries(bResult.policy)) {
      expect(retention.mode).toBe("permanent");
    }
    expect(bResult.policy.auditLogs).toEqual({ mode: "permanent" });

    // Owner A reads back its own opt-in.
    const aResult = (await getRoute().handler(
      makeCtx({ principal: { userId: "owner-a" } as never }),
    )) as { policy: Record<string, { mode: string; days?: number }> };
    expect(aResult.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });

    // Persistence is physically scoped: A has a row, B has none.
    expect(rowsFor("owner-a")).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    expect(rowsFor("owner-b")).toHaveLength(0);
  });

  it("owner id comes ONLY from the principal — a body-supplied owner id is ignored", async () => {
    // Body tries to target owner-b; handler must write under the principal (owner-a).
    await putRoute().handler(
      makeCtx({
        principal: { userId: "owner-a" } as never,
        body: {
          userId: "owner-b",
          principalId: "owner-b",
          ownerId: "owner-b",
          policy: { agentRuns: { mode: "after_days", days: 10 } },
        } as never,
      }),
    );
    expect(rowsFor("owner-a")).toEqual([{ content_category: "agentRuns", after_days: 10 }]);
    expect(rowsFor("owner-b")).toHaveLength(0);
  });

  // ── 3. "OFF" = clean disabled (permanent / no row) — NEVER a sentinel ─────
  it("setting a category OFF (permanent) removes the override row — no sentinel persisted", async () => {
    // Enable, then disable ("off").
    await putRoute().handler(
      makeCtx({ body: { policy: { learningEvents: { mode: "after_days", days: 45 } } } }),
    );
    expect(rowsFor("owner-a")).toHaveLength(1);

    const offResult = (await putRoute().handler(
      makeCtx({ body: { policy: { learningEvents: { mode: "permanent" } } } }),
    )) as { policy: Record<string, { mode: string; days?: number }> };

    // Read back = permanent; the override row is GONE (absence = permanent).
    expect(offResult.policy.learningEvents).toEqual({ mode: "permanent" });
    expect(rowsFor("owner-a")).toHaveLength(0);

    // No sentinel number is EVER present in persisted rows: every stored
    // after_days is a positive integer, and "off" is never a magic number.
    for (const row of rowsFor("owner-a")) {
      expect(Number.isInteger(row.after_days)).toBe(true);
      expect(row.after_days).toBeGreaterThan(0);
    }
    // And the read-back never surfaces a sentinel days for a permanent category.
    expect(offResult.policy.learningEvents).not.toHaveProperty("days");
  });

  it("a fresh owner GET defaults every content category to permanent (default-OFF)", async () => {
    const result = (await getRoute().handler(makeCtx())) as {
      policy: Record<string, { mode: string; days?: number }>;
    };
    const categories = Object.keys(result.policy);
    expect(categories).toEqual(
      expect.arrayContaining([
        "learningEvents",
        "heartbeats",
        "skillRunTerminal",
        "auditLogs",
        "agentRuns",
        "llmUsageRecords",
        "errorIncidents",
      ]),
    );
    for (const cat of categories) {
      expect(result.policy[cat]).toEqual({ mode: "permanent" });
    }
    expect(rowsFor("owner-a")).toHaveLength(0);
  });

  // ── 4. INVALID PUT bodies → typed 400, nothing persisted ─────────────────
  const invalidPolicies: Array<[string, unknown]> = [
    ["bad mode", { auditLogs: { mode: "forever" } }],
    ["days = 0", { auditLogs: { mode: "after_days", days: 0 } }],
    ["days = -1", { auditLogs: { mode: "after_days", days: -1 } }],
    ["days = 1.5", { auditLogs: { mode: "after_days", days: 1.5 } }],
    ["days = NaN", { auditLogs: { mode: "after_days", days: Number.NaN } }],
    ["days = Infinity", { auditLogs: { mode: "after_days", days: Number.POSITIVE_INFINITY } }],
    ["days = string", { auditLogs: { mode: "after_days", days: "30" } }],
    ["days missing", { auditLogs: { mode: "after_days" } }],
    ["retention not object", { auditLogs: 30 }],
    ["unknown category", { totallyBogusCategory: { mode: "after_days", days: 30 } }],
    ["category value null", { auditLogs: null }],
  ];

  it.each(invalidPolicies)(
    "PUT with %s → 400 and persists nothing",
    async (_label, policy) => {
      await expect(
        putRoute().handler(makeCtx({ body: { policy } as never })),
      ).rejects.toMatchObject({ httpStatus: 400 });
      expect(rowsFor("owner-a")).toHaveLength(0);
    },
  );

  it("a MIXED body with one invalid entry persists NOTHING (validate-then-apply)", async () => {
    await expect(
      putRoute().handler(
        makeCtx({
          body: {
            policy: {
              auditLogs: { mode: "after_days", days: 30 }, // valid
              agentRuns: { mode: "after_days", days: 0 }, // invalid → whole PUT rejected
            },
          } as never,
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    // Neither the valid nor the invalid entry was written.
    expect(rowsFor("owner-a")).toHaveLength(0);
  });

  it("PUT with a non-object / missing policy → 400", async () => {
    await expect(
      putRoute().handler(makeCtx({ body: {} as never })),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      putRoute().handler(makeCtx({ body: { policy: [] } as never })),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      putRoute().handler(makeCtx({ body: null as never })),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });
});
