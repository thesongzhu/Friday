/**
 * Skill Scan & Migrate Routes.
 *
 * REST endpoints for local skill scanning, community catalog browsing,
 * and batch skill conversion preview.
 *
 * @module api/http/routes
 */

import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { LocalSkillScanResult } from "../../../skills/converter/discovery/friday-local-skill-scanner.js";
import type { CommunitySkillItem } from "../../../skills/converter/discovery/friday-community-skill-catalog.js";
import {
  redactFridaySkillCandidateSourceUri,
  redactFridaySkillSourceText,
} from "../../../skills/converter/index.js";

// ─── Deps ───

export interface FridayScanMigrateRoutesDeps {
  scanLocal: () => LocalSkillScanResult;
  getCommunitySkills: (query?: string) => CommunitySkillItem[];
  convertSkill: (sourcePath: string, formatHint?: string) => Promise<{
    success: boolean;
    skillId?: string;
    mode?: "preview";
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

    // ── Convert Batch Preview ──
    {
      operationId: "skills.convert.batch",
      method: "POST",
      path: "/v1/skills/convert-batch",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      handler: async (ctx: Ctx) => {
        const body = (ctx.body ?? {}) as {
          items?: Array<{ sourcePath: string; formatHint?: string }>;
        };

        const items = body.items ?? [];
        const results: Array<{ sourcePath: string; success: boolean; skillId?: string; mode?: "preview"; error?: string }> = [];
        let convertedCount = 0;
        let failedCount = 0;

        for (const item of items) {
          const result = await deps.convertSkill(item.sourcePath, item.formatHint);
          const source = { uri: item.sourcePath };
          results.push({
            sourcePath: redactFridaySkillCandidateSourceUri(item.sourcePath),
            success: result.success,
            skillId: result.skillId,
            mode: result.mode,
            error: result.error ? redactFridaySkillSourceText(result.error, source) : undefined,
          });
          if (result.success) {
            convertedCount++;
          } else {
            failedCount++;
          }
        }

        return {
          status: 200,
          body: { results, convertedCount, failedCount },
        };
      },
    },
  ];
}
