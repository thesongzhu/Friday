import type {
  FridayBriefTtsProvider,
  FridayBriefTtsRegistry,
} from "./friday-brief-tts.types.js";
import type { FridayBriefTtsProviderKind } from "../friday-brief.types.js";

export function createFridayBriefTtsRegistry(
  providers: readonly FridayBriefTtsProvider[],
): FridayBriefTtsRegistry {
  const map = new Map<FridayBriefTtsProviderKind, FridayBriefTtsProvider>();
  for (const p of providers) map.set(p.kind, p);
  return {
    get(kind) {
      return map.get(kind);
    },
    select(preferred) {
      const primary = map.get(preferred);
      if (primary && primary.isConfigured()) return primary;
      for (const provider of map.values()) {
        if (provider.isConfigured()) return provider;
      }
      return undefined;
    },
  };
}
