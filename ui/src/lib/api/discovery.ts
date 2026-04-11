import { apiClient } from "./client";

// ─── Types matching backend response shapes ───

export interface DiscoveryStatus {
  enabled: boolean;
  hasCatalog: boolean;
  catalogId: string | null;
  lastScanAt: string | null;
  programCount: number;
}

export interface DiscoveryScanResult {
  catalog: {
    id: string;
    platform: string;
    programCount: number;
    generatedAt: string;
    scanDurationMs: number;
    scanErrors: number;
  };
}

export type ProgramCategory =
  | "browser" | "editor" | "terminal" | "communication" | "media"
  | "productivity" | "development" | "database" | "cloud" | "security"
  | "automation" | "design" | "finance" | "system" | "other";

export interface DiscoveredProgram {
  id: string;
  name: string;
  version?: string;
  executablePath: string;
  bundleId?: string;
  category: ProgramCategory;
  platform: string;
  isCli: boolean;
  metadata: Record<string, string>;
  discoveredAt: string;
}

export type IntegrationPath = "code-repo" | "rest-api" | "web-flow" | "desktop-recording" | "desktop-control";

export interface IntegrationRecommendation {
  programId: string;
  programName: string;
  integrationPath: IntegrationPath;
  confidence: number;
  rationale: string;
  converterHint?: string;
  context: Record<string, string>;
}

// ─── API client ───

export const discoveryApi = {
  async getStatus(): Promise<DiscoveryStatus> {
    return apiClient.get<DiscoveryStatus>("/v1/discovery/status");
  },

  async scan(): Promise<DiscoveryScanResult> {
    return apiClient.post<Record<string, never>, DiscoveryScanResult>("/v1/discovery/scan", {});
  },

  async getPrograms(params?: {
    category?: string;
    q?: string;
    cli?: boolean;
  }): Promise<{ programs: DiscoveredProgram[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.category) query.set("category", params.category);
    if (params?.q) query.set("q", params.q);
    if (params?.cli !== undefined) query.set("cli", String(params.cli));
    const qs = query.toString();
    return apiClient.get(`/v1/discovery/programs${qs ? `?${qs}` : ""}`);
  },

  async getRecommendations(params?: {
    minConfidence?: number;
  }): Promise<{ recommendations: IntegrationRecommendation[]; unmatched: number }> {
    const query = new URLSearchParams();
    if (params?.minConfidence !== undefined) query.set("minConfidence", String(params.minConfidence));
    const qs = query.toString();
    return apiClient.get(`/v1/discovery/recommendations${qs ? `?${qs}` : ""}`);
  },
};
