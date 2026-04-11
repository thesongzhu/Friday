/**
 * Skill Scan & Migrate Routes.
 *
 * REST endpoints for local skill scanning, community catalog browsing,
 * and batch skill import.
 *
 * @module api/http/routes
 */

import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { LocalSkillScanResult } from "../../../skills/converter/discovery/friday-local-skill-scanner.js";
import type { CommunitySkillItem } from "../../../skills/converter/discovery/friday-community-skill-catalog.js";

// ─── Deps ───

export interface FridayScanMigrateRoutesDeps {
  scanLocal: () => LocalSkillScanResult;
  getCommunitySkills: (query?: string) => CommunitySkillItem[];
  importSkill: (sourcePath: string, formatHint?: string) => Promise<{
    success: boolean;
    skillId?: string;
    error?: string;
  }>;
}

// ─── Helpers ───

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

// ─── Factory ───

export function createFridayScanMigrateRoutes(
  deps: FridayScanMigrateRoutesDeps,
): Route[] {
  return [
    // ── Scan Local ──
    {
      operationId: "skills.scan.local",
      method: "POST",
      path: "/v1/skills/scan-local",
      auth: { public: false, anyOfScopes: ["skill.read"] },
      handler: async (_ctx: Ctx) => {
        const result = deps.scanLocal();
        return { status: 200, body: result };
      },
    },

    // ── Community Catalog ──
    {
      operationId: "skills.catalog.community",
      method: "GET",
      path: "/v1/skills/catalog/community",
      auth: { public: false, anyOfScopes: ["skill.read"] },
      handler: async (ctx: Ctx) => {
        const query = ctx.query ?? {};
        const q = query.q ?? undefined;
        const items = deps.getCommunitySkills(q);
        return { status: 200, body: { items } };
      },
    },

    // ── Import Batch ──
    {
      operationId: "skills.import.batch",
      method: "POST",
      path: "/v1/skills/import-batch",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      handler: async (ctx: Ctx) => {
        const body = (ctx.body ?? {}) as {
          items?: Array<{ sourcePath: string; formatHint?: string }>;
        };

        const items = body.items ?? [];
        const results: Array<{ sourcePath: string; success: boolean; skillId?: string; error?: string }> = [];
        let importedCount = 0;
        let failedCount = 0;

        for (const item of items) {
          const result = await deps.importSkill(item.sourcePath, item.formatHint);
          results.push({
            sourcePath: item.sourcePath,
            success: result.success,
            skillId: result.skillId,
            error: result.error,
          });
          if (result.success) {
            importedCount++;
          } else {
            failedCount++;
          }
        }

        return {
          status: 200,
          body: { results, importedCount, failedCount },
        };
      },
    },
  ];
}
