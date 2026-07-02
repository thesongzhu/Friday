import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadFridaySkillPackage, type FridayLoadedSkillPackage } from "../manifest/friday-skill-package-loader.js";
import type {
  FridaySkillCatalogItem,
  FridaySkillCatalogQuery,
  FridaySkillCatalogResult,
  FridaySignatureVerificationResult,
  FridaySkillSourceEntity,
} from "../model/friday-skill-catalog.types.js";
import { createFridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";

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
const TRUST_SCORE_VERIFIED = 90;
const TRUST_SCORE_UNSIGNED = 55;
const TRUST_SCORE_BLOCKED = 20;

function buildLocalPackageBytes(loaded: FridayLoadedSkillPackage): Buffer {
  const chunks: Buffer[] = [];
  const declaredFiles = [...new Set(loaded.declaredFiles)].sort();
  for (const filePath of declaredFiles) {
    if (!existsSync(filePath)) {
      chunks.push(Buffer.from(`missing:${relative(loaded.skillDir, filePath)}\0`));
      continue;
    }
    const fileStat = statSync(filePath);
    if (!fileStat.isFile()) {
      continue;
    }
    const relativePath = relative(loaded.skillDir, filePath).replaceAll("\\", "/");
    chunks.push(Buffer.from(`${relativePath}\0`));
    chunks.push(readFileSync(filePath));
    chunks.push(Buffer.from("\0"));
  }
  return Buffer.concat(chunks);
}

function verifyManagedSkillPackage(loaded: FridayLoadedSkillPackage): {
  verification: FridaySignatureVerificationResult;
  declaredDistribution: boolean;
} {
  const distribution = loaded.manifest.distribution;
  if (!distribution) {
    return {
      declaredDistribution: false,
      verification: {
        integrityValid: false,
        signatureValid: false,
        checks: ["distribution:missing"],
        reason: "No distribution integrity or signature metadata declared",
      },
    };
  }

  const verifier = createFridaySkillSignatureVerifier();
  const signatureDoc = distribution.signature
    ? {
        skillId: loaded.manifest.id,
        version: loaded.manifest.version,
        keyId: distribution.signature.keyId,
        algorithm: distribution.signature.algorithm,
        value: distribution.signature.value,
      }
    : undefined;

  return {
    declaredDistribution: true,
    verification: verifier.verifySignature({
      packageBytes: buildLocalPackageBytes(loaded),
      expectedChecksum: distribution.integrity.digest,
      skillId: loaded.manifest.id,
      version: loaded.manifest.version,
      signatureDoc,
    }),
  };
}

function getEntrypointBlockedReason(loaded: FridayLoadedSkillPackage): string | undefined {
  const { manifest, skillDir } = loaded;
  if (manifest.runtime.kind === "builtin") {
    return undefined;
  }

  const entrypoint = manifest.runtime.entrypoint.trim();
  if (!entrypoint) {
    return "Skill entrypoint is required for non-builtin runtimes.";
  }

  const entrypointPath = resolve(skillDir, entrypoint);
  const relativeEntrypoint = relative(skillDir, entrypointPath);
  if (relativeEntrypoint.startsWith("..") || relativeEntrypoint === "" || relativeEntrypoint.startsWith("/")) {
    return `Skill entrypoint "${entrypoint}" escapes the skill directory.`;
  }

  try {
    const fileStat = statSync(entrypointPath);
    if (!fileStat.isFile()) {
      return `Skill entrypoint "${entrypoint}" is not a file.`;
    }
    if (fileStat.size === 0) {
      return `Skill entrypoint "${entrypoint}" is empty.`;
    }
  } catch {
    return `Skill entrypoint "${entrypoint}" is missing.`;
  }

  return undefined;
}

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
      const loadedPackage = loaded.value;
      const { manifest } = loadedPackage;
      const { declaredDistribution, verification } = verifyManagedSkillPackage(loadedPackage);
      const entrypointBlockedReason = getEntrypointBlockedReason(loadedPackage);
      const blockedReasons: string[] = [];
      if (declaredDistribution && !verification.signatureValid) {
        blockedReasons.push(`Skill signature verification failed: ${verification.reason ?? verification.checks.join(", ")}`);
      }
      if (entrypointBlockedReason) {
        blockedReasons.push(entrypointBlockedReason);
      }
      const blocked = blockedReasons.length > 0;
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
        signatureValid: verification.signatureValid,
        trustScore: verification.signatureValid
          ? TRUST_SCORE_VERIFIED
          : blocked
            ? TRUST_SCORE_BLOCKED
            : TRUST_SCORE_UNSIGNED,
        starter: (manifest.tags ?? []).includes("starter"),
        manifest,
        implementationStatus: blocked ? "catalog-only" : "installed",
        blockedReasons,
        recommendedNextAction: blocked
          ? entrypointBlockedReason
            ? "Fix skill entrypoint before installation."
            : "Fix skill signature before installation."
          : undefined,
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
