import { apiClient } from "./client";

// ─── Types ───

export type LocalSkillSourceTool = "claude-code" | "cursor" | "n8n" | "codex" | "clawdbot" | "friday" | "unknown";

export interface LocalSkillScanItem {
  id: string;
  name: string;
  sourceTool: LocalSkillSourceTool;
  sourcePath: string;
  description: string;
  convertible: boolean;
  converterHint?: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocalSkillScanResult {
  items: LocalSkillScanItem[];
  scannedAt: string;
  scanDurationMs: number;
  directoriesScanned: string[];
}

export interface CommunitySkillItem {
  id: string;
  name: string;
  nameZh: string;
  nameEn: string;
  description: string;
  descriptionZh: string;
  descriptionEn: string;
  author: string;
  sourceUrl: string;
  tags: string[];
  category: string;
}

export interface BatchImportResult {
  results: Array<{ sourcePath: string; success: boolean; skillId?: string; error?: string }>;
  importedCount: number;
  failedCount: number;
}

// Note: routes may wrap in { status, body } envelope like discovery routes
interface RouteEnvelope<T> { status: number; body: T }

export const scanMigrateApi = {
  async scanLocal(): Promise<LocalSkillScanResult> {
    const res = await apiClient.post<Record<string, never>, RouteEnvelope<LocalSkillScanResult>>("/v1/skills/scan-local", {});
    return res.body ?? (res as unknown as LocalSkillScanResult);
  },

  async getCommunitySkills(q?: string): Promise<{ items: CommunitySkillItem[] }> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    const res = await apiClient.get<RouteEnvelope<{ items: CommunitySkillItem[] }>>(`/v1/skills/catalog/community${qs}`);
    return res.body ?? (res as unknown as { items: CommunitySkillItem[] });
  },

  async importBatch(items: Array<{ sourcePath: string; formatHint?: string }>): Promise<BatchImportResult> {
    const res = await apiClient.post<
      { items: Array<{ sourcePath: string; formatHint?: string }> },
      RouteEnvelope<BatchImportResult>
    >("/v1/skills/import-batch", { items });
    return res.body ?? (res as unknown as BatchImportResult);
  },
};
