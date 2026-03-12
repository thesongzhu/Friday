// Types
export type {
  FridayDiscoveryPlatform,
  FridayProgramCategory,
  FridayDiscoveredProgram,
  FridayProgramCatalog,
  FridayIntegrationPath,
  FridayIntegrationRecommendation,
  FridayRecommendationResult,
  FridayDiscoveryFilterOptions,
  FridayDiscoveryPolicy,
  FridayProgramScanner,
  FridayProgramDiscoveryService,
} from "./friday-program-discovery.types.js";

export { DEFAULT_DISCOVERY_POLICY } from "./friday-program-discovery.types.js";

// Scanners
export { createDarwinProgramScanner } from "./friday-program-scanner-darwin.js";
export { createWin32ProgramScanner } from "./friday-program-scanner-win32.js";
export { createLinuxProgramScanner } from "./friday-program-scanner-linux.js";

// Recommendation engine
export { generateRecommendations } from "./friday-integration-recommendation-engine.js";

// Discovery service
export { createFridayProgramDiscoveryService } from "./friday-program-discovery-service.js";
export type { CreateFridayProgramDiscoveryServiceDeps } from "./friday-program-discovery-service.js";
