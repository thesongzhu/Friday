import { apiClient } from "./client";

// ─── Types ───

export type LocalSkillSourceTool =
  | "claude-code"
  | "cursor"
  | "n8n"
  | "codex"
  | "openclaw"
  | "friday"
  | "local-project"
  | "unknown";

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

export interface BatchConvertResult {
  results: Array<{ sourcePath: string; success: boolean; skillId?: string; mode?: "preview"; error?: string }>;
  convertedCount: number;
  failedCount: number;
}

// Helper to unwrap route envelope if present
function unwrap<T>(res: unknown): T {
  if (res && typeof res === "object" && "body" in res && "status" in res) {
    return (res as { body: T }).body;
  }
  return res as T;
}

export const scanMigrateApi = {
  async scanLocal(): Promise<LocalSkillScanResult> {
    const res = await apiClient.post<Record<string, never>, unknown>("/v1/skills/scan-local", {});
    return unwrap<LocalSkillScanResult>(res);
  },

  async convertBatch(items: Array<{ sourcePath: string; formatHint?: string }>): Promise<BatchConvertResult> {
    const res = await apiClient.post<
      { items: Array<{ sourcePath: string; formatHint?: string }> },
      unknown
    >("/v1/skills/convert-batch", { items });
    return unwrap<BatchConvertResult>(res);
  },
};
