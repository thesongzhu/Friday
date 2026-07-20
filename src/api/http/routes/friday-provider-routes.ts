import { createHash } from "node:crypto";

import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";

import type {
  FridayActivateProviderAuthProfileResponse,
  FridayClearProviderRoutePenaltyResponse,
  FridayCompleteAnthropicOAuthCallbackRequest,
  FridayCompleteAnthropicOAuthCallbackResponse,
  FridayCompleteOpenAICodexDeviceOAuthResponse,
  FridayConfirmProviderMutationResponse,
  FridayCreateProviderRequest,
  FridayCreateProviderResponse,
  FridayDeleteProviderResponse,
  FridayGetProviderCapabilityHealthSnapshotResponse,
  FridayGetProviderDoctorResponse,
  FridayGetProviderHealthSnapshotResponse,
  FridayGetProviderResponse,
  FridayGetProviderRoutingExplainResponse,
  FridayGetProviderTemplateResponse,
  FridayGetRoutingConfigResponse,
  FridayInitiateAnthropicOAuthRequest,
  FridayInitiateAnthropicOAuthResponse,
  FridayInitiateOpenAICodexDeviceOAuthResponse,
  FridayListProviderAuthProfilesResponse,
  FridayListProvidersResponse,
  FridayListProviderTemplatesResponse,
  FridayPinProviderRouteResponse,
  FridayPlanProviderMutationResponse,
  FridayProviderMutationPlan,
  FridayProviderPlannableAction,
  FridayRunCapabilityDoctorRequest,
  FridayRunCapabilityDoctorResponse,
  FridaySetRoutingConfigRequest,
  FridaySetRoutingConfigResponse,
  FridayUpdateProviderRequest,
  FridayUpdateProviderResponse,
  FridayValidateProviderResponse,
} from "../../model/friday-api-provider.types.js";

import type {
  FridayModelRoutingConfig,
  FridayProviderCapabilityHealthCapabilityItem,
  FridayProviderCapabilityHealthSnapshotSummary,
  FridayProviderHealthSnapshotItem,
  FridayProviderLane,
  FridayProviderProfile,
  FridayProviderRuntimeCapabilityDeclaration,
  FridayProviderService,
  FridayRuntimeCapabilityId,
} from "#providers";
import {
  FRIDAY_PROVIDER_APIS,
  FRIDAY_PROVIDER_BACKEND_KINDS,
  FRIDAY_PROVIDER_KINDS,
  FRIDAY_RUNTIME_CAPABILITY_IDS,
  getFridayProviderTemplate,
  listFridayProviderTemplates,
} from "#providers";
import { FridayDomainError } from "#errors";
import type {
  FridayRustCapabilityDoctorReceipt,
  FridayRustHubCapabilityDoctorService,
} from "../../mission-spine/friday-rust-hub-capability-doctor-bridge-service.js";
import {
  resolveExistingOAuthProvider,
  resolveOrProvisionOAuthProvider,
} from "../../../providers/services/friday-provider-oauth-selection.js";
import { FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE } from "../../../providers/oauth/friday-anthropic-oauth.js";
import {
  createFridayMutatingActionDigest,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionTicket,
} from "../../../security/friday-mutating-action-gate.js";
import { deviceOwnerPrincipalId } from "../../../security/friday-device-owner-authority-precondition.js";
import { isUnauthenticatedPublicPrincipal } from "../../../security/friday-owner-session-channel-capability.js";
import type {
  FridayProviderApprovalPoPVerifier,
  ProviderApprovalDeviceProof,
} from "../../auth/device-attest/index.js";

// ─── Validation helpers ───

const VALID_KINDS = new Set<string>(FRIDAY_PROVIDER_KINDS);
const VALID_APIS = new Set<string>(FRIDAY_PROVIDER_APIS);
const VALID_BACKEND_KINDS = new Set<string>(FRIDAY_PROVIDER_BACKEND_KINDS);
const VALID_AUTH_MODES = new Set(["api-key", "bearer-token", "oauth", "token", "external-session", "none"]);
const VALID_DEPLOYMENT_KINDS = new Set(["hosted", "local", "self-hosted", "consumer-cli"]);
const VALID_REGION_TAGS = new Set(["global", "us", "china", "local", "custom"]);
const VALID_ROUTING_COST_MODES = new Set(["frugal", "standard", "strict"]);
const VALID_RUNTIME_CAPABILITIES = new Set<string>(FRIDAY_RUNTIME_CAPABILITY_IDS);

function parseCapabilityDoctorProviderIds(body: unknown): string[] | undefined {
  if (body == null) {
    return undefined;
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body must be an object", { httpStatus: 400 });
  }
  const { providerIds } = body as FridayRunCapabilityDoctorRequest;
  if (providerIds == null) {
    return undefined;
  }
  if (!Array.isArray(providerIds)) {
    throw new FridayDomainError("VALIDATION_ERROR", "providerIds must be an array", { httpStatus: 400 });
  }
  const normalizedProviderIds = providerIds.map((providerId) => {
    if (typeof providerId !== "string" || providerId.trim().length === 0) {
      throw new FridayDomainError("VALIDATION_ERROR", "providerIds must contain non-empty strings", {
        httpStatus: 400,
      });
    }
    return providerId.trim();
  });
  const uniqueProviderIds = [...new Set(normalizedProviderIds)];
  if (uniqueProviderIds.length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "providerIds must contain at least one provider id when provided", {
      httpStatus: 400,
    });
  }
  return uniqueProviderIds;
}

const PROVIDER_CREATE_ACCEPTED_FIELDS = [
  "kind",
  "name",
  "backendKind",
  "baseUrl",
  "authMode",
  "api",
  "apiKey",
  "supportedModels",
  "defaultModel",
  "headers",
  "cliConfig",
  "runtimeCapabilities",
  "deploymentKind",
  "regionTag",
  "enabled",
  "validateOnSave",
] as const;

const PROVIDER_CREATE_REQUIRED_FIELDS = [
  "kind",
  "name",
  "baseUrl",
  "authMode",
  "api",
  "supportedModels",
] as const;

const PROVIDER_CREATE_FIELD_ALIASES = {
  providerKind: "kind",
  displayName: "name",
  providerName: "name",
  apiBaseUrl: "baseUrl",
  baseURL: "baseUrl",
  providerApi: "api",
  models: "supportedModels",
  modelIds: "supportedModels",
  validate: "validateOnSave",
} as const;

function providerCreateSchemaDetails(): Record<string, unknown> {
  return {
    acceptedFields: [...PROVIDER_CREATE_ACCEPTED_FIELDS],
    requiredFields: [...PROVIDER_CREATE_REQUIRED_FIELDS],
    aliases: PROVIDER_CREATE_FIELD_ALIASES,
    enums: {
      kind: [...FRIDAY_PROVIDER_KINDS],
      backendKind: [...FRIDAY_PROVIDER_BACKEND_KINDS],
      authMode: [...VALID_AUTH_MODES],
      api: [...FRIDAY_PROVIDER_APIS],
      deploymentKind: [...VALID_DEPLOYMENT_KINDS],
      regionTag: [...VALID_REGION_TAGS],
    },
    example: {
      kind: "openai",
      name: "OpenAI",
      backendKind: "http",
      baseUrl: "https://api.openai.com",
      authMode: "api-key",
      api: "openai-completions",
      apiKey: "<secret>",
      supportedModels: ["gpt-4o"],
      defaultModel: "gpt-4o",
      validateOnSave: true,
    },
  };
}

function requireOAuthOwnerUserId(principal: { userId?: string } | null): string {
  const userId = principal?.userId?.trim();
  if (!userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped principal is required for provider OAuth", {
      httpStatus: 401,
    });
  }
  return userId;
}

function pushProviderCreateAliasErrors(body: Record<string, unknown>, errors: string[]): void {
  for (const [alias, canonical] of Object.entries(PROVIDER_CREATE_FIELD_ALIASES)) {
    if (body[alias] !== undefined) {
      errors.push(`${alias} is not accepted; use ${canonical}`);
    }
  }
}

function validateCliConfig(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    errors.push("cliConfig must be an object when provided");
    return;
  }
  const cliConfig = value as Record<string, unknown>;
  if (typeof cliConfig.backendId !== "string" || cliConfig.backendId.trim() === "") {
    errors.push("cliConfig.backendId is required when cliConfig is provided");
  }
  if (cliConfig.binaryPath !== undefined && typeof cliConfig.binaryPath !== "string") {
    errors.push("cliConfig.binaryPath must be a string when provided");
  }
}

function validateRuntimeCapabilities(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("runtimeCapabilities must be an array when provided");
    return;
  }
  value.forEach((entry, index) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`runtimeCapabilities[${String(index)}] must be an object`);
      return;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.capability !== "string" || !VALID_RUNTIME_CAPABILITIES.has(item.capability)) {
      errors.push(`runtimeCapabilities[${String(index)}].capability must be one of: ${[...VALID_RUNTIME_CAPABILITIES].join(", ")}`);
    }
    if (item.model !== undefined && typeof item.model !== "string") {
      errors.push(`runtimeCapabilities[${String(index)}].model must be a string when provided`);
    }
    if (item.verified !== undefined && typeof item.verified !== "boolean") {
      errors.push(`runtimeCapabilities[${String(index)}].verified must be a boolean when provided`);
    }
    if (item.status !== undefined && item.status !== "declared" && item.status !== "verified" && item.status !== "failed") {
      errors.push(`runtimeCapabilities[${String(index)}].status must be declared, verified, or failed when provided`);
    }
    if (item.verifiedAt !== undefined && typeof item.verifiedAt !== "string") {
      errors.push(`runtimeCapabilities[${String(index)}].verifiedAt must be a string when provided`);
    }
    if (item.notes !== undefined && typeof item.notes !== "string") {
      errors.push(`runtimeCapabilities[${String(index)}].notes must be a string when provided`);
    }
  });
}

function validateCreateBody(body: unknown): asserts body is FridayCreateProviderRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  pushProviderCreateAliasErrors(b, errors);

  if (typeof b.kind !== "string" || !VALID_KINDS.has(b.kind)) {
    errors.push(`kind must be one of: ${[...VALID_KINDS].join(", ")}`);
  }
  if (typeof b.name !== "string" || b.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }
  const backendKind = typeof b.backendKind === "string" ? b.backendKind : "http";
  if (!VALID_BACKEND_KINDS.has(backendKind)) {
    errors.push(`backendKind must be one of: ${[...VALID_BACKEND_KINDS].join(", ")}`);
  }
  if (backendKind === "http" && (typeof b.baseUrl !== "string" || b.baseUrl.trim() === "")) {
    errors.push("baseUrl is required and must be a non-empty string");
  }
  if (backendKind !== "http" && b.baseUrl !== undefined && typeof b.baseUrl !== "string") {
    errors.push("baseUrl must be a string when provided");
  }
  if (typeof b.authMode !== "string" || !VALID_AUTH_MODES.has(b.authMode)) {
    errors.push(`authMode must be one of: ${[...VALID_AUTH_MODES].join(", ")}`);
  }
  if (typeof b.api !== "string" || !VALID_APIS.has(b.api)) {
    errors.push(`api must be one of: ${[...VALID_APIS].join(", ")}`);
  }
  if (!Array.isArray(b.supportedModels) || b.supportedModels.length === 0 || !b.supportedModels.every((m: unknown) => typeof m === "string")) {
    errors.push("supportedModels must be a non-empty array of strings");
  }
  if (b.apiKey !== undefined && typeof b.apiKey !== "string") {
    errors.push("apiKey must be a string when provided");
  }
  if (b.defaultModel !== undefined && typeof b.defaultModel !== "string") {
    errors.push("defaultModel must be a string when provided");
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    errors.push("enabled must be a boolean when provided");
  }
  if (b.validateOnSave !== undefined && typeof b.validateOnSave !== "boolean") {
    errors.push("validateOnSave must be a boolean when provided");
  }
  if (b.headers !== undefined && (b.headers == null || typeof b.headers !== "object" || Array.isArray(b.headers))) {
    errors.push("headers must be an object when provided");
  }
  if (b.deploymentKind !== undefined && (typeof b.deploymentKind !== "string" || !VALID_DEPLOYMENT_KINDS.has(b.deploymentKind))) {
    errors.push(`deploymentKind must be one of: ${[...VALID_DEPLOYMENT_KINDS].join(", ")}`);
  }
  if (b.regionTag !== undefined && (typeof b.regionTag !== "string" || !VALID_REGION_TAGS.has(b.regionTag))) {
    errors.push(`regionTag must be one of: ${[...VALID_REGION_TAGS].join(", ")}`);
  }
  validateCliConfig(b.cliConfig, errors);
  validateRuntimeCapabilities(b.runtimeCapabilities, errors);

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid provider create request: ${errors.join("; ")}`, {
      httpStatus: 422,
      details: {
        errors,
        schema: providerCreateSchemaDetails(),
      },
    });
  }
}

function validateUpdateBody(body: unknown): asserts body is FridayUpdateProviderRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.kind !== undefined) {
    errors.push("kind cannot be changed after creation");
  }
  if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim() === "")) {
    errors.push("name must be a non-empty string when provided");
  }
  if (b.backendKind !== undefined && (typeof b.backendKind !== "string" || !VALID_BACKEND_KINDS.has(b.backendKind))) {
    errors.push(`backendKind must be one of: ${[...VALID_BACKEND_KINDS].join(", ")}`);
  }
  if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || b.baseUrl.trim() === "")) {
    errors.push("baseUrl must be a non-empty string when provided");
  }
  if (b.authMode !== undefined && (typeof b.authMode !== "string" || !VALID_AUTH_MODES.has(b.authMode))) {
    errors.push(`authMode must be one of: ${[...VALID_AUTH_MODES].join(", ")}`);
  }
  if (b.api !== undefined && (typeof b.api !== "string" || !VALID_APIS.has(b.api))) {
    errors.push(`api must be one of: ${[...VALID_APIS].join(", ")}`);
  }
  if (b.supportedModels !== undefined && (!Array.isArray(b.supportedModels) || !b.supportedModels.every((m: unknown) => typeof m === "string"))) {
    errors.push("supportedModels must be an array of strings when provided");
  }
  if (b.apiKey !== undefined && typeof b.apiKey !== "string") {
    errors.push("apiKey must be a string when provided");
  }
  if (b.defaultModel !== undefined && typeof b.defaultModel !== "string") {
    errors.push("defaultModel must be a string when provided");
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    errors.push("enabled must be a boolean when provided");
  }
  if (b.validateOnSave !== undefined && typeof b.validateOnSave !== "boolean") {
    errors.push("validateOnSave must be a boolean when provided");
  }
  if (b.headers !== undefined && (b.headers == null || typeof b.headers !== "object" || Array.isArray(b.headers))) {
    errors.push("headers must be an object when provided");
  }
  validateCliConfig(b.cliConfig, errors);
  validateRuntimeCapabilities(b.runtimeCapabilities, errors);

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

function validateRoutingBody(body: unknown): asserts body is FridaySetRoutingConfigRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.defaultProviderId !== "string" || b.defaultProviderId.trim() === "") {
    errors.push("defaultProviderId is required and must be a non-empty string");
  }
  if (b.fallbackProviderIds === undefined) {
    (b as Record<string, unknown>).fallbackProviderIds = [];
  } else if (
    !Array.isArray(b.fallbackProviderIds)
    || !b.fallbackProviderIds.every((id: unknown) => typeof id === "string" && id.trim() !== "")
  ) {
    errors.push("fallbackProviderIds must be an array of non-empty strings when provided");
  }
  if (b.defaultModel !== undefined && typeof b.defaultModel !== "string") {
    errors.push("defaultModel must be a string when provided");
  }
  if (b.costMode !== undefined && (typeof b.costMode !== "string" || !VALID_ROUTING_COST_MODES.has(b.costMode))) {
    errors.push("costMode must be one of: frugal, standard, strict");
  }
  if (b.enforceRequestedModel !== undefined && typeof b.enforceRequestedModel !== "boolean") {
    errors.push("enforceRequestedModel must be a boolean when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

// ─── Dependencies ───

export interface FridayProviderRoutesDeps {
  providerService: FridayProviderService;
  canonicalMutationGate?: FridayMutatingActionGate;
  providerMutationGateRequired?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript provider probe surfaces
   * (POST /v1/providers/:providerId/validate, GET /v1/providers/:providerId/doctor,
   * POST /v1/capabilities/doctor) in isolated/mock validation. Production/runtime
   * callers must leave this unset so these transient capability/key-validation
   * probes fail-close until Rust owns the provider-probe entrypoint.
   */
  allowTestOnlyProviderProbeExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript provider routing-controls
   * surfaces (POST /v1/providers/routing/pin, POST /v1/providers/routing/penalties/clear)
   * in isolated/mock validation. Production/runtime callers must leave this unset
   * so these user-scoped routing-state mutations fail-close until Rust owns the
   * routing-controls entrypoint. This does NOT cover the model-routing config
   * surfaces (GET/PUT /v1/model-routing), which remain operator_external_adapter.
   */
  allowTestOnlyProviderRoutingControlsExecution?: boolean;
  /**
   * DARK cut-over flag (DEFAULT-OFF). When `true`, the retired provider-probe routes
   * (`providers.validate` / `providers.doctor` / `capabilities.doctor`) — instead of
   * fail-closing with 503 — bridge to the merged Rust `hub_capability_doctor` bin
   * (#658) via {@link rustCapabilityDoctor} and return its REFS-ONLY composite payload.
   * When falsy (the default) those routes are byte-identical to today: they fail-close
   * (503 TS_RUNTIME_PROVIDER_PROBE_RETIRED) unless the test-oracle flag re-enables the
   * legacy probe.
   *
   * SURFACE-SHAPE: the Rust bin is a fixed codex/claude (CLI) + deepseek/anthropic
   * (key) doctor with NO providerId input — it does NOT reproduce the legacy
   * per-`:providerId` validate/doctor shapes. Flipping this flag CHANGES the response
   * contract for clients — see the PR / operator note.
   *
   * QUOTA: only `capabilities.doctor` may opt into the bin's LIVE key-validation arm
   * (~1-2 Anthropic tokens), and ONLY on an explicit `validateKeys: true` request body
   * field; `providers.validate` / `providers.doctor` never pass `--validate-keys`. The
   * resolved boolean is supplied by the runtime (sourced from
   * `FRIDAY_ROUTE_PROVIDERS_VIA_RUST` / explicit config); this factory does NOT read
   * the env itself.
   */
  routeProvidersViaRust?: boolean;
  /**
   * The Rust capability-doctor bridge service consulted ONLY when
   * {@link routeProvidersViaRust} is `true`. Injected by the runtime (and by tests).
   * When the flag is on but this is absent, those routes fail closed.
   */
  rustCapabilityDoctor?: FridayRustHubCapabilityDoctorService;
  /**
   * Clock for the provider mutation plan store (plan TTL / confirm expiry checks).
   * Defaults to the wall clock; the runtime injects its canonical `nowIso`.
   */
  nowIso?: () => string;
  /**
   * Owner-confirm DEVICE-APPROVAL VERIFIER (SEC-APPROVAL-AUTHORITY-001 / CORE-A CR-2).
   *
   * The Hub holds NO signing key on the approval path. `providers.plan.confirm` no
   * longer MINTS an HMAC approval — it VERIFIES the owner device's P-256
   * proof-of-possession over the reviewed action digest with this asymmetric
   * verifier and, on success, returns the DEVICE-AUTHORED canonical approval. The
   * runtime injects `createFridayProviderApprovalPoPVerifier()`. When absent, the
   * confirm route fails closed (503); it never self-mints an approval.
   */
  providerApprovalVerifier?: FridayProviderApprovalPoPVerifier;
  /**
   * SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 (Option B*): resolve the authenticated
   * user's durable owner↔device binding SERVER-SIDE (`users.password_hash =
   * device-owner$v1$<hash>` → `<hash>`, else `null`). The runtime injects
   * `authService.resolveBoundDeviceOwnerSentinelHash`. Used to bind a device-authored
   * provider approval to the authenticated owner's REGISTERED device WITHOUT changing
   * token minting (`principalId=user.id`). When absent (test fixtures that never
   * device-claim), a device-authored approval fails closed at the binding check.
   */
  resolveBoundDeviceOwnerSentinelHash?: (userId: string) => string | null;
}

// ─── Provider mutation plan / owner-confirm protocol (CORE-RUNNABLE-001) ───

/** Plan lifetime. Deliberately <= the device approval's ~10 minute expiry. */
const PROVIDER_MUTATION_PLAN_TTL_MS = 10 * 60 * 1000;
/** Hard cap so an authenticated client cannot grow the plan store without bound. */
const PROVIDER_MUTATION_PLAN_MAX_ENTRIES = 256;
/**
 * Max lifetime the Hub will honour on a DEVICE-AUTHORED approval. The owner device
 * chooses the expiry; the Hub refuses one further out than this so a device cannot
 * mint a long-lived standing approval. Matches the plan TTL.
 */
const PROVIDER_MUTATION_APPROVAL_MAX_LIFETIME_MS = 10 * 60 * 1000;

const PROVIDER_PLANNABLE_ACTIONS = new Set<string>([
  "providers.create",
  "providers.update",
  "providers.delete",
  "providers.validate",
  "providers.routing.set",
  "providers.routing.pin",
  "providers.routing.penalty.clear",
  "providers.auth.profiles.activate",
  "providers.oauth.openai_codex.device.initiate",
  "providers.oauth.openai_codex.device.complete",
  "capabilities.doctor",
]);

/**
 * The single canonical description of a gated provider mutation: the exact
 * `{action, surface, resourceId, parameters}` tuple that feeds
 * {@link createFridayProviderSetupMutatingActionRequest}.
 *
 * Both the plan endpoint AND every mutation route derive their gate inputs from this
 * one builder, so a plan and the mutation it authorizes cannot drift apart.
 */
interface FridayProviderMutationDescriptor {
  readonly action: FridayProviderPlannableAction;
  readonly surface: string;
  readonly resourceId?: string;
  readonly parameters: Record<string, unknown>;
  /** Secret-free review lines shown to the owner before they confirm. */
  readonly humanReadableSummary: string[];
}

interface FridayProviderMutationPlanRecord {
  readonly planDigest: string;
  readonly actionDigest: string;
  readonly request: FridayMutatingActionRequest;
  readonly ownerPrincipalId: string;
  readonly action: FridayProviderPlannableAction;
  readonly surface: string;
  readonly resourceId?: string;
  readonly idempotencyKey?: string;
  readonly humanReadableSummary: string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  confirmedAt?: string;
}

function asProviderMutationRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body must be an object", { httpStatus: 400 });
  }
  return { ...(value as Record<string, unknown>) };
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireProviderMutationTargetId(value: string | undefined, field: string, action: string): string {
  const trimmed = readOptionalTrimmedString(value);
  if (!trimmed) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} is required to plan ${action}`,
      { httpStatus: 400 },
    );
  }
  return trimmed;
}

/**
 * DX-001 create-shape normalization (nested `config` → flat), extracted so the plan
 * endpoint and the create route normalize byte-identically before hashing.
 */
function liftProviderCreateConfigFields(
  rawInput: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const raw = rawInput ? { ...rawInput } : rawInput;
  if (raw && raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)) {
    const config = raw.config as Record<string, unknown>;
    const liftFields = [
      "api", "authMode", "supportedModels", "apiKey", "defaultModel", "headers",
      "backendKind", "cliConfig", "runtimeCapabilities", "deploymentKind", "regionTag",
    ] as const;
    for (const field of liftFields) {
      if (config[field] !== undefined && raw[field] === undefined) {
        raw[field] = config[field];
      }
    }
  }
  return raw;
}

function assertProviderRoutingControlBody(
  body: Record<string, unknown> | null,
): asserts body is Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  if (typeof body.providerId !== "string" || typeof body.model !== "string") {
    throw new FridayDomainError("VALIDATION_ERROR", "providerId and model are required", { httpStatus: 400 });
  }
  if (body.backendKind !== "http" && body.backendKind !== "cli" && body.backendKind !== "sdk") {
    throw new FridayDomainError("VALIDATION_ERROR", "backendKind must be one of: http, cli, sdk", { httpStatus: 400 });
  }
}

// ─── Secret-free plan summaries ───
//
// EVERY line below is built from an explicit allow-list of non-secret fields. An API
// key / token / header value is NEVER echoed: credentials are reported only as a
// presence boolean, and free-form header values only as a count.

function describeProviderCredentialFields(body: Record<string, unknown>, summary: string[]): void {
  if (body.apiKey !== undefined) {
    summary.push(
      typeof body.apiKey === "string" && body.apiKey.length > 0
        ? "Credential: a new API key will be stored encrypted (the key itself is never shown or echoed back)."
        : "Credential: the stored API key will be cleared.",
    );
  }
  if (body.headers !== undefined && body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    const count = Object.keys(body.headers as Record<string, unknown>).length;
    summary.push(`Custom headers: ${String(count)} header value(s) will be stored (values are not shown).`);
  }
}

function describeProviderShapeFields(body: Record<string, unknown>, summary: string[]): void {
  const labels: Array<[string, string]> = [
    ["kind", "Provider kind"],
    ["name", "Display name"],
    ["backendKind", "Backend"],
    ["baseUrl", "Endpoint"],
    ["api", "API dialect"],
    ["authMode", "Auth mode"],
    ["deploymentKind", "Deployment"],
    ["regionTag", "Region"],
    ["defaultModel", "Default model"],
  ];
  for (const [field, label] of labels) {
    if (typeof body[field] === "string" && (body[field] as string).length > 0) {
      summary.push(`${label}: ${body[field] as string}`);
    }
  }
  if (Array.isArray(body.supportedModels)) {
    summary.push(`Models: ${(body.supportedModels as unknown[]).map((m) => String(m)).join(", ")}`);
  }
  if (typeof body.enabled === "boolean") {
    summary.push(`Enabled: ${body.enabled ? "yes" : "no"}`);
  }
  if (typeof body.validateOnSave === "boolean") {
    summary.push(`Test the connection on save: ${body.validateOnSave ? "yes" : "no"}`);
  }
}

function summarizeProviderCreate(body: Record<string, unknown>): string[] {
  const summary = ["Add a new model provider connection to this Friday hub."];
  describeProviderShapeFields(body, summary);
  describeProviderCredentialFields(body, summary);
  return summary;
}

function summarizeProviderUpdate(providerId: string, body: Record<string, unknown>): string[] {
  const changed = Object.keys(body).sort();
  const summary = [
    `Change the saved settings of provider "${providerId}".`,
    changed.length > 0 ? `Fields changed: ${changed.join(", ")}` : "Fields changed: (none)",
  ];
  describeProviderShapeFields(body, summary);
  describeProviderCredentialFields(body, summary);
  return summary;
}

function summarizeProviderRoutingSet(body: Record<string, unknown>): string[] {
  const summary = ["Change which provider Friday uses to answer by default."];
  if (typeof body.defaultProviderId === "string") {
    summary.push(`Default provider: ${body.defaultProviderId}`);
  }
  if (typeof body.defaultModel === "string") {
    summary.push(`Default model: ${body.defaultModel}`);
  }
  if (Array.isArray(body.fallbackProviderIds)) {
    const fallbacks = (body.fallbackProviderIds as unknown[]).map((id) => String(id));
    summary.push(`Fallback providers: ${fallbacks.length > 0 ? fallbacks.join(", ") : "(none)"}`);
  }
  if (typeof body.costMode === "string") {
    summary.push(`Cost mode: ${body.costMode}`);
  }
  if (typeof body.enforceRequestedModel === "boolean") {
    summary.push(`Enforce requested model: ${body.enforceRequestedModel ? "yes" : "no"}`);
  }
  return summary;
}

/**
 * Builds the canonical gate descriptor for one provider mutation.
 *
 * SECURITY: this is the ONLY place `{action, surface, resourceId, parameters}` is
 * decided. The plan endpoint and the mutation routes both call it, so the digest the
 * owner confirms and the digest the gate recomputes are produced by the same code on
 * the same inputs. It performs the same validation the mutation performs, so an
 * invalid plan is rejected up front instead of minting an unusable approval.
 */
function buildFridayProviderMutationDescriptor(input: {
  action: string;
  providerId?: string;
  profileKey?: string;
  /**
   * Owner user id, required by the provider-OAuth actions whose gate parameters are
   * owner-scoped. It is supplied by the SERVER from the authenticated principal at
   * both plan and mutation time (never read from the request body), so a plan minted
   * for one owner can never authorize another owner's OAuth mutation.
   */
  ownerUserId?: string;
  body: unknown;
}): FridayProviderMutationDescriptor {
  const action = input.action;
  if (!PROVIDER_PLANNABLE_ACTIONS.has(action)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `action must be one of: ${[...PROVIDER_PLANNABLE_ACTIONS].join(", ")}`,
      { httpStatus: 400 },
    );
  }

  switch (action as FridayProviderPlannableAction) {
    case "providers.create": {
      const raw = liftProviderCreateConfigFields(asProviderMutationRecord(input.body));
      const body = raw ? stripProviderMutationControlFields(raw) : raw;
      validateCreateBody(body);
      const parameters = body as unknown as Record<string, unknown>;
      return {
        action: "providers.create",
        surface: "api:/v1/providers/create",
        parameters,
        humanReadableSummary: summarizeProviderCreate(parameters),
      };
    }
    case "providers.update": {
      const providerId = requireProviderMutationTargetId(input.providerId, "providerId", action);
      const raw = asProviderMutationRecord(input.body);
      const body = raw ? stripProviderMutationControlFields(raw) : raw;
      validateUpdateBody(body);
      const patch = body as unknown as Record<string, unknown>;
      return {
        action: "providers.update",
        surface: "api:/v1/providers/update",
        resourceId: providerId,
        parameters: { providerId, patch },
        humanReadableSummary: summarizeProviderUpdate(providerId, patch),
      };
    }
    case "providers.delete": {
      const providerId = requireProviderMutationTargetId(input.providerId, "providerId", action);
      return {
        action: "providers.delete",
        surface: "api:/v1/providers/delete",
        resourceId: providerId,
        parameters: { providerId },
        humanReadableSummary: [
          `Delete provider connection "${providerId}" from this hub.`,
          "The stored credential for this provider is removed and any routing that points at it stops working.",
        ],
      };
    }
    case "providers.validate": {
      const providerId = requireProviderMutationTargetId(input.providerId, "providerId", action);
      return {
        action: "providers.validate",
        surface: "api:/v1/providers/validate",
        resourceId: providerId,
        parameters: { providerId },
        humanReadableSummary: [
          `Test the stored credential of provider "${providerId}" against its endpoint.`,
          "This contacts the provider and records the validation result on the profile.",
        ],
      };
    }
    case "providers.routing.set": {
      const raw = asProviderMutationRecord(input.body);
      const body = raw ? stripProviderMutationControlFields(raw) : raw;
      validateRoutingBody(body);
      const parameters = body as unknown as Record<string, unknown>;
      return {
        action: "providers.routing.set",
        surface: "api:/v1/model-routing/set",
        resourceId: "model-routing",
        parameters,
        humanReadableSummary: summarizeProviderRoutingSet(parameters),
      };
    }
    case "providers.routing.pin":
    case "providers.routing.penalty.clear": {
      const raw = asProviderMutationRecord(input.body);
      const body = raw ? stripProviderMutationControlFields(raw) : raw;
      assertProviderRoutingControlBody(body);
      const resourceId = `${String(body.providerId)}:${String(body.model)}:${String(body.backendKind)}`;
      const pinning = action === "providers.routing.pin";
      return {
        action: pinning ? "providers.routing.pin" : "providers.routing.penalty.clear",
        surface: pinning ? "api:/v1/providers/routing/pin" : "api:/v1/providers/routing/penalties/clear",
        resourceId,
        parameters: body,
        humanReadableSummary: [
          pinning
            ? `Pin routing to provider "${String(body.providerId)}" model "${String(body.model)}" (${String(body.backendKind)}).`
            : `Clear the routing penalty on provider "${String(body.providerId)}" model "${String(body.model)}" (${String(body.backendKind)}).`,
        ],
      };
    }
    case "providers.auth.profiles.activate": {
      const providerId = requireProviderMutationTargetId(input.providerId, "providerId", action);
      const profileKey = requireProviderMutationTargetId(input.profileKey, "profileKey", action);
      return {
        action: "providers.auth.profiles.activate",
        surface: "api:/v1/providers/auth-profiles/activate",
        resourceId: `${providerId}:${profileKey}`,
        parameters: { providerId, profileKey },
        humanReadableSummary: [
          `Switch provider "${providerId}" to auth profile "${profileKey}".`,
          "Later requests to this provider will use that profile's stored credential.",
        ],
      };
    }
    case "providers.oauth.openai_codex.device.initiate":
    case "providers.oauth.openai_codex.device.complete": {
      const ownerUserId = requireProviderMutationTargetId(input.ownerUserId, "ownerUserId", action);
      const raw = asProviderMutationRecord(input.body);
      const body = raw ? stripProviderMutationControlFields(raw) : raw;
      const completing = action === "providers.oauth.openai_codex.device.complete";
      if (completing) {
        // Same validation the mutation performs, so an unusable plan is refused up
        // front. The device code VALUE never enters the descriptor (only its
        // presence), so it can never reach a digest, a summary or a stored plan.
        if (!body || typeof body.deviceCodeId !== "string" || body.deviceCodeId.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "deviceCodeId is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
      }
      const selection = readOAuthSelectionInput(body, "openai-codex");
      const resourceId = readOptionalTrimmedString(body?.providerId) ?? "openai-codex";
      const summary = completing
        ? [
          `Finish signing in to OpenAI Codex and store the resulting login on provider "${resourceId}".`,
          "The device code and the returned tokens are never shown here; they are stored encrypted.",
        ]
        : [
          `Start an OpenAI Codex device sign-in for provider "${resourceId}".`,
          "This asks OpenAI for a device code you will approve in your browser; no credential is stored yet.",
        ];
      if (selection.kind) {
        summary.push(`Provider kind: ${selection.kind}`);
      }
      if (selection.name) {
        summary.push(`Display name: ${selection.name}`);
      }
      if (selection.defaultModel) {
        summary.push(`Default model: ${selection.defaultModel}`);
      }
      return {
        action: completing
          ? "providers.oauth.openai_codex.device.complete"
          : "providers.oauth.openai_codex.device.initiate",
        surface: completing
          ? "api:/v1/auth/oauth/openai-codex/device/complete"
          : "api:/v1/auth/oauth/openai-codex/device/initiate",
        resourceId,
        parameters: completing
          ? { ownerUserId, selection, deviceCodeIdPresent: true }
          : { ownerUserId, selection },
        humanReadableSummary: summary,
      };
    }
    case "capabilities.doctor": {
      const providerIds = parseCapabilityDoctorProviderIds(input.body ?? undefined);
      return {
        action: "capabilities.doctor",
        surface: "api:/v1/capabilities/doctor",
        resourceId: providerIds ? providerIds.join(",") : "all-providers",
        parameters: { providerIds: providerIds ?? "all-providers" },
        humanReadableSummary: [
          providerIds
            ? `Run the capability doctor against provider(s): ${providerIds.join(", ")}.`
            : "Run the capability doctor against every configured provider.",
          "This contacts the providers and records capability proof results.",
        ],
      };
    }
  }
}

/**
 * SERVER-SIDE plan digest. Derived only from the sanitized (secret-redacted)
 * parameters plus the immutable identity of the mutation, never from anything the
 * client asserts. Deterministic on purpose: re-planning the same change for the same
 * owner yields the same digest, so a stale digest is detectable.
 */
function computeFridayProviderMutationPlanDigest(input: {
  descriptor: FridayProviderMutationDescriptor;
  ownerPrincipalId: string;
  idempotencyKey?: string;
}): string {
  const sanitizedParameters = sanitizeProviderMutationParameters(input.descriptor.parameters);
  return `fpmp_${hashStableJson({
    version: 1,
    kind: "friday.provider.mutation.plan",
    action: input.descriptor.action,
    surface: input.descriptor.surface,
    resourceId: input.descriptor.resourceId,
    ownerPrincipalId: input.ownerPrincipalId,
    parameters: sanitizedParameters,
    idempotencyKey: input.idempotencyKey,
  })}`;
}

export function createFridayProviderSetupMutatingActionRequest(input: {
  action: string;
  actor: FridayMutatingActionActor;
  surface: string;
  resourceId?: string;
  parameters: Record<string, unknown>;
  planDigest?: string;
  idempotencyKey?: string;
}): FridayMutatingActionRequest {
  const sanitizedParameters = sanitizeProviderMutationParameters(input.parameters) as Readonly<Record<string, unknown>>;
  return {
    action: input.action,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: input.action.startsWith("providers.routing.")
        ? "provider_routing"
        : input.action.startsWith("providers.budget.")
          ? "provider_budget"
          : "provider_setup",
      id: input.resourceId,
      digest: hashStableJson(sanitizedParameters),
      attributes: {
        providerAction: input.action,
        resourceId: input.resourceId,
      },
    },
    mutating: true,
    risk: "high",
    parameters: sanitizedParameters,
    planDigest: input.planDigest,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "provider_setup_mutation_guard",
        decision: "requires_approval",
        risk: "high",
        reason: "provider_setup_routing_or_budget_mutation_requires_canonical_approval",
      },
    ],
  };
}

// ─── Retirement helpers ───
//
// The provider probe surfaces (validate / doctor / capabilities.doctor) run
// transient TypeScript capability/key-validation product logic via
// providerService: validateProvider probes the provider connection and writes
// validation state; runCapabilityDoctor validates + runs live capability
// probes; doctorProvider computes a backend/auth/routing health diagnostic
// (read-shaped, with a live cli-session probe in the CLI branch). The
// routing-controls surfaces (routing.pin / routing.penalty.clear) write
// user-scoped routing state. They fail-close by default/live until Rust owns
// the corresponding entrypoints; legacy behavior is reachable only through the
// explicit per-group test-oracle flags. The model-routing config reads/writes
// (GET/PUT /v1/model-routing) and the provider CRUD/OAuth adapters stay
// operator_external_adapter and are NOT covered here.

function throwRetiredProviderRuntime(
  code: string,
  label: string,
  replacement: string,
): never {
  throw new FridayDomainError(
    code,
    `${label} is fail-closed in default/live runtime; use the Rust-owned ${replacement} entrypoint.`,
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: `rust_owned_${replacement}_entrypoint_required`,
      },
    },
  );
}

function assertProviderProbeTestOracleAllowed(deps: FridayProviderRoutesDeps): void {
  if (deps.allowTestOnlyProviderProbeExecution !== true) {
    throwRetiredProviderRuntime(
      "TS_RUNTIME_PROVIDER_PROBE_RETIRED",
      "TypeScript provider probe execution",
      "provider_probe",
    );
  }
}

function assertProviderRoutingControlsTestOracleAllowed(deps: FridayProviderRoutesDeps): void {
  if (deps.allowTestOnlyProviderRoutingControlsExecution !== true) {
    throwRetiredProviderRuntime(
      "TS_RUNTIME_PROVIDER_ROUTING_CONTROLS_RETIRED",
      "TypeScript provider routing-controls execution",
      "provider_routing_controls",
    );
  }
}

// ─── Factory ───

export function createFridayProviderRoutes(
  deps: FridayProviderRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function readProviderMutationControls(body: Record<string, unknown> | null | undefined): {
    planDigest?: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  } {
    return {
      planDigest: typeof body?.planDigest === "string" ? body.planDigest : undefined,
      idempotencyKey: typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      canonicalApproval: readCanonicalApproval(body?.canonicalApproval),
    };
  }

  const nowIso = deps.nowIso ?? ((): string => new Date().toISOString());

  /**
   * Owner-confirm plan store. In-memory and process-local BY DESIGN: a plan is a
   * short-lived, unprivileged review artifact — losing it on restart only forces a
   * re-plan (fail-closed), while persisting it would create a durable record keyed to
   * a mutation the owner may never confirm.
   */
  const providerMutationPlans = new Map<string, FridayProviderMutationPlanRecord>();

  function pruneProviderMutationPlans(): void {
    const nowMs = Date.parse(nowIso());
    for (const [key, record] of providerMutationPlans) {
      const expiresAtMs = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
        providerMutationPlans.delete(key);
      }
    }
    while (providerMutationPlans.size > PROVIDER_MUTATION_PLAN_MAX_ENTRIES) {
      const oldest = providerMutationPlans.keys().next();
      if (oldest.done) break;
      providerMutationPlans.delete(oldest.value);
    }
  }

  /**
   * The plan + confirm endpoints require exactly the authority the mutation requires:
   * a bound (non-synthetic) owner principal. The HTTP server already refuses the
   * synthetic public principal on public POST routes; this is the in-handler
   * restatement so the seam is fail-closed for every caller of the factory.
   */
  function requireProviderMutationOwnerPrincipalId(principal: FridayAuthPrincipal | null): string {
    if (isUnauthenticatedPublicPrincipal(principal) || !principal?.principalId) {
      throw new FridayDomainError(
        "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
        "Provider setup planning and confirmation require a bound owner principal; the synthetic public principal cannot review or approve provider mutations.",
        { httpStatus: 401 },
      );
    }
    return principal.principalId;
  }

  function maybeRequireProviderMutationTicket(input: {
    descriptor: FridayProviderMutationDescriptor;
    ctx: { requestId: string; principal: FridayAuthPrincipal | null };
    body?: Record<string, unknown> | null;
  }): FridayMutatingActionTicket | undefined {
    const { action, surface, resourceId, parameters } = input.descriptor;
    if (!deps.providerMutationGateRequired) {
      return undefined;
    }
    if (!deps.canonicalMutationGate) {
      throw new FridayDomainError(
        "PROVIDER_MUTATION_CANONICAL_GATE_UNAVAILABLE",
        "Provider setup and routing mutations require the canonical approval gate in this profile.",
        { httpStatus: 503 },
      );
    }
    const controls = readProviderMutationControls(input.body);
    if (!controls.planDigest) {
      throw new FridayDomainError(
        "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED",
        "Provider setup and routing mutations require an approved plan digest in this profile. "
          + "Call POST /v1/providers/plan, review the returned summary, then POST /v1/providers/plan/confirm.",
        { httpStatus: 403, details: { action, resourceId } },
      );
    }
    // SEC-APPROVAL-AUTHORITY-001 negative control (Hub self-sign / shared-HMAC leak):
    // a provider mutation admits ONLY on a DEVICE-AUTHORED approval. Any Hub-minted
    // symmetric-HMAC approval (`friday_canonical_gate`) — or an issuer-less one — is
    // refused at the seam BEFORE the gate, so the Hub can never verify its own
    // signature on the provider path.
    if (controls.canonicalApproval && controls.canonicalApproval.issuer !== "friday_device_owner") {
      throw new FridayDomainError(
        "PROVIDER_MUTATION_APPROVAL_NOT_DEVICE_AUTHORED",
        "Provider mutations require a device-authored owner approval; a Hub-signed or unsigned approval is refused.",
        { httpStatus: 403, details: { action, resourceId } },
      );
    }
    // The digest of record is recomputed HERE, server-side, from the sanitized
    // parameters this request actually carries. The client-supplied `planDigest` is
    // only an input to that computation — it is never trusted as the truth, and any
    // drift between what was confirmed and what arrived changes the action digest and
    // is refused below as `canonical_approval_digest_mismatch`.
    const request = createFridayProviderSetupMutatingActionRequest({
      action,
      actor: createActorFromPrincipal(
        input.ctx.principal,
        `api:${input.ctx.requestId}`,
        deps.resolveBoundDeviceOwnerSentinelHash,
      ),
      surface,
      resourceId,
      parameters,
      planDigest: controls.planDigest,
      idempotencyKey: controls.idempotencyKey,
    });
    const gateResult = deps.canonicalMutationGate.evaluate({
      ...request,
      canonicalApproval: controls.canonicalApproval,
    });
    if (gateResult.decision !== "allow" || !gateResult.ticket) {
      throw new FridayDomainError(
        gateResult.decision === "requires_approval"
          ? "CANONICAL_APPROVAL_REQUIRED"
          : "CANONICAL_APPROVAL_DENIED",
        gateResult.decision === "requires_approval"
          ? "Provider setup or routing mutation requires canonical approval before any mutation."
          : `Provider setup or routing mutation was blocked by the canonical approval gate: ${gateResult.reason}`,
        {
          httpStatus: 403,
          details: {
            canonicalGate: gateResult.evidenceRecord,
            actionDigest: gateResult.actionDigest,
          },
        },
      );
    }
    return gateResult.ticket;
  }

  async function listHealthSnapshot(): Promise<FridayGetProviderHealthSnapshotResponse> {
    const providers = await deps.providerService.listProviders();
    const routing = await deps.providerService.getRoutingConfig().catch((): FridayModelRoutingConfig => ({
      defaultProviderId: "",
      fallbackProviderIds: [],
    }));
    const healthCapable = deps.providerService as FridayProviderService & {
      getProviderFallbackState?: (
        providerId: string,
      ) => {
        circuitState: "closed" | "cooldown" | "unknown";
        lastFailureAt?: string;
        cooldownRemainingMs?: number;
      };
    };

    const items = await Promise.all(
      providers.map(async (provider) => {
        const doctor = await deps.providerService.doctorProvider(provider.id);
        const fallbackState = healthCapable.getProviderFallbackState?.(provider.id);
        const lane: FridayProviderLane = !provider.enabled
          ? "disabled"
          : provider.id === routing.defaultProviderId
            ? "primary"
            : routing.fallbackProviderIds.includes(provider.id)
              ? "fallback"
              : "standby";
        const validationStatus = provider.config.validation?.status ?? "never";
        const reasons = Array.from(new Set([
          ...doctor.reasons,
          ...(validationStatus === "failed" ? ["validation_failed"] : []),
          ...(validationStatus !== "ok" && validationStatus !== "failed" ? ["validation_unverified"] : []),
        ]));
        const suggestedAction = !provider.enabled
          ? "Enable the provider before using it for routing."
          : fallbackState?.circuitState === "cooldown"
            ? "Wait for cooldown to expire or route around this provider for now."
            : validationStatus === "failed"
              ? "Re-validate credentials or base URL before promoting this provider."
              : validationStatus !== "ok"
                ? "Validate this provider before using it for routing."
              : doctor.routingEligible
                ? lane === "primary"
                  ? "Keep this provider healthy; it is the current default lane."
                  : "Promote this provider into fallback or primary only when you need broader resilience."
                : "Fix the reported doctor reasons before using this provider in routing.";

        return {
          providerId: provider.id,
          providerKind: provider.kind,
          lane,
          enabled: provider.enabled,
          defaultModel: provider.defaultModel,
          backendKind: doctor.backendKind,
          authMode: doctor.authMode,
          backendHealth: doctor.backendHealth,
          authHealth: doctor.authHealth,
          routingEligible: doctor.routingEligible,
          validationStatus,
          circuitState: fallbackState?.circuitState ?? "unknown",
          cooldownRemainingMs: fallbackState?.cooldownRemainingMs,
          lastFailureAt: fallbackState?.lastFailureAt,
          reasons,
          suggestedAction,
        };
      }),
    );
    return { items };
  }

  function summarizeCapabilityHealth(
    items: FridayGetProviderCapabilityHealthSnapshotResponse["items"],
  ): FridayProviderCapabilityHealthSnapshotSummary {
    const summary: FridayProviderCapabilityHealthSnapshotSummary = {
      available: 0,
      setupNeeded: 0,
      proofPending: 0,
      disabled: 0,
      unsupported: 0,
    };
    for (const item of items) {
      for (const capability of item.capabilities) {
        if (capability.state === "available") summary.available += 1;
        if (capability.state === "setup_needed") summary.setupNeeded += 1;
        if (capability.state === "proof_pending") summary.proofPending += 1;
        if (capability.state === "disabled") summary.disabled += 1;
        if (capability.state === "unsupported") summary.unsupported += 1;
      }
    }
    return summary;
  }

  function providerHealthCapabilityBlock(input: {
    provider: FridayProviderProfile;
    healthItem: FridayProviderHealthSnapshotItem | undefined;
  }): Pick<FridayProviderCapabilityHealthCapabilityItem, "state" | "source" | "message"> | null {
    const { provider, healthItem } = input;
    const validationStatus = healthItem?.validationStatus ?? provider.config.validation?.status ?? "never";
    const backendHealth = healthItem?.backendHealth ?? "status_unknown";
    const authHealth = healthItem?.authHealth ?? "status_unknown";

    if (!provider.enabled) {
      return {
        state: "disabled",
        source: "provider_health_snapshot",
        message: "Provider is disabled; enable it before this capability can be used.",
      };
    }
    if (backendHealth === "unsupported" || authHealth === "unsupported") {
      return {
        state: "unsupported",
        source: "provider_health_snapshot",
        message: "Provider backend or auth mode is unsupported for this capability.",
      };
    }
    if (backendHealth === "missing" || authHealth === "missing" || validationStatus === "failed") {
      return {
        state: "setup_needed",
        source: "provider_health_snapshot",
        message: provider.config.validation?.errorMessage
          ?? "Provider setup or validation is failing; fix credentials or connection before claiming this capability.",
      };
    }
    if (validationStatus !== "ok") {
      return {
        state: "setup_needed",
        source: "provider_health_snapshot",
        message: "Provider validation has not passed; validate credentials before claiming this capability.",
      };
    }
    return null;
  }

  function runtimeCapabilityHealthState(
    declaration: FridayProviderRuntimeCapabilityDeclaration,
  ): Pick<FridayProviderCapabilityHealthCapabilityItem, "state" | "source" | "message"> {
    if (declaration.status === "verified" && declaration.verified === true) {
      return {
        state: "available",
        source: "runtime_capability_snapshot",
        message: declaration.notes ?? "Capability is available because it passed a persisted capability doctor proof.",
      };
    }
    if (declaration.status === "failed" || declaration.verified === false) {
      return {
        state: "setup_needed",
        source: "runtime_capability_snapshot",
        message: declaration.notes ?? "Capability failed its latest persisted proof; rerun setup or validation before use.",
      };
    }
    return {
      state: "proof_pending",
      source: "declared_configuration",
      message: declaration.notes ?? "Capability is declared but has not passed a persisted live proof yet.",
    };
  }

  function deriveCapabilityHealthCapability(input: {
    provider: FridayProviderProfile;
    healthItem: FridayProviderHealthSnapshotItem | undefined;
    declaration: FridayProviderRuntimeCapabilityDeclaration;
  }): FridayProviderCapabilityHealthCapabilityItem {
    const { provider, healthItem, declaration } = input;
    const blockerCodes = Array.from(new Set(healthItem?.reasons ?? []));
    const checkedAt = declaration.verifiedAt ?? provider.config.validation?.checkedAt;
    const healthBlock = providerHealthCapabilityBlock({ provider, healthItem });
    const state = healthBlock ?? runtimeCapabilityHealthState(declaration);
    const base = {
      capability: declaration.capability,
      ...(declaration.model ? { model: declaration.model } : {}),
      blockerCodes,
      ...(checkedAt ? { checkedAt } : {}),
      ...(declaration.verifiedAt ? { lastVerifiedAt: declaration.verifiedAt } : {}),
    };
    return {
      ...base,
      ...state,
    };
  }

  async function listCapabilityHealthSnapshot(): Promise<FridayGetProviderCapabilityHealthSnapshotResponse> {
    const providers = await deps.providerService.listProviders();
    const health = await listHealthSnapshot();
    const healthByProviderId = new Map(health.items.map((item) => [item.providerId, item]));
    const items = providers.map((provider) => {
      const declarations = provider.config.runtimeCapabilities?.length
        ? provider.config.runtimeCapabilities
        : [{
            capability: "text" as FridayRuntimeCapabilityId,
            ...(provider.defaultModel ?? provider.config.supportedModels[0]
              ? { model: provider.defaultModel ?? provider.config.supportedModels[0] }
              : {}),
            status: "declared" as const,
          }];
      const healthItem = healthByProviderId.get(provider.id);
      return {
        providerId: provider.id,
        providerKind: provider.kind,
        providerName: provider.name,
        lane: healthItem?.lane ?? (provider.enabled ? "standby" : "disabled"),
        enabled: provider.enabled,
        validationStatus: healthItem?.validationStatus ?? provider.config.validation?.status ?? "never",
        capabilities: declarations.map((declaration) =>
          deriveCapabilityHealthCapability({ provider, healthItem, declaration }),
        ),
      };
    });
    return {
      items,
      summary: summarizeCapabilityHealth(items),
    };
  }

  /**
   * DARK cut-over bridge for the retired provider-probe routes. Returns the Rust
   * `hub_capability_doctor` refs-only payload. Fails closed (503) when the flag is on
   * but the bridge was not wired. `validateKeys` is forwarded ONLY where an explicit
   * request opts in (capabilities.doctor); the other probe routes pass false → the
   * bin's zero-quota CLI-detect-only default.
   */
  async function bridgeCapabilityDoctorViaRust(
    validateKeys: boolean,
  ): Promise<FridayRustCapabilityDoctorReceipt> {
    if (!deps.rustCapabilityDoctor) {
      throwRetiredProviderRuntime(
        "TS_RUNTIME_PROVIDER_PROBE_RETIRED",
        "TypeScript provider probe execution (Rust route enabled but capability-doctor bridge not wired)",
        "provider_probe",
      );
    }
    return deps.rustCapabilityDoctor.doctor({ validateKeys });
  }

  return [
    {
      operationId: "providers.templates.list",
      method: "GET",
      path: "/v1/providers/templates",
      auth: { public: true },
      async handler(): Promise<FridayListProviderTemplatesResponse> {
        return { items: listFridayProviderTemplates() };
      },
    },

    // ─── Plan a provider mutation (step 1 of the owner-confirm protocol) ───
    //
    // READ-SHAPED: builds and records a review artifact. It performs NO provider
    // mutation, mints NO approval and grants NO authority — the returned digests are
    // useless until the same owner explicitly confirms them at
    // POST /v1/providers/plan/confirm.
    {
      operationId: "providers.plan",
      method: "POST",
      path: "/v1/providers/plan",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayPlanProviderMutationResponse> {
        const ownerPrincipalId = requireProviderMutationOwnerPrincipalId(ctx.principal);
        const body = asProviderMutationRecord(ctx.body);
        const action = typeof body?.action === "string" ? body.action.trim() : "";
        const idempotencyKey = readOptionalTrimmedString(body?.idempotencyKey);
        const descriptor = buildFridayProviderMutationDescriptor({
          action,
          providerId: readOptionalTrimmedString(body?.providerId),
          profileKey: readOptionalTrimmedString(body?.profileKey),
          // SERVER-supplied, never client-supplied: the owner identity that the
          // mutation route will itself derive from its own authenticated principal.
          ownerUserId: readOptionalTrimmedString(ctx.principal?.userId),
          body: body?.params ?? null,
        });

        const planDigest = computeFridayProviderMutationPlanDigest({
          descriptor,
          ownerPrincipalId,
          idempotencyKey,
        });
        // Same builder + same digest function the mutation route will use, so the
        // action digest the owner confirms is byte-identical to the one the gate
        // recomputes when the mutation actually arrives.
        const request = createFridayProviderSetupMutatingActionRequest({
          action: descriptor.action,
          actor: createActorFromPrincipal(
            ctx.principal,
            `api:${ctx.requestId}`,
            deps.resolveBoundDeviceOwnerSentinelHash,
          ),
          surface: descriptor.surface,
          resourceId: descriptor.resourceId,
          parameters: descriptor.parameters,
          planDigest,
          idempotencyKey,
        });
        const actionDigest = createFridayMutatingActionDigest(request);

        const createdAt = nowIso();
        const createdAtMs = Date.parse(createdAt);
        const expiresAt = new Date(
          (Number.isFinite(createdAtMs) ? createdAtMs : Date.now()) + PROVIDER_MUTATION_PLAN_TTL_MS,
        ).toISOString();

        pruneProviderMutationPlans();
        // A fresh plan always REPLACES any earlier record for the same digest, and is
        // always unconfirmed: planning can never resurrect a spent confirmation.
        providerMutationPlans.delete(planDigest);
        providerMutationPlans.set(planDigest, {
          planDigest,
          actionDigest,
          request,
          ownerPrincipalId,
          action: descriptor.action,
          surface: descriptor.surface,
          resourceId: descriptor.resourceId,
          idempotencyKey,
          humanReadableSummary: descriptor.humanReadableSummary,
          createdAt,
          expiresAt,
        });

        const plan: FridayProviderMutationPlan = {
          planDigest,
          actionDigest,
          action: descriptor.action,
          surface: descriptor.surface,
          resourceId: descriptor.resourceId,
          idempotencyKey,
          humanReadableSummary: descriptor.humanReadableSummary,
          approvalRequired: deps.providerMutationGateRequired === true,
          createdAt,
          expiresAt,
        };
        return { plan };
      },
    },

    // ─── Confirm a provider mutation plan (step 2: the owner's explicit decision) ───
    //
    // This is the ONLY seam that mints a provider-setup canonical approval. It refuses
    // unless: the caller is the SAME bound owner principal that created the plan; the
    // plan digest names a plan THIS server produced; that plan has not expired; and it
    // has not already been confirmed. There is no plan-and-approve shortcut anywhere —
    // the mutation route never calls this, so an approval can only exist because a
    // human owner asked for it against a summary they were shown.
    {
      operationId: "providers.plan.confirm",
      method: "POST",
      path: "/v1/providers/plan/confirm",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayConfirmProviderMutationResponse> {
        const ownerPrincipalId = requireProviderMutationOwnerPrincipalId(ctx.principal);
        const body = asProviderMutationRecord(ctx.body);
        const planDigest = readOptionalTrimmedString(body?.planDigest);
        if (!planDigest) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "planDigest is required to confirm a provider mutation plan",
            { httpStatus: 400 },
          );
        }
        if (body?.confirm !== true) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_CONFIRMATION_REQUIRED",
            "Provider mutation approval requires an explicit owner confirmation (`confirm: true`) of the reviewed plan.",
            { httpStatus: 400 },
          );
        }
        // SEC-APPROVAL-AUTHORITY-001: the Hub holds NO signing key. It can only
        // VERIFY the owner device's proof. A runtime without the asymmetric verifier
        // fails closed — it NEVER self-mints an approval.
        if (!deps.providerApprovalVerifier) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_APPROVAL_VERIFIER_UNAVAILABLE",
            "This runtime cannot verify device-authored provider approvals; the asymmetric approval verifier is not wired.",
            { httpStatus: 503 },
          );
        }
        const deviceProof = readDeviceApprovalProof(body?.deviceApproval);

        pruneProviderMutationPlans();
        const record = providerMutationPlans.get(planDigest);
        if (!record) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_PLAN_NOT_FOUND",
            "No live provider mutation plan matches that plan digest. Re-plan the change and review it again.",
            { httpStatus: 404 },
          );
        }
        if (record.ownerPrincipalId !== ownerPrincipalId) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_PLAN_OWNER_MISMATCH",
            "A provider mutation plan can only be confirmed by the owner principal that created it.",
            { httpStatus: 403 },
          );
        }
        if (record.confirmedAt !== undefined) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_PLAN_ALREADY_CONFIRMED",
            "That provider mutation plan has already been confirmed. Re-plan the change to confirm it again.",
            { httpStatus: 409 },
          );
        }

        // ─── ASYMMETRIC device proof-of-possession (verify-only; sync, no side effect) ───
        const confirmedAt = nowIso();
        const nowMs = Date.parse(confirmedAt);
        const verified = deps.providerApprovalVerifier.verifyPossession({
          transcript: deviceProof.transcript,
          devicePublicKey: deviceProof.devicePublicKey,
          signature: deviceProof.signature,
          nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
        });
        if (!verified.ok) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_APPROVAL_SIGNATURE_INVALID",
            "The device-authored approval could not be verified; it was not signed by a valid owner device key over this action.",
            { httpStatus: 403, details: { reason: verified.reason } },
          );
        }
        // (1) The signed transcript must bind the EXACT reviewed action digest.
        if (verified.actionDigest !== record.actionDigest) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_APPROVAL_DIGEST_MISMATCH",
            "The device-authored approval did not bind to the reviewed plan's action digest; refusing it.",
            { httpStatus: 403 },
          );
        }
        // (2) DURABLE owner-device binding (Option B*): the approval's signing device
        //     MUST be the device registered to the AUTHENTICATED owner
        //     (`users.password_hash = device-owner$v1$<hash>`), compared with the
        //     sentinel's OWN convention `sha256Hex(devicePublicKey)` — the same one
        //     `deviceKeyLogin` already trusts. The acting `principalId` stays `user.id`
        //     (token minting is unchanged); a passphrase / unclaimed owner has NO
        //     sentinel → refused. This resolves the authenticated owner's binding
        //     SERVER-SIDE and never trusts a request-supplied principal.
        const boundSentinelHash = deps.resolveBoundDeviceOwnerSentinelHash?.(
          ctx.principal?.userId ?? ownerPrincipalId,
        ) ?? null;
        if (
          boundSentinelHash === null
          || createHash("sha256").update(deviceProof.devicePublicKey.value).digest("hex")
            !== boundSentinelHash
        ) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_APPROVAL_DEVICE_NOT_BOUND",
            "The device-authored approval was not signed by the authenticated owner's registered device.",
            { httpStatus: 403 },
          );
        }
        // (2b) CANONICAL self-consistency (unchanged intent): the approval's declared
        //      principal must match its signing device key hash
        //      (`canonicalDevicePublicKeyHash`), so a valid proof cannot carry a
        //      foreign owner principal.
        if (deviceOwnerPrincipalId(verified.devicePublicKeyHash) !== verified.decidedByPrincipalId) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_APPROVAL_PRINCIPAL_MISMATCH",
            "The device-authored approval's declared principal does not match its signing device key.",
            { httpStatus: 403 },
          );
        }
        // (3) Bound expiry: present, in the future, and no longer than the max lifetime.
        const expiresAtMs = Date.parse(verified.expiresAt);
        if (
          !Number.isFinite(expiresAtMs)
          || !Number.isFinite(nowMs)
          || expiresAtMs <= nowMs
          || expiresAtMs - nowMs > PROVIDER_MUTATION_APPROVAL_MAX_LIFETIME_MS
        ) {
          throw new FridayDomainError(
            "PROVIDER_MUTATION_APPROVAL_EXPIRY_INVALID",
            "The device-authored approval's expiry is missing, in the past, or beyond the allowed lifetime.",
            { httpStatus: 403 },
          );
        }

        // Single-use at the plan layer: spend the record AFTER a successful verify
        // (verifyPossession is synchronous, so the check-then-set below cannot
        // interleave with a concurrent confirm of the same plan).
        record.confirmedAt = confirmedAt;

        // The Hub adds NO signature. It returns the DEVICE-AUTHORED approval, which the
        // admission gate re-verifies asymmetrically against the same device proof.
        // `decidedByPrincipalId` is the DEVICE principal from the verified transcript
        // (`device-owner:<canonicalDevicePublicKeyHash>`), NOT the acting `user.id` —
        // so the gate's canonical self-consistency (`deviceOwnerPrincipalId(verified
        // .devicePublicKeyHash) === decidedByPrincipalId`) holds at mutate time. The
        // durable owner↔device binding was enforced above (sentinel) and is re-enforced
        // by the gate via the actor's server-resolved `boundDeviceOwnerSentinelHash`.
        const canonicalApproval: FridayCanonicalApprovalResolution = {
          decision: "approved",
          approvalId: verified.approvalId,
          decidedByPrincipalId: verified.decidedByPrincipalId,
          actionDigest: record.actionDigest,
          expiresAt: verified.expiresAt,
          issuer: "friday_device_owner",
          deviceProof,
        };

        return {
          approval: {
            planDigest: record.planDigest,
            actionDigest: record.actionDigest,
            action: record.action,
            resourceId: record.resourceId,
            idempotencyKey: record.idempotencyKey,
            confirmedAt,
            expiresAt: verified.expiresAt,
            canonicalApproval,
          },
        };
      },
    },

    {
      operationId: "providers.templates.get",
      method: "GET",
      path: "/v1/providers/templates/:templateId",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetProviderTemplateResponse> {
        const { templateId } = ctx.params as { templateId: string };
        const template = getFridayProviderTemplate(templateId);
        if (!template) {
          throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider template not found", { httpStatus: 404 });
        }
        return { template };
      },
    },

    // ─── List providers ───
    {
      operationId: "providers.list",
      method: "GET",
      path: "/v1/providers",
      auth: { public: true },
      async handler(): Promise<FridayListProvidersResponse> {
        const items = await deps.providerService.listProviders();
        return { items };
      },
    },

    {
      operationId: "providers.health.list",
      method: "GET",
      path: "/v1/providers/health",
      auth: { public: true },
      async handler(): Promise<FridayGetProviderHealthSnapshotResponse> {
        return listHealthSnapshot();
      },
    },

    {
      operationId: "providers.capability.health.list",
      method: "GET",
      path: "/v1/providers/capability-health",
      auth: { public: true },
      async handler(): Promise<FridayGetProviderCapabilityHealthSnapshotResponse> {
        return listCapabilityHealthSnapshot();
      },
    },

    {
      operationId: "capabilities.doctor",
      method: "POST",
      path: "/v1/capabilities/doctor",
      auth: { public: true },
      rateLimitPolicyId: "provider.validate",
      async handler(ctx): Promise<FridayRunCapabilityDoctorResponse | FridayRustCapabilityDoctorReceipt> {
        const raw = ctx.body as Record<string, unknown> | null;
        const providerIds = parseCapabilityDoctorProviderIds(raw);
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "capabilities.doctor", body: raw }),
          ctx,
          body: raw,
        });
        // DARK cut-over (DEFAULT-OFF): bridge to the Rust hub_capability_doctor bin
        // instead of fail-closing. The canonical mutation gate above still runs first
        // (byte-identical gate ordering). QUOTA: this is the ONLY probe route that may
        // request the bin's LIVE key-validation arm (~1-2 Anthropic tokens), and ONLY
        // when the request body explicitly sets `validateKeys: true`; absent/false runs
        // the bin's zero-quota CLI-detect-only default.
        if (deps.routeProvidersViaRust === true) {
          const validateKeys = raw?.validateKeys === true;
          const receipt = await bridgeCapabilityDoctorViaRust(validateKeys);
          return withCanonicalGate(receipt, ticket);
        }
        assertProviderProbeTestOracleAllowed(deps);
        const report = await deps.providerService.runCapabilityDoctor({
          ownerUserId: ctx.principal?.userId,
          providerIds,
        });
        return withCanonicalGate(report, ticket);
      },
    },

    // ─── Get provider ───
    {
      operationId: "providers.get",
      method: "GET",
      path: "/v1/providers/:providerId",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        const provider = await deps.providerService.getProvider(providerId);
        if (!provider) {
          throw new FridayDomainError(
            "PROVIDER_NOT_FOUND",
            "Provider not found",
            { httpStatus: 404 },
          );
        }
        return { provider };
      },
    },

    // ─── Create provider ───
    {
      operationId: "providers.create",
      method: "POST",
      path: "/v1/providers",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayCreateProviderResponse> {
        // DX-001: Accept both flat and nested (config) formats.
        // If the body has a `config` object with provider fields, lift them to top level.
        const rawInput = ctx.body as Record<string, unknown> | null;
        const raw = liftProviderCreateConfigFields(rawInput);
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        validateCreateBody(body);
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.create", body: rawInput }),
          ctx,
          body: raw && typeof raw === "object" ? raw : undefined,
        });
        const provider = await deps.providerService.createProvider(body);
        return withCanonicalGate({
          provider,
          validation: provider.config.validation,
        }, ticket);
      },
    },

    // ─── Update provider ───
    {
      operationId: "providers.update",
      method: "PATCH",
      path: "/v1/providers/:providerId",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayUpdateProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        const raw = ctx.body as Record<string, unknown> | null;
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        validateUpdateBody(body);
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.update", providerId, body: raw }),
          ctx,
          body: raw,
        });
        const provider = await deps.providerService.updateProvider(
          providerId,
          body,
        );
        return withCanonicalGate({
          provider,
          validation: provider.config.validation,
        }, ticket);
      },
    },

    // ─── Delete provider ───
    {
      operationId: "providers.delete",
      method: "DELETE",
      path: "/v1/providers/:providerId",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayDeleteProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.delete", providerId, body }),
          ctx,
          body,
        });
        await deps.providerService.deleteProvider(providerId);
        return withCanonicalGate({ deleted: true as const }, ticket);
      },
    },

    // ─── Validate provider ───
    {
      operationId: "providers.validate",
      method: "POST",
      path: "/v1/providers/:providerId/validate",
      auth: { public: true },
      rateLimitPolicyId: "provider.validate",
      async handler(ctx): Promise<FridayValidateProviderResponse | FridayRustCapabilityDoctorReceipt> {
        const { providerId } = ctx.params as { providerId: string };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.validate", providerId, body }),
          ctx,
          body,
        });
        // DARK cut-over (DEFAULT-OFF): bridge to the Rust hub_capability_doctor bin
        // instead of fail-closing. The canonical mutation gate above still runs first.
        // QUOTA: validate NEVER opts into the live key-validation arm (validateKeys
        // false) — zero quota. SURFACE-SHAPE: the bin has no providerId input, so the
        // returned doctor is the fixed codex/claude+deepseek/anthropic composite, not a
        // per-`:providerId` validation result (see the deps doc + PR).
        if (deps.routeProvidersViaRust === true) {
          const receipt = await bridgeCapabilityDoctorViaRust(false);
          return withCanonicalGate(receipt, ticket);
        }
        assertProviderProbeTestOracleAllowed(deps);
        const validation =
          await deps.providerService.validateProvider(providerId, {
            ownerUserId: ctx.principal?.userId,
          });
        return withCanonicalGate({ validation }, ticket);
      },
    },

    {
      operationId: "providers.doctor",
      method: "GET",
      path: "/v1/providers/:providerId/doctor",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetProviderDoctorResponse | FridayRustCapabilityDoctorReceipt> {
        const { providerId } = ctx.params as { providerId: string };
        // DARK cut-over (DEFAULT-OFF): bridge to the Rust hub_capability_doctor bin
        // instead of fail-closing. QUOTA: doctor NEVER opts into the live key-validation
        // arm (validateKeys false) — zero quota. SURFACE-SHAPE: the bin has no
        // providerId input, so the returned doctor is the fixed
        // codex/claude+deepseek/anthropic composite, not a per-`:providerId` health
        // diagnostic (see the deps doc + PR).
        if (deps.routeProvidersViaRust === true) {
          return bridgeCapabilityDoctorViaRust(false);
        }
        assertProviderProbeTestOracleAllowed(deps);
        const doctor = await deps.providerService.doctorProvider(providerId);
        return { doctor };
      },
    },
    {
      operationId: "providers.routing.explain",
      method: "GET",
      path: "/v1/providers/routing/explain",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetProviderRoutingExplainResponse> {
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const requestedProviderId = typeof query.requestedProviderId === "string" && query.requestedProviderId.trim().length > 0
          ? query.requestedProviderId
          : undefined;
        const requestedModel = typeof query.requestedModel === "string" && query.requestedModel.trim().length > 0
          ? query.requestedModel
          : undefined;
        const taskProfileId = typeof query.taskProfileId === "string" && query.taskProfileId.trim().length > 0
          ? query.taskProfileId
          : undefined;
        const estimatedInputTokens = typeof query.estimatedInputTokens === "string"
          ? Math.max(0, Number.parseInt(query.estimatedInputTokens, 10) || 0)
          : 0;
        const complexity = query.complexity === "simple" || query.complexity === "medium" || query.complexity === "complex"
          ? query.complexity
          : "medium";
        const requiresNativeTools = query.requiresNativeTools === true || query.requiresNativeTools === "true";
        const explain = await deps.providerService.explainRouting({
          requestedProviderId,
          requestedModel,
          tenantContext: ctx.principal?.userId
            ? {
                hubId: "default",
                userId: ctx.principal.userId,
              }
            : undefined,
          routingContext: {
            estimatedInputTokens,
            complexity,
            requiresNativeTools,
            taskProfileId,
          },
        });
        return { explain };
      },
    },
    {
      operationId: "providers.routing.pin",
      method: "POST",
      path: "/v1/providers/routing/pin",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayPinProviderRouteResponse> {
        if (!ctx.principal?.userId) {
          throw new FridayDomainError("UNAUTHORIZED", "A user-scoped principal is required", {
            httpStatus: 401,
          });
        }
        const raw = ctx.body as Record<string, unknown> | null;
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }
        if (typeof body.providerId !== "string" || typeof body.model !== "string") {
          throw new FridayDomainError("VALIDATION_ERROR", "providerId and model are required", { httpStatus: 400 });
        }
        if (body.backendKind !== "http" && body.backendKind !== "cli" && body.backendKind !== "sdk") {
          throw new FridayDomainError("VALIDATION_ERROR", "backendKind must be one of: http, cli, sdk", { httpStatus: 400 });
        }
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.routing.pin", body: raw }),
          ctx,
          body: raw,
        });
        assertProviderRoutingControlsTestOracleAllowed(deps);
        await deps.providerService.pinRoute({
          userId: ctx.principal.userId,
          taskProfileId: typeof body.taskProfileId === "string" ? body.taskProfileId : undefined,
          providerId: body.providerId,
          model: body.model,
          backendKind: body.backendKind,
          reason: typeof body.reason === "string" ? body.reason : undefined,
        });
        return withCanonicalGate({ pinned: true as const }, ticket);
      },
    },
    {
      operationId: "providers.routing.penalty.clear",
      method: "POST",
      path: "/v1/providers/routing/penalties/clear",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayClearProviderRoutePenaltyResponse> {
        if (!ctx.principal?.userId) {
          throw new FridayDomainError("UNAUTHORIZED", "A user-scoped principal is required", {
            httpStatus: 401,
          });
        }
        const raw = ctx.body as Record<string, unknown> | null;
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }
        if (typeof body.providerId !== "string" || typeof body.model !== "string") {
          throw new FridayDomainError("VALIDATION_ERROR", "providerId and model are required", { httpStatus: 400 });
        }
        if (body.backendKind !== "http" && body.backendKind !== "cli" && body.backendKind !== "sdk") {
          throw new FridayDomainError("VALIDATION_ERROR", "backendKind must be one of: http, cli, sdk", { httpStatus: 400 });
        }
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.routing.penalty.clear", body: raw }),
          ctx,
          body: raw,
        });
        assertProviderRoutingControlsTestOracleAllowed(deps);
        const cleared = await deps.providerService.clearRoutePenalty({
          userId: ctx.principal.userId,
          taskProfileId: typeof body.taskProfileId === "string" ? body.taskProfileId : undefined,
          providerId: body.providerId,
          model: body.model,
          backendKind: body.backendKind,
        });
        return withCanonicalGate({ cleared }, ticket);
      },
    },

    {
      operationId: "providers.auth.profiles.list",
      method: "GET",
      path: "/v1/providers/:providerId/auth-profiles",
      auth: { public: true },
      async handler(ctx): Promise<FridayListProviderAuthProfilesResponse> {
        const { providerId } = ctx.params as { providerId: string };
        const items = await deps.providerService.listAuthProfiles(providerId);
        return { items };
      },
    },

    {
      operationId: "providers.auth.profiles.activate",
      method: "POST",
      path: "/v1/providers/:providerId/auth-profiles/:profileKey/activate",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayActivateProviderAuthProfileResponse> {
        const { providerId, profileKey } = ctx.params as { providerId: string; profileKey: string };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({
            action: "providers.auth.profiles.activate",
            providerId,
            profileKey,
            body,
          }),
          ctx,
          body,
        });
        const profile = await deps.providerService.activateAuthProfile(providerId, profileKey);
        return withCanonicalGate({ profile }, ticket);
      },
    },

    // ─── Get routing config ───
    {
      operationId: "providers.routing.get",
      method: "GET",
      path: "/v1/model-routing",
      auth: { public: true },
      async handler(): Promise<FridayGetRoutingConfigResponse> {
        const routing = await deps.providerService.getRoutingConfig();
        return { routing };
      },
    },

    // ─── Set routing config ───
    {
      operationId: "providers.routing.set",
      method: "PUT",
      path: "/v1/model-routing",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridaySetRoutingConfigResponse> {
        const raw = ctx.body as Record<string, unknown> | null;
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        validateRoutingBody(body);
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({ action: "providers.routing.set", body: raw }),
          ctx,
          body: raw,
        });
        const routing = await deps.providerService.setRoutingConfig(body);
        return withCanonicalGate({ routing }, ticket);
      },
    },

    // ─── OAuth: Initiate Anthropic login ───
    {
      operationId: "auth.oauth.anthropic.initiate",
      method: "POST",
      path: "/v1/auth/oauth/anthropic/initiate",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayInitiateAnthropicOAuthResponse> {
        requireOAuthOwnerUserId(ctx.principal);
        throw new FridayDomainError(
          "ANTHROPIC_OAUTH_DISABLED",
          FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
          { httpStatus: 400 },
        );
      },
    },

    // ─── OAuth: Complete Anthropic callback ───
    {
      operationId: "auth.oauth.anthropic.callback",
      method: "POST",
      path: "/v1/auth/oauth/anthropic/callback",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayCompleteAnthropicOAuthCallbackResponse> {
        requireOAuthOwnerUserId(ctx.principal);
        throw new FridayDomainError(
          "ANTHROPIC_OAUTH_DISABLED",
          FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
          { httpStatus: 400 },
        );
      },
    },
    {
      operationId: "auth.oauth.openai.codex.device.initiate",
      method: "POST",
      path: "/v1/auth/oauth/openai-codex/device/initiate",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayInitiateOpenAICodexDeviceOAuthResponse> {
        const ownerUserId = requireOAuthOwnerUserId(ctx.principal);
        const raw = ctx.body as Record<string, unknown> | null;
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({
            action: "providers.oauth.openai_codex.device.initiate",
            ownerUserId,
            body: raw,
          }),
          ctx,
          body: raw,
        });
        const selection = await resolveOrProvisionOAuthProvider(
          deps.providerService,
          readOAuthSelectionInput(body, "openai-codex"),
        );
        const oauth = await deps.providerService.initiateOAuthDeviceAuthorization({
          providerId: selection.provider.id,
          ownerUserId,
        });
        return withCanonicalGate({ oauth }, ticket);
      },
    },
    {
      operationId: "auth.oauth.openai.codex.device.complete",
      method: "POST",
      path: "/v1/auth/oauth/openai-codex/device/complete",
      auth: { public: true },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayCompleteOpenAICodexDeviceOAuthResponse> {
        const ownerUserId = requireOAuthOwnerUserId(ctx.principal);
        const raw = ctx.body as Record<string, unknown> | null;
        const body = raw && typeof raw === "object"
          ? stripProviderMutationControlFields(raw)
          : raw;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        if (typeof body.deviceCodeId !== "string" || body.deviceCodeId.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "deviceCodeId is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        const ticket = maybeRequireProviderMutationTicket({
          descriptor: buildFridayProviderMutationDescriptor({
            action: "providers.oauth.openai_codex.device.complete",
            ownerUserId,
            body: raw,
          }),
          ctx,
          body: raw,
        });
        const selection = await resolveExistingOAuthProvider(
          deps.providerService,
          readOAuthSelectionInput(body, "openai-codex"),
          "oauth_complete",
        );
        const oauth = await deps.providerService.completeOAuthDeviceAuthorization({
          providerId: selection.provider.id,
          ownerUserId,
          deviceCodeId: body.deviceCodeId.trim(),
        });
        return withCanonicalGate({ oauth }, ticket);
      },
    },
  ];
}

function readOAuthSelectionInput(body: Record<string, unknown> | null, defaultKind: "anthropic" | "openai-codex"): {
  providerId?: string;
  kind?: "anthropic" | "openai-codex";
  name?: string;
  defaultModel?: string;
} {
  return {
    providerId: typeof body?.providerId === "string" && body.providerId.trim().length > 0
      ? body.providerId.trim()
      : undefined,
    kind: typeof body?.kind === "string" && body.kind.trim().length > 0
      ? body.kind.trim() as "anthropic" | "openai-codex"
      : defaultKind,
    name: typeof body?.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : undefined,
    defaultModel: typeof body?.defaultModel === "string" && body.defaultModel.trim().length > 0
      ? body.defaultModel.trim()
      : undefined,
  };
}

function createActorFromPrincipal(
  principal: FridayAuthPrincipal | null,
  fallbackId: string,
  resolveBoundDeviceOwnerSentinelHash?: (userId: string) => string | null,
): FridayMutatingActionActor {
  if (!principal) {
    return {
      kind: "api",
      id: fallbackId,
      principalId: fallbackId,
    };
  }
  // Option B*: resolve the durable owner↔device binding SERVER-SIDE from the
  // authenticated user id (NOT from the acting principalId, which stays `user.id`).
  // `boundDeviceOwnerSentinelHash` binds a device-authored approval to the owner's
  // registered device without perturbing the action digest (it is never hashed in).
  const ownerUserId = principal.userId ?? principal.principalId;
  const boundDeviceOwnerSentinelHash =
    resolveBoundDeviceOwnerSentinelHash?.(ownerUserId) ?? undefined;
  return {
    kind: principal.principalType,
    id: principal.principalId,
    principalId: principal.principalId,
    ...(boundDeviceOwnerSentinelHash ? { boundDeviceOwnerSentinelHash } : {}),
  };
}

function readCanonicalApproval(value: unknown): FridayCanonicalApprovalResolution | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as FridayCanonicalApprovalResolution;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "canonicalApproval must be an object", { httpStatus: 400 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structurally validate the device-approval proof carried on the confirm body. This
 * only checks SHAPE (the cryptographic verification is done by the asymmetric
 * verifier); a malformed shape is a 400 so the verifier is never handed junk.
 */
function readDeviceApprovalProof(value: unknown): ProviderApprovalDeviceProof {
  if (!isPlainObject(value)) {
    throw new FridayDomainError(
      "PROVIDER_MUTATION_APPROVAL_PROOF_REQUIRED",
      "A device-authored approval proof (`deviceApproval`) is required to confirm a provider mutation plan.",
      { httpStatus: 400 },
    );
  }
  const { transcript, devicePublicKey, signature } = value;
  if (!isPlainObject(transcript) || !isPlainObject(devicePublicKey) || !isPlainObject(signature)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "deviceApproval must carry a transcript, a devicePublicKey and a signature object.",
      { httpStatus: 400 },
    );
  }
  return value as unknown as ProviderApprovalDeviceProof;
}

function stripProviderMutationControlFields<T extends Record<string, unknown>>(body: T): T {
  const stripped = { ...body };
  delete stripped.canonicalApproval;
  delete stripped.planDigest;
  delete stripped.idempotencyKey;
  return stripped;
}

function canonicalGateEvidence(ticket: FridayMutatingActionTicket | undefined): {
  ticketId: string;
  actionDigest: string;
  approvalId: string;
  planDigest?: string;
} | undefined {
  if (!ticket) {
    return undefined;
  }
  return {
    ticketId: ticket.ticketId,
    actionDigest: ticket.actionDigest,
    approvalId: ticket.approvalId,
    planDigest: ticket.planDigest,
  };
}

function withCanonicalGate<T extends object>(
  payload: T,
  ticket: FridayMutatingActionTicket | undefined,
): T & { canonicalGate?: NonNullable<ReturnType<typeof canonicalGateEvidence>> } {
  const evidence = canonicalGateEvidence(ticket);
  return evidence ? { ...payload, canonicalGate: evidence } : payload;
}

function sanitizeProviderMutationParameters(value: unknown, keyHint = ""): unknown {
  if (typeof value === "string") {
    return isSensitiveProviderMutationKey(keyHint)
      ? { redacted: true, sha256: createHash("sha256").update(value).digest("hex") }
      : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProviderMutationParameters(entry, keyHint));
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "canonicalApproval" || key === "planDigest" || key === "idempotencyKey") {
      continue;
    }
    sanitized[key] = sanitizeProviderMutationParameters(record[key], key);
  }
  return sanitized;
}

function isSensitiveProviderMutationKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("key")
    || normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("authorization")
    || normalized.includes("cookie")
    || normalized.includes("password")
    || normalized.includes("authorizationcode")
    || normalized.includes("devicecode");
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
