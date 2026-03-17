import type {
  FridayModelRoutingConfig,
  FridayProviderProfile,
} from "../model/friday-provider.types.js";

export function resolveFridayRoutingStabilityWarning(input: {
  routing: FridayModelRoutingConfig;
  providers: FridayProviderProfile[];
}): string | null {
  if (!input.routing.defaultProviderId || input.routing.fallbackProviderIds.length > 0) {
    return null;
  }

  const alternateProviders = input.providers.filter((provider) =>
    provider.id !== input.routing.defaultProviderId
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
    `Default provider "${input.routing.defaultProviderId}" has no fallback providers configured.`,
    `Validated enabled alternatives are available: ${providerNames}.`,
    "Live runs may fail hard if the default provider is temporarily unavailable.",
  ].join(" ");
}
