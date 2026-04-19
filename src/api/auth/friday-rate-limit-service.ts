import type {
  FridayRateLimitDecision,
  FridayRateLimitPolicy,
  FridayRateLimitPolicyId,
} from "../model/friday-api-auth.types.js";
import type {
  CreateFridayRateLimitServiceDeps,
  FridayAuthLockoutConfig,
  FridayAuthLockoutStatus,
  FridayRateLimitService,
} from "./friday-rate-limit-service.types.js";
import { AUTH_LOCKOUT_SCOPE_SHARED_SECRET } from "./friday-rate-limit-service.types.js";
import { createFridayRateLimitCounterRepository } from "../persistence/friday-rate-limit-counter-repository.js";

// ─── Default Policies ───

const DEFAULT_POLICIES: FridayRateLimitPolicy[] = [
  { id: "auth.login", windowMs: 60_000, maxHits: 10, keyBy: "ip" },
  { id: "auth.refresh", windowMs: 60_000, maxHits: 30, keyBy: "session" },
  { id: "auth.logout", windowMs: 60_000, maxHits: 30, keyBy: "principal" },
  { id: "session.write", windowMs: 60_000, maxHits: 60, keyBy: "principal" },
  { id: "workflow.start_run", windowMs: 60_000, maxHits: 60, keyBy: "principal" },
  { id: "workflow.publish", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
  { id: "workflow.resolve_conflict", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
  { id: "realtime.subscribe", windowMs: 60_000, maxHits: 120, keyBy: "principal" },
  { id: "realtime.pull", windowMs: 60_000, maxHits: 300, keyBy: "principal" },
  { id: "realtime.ws_connect", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
  // Provider write + validate
  { id: "provider.write", windowMs: 60_000, maxHits: 30, keyBy: "principal" },
  { id: "provider.validate", windowMs: 60_000, maxHits: 10, keyBy: "principal" },
  // Agent / memory / marketplace writes
  { id: "agent.run", windowMs: 60_000, maxHits: 10, keyBy: "principal" },
  { id: "memory.write", windowMs: 60_000, maxHits: 60, keyBy: "principal" },
  { id: "marketplace.checkout", windowMs: 60_000, maxHits: 10, keyBy: "principal" },
  { id: "marketplace.write", windowMs: 60_000, maxHits: 30, keyBy: "principal" },
  // Workflow generator (LLM-heavy)
  { id: "generator.llm", windowMs: 60_000, maxHits: 10, keyBy: "principal" },
  { id: "generator.write", windowMs: 60_000, maxHits: 30, keyBy: "principal" },
  // Skill generator (LLM-heavy)
  { id: "skill_generator.llm", windowMs: 60_000, maxHits: 10, keyBy: "principal" },
  { id: "skill_generator.write", windowMs: 60_000, maxHits: 30, keyBy: "principal" },
  // Skill converter (CPU/IO-heavy)
  { id: "skill_converter.write", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
];

function buildPolicyMap(
  overrides?: Partial<Record<FridayRateLimitPolicyId, Partial<FridayRateLimitPolicy>>>,
): Map<FridayRateLimitPolicyId, FridayRateLimitPolicy> {
  const map = new Map<FridayRateLimitPolicyId, FridayRateLimitPolicy>();
  for (const policy of DEFAULT_POLICIES) {
    const override = overrides?.[policy.id];
    map.set(policy.id, override ? { ...policy, ...override } : policy);
  }
  return map;
}

function computeWindowStart(nowIso: string, windowMs: number): string {
  const nowMs = new Date(nowIso).getTime();
  const windowStart = nowMs - (nowMs % windowMs);
  return new Date(windowStart).toISOString();
}

function computeResetAt(windowStart: string, windowMs: number): string {
  const resetMs = new Date(windowStart).getTime() + windowMs;
  return new Date(resetMs).toISOString();
}

// ─── Loopback detection ───

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (LOOPBACK_ADDRESSES.has(ip)) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

// ─── Default lockout configuration ───

const DEFAULT_AUTH_LOCKOUT_CONFIG: FridayAuthLockoutConfig = {
  maxAttempts: 10,
  windowMs: 60_000,
  lockoutMs: 300_000,
  maxLockoutLevel: 4,
  // Secure default: loopback addresses are NOT exempt unless explicitly enabled.
  exemptLoopback: process.env.FRIDAY_RATE_LIMIT_LOOPBACK_EXEMPT === "true",
};

// ─── Pruning constants ───

const PRUNE_INTERVAL_MS = 60_000;

// ─── In-memory lockout state ───

interface LockoutEntry {
  failures: Array<{ ts: number }>;
  lockoutUntil: number | null;
  lockoutLevel: number;
}

// ─── Factory ───

export function createFridayRateLimitService(
  deps: CreateFridayRateLimitServiceDeps,
): FridayRateLimitService {
  const policies = buildPolicyMap(deps.policyOverrides);
  const counterRepo = createFridayRateLimitCounterRepository();
  const lockoutConfig: FridayAuthLockoutConfig = {
    ...DEFAULT_AUTH_LOCKOUT_CONFIG,
    ...deps.authLockoutConfig,
  };
  const exemptLoopback = lockoutConfig.exemptLoopback ?? false;

  // Principal lockout map: keyed by `{scope}:{principalKey}`
  const lockoutMap = new Map<string, LockoutEntry>();
  // IP lockout map: keyed by normalized IP
  const ipLockoutMap = new Map<string, LockoutEntry>();

  // Periodic pruning timer
  const pruneTimer = setInterval(() => maybePrune(), PRUNE_INTERVAL_MS);
  if (pruneTimer.unref) {
    pruneTimer.unref();
  }

  // ─── Internal helpers ───

  function normalizeScope(scope?: string): string {
    return (scope ?? AUTH_LOCKOUT_SCOPE_SHARED_SECRET).trim() || AUTH_LOCKOUT_SCOPE_SHARED_SECRET;
  }

  function normalizeIp(ip: string | undefined): string {
    return (ip ?? "").trim() || "unknown";
  }

  function resolvePrincipalKey(principalKey: string, scope?: string): string {
    return `${normalizeScope(scope)}:${principalKey}`;
  }

  function isIpExempt(ip: string): boolean {
    return exemptLoopback && isLoopbackAddress(ip);
  }

  function getLockoutEntry(map: Map<string, LockoutEntry>, key: string): LockoutEntry {
    let entry = map.get(key);
    if (!entry) {
      entry = { failures: [], lockoutUntil: null, lockoutLevel: 0 };
      map.set(key, entry);
    }
    return entry;
  }

  function pruneExpiredFailures(entry: LockoutEntry, nowMs: number): void {
    const windowStart = nowMs - lockoutConfig.windowMs;
    entry.failures = entry.failures.filter((f) => f.ts > windowStart);
  }

  function buildLockoutStatus(entry: LockoutEntry, nowMs: number): FridayAuthLockoutStatus {
    if (entry.lockoutUntil && nowMs < entry.lockoutUntil) {
      const retryAfterMs = entry.lockoutUntil - nowMs;
      return {
        locked: true,
        retryAfter: new Date(entry.lockoutUntil).toISOString(),
        retryAfterMs,
        failureCount: entry.failures.length,
        lockoutLevel: entry.lockoutLevel,
      };
    }
    return {
      locked: false,
      failureCount: entry.failures.length,
      lockoutLevel: entry.lockoutLevel,
    };
  }

  function checkLockoutOnMap(
    map: Map<string, LockoutEntry>,
    key: string,
  ): FridayAuthLockoutStatus {
    const entry = getLockoutEntry(map, key);
    const nowMs = new Date(deps.nowIso()).getTime();

    // If lockout has expired, clear it (but keep the level for escalation)
    if (entry.lockoutUntil && nowMs >= entry.lockoutUntil) {
      entry.lockoutUntil = null;
    }

    pruneExpiredFailures(entry, nowMs);
    return buildLockoutStatus(entry, nowMs);
  }

  function recordFailureOnMap(
    map: Map<string, LockoutEntry>,
    key: string,
  ): FridayAuthLockoutStatus {
    const entry = getLockoutEntry(map, key);
    const nowMs = new Date(deps.nowIso()).getTime();

    // If already locked and lockout not expired, just return status
    if (entry.lockoutUntil && nowMs < entry.lockoutUntil) {
      return buildLockoutStatus(entry, nowMs);
    }

    // If lockout expired, clear it before recording
    if (entry.lockoutUntil && nowMs >= entry.lockoutUntil) {
      entry.lockoutUntil = null;
    }

    // Prune old failures outside the window
    pruneExpiredFailures(entry, nowMs);

    // Record this failure
    entry.failures.push({ ts: nowMs });

    // Check if threshold reached
    if (entry.failures.length >= lockoutConfig.maxAttempts) {
      // Escalate: lockoutMs * 2^level, capped at maxLockoutLevel
      const level = Math.min(entry.lockoutLevel, lockoutConfig.maxLockoutLevel);
      const duration = lockoutConfig.lockoutMs * Math.pow(2, level);
      entry.lockoutUntil = nowMs + duration;
      // Cap the stored level so it doesn't grow unboundedly
      entry.lockoutLevel = Math.min(entry.lockoutLevel + 1, lockoutConfig.maxLockoutLevel);
      // Clear failures for the next window after lockout
      entry.failures = [];
    }

    return buildLockoutStatus(entry, nowMs);
  }

  function resetOnMap(map: Map<string, LockoutEntry>, key: string): void {
    map.delete(key);
  }

  /** Prune entries from a lockout map whose lockout has expired and have no recent failures. */
  function pruneMap(map: Map<string, LockoutEntry>): void {
    const nowMs = new Date(deps.nowIso()).getTime();
    for (const [key, entry] of map) {
      // Keep entries that are still locked
      if (entry.lockoutUntil && nowMs < entry.lockoutUntil) continue;
      // Prune failures outside window
      const windowStart = nowMs - lockoutConfig.windowMs;
      entry.failures = entry.failures.filter((f) => f.ts > windowStart);
      if (entry.failures.length === 0 && (!entry.lockoutUntil || nowMs >= entry.lockoutUntil)) {
        map.delete(key);
      }
    }
  }

  function maybePrune(): void {
    pruneMap(lockoutMap);
    pruneMap(ipLockoutMap);
  }

  // ─── Policy-based rate limiting helpers ───

  function buildSnapshotDecision(
    policy: FridayRateLimitPolicy,
    hitCount: number,
    windowStart: string,
  ): FridayRateLimitDecision {
    const remaining = Math.max(0, policy.maxHits - hitCount);
    return {
      allowed: hitCount < policy.maxHits,
      policyId: policy.id,
      limit: policy.maxHits,
      remaining,
      resetAt: computeResetAt(windowStart, policy.windowMs),
    };
  }

  function buildIncrementDecision(
    policy: FridayRateLimitPolicy,
    hitCount: number,
    windowStart: string,
    incremented: boolean,
  ): FridayRateLimitDecision {
    const remaining = Math.max(0, policy.maxHits - hitCount);
    return {
      allowed: incremented,
      policyId: policy.id,
      limit: policy.maxHits,
      remaining,
      resetAt: computeResetAt(windowStart, policy.windowMs),
    };
  }

  return {
    getPolicy(policyId) {
      return policies.get(policyId);
    },

    check(policyId, key) {
      // Advisory only — uses a read-only snapshot that may straddle a
      // window boundary relative to a subsequent increment() call.
      // For enforcement, always use increment() which is atomic.
      const policy = policies.get(policyId);
      if (!policy) {
        return {
          allowed: true,
          policyId,
          limit: 0,
          remaining: 0,
          resetAt: deps.nowIso(),
        };
      }
      const now = deps.nowIso();
      const windowStart = computeWindowStart(now, policy.windowMs);
      const bucketKey = `${policyId}:${key}`;
      const hitCount = deps.db.withReadConnection((db) =>
        counterRepo.getCount(db, bucketKey, windowStart),
      );
      return buildSnapshotDecision(policy, hitCount, windowStart);
    },

    increment(policyId, key) {
      // Authoritative check-and-increment: reads count, checks limit,
      // and increments in one write transaction, avoiding window
      // boundary drift between separate check() and increment() calls.
      const policy = policies.get(policyId);
      if (!policy) {
        return {
          allowed: true,
          policyId,
          limit: 0,
          remaining: 0,
          resetAt: deps.nowIso(),
        };
      }
      const now = deps.nowIso();
      const windowStart = computeWindowStart(now, policy.windowMs);
      const bucketKey = `${policyId}:${key}`;
      const result = deps.db.withWriteTransaction((db) => {
        const currentCount = counterRepo.getCount(db, bucketKey, windowStart);
        if (currentCount >= policy.maxHits) {
          return { hitCount: currentCount, incremented: false };
        }
        const hitCount = counterRepo.increment(db, bucketKey, windowStart, now);
        return { hitCount, incremented: true };
      });
      return buildIncrementDecision(policy, result.hitCount, windowStart, result.incremented);
    },

    // ─── Principal lockout methods (scope-partitioned) ───

    checkAuthLockout(principalKey: string, scope?: string): FridayAuthLockoutStatus {
      const key = resolvePrincipalKey(principalKey, scope);
      return checkLockoutOnMap(lockoutMap, key);
    },

    recordAuthFailure(principalKey: string, scope?: string): FridayAuthLockoutStatus {
      const key = resolvePrincipalKey(principalKey, scope);
      return recordFailureOnMap(lockoutMap, key);
    },

    resetAuthFailures(principalKey: string, scope?: string): void {
      const key = resolvePrincipalKey(principalKey, scope);
      resetOnMap(lockoutMap, key);
    },

    // ─── IP lockout methods ───

    checkIpLockout(ip: string | undefined): FridayAuthLockoutStatus {
      const normalizedIp = normalizeIp(ip);
      if (isIpExempt(normalizedIp)) {
        return { locked: false, failureCount: 0, lockoutLevel: 0 };
      }
      return checkLockoutOnMap(ipLockoutMap, normalizedIp);
    },

    recordIpFailure(ip: string | undefined): FridayAuthLockoutStatus {
      const normalizedIp = normalizeIp(ip);
      if (isIpExempt(normalizedIp)) {
        return { locked: false, failureCount: 0, lockoutLevel: 0 };
      }
      return recordFailureOnMap(ipLockoutMap, normalizedIp);
    },

    resetIpFailures(ip: string | undefined): void {
      const normalizedIp = normalizeIp(ip);
      if (isIpExempt(normalizedIp)) return;
      resetOnMap(ipLockoutMap, normalizedIp);
    },

    // ─── Dispose ───

    dispose(): void {
      clearInterval(pruneTimer);
      lockoutMap.clear();
      ipLockoutMap.clear();
    },
  };
}
