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
import { FridayDomainError } from "#errors";
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
  /**
   * Test-oracle only: allow the legacy TypeScript scan-migrate product logic
   * (local-skill discovery scan + batch convert preview). Production/runtime
   * callers must leave this unset so the two POST routes fail-close
   * (503 TS_RUNTIME_SCAN_MIGRATE_RETIRED) until Rust owns local skill discovery
   * and batch conversion. The GET community catalog is a pure read, never gated.
   */
  allowTestOnlyScanMigrateExecution?: boolean;
}

/**
 * TS-runtime retirement guard for the scan-migrate product-logic routes. Both
 * surfaces are non-mutating but execute Rust-ownable product logic
 * (scanLocalSkills runs a multi-source filesystem discovery algorithm;
 * convert-batch runs converterService.convert per item), so they fail-close
 * rather than serve as compat_shim reads. Each underlying method has exactly one
 * user-triggerable call site (its route), so the retirement is complete.
 */
function assertScanMigrateTestOracleAllowed(
  deps: FridayScanMigrateRoutesDeps,
): void {
  if (deps.allowTestOnlyScanMigrateExecution === true) {
    return;
  }
  throw new FridayDomainError(
    "TS_RUNTIME_SCAN_MIGRATE_RETIRED",
    "Local skill discovery scan and batch convert preview are fail-closed in the default/live runtime; the Rust-owned scan-migrate entrypoint is required.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_scan_migrate_entrypoint_required",
      },
    },
  );
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
      auth: { public: true },
      handler: async (_ctx: Ctx) => {
        assertScanMigrateTestOracleAllowed(deps);
        const result = deps.scanLocal();
        return { status: 200, body: result };
      },
    },

    // ── Community Catalog ──
    {
      operationId: "skills.catalog.community",
      method: "GET",
      path: "/v1/skills/catalog/community",
      auth: { public: true },
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
      auth: { public: true },
      handler: async (ctx: Ctx) => {
        assertScanMigrateTestOracleAllowed(deps);
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
