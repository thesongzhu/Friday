/**
 * Policy Bundle Manager — loads, validates, caches, and manages policy bundles.
 *
 * Converts YAML/JSON policy bundle definitions into runtime FridayPolicyBundle
 * and FridayRule entities. Maintains an in-memory cache and rebuilds the rule
 * index on any mutation.
 *
 * @module rules/engine
 */

import type {
  FridayPolicyBundle,
  FridayPolicyBundleYaml,
  FridayPolicyBundleYamlRule,
  FridayRule,
  FridayRuleConditionGroup,
  ISODateTime,
  UUID,
} from "../model/friday-rules-engine.types.js";

import type { FridayRuleIndex } from "./rule-index.js";
import { parsePolicyBundleDocument, parsePolicyBundleJson, parsePolicyBundleYaml } from "./dsl-parser.js";
import {
  assertPolicyBundleSignatureValid,
  createDomainBundleSigningPayload,
  createParsedBundleSigningPayload,
  type PolicyBundleSignatureVerificationOptions,
} from "./policy-bundle-signature.js";

// ─── Types ───

/** A loaded bundle with its rules, ready for indexing. */
export interface LoadedBundle {
  bundle: FridayPolicyBundle;
  rules: FridayRule[];
}

type LoadedBundleSnapshot = {
  readonly bundle: FridayPolicyBundle;
  readonly rules: readonly FridayRule[];
};

/** Statistics about loaded bundles. */
export interface BundleManagerStats {
  bundleCount: number;
  ruleCount: number;
  enabledBundleCount: number;
  enabledRuleCount: number;
}

/** Configuration options for bundle signature verification. */
export interface FridayPolicyBundleManagerOptions extends PolicyBundleSignatureVerificationOptions {}

// ─── UUID Generation ───

let uuidCounter = 0;

/** Generate a simple UUID v4-like string using crypto.randomUUID when available. */
function generateUuid(): UUID {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  uuidCounter++;
  return `${Date.now().toString(36)}-${uuidCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Generate an etag string. */
function generateEtag(): string {
  return generateUuid().replace(/-/g, "").slice(0, 16);
}

/** Get current ISO datetime. */
function nowIso(): ISODateTime {
  return new Date().toISOString();
}

// ─── YAML Rule to Domain Rule Conversion ───

/** Convert a YAML rule definition to a domain FridayRule entity. */
function yamlRuleToDomainRule(
  yamlRule: FridayPolicyBundleYamlRule,
  bundleId: UUID,
  now: ISODateTime,
): FridayRule {
  const conditions: FridayRuleConditionGroup = yamlRule.conditions ?? {};
  return {
    id: yamlRule.id,
    policyBundleId: bundleId,
    name: yamlRule.name,
    description: yamlRule.description,
    enabled: yamlRule.enabled ?? true,
    resource: yamlRule.resource,
    action: yamlRule.action,
    conditions,
    decision: yamlRule.decision,
    message: yamlRule.message,
    priority: yamlRule.priority ?? 100,
    version: 1,
    etag: generateEtag(),
    createdAt: now,
    updatedAt: now,
  };
}

/** Convert a parsed YAML bundle to domain entities. */
function yamlBundleToDomain(parsed: FridayPolicyBundleYaml): LoadedBundle {
  const now = nowIso();
  const meta = parsed.metadata;

  const bundle: FridayPolicyBundle = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    priority: meta.priority ?? 100,
    enabled: meta.enabled ?? true,
    tags: meta.tags ?? [],
    source: "import",
    signature: meta.signature,
    etag: generateEtag(),
    createdAt: now,
    updatedAt: now,
  };

  const rules = parsed.rules.map((r) => yamlRuleToDomainRule(r, bundle.id, now));

  return { bundle, rules };
}

// ─── Policy Bundle Manager ───

export class FridayPolicyBundleManager {
  /** In-memory cache of loaded bundles, keyed by bundle ID. */
  private cache: Map<UUID, LoadedBundleSnapshot> = new Map();

  /** Reference to the rule index for rebuilding on mutations. */
  private readonly ruleIndex: FridayRuleIndex;
  /** Signature verification options for policy bundle loading. */
  private readonly signatureVerificationOptions: FridayPolicyBundleManagerOptions;

  constructor(ruleIndex: FridayRuleIndex, options: FridayPolicyBundleManagerOptions = {}) {
    this.ruleIndex = ruleIndex;
    this.signatureVerificationOptions = {
      signatureSecrets: options.signatureSecrets ?? {},
      enforceBundleSignature: options.enforceBundleSignature ?? false,
    };
  }

  /** Load a policy bundle from a YAML string. */
  async loadFromYaml(yamlContent: string): Promise<LoadedBundle> {
    const parsed = await parsePolicyBundleYaml(yamlContent);
    return this.loadParsedBundle(parsed);
  }

  /** Load a policy bundle from a JSON string. */
  loadFromJson(jsonContent: string): LoadedBundle {
    const parsed = parsePolicyBundleJson(jsonContent);
    return this.loadParsedBundle(parsed);
  }

  /** Load a policy bundle from a pre-parsed raw object. */
  loadFromObject(raw: unknown): LoadedBundle {
    const parsed = parsePolicyBundleDocument(raw);
    return this.loadParsedBundle(parsed);
  }

  /** Load a policy bundle from pre-constructed domain entities (e.g., from DB). */
  loadDomainBundle(bundle: FridayPolicyBundle, rules: FridayRule[]): LoadedBundle {
    this.verifyDomainBundleSignature(bundle, rules);
    const snapshot = toImmutableSnapshot({ bundle, rules });
    this.applyCacheMutation((nextCache) => {
      nextCache.set(snapshot.bundle.id, snapshot);
    });
    return toReadableClone(snapshot);
  }

  /** Remove a bundle from the cache and rebuild the index. */
  removeBundle(bundleId: UUID): boolean {
    if (!this.cache.has(bundleId)) {
      return false;
    }

    this.applyCacheMutation((nextCache) => {
      nextCache.delete(bundleId);
    });
    return true;
  }

  /** Get a loaded bundle by ID. */
  getBundle(bundleId: UUID): LoadedBundle | undefined {
    const snapshot = this.cache.get(bundleId);
    return snapshot ? toReadableClone(snapshot) : undefined;
  }

  /** Get all loaded bundles. */
  getAllBundles(): readonly LoadedBundle[] {
    return Object.freeze(Array.from(this.cache.values(), (snapshot) => toReadableClone(snapshot)));
  }

  /** Get statistics about loaded bundles. */
  getStats(): BundleManagerStats {
    let ruleCount = 0;
    let enabledBundleCount = 0;
    let enabledRuleCount = 0;

    for (const { bundle, rules } of this.cache.values()) {
      ruleCount += rules.length;
      if (bundle.enabled) {
        enabledBundleCount++;
        enabledRuleCount += rules.filter((r) => r.enabled && !r.deletedAt).length;
      }
    }

    return {
      bundleCount: this.cache.size,
      ruleCount,
      enabledBundleCount,
      enabledRuleCount,
    };
  }

  /** Clear all bundles and the index. */
  clear(): void {
    this.cache = new Map();
    this.ruleIndex.clear();
  }

  // ─── Internal ───

  /** Load a parsed YAML bundle document, convert to domain, cache, and rebuild index. */
  private loadParsedBundle(parsed: FridayPolicyBundleYaml): LoadedBundle {
    this.verifyParsedBundleSignature(parsed);
    const snapshot = toImmutableSnapshot(yamlBundleToDomain(parsed));
    this.applyCacheMutation((nextCache) => {
      nextCache.set(snapshot.bundle.id, snapshot);
    });
    return toReadableClone(snapshot);
  }

  private verifyParsedBundleSignature(parsed: FridayPolicyBundleYaml): void {
    const payload = createParsedBundleSigningPayload(parsed);
    assertPolicyBundleSignatureValid(
      payload,
      parsed.metadata.signature,
      this.signatureVerificationOptions,
    );
  }

  private verifyDomainBundleSignature(bundle: FridayPolicyBundle, rules: FridayRule[]): void {
    const payload = createDomainBundleSigningPayload(bundle, rules);
    assertPolicyBundleSignatureValid(
      payload,
      bundle.signature,
      this.signatureVerificationOptions,
    );
  }

  /** Apply a cache mutation atomically: prepare -> rebuild index -> commit. */
  private applyCacheMutation(mutator: (nextCache: Map<UUID, LoadedBundleSnapshot>) => void): void {
    const nextCache = new Map(this.cache);
    mutator(nextCache);
    this.rebuildIndex(nextCache);
    this.cache = nextCache;
  }

  /** Rebuild the rule index from a target cache snapshot. */
  private rebuildIndex(cache: ReadonlyMap<UUID, LoadedBundleSnapshot>): void {
    const entries = Array.from(cache.values(), (entry) => ({
      bundle: entry.bundle,
      rules: Array.from(entry.rules),
    }));
    this.ruleIndex.rebuild(entries);
  }
}

function toImmutableSnapshot(loaded: LoadedBundle): LoadedBundleSnapshot {
  return deepFreeze(structuredClone(loaded));
}

function toReadableClone(snapshot: LoadedBundleSnapshot): LoadedBundle {
  const clone = structuredClone(snapshot);
  return {
    bundle: clone.bundle,
    rules: Array.from(clone.rules),
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const target = value as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    deepFreeze(target[key]);
  }

  return Object.freeze(value);
}
