/**
 * Program Discovery Service.
 *
 * Orchestrates OS-specific scanners, caches the program catalog,
 * and delegates to the recommendation engine for integration mapping.
 */

import { randomUUID } from "node:crypto";
import { FridayDomainError } from "#errors";

import type {
  FridayDiscoveryFilterOptions,
  FridayDiscoveryPolicy,
  FridayProgramCatalog,
  FridayProgramDiscoveryService,
  FridayProgramScanner,
} from "./friday-program-discovery.types.js";
import { DEFAULT_DISCOVERY_POLICY } from "./friday-program-discovery.types.js";
import { generateRecommendations } from "./friday-integration-recommendation-engine.js";
import type { FridayRecommendationResult } from "./friday-program-discovery.types.js";

// ─── Deps ───

export interface CreateFridayProgramDiscoveryServiceDeps {
  scanner: FridayProgramScanner;
  initialPolicy?: Partial<FridayDiscoveryPolicy>;
}

// ─── Factory ───

export function createFridayProgramDiscoveryService(
  deps: CreateFridayProgramDiscoveryServiceDeps,
): FridayProgramDiscoveryService {
  let policy: FridayDiscoveryPolicy = {
    ...DEFAULT_DISCOVERY_POLICY,
    ...deps.initialPolicy,
  };
  let cachedCatalog: FridayProgramCatalog | null = null;

  return {
    async discover(): Promise<FridayProgramCatalog> {
      if (!policy.enabled) {
        throw new FridayDomainError(
          "DISCOVERY_DISABLED",
          "Program discovery is disabled by policy",
          { httpStatus: 403 },
        );
      }

      const startMs = Date.now();
      let scanErrors = 0;
      let programs: Awaited<ReturnType<typeof deps.scanner.scan>> = [];

      try {
        programs = await deps.scanner.scan(policy);
      } catch (err) {
      console.warn("[friday][program-discovery-service] operation failed:", err instanceof Error ? err.message : String(err));
        scanErrors++;
        programs = [];
      }

      const catalog: FridayProgramCatalog = {
        id: randomUUID(),
        platform: deps.scanner.platform,
        programs,
        generatedAt: new Date().toISOString(),
        scanDurationMs: Date.now() - startMs,
        scanErrors,
      };

      cachedCatalog = catalog;
      return catalog;
    },

    getCachedCatalog(): FridayProgramCatalog | null {
      return cachedCatalog;
    },

    async recommend(
      filter?: FridayDiscoveryFilterOptions,
    ): Promise<FridayRecommendationResult> {
      if (!policy.enabled) {
        throw new FridayDomainError(
          "DISCOVERY_DISABLED",
          "Program discovery is disabled by policy",
          { httpStatus: 403 },
        );
      }

      // Use cached catalog or run a fresh scan
      const catalog = cachedCatalog ?? (await this.discover());
      return generateRecommendations(catalog.programs, filter);
    },

    getPolicy(): FridayDiscoveryPolicy {
      return { ...policy };
    },

    setPolicy(updates: Partial<FridayDiscoveryPolicy>): void {
      policy = { ...policy, ...updates };
    },

    isEnabled(): boolean {
      return policy.enabled;
    },
  };
}
