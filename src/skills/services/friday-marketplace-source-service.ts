import type { FridaySqliteLayer } from "#state";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type {
  FridayMarketplaceSourceCreateInput,
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourcePatchInput,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceSourceService {
  addSource(input: FridayMarketplaceSourceCreateInput): FridayMarketplaceSourceEntity;
  getSource(id: string): FridayMarketplaceSourceEntity | null;
  listSources(enabledOnly?: boolean): FridayMarketplaceSourceEntity[];
  updateSource(id: string, patch: FridayMarketplaceSourcePatchInput): FridayMarketplaceSourceEntity;
  enableSource(id: string): void;
  disableSource(id: string): void;
  removeSource(id: string): void;
}

// ─── Dependencies ───

export interface CreateMarketplaceSourceServiceDeps {
  db: FridaySqliteLayer;
  sourceRepo: FridayMarketplaceSourceRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayMarketplaceSourceService(
  deps: CreateMarketplaceSourceServiceDeps,
): FridayMarketplaceSourceService {
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
