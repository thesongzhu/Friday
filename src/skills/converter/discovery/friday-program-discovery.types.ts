/**
 * Local Program Discovery & Integration Recommendation — Types.
 *
 * Canonical types for the program discovery system: OS-specific scanners,
 * normalized catalog schema, integration recommendation mapping, and
 * discovery policy controls.
 */

// ─── Platform ───

export type FridayDiscoveryPlatform = "darwin" | "win32" | "linux";

// ─── Discovered Program ───

export type FridayProgramCategory =
  | "browser"
  | "editor"
  | "terminal"
  | "communication"
  | "media"
  | "productivity"
  | "development"
  | "database"
  | "cloud"
  | "security"
  | "automation"
  | "design"
  | "finance"
  | "system"
  | "other";

export interface FridayDiscoveredProgram {
  /** Stable identifier (bundle ID on macOS, registry key on Windows, desktop file on Linux). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Version string (if detected). */
  readonly version?: string;
  /** Absolute path to the executable. */
  readonly executablePath: string;
  /** Platform-specific bundle ID / package name. */
  readonly bundleId?: string;
  /** Detected category. */
  readonly category: FridayProgramCategory;
  /** Platform the program was discovered on. */
  readonly platform: FridayDiscoveryPlatform;
  /** Whether the program is a CLI tool (vs GUI application). */
  readonly isCli: boolean;
  /** Additional metadata (publisher, description, etc.). */
  readonly metadata: Readonly<Record<string, string>>;
  /** When this program record was last scanned. */
  readonly discoveredAt: string;
}

// ─── Program Catalog ───

export interface FridayProgramCatalog {
  /** Unique catalog snapshot identifier. */
  readonly id: string;
  /** Platform this catalog was built on. */
  readonly platform: FridayDiscoveryPlatform;
  /** All discovered programs. */
  readonly programs: readonly FridayDiscoveredProgram[];
  /** When the catalog was generated. */
  readonly generatedAt: string;
  /** Duration of the scan in milliseconds. */
  readonly scanDurationMs: number;
  /** Number of errors encountered during scanning. */
  readonly scanErrors: number;
}

// ─── Integration Path ───

export type FridayIntegrationPath =
  | "code-repo"
  | "rest-api"
  | "web-flow"
  | "desktop-recording"
  | "desktop-control";

// ─── Recommendation ───

export interface FridayIntegrationRecommendation {
  /** The program this recommendation targets. */
  readonly programId: string;
  /** Human-readable program name. */
  readonly programName: string;
  /** Recommended integration path. */
  readonly integrationPath: FridayIntegrationPath;
  /** Confidence score (0.0–1.0). */
  readonly confidence: number;
  /** Human-readable rationale explaining why this path was recommended. */
  readonly rationale: string;
  /** Specific converter or strategy identifier. */
  readonly converterHint?: string;
  /** Additional context for the integration. */
  readonly context: Readonly<Record<string, string>>;
}

// ─── Recommendation Result ───

export interface FridayRecommendationResult {
  /** All recommendations, sorted by confidence descending. */
  readonly recommendations: readonly FridayIntegrationRecommendation[];
  /** Number of programs that had no viable recommendation. */
  readonly unmatched: number;
  /** When the recommendations were generated. */
  readonly generatedAt: string;
}

// ─── Filter Options ───

export interface FridayDiscoveryFilterOptions {
  /** Filter by program category. */
  readonly category?: FridayProgramCategory;
  /** Filter by minimum recommendation confidence. */
  readonly minConfidence?: number;
  /** Filter by integration path. */
  readonly integrationPath?: FridayIntegrationPath;
  /** Search query (matches name or id). */
  readonly query?: string;
}

// ─── Discovery Policy ───

export interface FridayDiscoveryPolicy {
  /** Whether discovery is enabled. */
  readonly enabled: boolean;
  /** Whether scheduled refresh is enabled. */
  readonly scheduledRefreshEnabled: boolean;
  /** Refresh interval in milliseconds (default: 24h). */
  readonly refreshIntervalMs: number;
  /** Paths excluded from scanning. */
  readonly excludedPaths: readonly string[];
  /** Program IDs excluded from results. */
  readonly excludedProgramIds: readonly string[];
  /** Whether to redact sensitive host details (paths, usernames). */
  readonly redactSensitiveDetails: boolean;
}

export const DEFAULT_DISCOVERY_POLICY: FridayDiscoveryPolicy = {
  enabled: true,
  scheduledRefreshEnabled: false,
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  excludedPaths: [],
  excludedProgramIds: [],
  redactSensitiveDetails: false,
};

// ─── Scanner Interface ───

export interface FridayProgramScanner {
  /** Platform this scanner targets. */
  readonly platform: FridayDiscoveryPlatform;
  /** Scan for installed programs. */
  scan(policy: FridayDiscoveryPolicy): Promise<FridayDiscoveredProgram[]>;
}

// ─── Discovery Service Interface ───

export interface FridayProgramDiscoveryService {
  /** Run a full discovery scan and return the catalog. */
  discover(): Promise<FridayProgramCatalog>;
  /** Get the last cached catalog (or null if never scanned). */
  getCachedCatalog(): FridayProgramCatalog | null;
  /** Get recommendations for all discovered programs. */
  recommend(filter?: FridayDiscoveryFilterOptions): Promise<FridayRecommendationResult>;
  /** Get the current discovery policy. */
  getPolicy(): FridayDiscoveryPolicy;
  /** Update the discovery policy. */
  setPolicy(policy: Partial<FridayDiscoveryPolicy>): void;
  /** Check whether discovery is enabled by policy. */
  isEnabled(): boolean;
}
