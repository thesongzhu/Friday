import type {
  FridayModelRoutingConfig,
  FridayProviderProfile,
} from "../model/friday-provider.types.js";
import { normalizeFridayModelRoutingConfig } from "../model/friday-provider.types.js";

export function resolveFridayRoutingStabilityWarning(input: {
  routing: FridayModelRoutingConfig;
  providers: FridayProviderProfile[];
}): string | null {
  const routing = normalizeFridayModelRoutingConfig(input.routing);
  if (!routing.defaultProviderId || routing.fallbackProviderIds.length > 0) {
    return null;
  }

  const alternateProviders = input.providers.filter((provider) =>
    provider.id !== routing.defaultProviderId
    && provider.enabled
    && provider.config.validation?.status === "ok",
  );

  if (alternateProviders.length === 0) {
    return null;
  }

  const providerNames = alternateProviders
    .map((provider) => `${provider.name} (${provider.id})`)
    .join(", ");

  return [
    `Default provider "${routing.defaultProviderId}" has no fallback providers configured.`,
    `Validated enabled alternatives are available: ${providerNames}.`,
    "Live runs may fail hard if the default provider is temporarily unavailable.",
  ].join(" ");
}
