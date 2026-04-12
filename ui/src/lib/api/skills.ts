import { apiClient } from "./client";
import type {
  SkillUiSchemaV1,
  SkillCatalogItem,
  SkillDeleteOutcome,
  SkillConversionSource,
  SkillInstallOutcome,
  SkillLifecycleDetail,
  SkillLifecycleSummary,
  SkillManifestValidationOutcome,
  SkillSourceFormat,
  SkillSourceRecord,
  SkillUpdateOutcome,
  SkillVerificationEvidence,
  ConverterInfo,
  ConvertResponse,
  ImportResponse,
  PackResponse,
  StartSessionResponse,
  GetSessionResponse,
  SubmitTurnResponse,
  GenerateResponse,
  ApproveResponse,
  SkillListResponse,
  SkillGenerationEvidence,
  SkillGeneratorTestSummary,
} from "./types";

// ─── Request types ───

interface StartGeneratorSessionInput {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
}

interface SubmitGeneratorMessageInput {
  message: string;
  requestedModel?: string;
}

interface GenerateDraftInput {
  requestedModel?: string;
}

interface ConvertInput {
  source: SkillConversionSource;
  formatHint?: SkillSourceFormat | "auto";
  dryRun?: boolean;
  options?: {
    splitOperations?: boolean;
    skillIdPrefix?: string;
  };
}

interface ImportInput {
  source: SkillConversionSource;
  formatHint?: SkillSourceFormat | "auto";
  target?: "managed" | "workspace" | { path: string };
  replace?: boolean;
  refreshRegistry?: boolean;
}

interface PackInput {
  skillDir: string;
  outputFile: string;
}

interface SkillCatalogResponse {
  items: SkillCatalogItem[];
  nextCursor?: string;
  total: number;
}

interface SkillDetailResponse {
  skill: SkillLifecycleDetail;
}

interface SkillInstallInput {
  skillId: string;
  version?: string;
  sourceId?: string;
  targetSatelliteIds?: string[];
  grantPermissions?: string[];
}

interface SkillUpdateInput {
  version?: string;
  sourceId?: string;
  targetSatelliteIds?: string[];
  grantPermissions?: string[];
}

interface SkillValidateManifestInput {
  manifest: Record<string, unknown>;
}

interface SkillValidateManifestResponse {
  verdict: SkillManifestValidationOutcome;
}

interface SkillVerifyResponse {
  evidence: SkillVerificationEvidence;
}

interface SkillSourceListResponse {
  items: SkillSourceRecord[];
  total: number;
}

interface SkillSourceMutationInput {
  name: string;
  baseUrl: string;
  trustPolicy: "strict" | "warn" | "permissive";
  pinnedKeyIds?: string[];
}

interface SkillSourcePatchInput {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  trustPolicy?: "strict" | "warn" | "permissive";
  pinnedKeyIds?: string[];
}

interface SkillSourceResponse {
  source: SkillSourceRecord;
}

// ─── Response wrappers ───

interface ListConvertersResponse {
  converters: ConverterInfo[];
}

interface GetSkillUiResponse {
  ui: SkillUiSchemaV1;
}

interface SkillGeneratorTestResponse {
  test: SkillGeneratorTestSummary;
}

interface SkillGeneratorEvidenceResponse {
  evidence: SkillGenerationEvidence;
}

// ─── API ───

export const skillsApi = {
  async listSkills(): Promise<SkillLifecycleSummary[]> {
    const data = await apiClient.get<SkillListResponse>("/v1/skills");
    return data.items;
  },

  async listCatalog(input: {
    sourceId?: string;
    q?: string;
    category?: string;
    cursor?: string;
    limit?: number;
    includeStale?: boolean;
  } = {}): Promise<SkillCatalogResponse> {
    const params = new URLSearchParams();
    if (input.sourceId) params.set("sourceId", input.sourceId);
    if (input.q) params.set("q", input.q);
    if (input.category) params.set("category", input.category);
    if (input.cursor) params.set("cursor", input.cursor);
    if (typeof input.limit === "number") params.set("limit", String(input.limit));
    if (typeof input.includeStale === "boolean") params.set("includeStale", String(input.includeStale));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return apiClient.get<SkillCatalogResponse>(`/v1/skills/catalog${suffix}`);
  },

  async getSkill(skillId: string): Promise<SkillLifecycleDetail> {
    const data = await apiClient.get<SkillDetailResponse>(
      `/v1/skills/${encodeURIComponent(skillId)}`,
    );
    return data.skill;
  },

  async installSkill(input: SkillInstallInput): Promise<SkillInstallOutcome> {
    return apiClient.post<SkillInstallInput, SkillInstallOutcome>("/v1/skills/install", input);
  },

  async updateSkill(skillId: string, input: SkillUpdateInput = {}): Promise<SkillUpdateOutcome> {
    return apiClient.post<SkillUpdateInput, SkillUpdateOutcome>(
      `/v1/skills/${encodeURIComponent(skillId)}/update`,
      input,
    );
  },

  async deleteSkill(skillId: string): Promise<SkillDeleteOutcome> {
    return apiClient.del<SkillDeleteOutcome>(`/v1/skills/${encodeURIComponent(skillId)}`);
  },

  async validateManifest(input: SkillValidateManifestInput): Promise<SkillManifestValidationOutcome> {
    const data = await apiClient.post<SkillValidateManifestInput, SkillValidateManifestResponse>(
      "/v1/skills/validate-manifest",
      input,
    );
    return data.verdict;
  },

  async updateSkillContent(skillId: string, input: {
    description?: string;
    name?: string;
    tags?: string[];
  }): Promise<void> {
    await apiClient.patch<typeof input, unknown>(
      `/v1/skills/${encodeURIComponent(skillId)}/content`,
      input,
    );
  },

  async verifySkill(skillId: string): Promise<SkillVerificationEvidence> {
    const data = await apiClient.post<Record<string, never>, SkillVerifyResponse>(
      `/v1/skills/${encodeURIComponent(skillId)}/verify`,
      {},
    );
    return data.evidence;
  },

  async listSources(): Promise<SkillSourceRecord[]> {
    const data = await apiClient.get<SkillSourceListResponse>("/v1/marketplace/sources");
    return data.items;
  },

  async createSource(input: SkillSourceMutationInput): Promise<SkillSourceRecord> {
    const data = await apiClient.post<SkillSourceMutationInput, SkillSourceResponse>(
      "/v1/marketplace/sources",
      input,
    );
    return data.source;
  },

  async updateSource(sourceId: string, input: SkillSourcePatchInput): Promise<SkillSourceRecord> {
    const data = await apiClient.patch<SkillSourcePatchInput, SkillSourceResponse>(
      `/v1/marketplace/sources/${encodeURIComponent(sourceId)}`,
      input,
    );
    return data.source;
  },

  async enableSource(sourceId: string): Promise<SkillSourceRecord> {
    const data = await apiClient.post<Record<string, never>, SkillSourceResponse>(
      `/v1/marketplace/sources/${encodeURIComponent(sourceId)}/enable`,
      {},
    );
    return data.source;
  },

  async disableSource(sourceId: string): Promise<SkillSourceRecord> {
    const data = await apiClient.post<Record<string, never>, SkillSourceResponse>(
      `/v1/marketplace/sources/${encodeURIComponent(sourceId)}/disable`,
      {},
    );
    return data.source;
  },

  async deleteSource(sourceId: string): Promise<{ removed: true; sourceId: string }> {
    return apiClient.del<{ removed: true; sourceId: string }>(
      `/v1/marketplace/sources/${encodeURIComponent(sourceId)}`,
    );
  },

  // ─── Generator endpoints ───

  async startGeneratorSession(
    input: StartGeneratorSessionInput,
  ): Promise<StartSessionResponse> {
    return apiClient.post<StartGeneratorSessionInput, StartSessionResponse>(
      "/v1/skills/generator/sessions",
      input,
    );
  },

  async getGeneratorSession(sessionId: string): Promise<GetSessionResponse> {
    return apiClient.get<GetSessionResponse>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  async submitGeneratorMessage(
    sessionId: string,
    input: SubmitGeneratorMessageInput,
  ): Promise<SubmitTurnResponse> {
    return apiClient.post<SubmitGeneratorMessageInput, SubmitTurnResponse>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
      input,
    );
  },

  async generateDraft(
    sessionId: string,
    input?: GenerateDraftInput,
  ): Promise<GenerateResponse> {
    return apiClient.post<GenerateDraftInput | Record<string, never>, GenerateResponse>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/generate`,
      input ?? {},
    );
  },

  async approveSession(sessionId: string): Promise<ApproveResponse> {
    return apiClient.post<Record<string, never>, ApproveResponse>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/approve`,
      {},
    );
  },

  async testSession(sessionId: string): Promise<SkillGeneratorTestSummary> {
    const data = await apiClient.post<Record<string, never>, SkillGeneratorTestResponse>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/test`,
      {},
    );
    return data.test;
  },

  async getGenerationEvidence(sessionId: string): Promise<SkillGenerationEvidence> {
    const data = await apiClient.get<SkillGeneratorEvidenceResponse>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
    );
    return data.evidence;
  },

  async cancelSession(sessionId: string): Promise<{ cancelled: true }> {
    return apiClient.del<{ cancelled: true }>(
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  // ─── Converter endpoints ───

  async listConverters(): Promise<ConverterInfo[]> {
    const data = await apiClient.get<ListConvertersResponse>("/v1/skills/converters");
    return data.converters;
  },

  async convert(input: ConvertInput): Promise<ConvertResponse> {
    return apiClient.post<ConvertInput, ConvertResponse>("/v1/skills/convert", input);
  },

  async import(input: ImportInput): Promise<ImportResponse> {
    return apiClient.post<ImportInput, ImportResponse>("/v1/skills/import", input);
  },

  async pack(input: PackInput): Promise<PackResponse> {
    return apiClient.post<PackInput, PackResponse>("/v1/skills/pack", input);
  },

  // ─── Skill UI endpoint ───

  async getSkillUi(skillId: string): Promise<SkillUiSchemaV1> {
    const data = await apiClient.get<GetSkillUiResponse>(
      `/v1/skills/${encodeURIComponent(skillId)}/ui`,
    );
    return data.ui;
  },
};
