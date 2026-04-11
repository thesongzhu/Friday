import { apiClient } from "./client";

// ─── Types matching backend response shapes ───

export interface DiscoveryStatus {
  enabled: boolean;
  hasCatalog: boolean;
  catalogId: string | null;
  lastScanAt: string | null;
  programCount: number;
}

export interface DiscoveryScanCatalog {
  id: string;
  platform: string;
  programCount: number;
  generatedAt: string;
  scanDurationMs: number;
  scanErrors: number;
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

// ─── Helper: unwrap route envelope if present ───

function unwrap<T>(res: unknown): T {
  if (res && typeof res === "object" && "body" in res && "status" in res) {
    return (res as { body: T }).body;
  }
  return res as T;
}

// ─── API client ───

export const discoveryApi = {
  async getStatus(): Promise<DiscoveryStatus> {
    const res = await apiClient.get<unknown>("/v1/discovery/status");
    return unwrap<DiscoveryStatus>(res);
  },

  async scan(): Promise<{ catalog: DiscoveryScanCatalog }> {
    const res = await apiClient.post<Record<string, never>, unknown>("/v1/discovery/scan", {});
    return unwrap<{ catalog: DiscoveryScanCatalog }>(res);
  },

  async getPrograms(params?: {
    category?: string;
    q?: string;
    cli?: boolean;
  }): Promise<{ programs: DiscoveredProgram[]; total: number; catalogId: string }> {
    const query = new URLSearchParams();
    if (params?.category) query.set("category", params.category);
    if (params?.q) query.set("q", params.q);
    if (params?.cli !== undefined) query.set("cli", String(params.cli));
    const qs = query.toString();
    const res = await apiClient.get<unknown>(`/v1/discovery/programs${qs ? `?${qs}` : ""}`);
    return unwrap<{ programs: DiscoveredProgram[]; total: number; catalogId: string }>(res);
  },

  async getRecommendations(params?: {
    minConfidence?: number;
  }): Promise<{ recommendations: IntegrationRecommendation[]; unmatched: number }> {
    const query = new URLSearchParams();
    if (params?.minConfidence !== undefined) query.set("minConfidence", String(params.minConfidence));
    const qs = query.toString();
    const res = await apiClient.get<unknown>(`/v1/discovery/recommendations${qs ? `?${qs}` : ""}`);
    return unwrap<{ recommendations: IntegrationRecommendation[]; unmatched: number }>(res);
  },
};
