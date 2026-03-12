import type { FridaySqliteLayer } from "#state";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridayMarketplaceHttpClient } from "./friday-marketplace-http-client.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type {
  FridayMarketplaceIndexDocument,
  FridayMarketplaceSourceEntity,
} from "../model/friday-skill-marketplace.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import { FridayDomainError } from "#errors";

// ─── Interface ───

export interface FridayMarketplaceSyncService {
  /** Sync all enabled sources. Returns per-source results. */
  syncAllSources(): Promise<FridaySyncResult[]>;
  /** Sync a single source by ID. */
  syncSource(sourceId: string): Promise<FridaySyncResult>;
}

export interface FridaySyncResult {
  sourceId: string;
  sourceName: string;
  skillsSynced: number;
  versionsSynced: number;
  errors: string[];
}

// ─── Dependencies ───

export interface CreateMarketplaceSyncServiceDeps {
  db: FridaySqliteLayer;
  sourceRepo: FridayMarketplaceSourceRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
  skillRepo: FridaySkillRepository;
  versionRepo: FridaySkillVersionRepository;
  httpClient: FridayMarketplaceHttpClient;
  trustScoring: FridaySkillTrustScoringService;
  signatureVerifier: FridaySkillSignatureVerifier;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
}

// ─── Factory ───

export function createFridayMarketplaceSyncService(
  deps: CreateMarketplaceSyncServiceDeps,
): FridayMarketplaceSyncService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  async function syncSingleSource(source: FridayMarketplaceSourceEntity): Promise<FridaySyncResult> {
    const result: FridaySyncResult = {
      sourceId: source.id,
      sourceName: source.name,
      skillsSynced: 0,
      versionsSynced: 0,
      errors: [],
    };

    let indexDoc: FridayMarketplaceIndexDocument;
    try {
      indexDoc = await deps.httpClient.fetchIndex(source.baseUrl);
    } catch (err) {
      result.errors.push(`Failed to fetch index: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    const nowIso = deps.nowIso();

    deps.db.withWriteTransaction((conn) => {
      for (const skill of indexDoc.skills) {
        try {
          // Upsert skill metadata
          deps.skillRepo.upsertSkillFromMarketplace(conn, {
            id: skill.id,
            name: skill.name,
            source: "marketplace",
            origin: "managed",
            publisher: skill.publisher,
            latestVersion: skill.latestVersion,
            status: "not_installed",
            nowIso,
          });
          result.skillsSynced++;

          for (const ver of skill.versions) {
            // Build a valid default SkillManifestV2 for synced skills
            const syncedManifest: SkillManifestV2 = {
              schemaVersion: "2.0",
              id: skill.id,
              name: skill.name,
              description: "",
              version: ver.version,
              kind: "conversation",
              category: "utility",
              author: { name: skill.publisher ?? "Unknown" },
              tags: [],
              runtime: {
                kind: "node",
                entrypoint: "index.js",
                minHubVersion: "0.1.0",
                apiVersion: "1",
                timeoutMsDefault: 30000,
              },
              triggers: { intents: [], phrases: [], channels: [] },
              invocation: {
                userInvocable: true,
                modelInvocable: false,
                priority: 50,
                modes: ["intent"],
              },
              requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
              inputs: [],
              outputs: [],
              permissions: { grants: [], promptOn: [] },
              executionTargets: {
                allowedSatelliteTypes: ["desktop"],
                requiredCapabilities: [],
              },
            };

            // Upsert version
            deps.versionRepo.upsertVersion(conn, {
              id: deps.idGenerator(),
              skillId: skill.id,
              version: ver.version,
              checksum: ver.checksum,
              packageUrl: ver.packageUrl,
              manifest: syncedManifest,
              releasedAt: ver.releasedAt,
              nowIso,
            });

            // Compute trust score for cache
            const trustBreakdown = deps.trustScoring.computeScore({
              verification: {
                integrityValid: true,
                signatureValid: false,
                checks: ["integrity:pass", "signature:pending"],
              },
              trustPolicy: source.trustPolicy,
              hasPinnedKeys: source.pinnedKeyIds.length > 0,
              keyPinningPassed: false,
              publisherInstallCount: 0,
              indexedAt: nowIso,
              nowIso,
              cacheTtlHours,
            });

            // Upsert cache entry
            deps.cacheRepo.upsertCacheEntry(conn, {
              id: deps.idGenerator(),
              sourceId: source.id,
              skillId: skill.id,
              version: ver.version,
              manifestJson: JSON.stringify({ id: skill.id, name: skill.name, version: ver.version }),
              signatureValid: false,
              indexedAt: nowIso,
              trustScore: trustBreakdown.total,
              nowIso,
            });
            result.versionsSynced++;
          }
        } catch (err) {
          result.errors.push(
            `Error syncing skill ${skill.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    return result;
  }

  return {
    async syncAllSources() {
      const sources = deps.db.withReadConnection((conn) =>
        deps.sourceRepo.listSources(conn, true),
      );

      const results: FridaySyncResult[] = [];
      for (const source of sources) {
        const result = await syncSingleSource(source);
        results.push(result);
      }
      return results;
    },

    async syncSource(sourceId) {
      const source = deps.db.withReadConnection((conn) =>
        deps.sourceRepo.getSourceById(conn, sourceId),
      );
      if (!source) {
        throw new FridayDomainError("MARKETPLACE_SOURCE_NOT_FOUND", `Source ${sourceId} not found`, { httpStatus: 404 });
      }
      return syncSingleSource(source);
    },
  };
}
