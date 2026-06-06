import { describe, expect, it, vi } from "vitest";

import type { FridayHttpContext } from "#api";
import { createFridayScanMigrateRoutes } from "../../../../../src/api/http/routes/friday-scan-migrate-routes.js";

function makeCtx(
  body: unknown,
): FridayHttpContext<unknown, Record<string, string>, unknown> {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-05T12:00:00.000Z",
    params: {},
    query: {},
    body,
    headers: {},
    principal: null,
  };
}

describe("createFridayScanMigrateRoutes", () => {
  it("exposes conversion preview instead of an import/install batch route", () => {
    const routes = createFridayScanMigrateRoutes({
      scanLocal: () => ({ items: [], scannedAt: "now", scanDurationMs: 0, directoriesScanned: [] }),
      getCommunitySkills: () => [],
      convertSkill: vi.fn(),
    });

    expect(routes.some((route) => route.operationId === "skills.import.batch")).toBe(false);
    expect(routes.some((route) => route.path === "/v1/skills/import-batch")).toBe(false);
    expect(routes.some((route) => route.operationId === "skills.convert.batch")).toBe(true);
    expect(routes.some((route) => route.path === "/v1/skills/convert-batch")).toBe(true);
  });

  it("returns transient conversion previews without installed/imported counts", async () => {
    const convertSkill = vi.fn(async () => ({
      success: true,
      skillId: "draft-weather",
      mode: "preview" as const,
    }));
    const routes = createFridayScanMigrateRoutes({
      scanLocal: () => ({ items: [], scannedAt: "now", scanDurationMs: 0, directoriesScanned: [] }),
      getCommunitySkills: () => [],
      convertSkill,
      allowTestOnlyScanMigrateExecution: true,
    });
    const route = routes.find((candidate) => candidate.operationId === "skills.convert.batch");
    expect(route).toBeTruthy();

    const response = await route!.handler(makeCtx({
      items: [{ sourcePath: "/tmp/SKILL.md", formatHint: "clawdbot-skill-md" }],
    }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      results: [
        {
          sourcePath: expect.stringMatching(/^local-path:/),
          success: true,
          skillId: "draft-weather",
          mode: "preview",
          error: undefined,
        },
      ],
      convertedCount: 1,
      failedCount: 0,
    });
    expect(JSON.stringify(response.body)).not.toContain("importedCount");
  });

  it("redacts token-bearing source paths and conversion errors", async () => {
    const tokenBearingSource = "https://example.com/skill.zip?token=batch-preview-secret-token";
    const convertSkill = vi.fn(async () => ({
      success: false,
      error: `Unable to convert ${tokenBearingSource}`,
    }));
    const routes = createFridayScanMigrateRoutes({
      scanLocal: () => ({ items: [], scannedAt: "now", scanDurationMs: 0, directoriesScanned: [] }),
      getCommunitySkills: () => [],
      convertSkill,
      allowTestOnlyScanMigrateExecution: true,
    });
    const route = routes.find((candidate) => candidate.operationId === "skills.convert.batch");
    expect(route).toBeTruthy();

    const response = await route!.handler(makeCtx({
      items: [{ sourcePath: tokenBearingSource, formatHint: "code-repo" }],
    }));

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(tokenBearingSource);
    expect(serialized).not.toContain("batch-preview-secret-token");
    expect(response.body).toEqual({
      results: [
        {
          sourcePath: "https://example.com/skill.zip?redacted=1",
          success: false,
          skillId: undefined,
          mode: undefined,
          error: "Unable to convert https://example.com/skill.zip?redacted=1",
        },
      ],
      convertedCount: 0,
      failedCount: 1,
    });
  });

  describe("TS-runtime retirement (default/live fail-close)", () => {
    // Build routes WITHOUT the test-oracle flag = production/live wiring.
    function makeRetiredDeps() {
      const scanLocal = vi.fn(() => ({ items: [], scannedAt: "now", scanDurationMs: 0, directoriesScanned: [] }));
      const convertSkill = vi.fn(async () => ({ success: true, skillId: "x", mode: "preview" as const }));
      const getCommunitySkills = vi.fn(() => [{ id: "c1", name: "Community Skill" } as never]);
      const routes = createFridayScanMigrateRoutes({ scanLocal, getCommunitySkills, convertSkill });
      return { routes, scanLocal, convertSkill, getCommunitySkills };
    }

    it("fail-closes scan-local with 503 TS_RUNTIME_SCAN_MIGRATE_RETIRED and does not scan", async () => {
      const { routes, scanLocal } = makeRetiredDeps();
      const route = routes.find((r) => r.operationId === "skills.scan.local")!;
      await expect(route.handler(makeCtx({}))).rejects.toMatchObject({
        code: "TS_RUNTIME_SCAN_MIGRATE_RETIRED",
        httpStatus: 503,
      });
      expect(scanLocal).not.toHaveBeenCalled();
    });

    it("fail-closes convert-batch with 503 and does not convert", async () => {
      const { routes, convertSkill } = makeRetiredDeps();
      const route = routes.find((r) => r.operationId === "skills.convert.batch")!;
      await expect(
        route.handler(makeCtx({ items: [{ sourcePath: "/tmp/SKILL.md" }] })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_SCAN_MIGRATE_RETIRED", httpStatus: 503 });
      expect(convertSkill).not.toHaveBeenCalled();
    });

    it("leaves the GET community catalog ungated (pure read)", async () => {
      const { routes, getCommunitySkills } = makeRetiredDeps();
      const route = routes.find((r) => r.operationId === "skills.catalog.community")!;
      const response = await route.handler(makeCtx({}));
      expect(response.status).toBe(200);
      expect(getCommunitySkills).toHaveBeenCalledOnce();
    });
  });
});
