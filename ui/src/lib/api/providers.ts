import { apiClient } from "./client";
import type { ProviderApprovalDeviceProof } from "@/lib/auth/device-key";
import type {
  FridayProviderProfile,
  FridayProviderValidationState,
  FridayModelRoutingConfig,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderKind,
  FridayProviderAuthMode,
  FridayProviderApi,
  FridayProviderBackendKind,
  FridayProviderCliConfig,
  FridayProviderDoctorReport,
  FridayProviderCapabilityHealthSnapshotItem,
  FridayProviderHealthSnapshotItem,
  FridayProviderRuntimeCapabilityDeclaration,
  FridayProviderRoutingExplainReport,
  FridayProviderTemplate,
  FridayRuntimeCapabilityId,
} from "./types";

// ─── Request types ───

export interface CreateProviderInput {
  kind: FridayProviderKind;
  name: string;
  baseUrl: string;
  authMode: FridayProviderAuthMode;
  api: FridayProviderApi;
  backendKind?: FridayProviderBackendKind;
  cliConfig?: FridayProviderCliConfig;
  deploymentKind?: "hosted" | "local" | "self-hosted" | "consumer-cli";
  regionTag?: "global" | "us" | "china" | "local" | "custom";
  apiKey?: string;
  supportedModels: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  runtimeCapabilities?: FridayProviderRuntimeCapabilityDeclaration[];
  enabled?: boolean;
  validateOnSave?: boolean;
  /**
   * Owner-confirm control fields (CORE-RUNNABLE-001 / CORE-A CR-2). Replayed
   * verbatim from the plan → confirm handshake so the canonical mutating-action
   * gate can recompute the action digest server-side from the request that
   * actually arrived. Never carries a secret. Absent ⇒ the gate fails closed
   * with `PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED`.
   */
  planDigest?: string;
  canonicalApproval?: unknown;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  authMode?: FridayProviderAuthMode;
  api?: FridayProviderApi;
  backendKind?: FridayProviderBackendKind;
  cliConfig?: FridayProviderCliConfig;
  deploymentKind?: "hosted" | "local" | "self-hosted" | "consumer-cli";
  regionTag?: "global" | "us" | "china" | "local" | "custom";
  apiKey?: string;
  supportedModels?: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  runtimeCapabilities?: FridayProviderRuntimeCapabilityDeclaration[];
  enabled?: boolean;
  validateOnSave?: boolean;
  /** Owner-confirm control fields — see {@link CreateProviderInput.planDigest}. */
  planDigest?: string;
  canonicalApproval?: unknown;
}

// ─── Provider mutation plan / owner-confirm handshake (CORE-A CR-2) ───

export type FridayProviderPlannableAction =
  | "providers.create"
  | "providers.update"
  | "providers.delete"
  | "providers.validate"
  | "providers.routing.set"
  | "providers.routing.pin"
  | "providers.routing.penalty.clear"
  | "providers.auth.profiles.activate"
  | "providers.oauth.openai_codex.device.initiate"
  | "providers.oauth.openai_codex.device.complete"
  | "capabilities.doctor";

export interface PlanProviderMutationInput {
  action: FridayProviderPlannableAction;
  providerId?: string;
  profileKey?: string;
  /** The exact body the follow-up mutation will send (control fields ignored). */
  params?: Record<string, unknown> | null;
  idempotencyKey?: string;
}

export interface FridayProviderMutationPlan {
  planDigest: string;
  actionDigest: string;
  action: FridayProviderPlannableAction;
  surface: string;
  resourceId?: string;
  idempotencyKey?: string;
  /** Secret-free review lines shown to the owner BEFORE they confirm. */
  humanReadableSummary: string[];
  approvalRequired: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface FridayProviderMutationApproval {
  planDigest: string;
  actionDigest: string;
  action: FridayProviderPlannableAction;
  resourceId?: string;
  idempotencyKey?: string;
  confirmedAt: string;
  expiresAt: string;
  /** Signed, single-use canonical approval to replay on the mutation request. */
  canonicalApproval: unknown;
}

interface PlanProviderMutationResponse {
  plan: FridayProviderMutationPlan;
}

interface ConfirmProviderMutationResponse {
  approval: FridayProviderMutationApproval;
}

export interface SetRoutingInput {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
  costMode?: FridayModelRoutingConfig["costMode"];
  enforceRequestedModel?: boolean;
  /**
   * Owner-confirm control fields (SEC-APPROVAL-AUTHORITY-001 / CORE-A CR-2 finding
   * #3). `providers.routing.set` is a GATED mutation: in a release profile it
   * requires an approved plan digest + a device-authored approval, exactly like
   * create/update. Routing setup MUST flow through plan → confirm so it can never
   * 403-after-persist and strand a created-but-unrouted provider. Absent ⇒ the gate
   * fails closed with `PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED`.
   */
  planDigest?: string;
  canonicalApproval?: unknown;
}

// ─── Response wrappers ───

interface ListProvidersResponse {
  items: FridayProviderProfile[];
}

interface ListProviderTemplatesResponse {
  items: FridayProviderTemplate[];
}

interface GetProviderTemplateResponse {
  template: FridayProviderTemplate;
}

interface GetProviderResponse {
  provider: FridayProviderProfile;
}

interface GetProviderHealthSnapshotResponse {
  items: FridayProviderHealthSnapshotItem[];
}

interface GetProviderCapabilityHealthSnapshotResponse {
  items: FridayProviderCapabilityHealthSnapshotItem[];
  summary: {
    available: number;
    setupNeeded: number;
    proofPending: number;
    disabled: number;
    unsupported: number;
  };
}

interface RunCapabilityDoctorResponse {
  checkedAt: string;
  providerValidations: Array<{
    providerId: string;
    providerKind: FridayProviderKind;
    validation: FridayProviderValidationState;
  }>;
  capabilityResults: Array<{
    providerId: string;
    providerKind: FridayProviderKind;
    capability: FridayRuntimeCapabilityId;
    model?: string;
    status: "verified" | "declared" | "failed" | "unsupported";
    checkedAt: string;
    message: string;
    errorCode?: string;
    httpStatus?: number;
    evidence?: {
      probe: string;
      standardized: boolean;
      endpoint?: string;
      responseStatus?: number;
    };
  }>;
}

interface CreateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

interface UpdateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

interface DeleteProviderResponse {
  deleted: true;
}

interface ValidateProviderResponse {
  validation: FridayProviderValidationState;
}

interface GetRoutingResponse {
  routing: FridayModelRoutingConfig;
}

interface SetRoutingResponse {
  routing: FridayModelRoutingConfig;
}

interface InitiateOAuthResponse {
  oauth: FridayOAuthLoginInitiation;
}

interface CompleteOAuthResponse {
  oauth: FridayOAuthLoginResult;
}

interface InitiateDeviceOAuthResponse {
  oauth: FridayOAuthDeviceAuthorizationRequest;
}

interface GetProviderDoctorResponse {
  doctor: FridayProviderDoctorReport;
}

interface GetProviderRoutingExplainResponse {
  explain: FridayProviderRoutingExplainReport;
}

interface ListProviderAuthProfilesResponse {
  items: Array<{
    id: string;
    providerProfileId: string;
    providerKind: FridayProviderKind;
    profileKey: string;
    label: string;
    authMode: FridayProviderAuthMode;
    oauthProvider?: string;
    isActive: boolean;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>;
}

interface ActivateProviderAuthProfileResponse {
  profile: ListProviderAuthProfilesResponse["items"][number];
}

export interface ExplainRoutingInput {
  requestedProviderId?: string;
  requestedModel?: string;
  taskProfileId?: string;
  estimatedInputTokens?: number;
  complexity?: "simple" | "medium" | "complex";
  requiresNativeTools?: boolean;
}

interface PinRouteInput {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
  reason?: string;
}

interface ClearRoutePenaltyInput {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
}

// ─── API ───

export const providersApi = {
  async listTemplates(): Promise<FridayProviderTemplate[]> {
    const data = await apiClient.get<ListProviderTemplatesResponse>("/v1/providers/templates");
    return data.items;
  },

  async getTemplate(templateId: string): Promise<FridayProviderTemplate> {
    const data = await apiClient.get<GetProviderTemplateResponse>(
      `/v1/providers/templates/${encodeURIComponent(templateId)}`,
    );
    return data.template;
  },

  async list(): Promise<FridayProviderProfile[]> {
    const data = await apiClient.get<ListProvidersResponse>("/v1/providers");
    return data.items;
  },

  async listHealth(): Promise<FridayProviderHealthSnapshotItem[]> {
    const data = await apiClient.get<GetProviderHealthSnapshotResponse>("/v1/providers/health");
    return data.items;
  },

  async listCapabilityHealth(): Promise<FridayProviderCapabilityHealthSnapshotItem[]> {
    const data = await apiClient.get<GetProviderCapabilityHealthSnapshotResponse>(
      "/v1/providers/capability-health",
    );
    return data.items;
  },

  async runCapabilityDoctor(): Promise<RunCapabilityDoctorResponse> {
    return apiClient.post<Record<string, never>, RunCapabilityDoctorResponse>(
      "/v1/capabilities/doctor",
      {},
    );
  },

  /**
   * Step 1 of the owner-confirm handshake (CORE-A CR-2): ask the SERVER to
   * sanitize the intended parameters and derive the plan + action digests
   * itself, returning a secret-free summary for the owner to review. The client
   * never computes a digest — drift can only fail closed, never be forged.
   */
  async planMutation(input: PlanProviderMutationInput): Promise<FridayProviderMutationPlan> {
    const data = await apiClient.post<PlanProviderMutationInput, PlanProviderMutationResponse>(
      "/v1/providers/plan",
      input,
    );
    return data.plan;
  },

  /**
   * Step 2: the SAME authenticated owner explicitly confirms that exact plan
   * digest by presenting a DEVICE-AUTHORED approval proof (SEC-APPROVAL-AUTHORITY-001).
   * The Hub holds NO signing key — it only VERIFIES the owner device's P-256
   * proof-of-possession over the reviewed action digest and returns the
   * device-authored, single-use canonical approval. `confirm` is always literal
   * `true` — never defaulted, never inferred.
   */
  async confirmMutation(
    planDigest: string,
    deviceApproval: ProviderApprovalDeviceProof,
  ): Promise<FridayProviderMutationApproval> {
    const data = await apiClient.post<
      { planDigest: string; confirm: true; deviceApproval: ProviderApprovalDeviceProof },
      ConfirmProviderMutationResponse
    >("/v1/providers/plan/confirm", { planDigest, confirm: true, deviceApproval });
    return data.approval;
  },

  async create(input: CreateProviderInput): Promise<CreateProviderResponse> {
    return apiClient.post<CreateProviderInput, CreateProviderResponse>(
      "/v1/providers",
      input,
    );
  },

  async get(providerId: string): Promise<FridayProviderProfile> {
    const data = await apiClient.get<GetProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}`,
    );
    return data.provider;
  },

  async update(
    providerId: string,
    patch: UpdateProviderInput,
  ): Promise<UpdateProviderResponse> {
    return apiClient.patch<UpdateProviderInput, UpdateProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}`,
      patch,
    );
  },

  async remove(providerId: string): Promise<void> {
    await apiClient.del<DeleteProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}`,
    );
  },

  async validate(providerId: string): Promise<FridayProviderValidationState> {
    const data = await apiClient.post<Record<string, never>, ValidateProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/validate`,
      {},
    );
    return data.validation;
  },

  async doctor(providerId: string): Promise<FridayProviderDoctorReport> {
    const data = await apiClient.get<GetProviderDoctorResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/doctor`,
    );
    return data.doctor;
  },

  async explainRouting(input: ExplainRoutingInput): Promise<FridayProviderRoutingExplainReport> {
    const params = new URLSearchParams();
    if (input.requestedProviderId) params.set("requestedProviderId", input.requestedProviderId);
    if (input.requestedModel) params.set("requestedModel", input.requestedModel);
    if (input.taskProfileId) params.set("taskProfileId", input.taskProfileId);
    if (typeof input.estimatedInputTokens === "number") params.set("estimatedInputTokens", String(input.estimatedInputTokens));
    if (input.complexity) params.set("complexity", input.complexity);
    if (typeof input.requiresNativeTools === "boolean") params.set("requiresNativeTools", String(input.requiresNativeTools));
    const qs = params.toString();
    const data = await apiClient.get<GetProviderRoutingExplainResponse>(
      `/v1/providers/routing/explain${qs ? `?${qs}` : ""}`,
    );
    return data.explain;
  },

  async pinRoute(input: PinRouteInput): Promise<void> {
    await apiClient.post<PinRouteInput, { pinned: true }>("/v1/providers/routing/pin", input);
  },

  async clearRoutePenalty(input: ClearRoutePenaltyInput): Promise<boolean> {
    const data = await apiClient.post<ClearRoutePenaltyInput, { cleared: boolean }>(
      "/v1/providers/routing/penalties/clear",
      input,
    );
    return data.cleared;
  },

  async listAuthProfiles(providerId: string): Promise<ListProviderAuthProfilesResponse["items"]> {
    const data = await apiClient.get<ListProviderAuthProfilesResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/auth-profiles`,
    );
    return data.items;
  },

  async activateAuthProfile(
    providerId: string,
    profileKey: string,
  ): Promise<ActivateProviderAuthProfileResponse["profile"]> {
    const data = await apiClient.post<Record<string, never>, ActivateProviderAuthProfileResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/auth-profiles/${encodeURIComponent(profileKey)}/activate`,
      {},
    );
    return data.profile;
  },

  async getRouting(): Promise<FridayModelRoutingConfig> {
    const data = await apiClient.get<GetRoutingResponse>("/v1/model-routing");
    return data.routing;
  },

  async setRouting(input: SetRoutingInput): Promise<FridayModelRoutingConfig> {
    const data = await apiClient.put<SetRoutingInput, SetRoutingResponse>(
      "/v1/model-routing",
      input,
    );
    return data.routing;
  },

  async initiateAnthropicOAuth(
    providerId: string,
  ): Promise<FridayOAuthLoginInitiation> {
    const data = await apiClient.post<{ providerId: string }, InitiateOAuthResponse>(
      "/v1/auth/oauth/anthropic/initiate",
      { providerId },
    );
    return data.oauth;
  },

  async completeAnthropicOAuth(input: {
    providerId: string;
    authorizationCode: string;
    state?: string;
  }): Promise<FridayOAuthLoginResult> {
    const data = await apiClient.post<typeof input, CompleteOAuthResponse>(
      "/v1/auth/oauth/anthropic/callback",
      input,
    );
    return data.oauth;
  },

  async initiateOpenAICodexDeviceOAuth(
    providerId?: string,
  ): Promise<FridayOAuthDeviceAuthorizationRequest> {
    const data = await apiClient.post<{ providerId?: string; kind: "openai-codex" }, InitiateDeviceOAuthResponse>(
      "/v1/auth/oauth/openai-codex/device/initiate",
      { kind: "openai-codex", ...(providerId ? { providerId } : {}) },
    );
    return data.oauth;
  },

  async completeOpenAICodexDeviceOAuth(input: {
    providerId?: string;
    deviceCodeId: string;
  }): Promise<FridayOAuthLoginResult> {
    const data = await apiClient.post<typeof input & { kind: "openai-codex" }, CompleteOAuthResponse>(
      "/v1/auth/oauth/openai-codex/device/complete",
      { kind: "openai-codex", ...input },
    );
    return data.oauth;
  },
};
