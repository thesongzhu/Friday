import { FridayDomainError } from "#errors";
import type {
  FridayModelRoutingConfig,
  FridayProviderAttempt,
  FridayProviderAttemptReason,
  FridayProviderProfile,
  FridayResolvedProviderRoute,
} from "../model/friday-provider.types.js";

// ─── Key redaction ───

/**
 * Redacts strings that look like API keys from error messages.
 * Matches patterns: sk-*, key-*, pk-*, rk-*, xai-*, gsk_*, and generic long hex/base64 tokens.
 */
const KEY_PATTERNS = [
  // Known prefixes: sk-xxx, key-xxx, pk-xxx, rk-xxx, xai-xxx, gsk_xxx, etc.
  /\b(sk-|key-|pk-|rk-|xai-|gsk_|aip-|whsk-|sess-|ssm-)[A-Za-z0-9_-]{8,}\b/g,
  // Generic long tokens (40+ alphanumeric chars that look like secrets)
  /\b[A-Za-z0-9/+]{40,}={0,2}\b/g,
];

function redactKeyMaterial(message: string): string {
  let result = message;
  for (const pattern of KEY_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ─── Cooldown tracking ───

/** How long a provider stays in cooldown after a transient failure (ms). */
const PROVIDER_COOLDOWN_MS = 120_000;

/** Patterns indicating transient/rate-limit errors that warrant provider cooldown. */
const TRANSIENT_ERROR_PATTERNS = [
  "429",
  "rate_limit",
  "quota",
  "capacity",
  "throttl",
  "timeout",
  "timed out",
  "ETIMEDOUT",
  "ECONNRESET",
  "socket hang up",
];

/**
 * Extracts a classifiable text string from an unknown thrown value.
 *
 * Handles:
 * - `Error` instances → `message`
 * - Objects with `status`, `code`, or `message` properties → concatenated
 * - Primitives → `String(value)`
 */
function extractErrorText(err: unknown): string {
  if (err instanceof Error) {
    let text = err.message;
    const code = (err as any).code;
    const status = (err as any).status;
    if (code !== undefined) text += ` code=${code}`;
    if (status !== undefined) text += ` status=${status}`;
    return text;
  }

  if (err !== null && typeof err === "object") {
    const parts: string[] = [];
    const obj = err as Record<string, unknown>;
    if ("status" in obj) parts.push(String(obj.status));
    if ("code" in obj) parts.push(String(obj.code));
    if ("message" in obj) parts.push(String(obj.message));
    if (parts.length > 0) return parts.join(" ");
  }

  return String(err);
}

/** Returns true if the error text looks like a transient/rate-limit failure. */
function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** OC-001: Classify a provider error into structured reason/status/code. */
function classifyProviderError(err: unknown): {
  reason: FridayProviderAttemptReason;
  status?: number;
  code?: string;
} {
  const text = extractErrorText(err);
  const status = typeof (err as any)?.status === "number" ? (err as any).status as number : undefined;
  const code = typeof (err as any)?.code === "string" ? (err as any).code as string : undefined;

  if (isTransientError(text)) {
    return { reason: "transient", status, code };
  }
  if (/\b(401|403|unauthorized|forbidden)\b/i.test(text)) {
    return { reason: "auth", status: status ?? (text.includes("401") ? 401 : 403), code };
  }
  if (/model.*(not found|unavailable|does not exist)/i.test(text)) {
    return { reason: "model_unavailable", status, code };
  }
  if (/\b(timeout|ETIMEDOUT|timed out|deadline exceeded)\b/i.test(text)) {
    return { reason: "timeout", status, code };
  }
  return { reason: "unknown", status, code };
}

function normalizeModelId(input: string): string {
  return input.trim().toLowerCase().replace(/_/g, "-").replace(/-+/g, "-");
}

function isNumericSuffixAliasMatch(
  requestedModel: string,
  supportedModel: string,
): boolean {
  if (!supportedModel.startsWith(`${requestedModel}-`)) {
    return false;
  }
  const suffix = supportedModel.slice(requestedModel.length + 1);
  return /^\d[\d-]*$/.test(suffix);
}

function resolveRequestedModelForProvider(
  requestedModel: string,
  supportedModels: string[],
): string | null {
  if (!requestedModel.trim()) return null;
  if (supportedModels.length === 0) return null;

  const req = normalizeModelId(requestedModel);
  const normalized = supportedModels.map((raw) => ({
    raw,
    norm: normalizeModelId(raw),
  }));

  const exact = normalized.find((model) => model.norm === req);
  if (exact) return exact.raw;

  const alias = normalized.find((model) => isNumericSuffixAliasMatch(req, model.norm));
  if (alias) return alias.raw;

  return null;
}

function resolveImplicitModelForProvider(params: {
  routingDefaultModel?: string;
  provider: FridayProviderProfile;
}): string {
  const { routingDefaultModel, provider } = params;
  const supportedModels = provider.config.supportedModels ?? [];
  const requested = routingDefaultModel?.trim();

  if (requested) {
    const matched = resolveRequestedModelForProvider(requested, supportedModels);
    if (matched) {
      return matched;
    }
  }

  if (
    provider.defaultModel &&
    supportedModels.includes(provider.defaultModel)
  ) {
    return provider.defaultModel;
  }

  return supportedModels[0] ?? provider.defaultModel ?? requested ?? "";
}

// ─── Fallback interface ───

export interface FridayProviderFallback {
  /**
   * Resolves an ordered list of candidate routes from routing config.
   * Deduplicates by provider id.
   */
  resolveCandidates(params: {
    routing: FridayModelRoutingConfig;
    providers: FridayProviderProfile[];
    requestedModel?: string;
  }): FridayResolvedProviderRoute[];

  /**
   * Runs a function against each candidate in order, returning on first success.
   * Tracks all attempts. Skips providers in cooldown.
   */
  runWithFallback<T>(params: {
    candidates: FridayResolvedProviderRoute[];
    run: (route: FridayResolvedProviderRoute) => Promise<T>;
  }): Promise<{
    result: T;
    route: FridayResolvedProviderRoute;
    attempts: FridayProviderAttempt[];
  }>;

  /**
   * Returns true if a provider is currently in cooldown (recently failed).
   */
  isInCooldown(providerId: string): boolean;
}

// ─── Factory options ───

export interface FridayProviderFallbackOptions {
  /** Custom clock function for deterministic tests. Defaults to `() => Date.now()`. */
  nowMs?: () => number;
  /** Cooldown duration in milliseconds. Defaults to 120 000 (2 minutes). */
  cooldownMs?: number;
}

// ─── Factory ───

export function createFridayProviderFallback(
  opts?: FridayProviderFallbackOptions,
): FridayProviderFallback {
  const nowMs = opts?.nowMs ?? (() => Date.now());
  const cooldownMs = opts?.cooldownMs ?? PROVIDER_COOLDOWN_MS;

  // Track provider failure timestamps for cooldown
  const cooldownMap = new Map<string, number>();

  function isInCooldown(providerId: string): boolean {
    const failedAt = cooldownMap.get(providerId);
    if (failedAt === undefined) return false;
    if (nowMs() - failedAt > cooldownMs) {
      cooldownMap.delete(providerId);
      return false;
    }
    return true;
  }

  function recordFailure(providerId: string): void {
    cooldownMap.set(providerId, nowMs());
  }

  return {
    resolveCandidates(params) {
      const { routing, providers, requestedModel } = params;
      const providerMap = new Map<string, FridayProviderProfile>();
      for (const p of providers) {
        providerMap.set(p.id, p);
      }

      // Build ordered provider id list: default + fallbacks, deduped
      const orderedIds: string[] = [];
      const seen = new Set<string>();

      const addId = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        orderedIds.push(id);
      };

      addId(routing.defaultProviderId);
      for (const fid of routing.fallbackProviderIds) {
        addId(fid);
      }

      // Build candidate routes
      const candidates: FridayResolvedProviderRoute[] = [];
      for (const id of orderedIds) {
        const provider = providerMap.get(id);
        if (!provider || !provider.enabled) continue;

        const requested = requestedModel?.trim();
        if (requested) {
          const matched = resolveRequestedModelForProvider(
            requested,
            provider.config.supportedModels,
          );
          if (!matched) continue;
          candidates.push({ provider, model: matched });
          continue;
        }

        const model = resolveImplicitModelForProvider({
          routingDefaultModel: routing.defaultModel,
          provider,
        });

        candidates.push({ provider, model });
      }

      return candidates;
    },

    async runWithFallback(params) {
      const { candidates, run } = params;
      const attempts: FridayProviderAttempt[] = [];
      let lastError: unknown;

      // Partition candidates: non-cooled-down first, cooled-down as last resort
      const ready: FridayResolvedProviderRoute[] = [];
      const cooledDown: FridayResolvedProviderRoute[] = [];
      for (const c of candidates) {
        if (isInCooldown(c.provider.id)) {
          cooledDown.push(c);
        } else {
          ready.push(c);
        }
      }
      const orderedCandidates = [...ready, ...cooledDown];

      for (const candidate of orderedCandidates) {
        try {
          const result = await run(candidate);
          return { result, route: candidate, attempts };
        } catch (err) {
          lastError = err;
          const rawMessage = extractErrorText(err);
          const classified = classifyProviderError(err);
          // Apply cooldown for transient errors, auth failures, and
          // model-unavailable errors. Without cooldown on persistent
          // failures (e.g. revoked API key), every LLM call would
          // attempt the broken provider before falling back, adding
          // unnecessary latency to every request.
          if (
            classified.reason === "transient" ||
            classified.reason === "auth" ||
            classified.reason === "model_unavailable" ||
            classified.reason === "timeout"
          ) {
            recordFailure(candidate.provider.id);
          }
          attempts.push({
            providerId: candidate.provider.id,
            providerKind: candidate.provider.kind,
            model: candidate.model,
            error: redactKeyMaterial(rawMessage),
            reason: classified.reason,
            status: classified.status,
            code: classified.code,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // All candidates exhausted
      const summary =
        attempts.length > 0
          ? attempts
              .map(
                (a) => `${a.providerKind}/${a.model}: ${a.error ?? "unknown"}`,
              )
              .join(" | ")
          : "no candidates available";

      throw new FridayDomainError(
        "PROVIDER_ERROR",
        `All providers failed (${String(attempts.length)}): ${summary}`,
        { httpStatus: 502, cause: lastError instanceof Error ? lastError : undefined },
      );
    },

    isInCooldown(providerId) {
      return isInCooldown(providerId);
    },
  };
}
