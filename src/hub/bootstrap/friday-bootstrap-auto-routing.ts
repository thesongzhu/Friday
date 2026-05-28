import type { FridayProviderKind } from "../../providers/model/friday-provider.types.js";

export interface FridayBootstrapRouteCandidate {
  kind: FridayProviderKind;
  id: string;
}

export interface FridayBootstrapAutoRoutingDecision {
  defaultProviderId: string;
  defaultModel: string;
  fallbackProviderIds: string[];
}

/**
 * Decide the boot-time default route from auto-detected / existing providers WITHOUT
 * making a hidden choice on the user's behalf.
 *
 * Locked product decision: multiple keys/providers require explicit user choice; Friday
 * must not silently pick a default provider or silently inject fallback providers.
 *
 * - Exactly one candidate: select it (single, unambiguous — preserves single-key BYOK).
 *   No fallback providers are injected.
 * - Two or more candidates: return `null`. Friday must NOT auto-pick a default by a hidden
 *   priority order, nor fan out fallbacks. The user chooses explicitly; until then
 *   `resolveRoute` surfaces `PROVIDER_NO_ROUTING`.
 * - No candidates: `null`.
 */
export function resolveFridayBootstrapAutoRouting(
  candidates: ReadonlyArray<FridayBootstrapRouteCandidate>,
  resolveDefaultModel: (candidate: FridayBootstrapRouteCandidate) => string,
): FridayBootstrapAutoRoutingDecision | null {
  if (candidates.length !== 1) {
    return null;
  }

  const sole = candidates[0]!;
  return {
    defaultProviderId: sole.id,
    defaultModel: resolveDefaultModel(sole),
    fallbackProviderIds: [],
  };
}

/**
 * Collect the full set of routing candidates available after env auto-detection: the
 * UNION of providers newly detected this boot and providers already enabled in the DB,
 * deduped by id.
 *
 * This count must reflect EVERY available provider, not just the freshly-detected ones.
 * A "detected OR existing" choice would undercount on a later boot — e.g. 2 providers
 * already configured + 1 new env key would yield a single-element detected list and
 * silently auto-select the new provider as default among three. The union keeps the
 * "two or more providers ⇒ explicit user choice" invariant correct across boots.
 */
export function collectFridayBootstrapRouteCandidates(input: {
  detected: ReadonlyArray<FridayBootstrapRouteCandidate>;
  existingEnabled: ReadonlyArray<FridayBootstrapRouteCandidate>;
}): FridayBootstrapRouteCandidate[] {
  const byId = new Map<string, FridayBootstrapRouteCandidate>();
  for (const candidate of [...input.detected, ...input.existingEnabled]) {
    if (!byId.has(candidate.id)) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
}
