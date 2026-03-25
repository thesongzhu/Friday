import type { FridaySqliteLayer } from "#state";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type {
  FridayMarketplaceSourceCreateInput,
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourcePatchInput,
  FridayMarketplaceSourceView,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceSourceService {
  addSource(input: FridayMarketplaceSourceCreateInput): FridayMarketplaceSourceEntity;
  getSource(id: string): FridayMarketplaceSourceEntity | null;
  listSources(enabledOnly?: boolean): FridayMarketplaceSourceEntity[];
  getSourceView?(id: string): FridayMarketplaceSourceView | null;
  listSourceViews?(enabledOnly?: boolean): FridayMarketplaceSourceView[];
  updateSource(id: string, patch: FridayMarketplaceSourcePatchInput): FridayMarketplaceSourceEntity;
  enableSource(id: string): void;
  disableSource(id: string): void;
  removeSource(id: string): void;
}

// ─── Dependencies ───

export interface CreateMarketplaceSourceServiceDeps {
  db: FridaySqliteLayer;
  sourceRepo: FridayMarketplaceSourceRepository;
  cacheRepo?: FridayMarketplaceCacheRepository;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
}

// ─── Factory ───

export function createFridayMarketplaceSourceService(
  deps: CreateMarketplaceSourceServiceDeps,
): FridayMarketplaceSourceService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  function staleCutoff(): string {
    return new Date(Date.parse(deps.nowIso()) - (cacheTtlHours * 60 * 60 * 1000)).toISOString();
  }

  function toSourceView(source: FridayMarketplaceSourceEntity): FridayMarketplaceSourceView {
    const catalogSummary = deps.cacheRepo
      ? deps.db.withReadConnection((conn) => deps.cacheRepo!.summarizeSource(conn, source.id, staleCutoff()))
      : {
        cachedSkillCount: 0,
        cachedVersionCount: 0,
        verifiedVersionCount: 0,
        unsignedVersionCount: 0,
        latestIndexedAt: undefined,
        stale: false,
      };

    const reasons: string[] = [];
    if (!source.enabled) {
      reasons.push("Source is disabled.");
    }
    if (catalogSummary.cachedVersionCount === 0) {
      reasons.push("No cached catalog entries have been synced yet.");
    }
    if (catalogSummary.unsignedVersionCount > 0) {
      reasons.push(`${catalogSummary.unsignedVersionCount} cached version(s) are unsigned.`);
    }
    if (catalogSummary.stale) {
      reasons.push("Cached catalog data is stale.");
    }

    return {
      ...source,
      trustSummary: {
        policy: source.trustPolicy,
        pinnedKeyCount: source.pinnedKeyIds.length,
        pinned: source.pinnedKeyIds.length > 0,
      },
      catalogSummary,
      healthSummary: {
        status: reasons.length === 0 ? "healthy" : "warning",
        reasons,
      },
    };
  }

  return {
    addSource(input) {
      return deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.insertSource(conn, deps.idGenerator(), input, deps.nowIso()),
      );
    },

    getSource(id) {
      return deps.db.withReadConnection((conn) =>
        deps.sourceRepo.getSourceById(conn, id),
      );
    },

    listSources(enabledOnly) {
      return deps.db.withReadConnection((conn) =>
        deps.sourceRepo.listSources(conn, enabledOnly),
      );
    },

    getSourceView(id) {
      const source = this.getSource(id);
      return source ? toSourceView(source) : null;
    },

    listSourceViews(enabledOnly) {
      return this.listSources(enabledOnly).map((source) => toSourceView(source));
    },

    updateSource(id, patch) {
      return deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.updateSource(conn, id, patch, deps.nowIso()),
      );
    },

    enableSource(id) {
      deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.setEnabled(conn, id, true, deps.nowIso()),
      );
    },

    disableSource(id) {
      deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.setEnabled(conn, id, false, deps.nowIso()),
      );
    },

    removeSource(id) {
      deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.deleteSource(conn, id),
      );
    },
  };
}
