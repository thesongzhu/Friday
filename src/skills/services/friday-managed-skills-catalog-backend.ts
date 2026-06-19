import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadFridaySkillPackage } from "../manifest/friday-skill-package-loader.js";
import type {
  FridaySkillCatalogItem,
  FridaySkillCatalogQuery,
  FridaySkillCatalogResult,
  FridaySkillSourceEntity,
} from "../model/friday-skill-catalog.types.js";

export interface FridaySkillCatalogBackend {
  listCatalog(query: FridaySkillCatalogQuery): FridaySkillCatalogResult;
  getSource(sourceId?: string): FridaySkillSourceEntity | undefined;
}

export interface CreateFridayManagedSkillsCatalogBackendOptions {
  managedSkillsDir: string;
  workspaceDir?: string;
  nowIso: () => string;
}

const MANAGED_SKILLS_SOURCE_ID = "managed-skills";

export function createFridayManagedSkillsCatalogBackend(
  options: CreateFridayManagedSkillsCatalogBackendOptions,
): FridaySkillCatalogBackend {
  const source = (): FridaySkillSourceEntity => {
    const now = options.nowIso();
    return {
      id: MANAGED_SKILLS_SOURCE_ID,
      name: "Managed Skills",
      baseUrl: pathToFileURL(resolve(options.managedSkillsDir)).href,
      enabled: true,
      trustPolicy: "warn",
      pinnedKeyIds: [],
      createdAt: now,
      updatedAt: now,
    };
  };

  function loadItems(): FridaySkillCatalogItem[] {
    let entries;
    try {
      entries = readdirSync(options.managedSkillsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const workspaceDir = options.workspaceDir ?? options.managedSkillsDir;
    const items: FridaySkillCatalogItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillDir = join(options.managedSkillsDir, entry.name);
      const loaded = loadFridaySkillPackage({ skillDir, workspaceDir });
      if (!loaded.ok) {
        continue;
      }
      const { manifest } = loaded.value;
      let releasedAt = options.nowIso();
      try {
        releasedAt = statSync(skillDir).mtime.toISOString();
      } catch {
        // Keep catalog reads fail-open for entry metadata; package parsing already gates inclusion.
      }
      items.push({
        sourceId: MANAGED_SKILLS_SOURCE_ID,
        skillId: manifest.id,
        skillName: manifest.name,
        publisher: manifest.author.name,
        version: manifest.version,
        category: manifest.category,
        releasedAt,
        signatureValid: true,
        trustScore: 80,
        starter: (manifest.tags ?? []).includes("starter"),
        manifest,
        implementationStatus: "installed",
        firstUsePrompts: [
          ...(manifest.triggers.phrases ?? []),
          ...(manifest.triggers.intents ?? []),
        ].slice(0, 3),
      });
    }

    return items.sort((left, right) => left.skillName.localeCompare(right.skillName));
  }

  return {
    listCatalog(query) {
      const sourceId = query.sourceId?.trim();
      const q = query.q?.trim().toLowerCase();
      const category = query.category?.trim().toLowerCase();
      const filtered = loadItems().filter((item) => {
        if (sourceId && item.sourceId !== sourceId) {
          return false;
        }
        if (category && item.category?.toLowerCase() !== category) {
          return false;
        }
        if (!q) {
          return true;
        }
        const haystack = [
          item.skillId,
          item.skillName,
          item.manifest.description,
          item.publisher,
          ...(item.manifest.tags ?? []),
          ...(item.manifest.triggers.phrases ?? []),
          ...(item.manifest.triggers.intents ?? []),
        ].join("\n").toLowerCase();
        return haystack.includes(q);
      });

      const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
      const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : filtered.length;
      const items = filtered.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        total: filtered.length,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
      };
    },

    getSource(sourceId) {
      if (!sourceId || sourceId === MANAGED_SKILLS_SOURCE_ID) {
        return source();
      }
      return undefined;
    },
  };
}
