import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayReflexRoutes } from "../../../src/api/index.js";
import { createFridaySqliteLayer, type FridaySqliteLayer } from "#state";
import { createFridayUixUserPreferenceRepository } from "../../../src/uix/persistence/friday-uix-user-preference-repository.js";
import {
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
} from "../../../src/reflex/index.js";

let db: FridaySqliteLayer | undefined;
let tempDir: string | undefined;
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `route-id-${String(idCounter).padStart(4, "0")}`;
}

function createService() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-reflex-route-test-"));
  db = createFridaySqliteLayer({
    dbPath: path.join(tempDir, "state.sqlite"),
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5_000, synchronous: "NORMAL" },
  });
  return createFridayReflexService({
    db,
    candidateRepo: createFridayReflexCandidateRepository(),
    onboardingRepo: createFridayReflexOnboardingRepository(),
    preferenceRepo: createFridayUixUserPreferenceRepository(),
    idGenerator: nextId,
    nowIso: () => "2026-04-30T12:00:00.000Z",
  });
}

function ctx(input: {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  userId?: string | null;
} = {}) {
  return {
    requestId: "req-1",
    receivedAt: "2026-04-30T12:00:00.000Z",
    headers: {},
    rawBody: "",
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    principal: input.userId === null
      ? null
      : {
          principalType: "user",
          principalId: input.userId ?? "user-1",
          userId: input.userId ?? "user-1",
          scopes: ["agent.run"],
          tokenId: "token-1",
          tokenKind: "api",
          issuedAt: "2026-04-30T12:00:00.000Z",
        },
  } as never;
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  idCounter = 0;
});

describe("Friday Reflex routes", () => {
  it("rejects invalid candidate filters instead of silently widening the query", async () => {
    const routes = createFridayReflexRoutes({ service: createService() });
    const listRoute = routes.find((route) => route.operationId === "reflex.candidates.list");

    await expect(listRoute!.handler(ctx({ query: { status: "ready-ish" } })))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
    await expect(listRoute!.handler(ctx({ query: { kind: "superpower" } })))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
  });

  it("revokes preferences through the public Review Center API", async () => {
    const service = createService();
    const routes = createFridayReflexRoutes({ service });
    const updateRoute = routes.find((route) => route.operationId === "reflex.preferences.update");
    const revokeRoute = routes.find((route) => route.operationId === "reflex.preferences.revoke");

    const written = await updateRoute!.handler(ctx({
      params: { key: "persona.verbosity" },
      body: {
        category: "communication",
        value: "short",
        sourceSurface: "review_center",
      },
    })) as { preference: { id: string } };

    const revoked = await revokeRoute!.handler(ctx({
      params: { id: written.preference.id },
      body: { sourceSurface: "review_center" },
    })) as { revoked: true };

    expect(revoked.revoked).toBe(true);
    expect(service.listPreferences("user-1")).toEqual([]);
  });

  it("returns a review candidate for high-impact preferences even if the caller claims Review Center", async () => {
    const service = createService();
    const routes = createFridayReflexRoutes({ service });
    const updateRoute = routes.find((route) => route.operationId === "reflex.preferences.update");

    const pending = await updateRoute!.handler(ctx({
      params: { key: "testing.live_llm_policy" },
      body: {
        category: "reflex",
        value: "allowed_with_cost_notice",
        sourceSurface: "review_center",
      },
    })) as { requiresConfirmation: true; candidate: { status: string; payload: Record<string, unknown> } };

    expect(pending.requiresConfirmation).toBe(true);
    expect(pending.candidate.status).toBe("ready_for_review");
    expect(pending.candidate.payload).toMatchObject({
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
    });
    expect(service.listPreferences("user-1")
      .find((pref) => pref.key === "testing.live_llm_policy")).toBeUndefined();
  });
});
