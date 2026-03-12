export const settingsKeys = {
  all: ["settings"] as const,

  // Providers
  providers: () => [...settingsKeys.all, "providers"] as const,
  provider: (providerId: string) =>
    [...settingsKeys.all, "provider", providerId] as const,
  routing: () => [...settingsKeys.all, "routing"] as const,

  // Usage
  usage: (query?: { from?: string; to?: string; groupBy?: string }) =>
    [...settingsKeys.all, "usage", query ?? {}] as const,
  budget: () => [...settingsKeys.all, "budget"] as const,

  // Security
  security: () => [...settingsKeys.all, "security"] as const,

  // Fleet
  fleetOverview: () => [...settingsKeys.all, "fleet-overview"] as const,
  fleetSatellites: (filters?: Record<string, unknown>) =>
    [...settingsKeys.all, "fleet-satellites", filters ?? {}] as const,
  fleetSatellite: (satelliteId: string) =>
    [...settingsKeys.all, "fleet-satellite", satelliteId] as const,

  // Health / General
  health: () => [...settingsKeys.all, "health"] as const,
  me: () => [...settingsKeys.all, "me"] as const,
};
