import { FridayDomainError } from "#errors";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayMissionSpineLifecycleState,
  FridayMissionSpineWorkbenchResponse,
  FridayMissionSpineWorkbenchSnapshot,
} from "../../model/friday-api-mission-spine.types.js";
import type {
  FridayRustHubMissionIntakeRequest,
  FridayRustHubMissionIntakeResult,
  FridayRustHubMissionLifecycleRequest,
  FridayRustHubMissionLifecycleResult,
  FridayRustHubRouteDecisionControlRequest,
  FridayRustHubRouteDecisionControlResult,
  FridayRustHubWorkItemStatusRequest,
  FridayRustHubWorkItemStatusResult,
} from "../../mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

export interface FridayMissionSpineWorkbenchProjectionInput {
  missionId?: string;
  principalId?: string;
  userId?: string;
  surface: "api:/v1/mission-spine/workbench";
}

export interface FridayMissionSpineWorkbenchProjectionService {
  getSnapshot(input: FridayMissionSpineWorkbenchProjectionInput): Promise<FridayMissionSpineWorkbenchSnapshot>;
}

/**
 * (Lane B) The ORGANIC mutation seam: a thin service that drives the (flag-gated) Rust sealed-WS
 * dispatch arms for the three Hub-owned mission-spine mutations. The route handlers validate the
 * body, then hand a typed request to this service, which seals + sends over the sealed-WS client
 * and returns the refs-only result. When this service is `null` (the DEFAULT — the route flag is
 * off / no client wired), the POST routes return honest-unavailable (503), byte-identical to the
 * read route's unavailable path. PROVIDING it is what makes the routes LIVE — and live closure
 * ALSO needs the SERVER flags (`FRIDAY_MISSION_INTAKE` for intake, `FRIDAY_MISSION_SPINE_DISPATCH`
 * for lifecycle/work-item), which are a separate operator-gated flip.
 */
export interface FridayMissionSpineDispatchService {
  intakeMission(request: FridayRustHubMissionIntakeRequest): Promise<FridayRustHubMissionIntakeResult>;
  transitionMission(
    request: FridayRustHubMissionLifecycleRequest,
  ): Promise<FridayRustHubMissionLifecycleResult>;
  transitionWorkItem(
    request: FridayRustHubWorkItemStatusRequest,
  ): Promise<FridayRustHubWorkItemStatusResult>;
  controlRouteDecision(
    request: FridayRustHubRouteDecisionControlRequest,
  ): Promise<FridayRustHubRouteDecisionControlResult>;
}

export interface FridayMissionSpineRoutesDeps {
  readonly workbench: FridayMissionSpineWorkbenchProjectionService | null;
  /**
   * (Lane B) The organic mutation dispatcher, DEFAULT-OFF (`null`). `null` ⇒ the three POST routes
   * are honest-unavailable (503); a real adapter ⇒ they seal + dispatch over the sealed-WS client.
   * Adding the routes with this `null` is byte-identical to today for existing traffic.
   */
  readonly dispatch?: FridayMissionSpineDispatchService | null;
  /** (Lane B) Optional reason for the dispatch-unavailable 503; falls back to a default message. */
  readonly dispatchDisabledReason?: string | null;
  readonly disabledReason: string | null;
}

/** (Lane B) Response envelope for each organic mutation route — refs-only result passthrough. */
export interface FridayMissionSpineIntakeResponse {
  readonly result: FridayRustHubMissionIntakeResult;
}
export interface FridayMissionSpineLifecycleResponse {
  readonly result: FridayRustHubMissionLifecycleResult;
}
export interface FridayMissionSpineWorkItemStatusResponse {
  readonly result: FridayRustHubWorkItemStatusResult;
}
export interface FridayMissionSpineRouteDecisionControlResponse {
  readonly result: FridayRustHubRouteDecisionControlResult;
}

const DEFAULT_DISABLED_MESSAGE =
  "Mission Spine workbench projection is unavailable in this runtime; the Rust Hub projection service has not been wired.";

const ALLOWED_STATUS_LABELS = new Set(["stale", "offline", "error"] as const);
const REQUIRED_TRANSCRIPT_SURFACES = ["mobile", "desktop", "telegram", "timeline"] as const;
const SURFACE_KINDS = new Set(REQUIRED_TRANSCRIPT_SURFACES);
const TRANSCRIPT_GROUP_KINDS = new Set(["mission", "work_item", "provider_session", "skill_run", "channel_task", "workflow", "surface", "status", "time"]);
const REQUIRED_TRANSCRIPT_EVIDENCE_FACETS = [
  "providerRef",
  "skillRunRef",
  "channelRef",
  "workflowRef",
  "surfaceThreadRef",
  "timelineRef",
  "proofReceiptRef",
] as const;
const CAPABILITY_KINDS = new Set(["skill", "capability", "advisor"]);
const APPROVAL_STATES = new Set(["not_required", "required", "approved", "blocked"]);
const TRUTH_LABELS = new Set(["friday_owned", "friday_adopted", "observed_only", "linked_only", "unknown"]);
const CONTROL_TRUTH_LABELS = new Set(["friday_owned", "friday_adopted"]);
const ROUTE_ACTION_TARGET_KINDS = new Set(["file", "command", "subtask"]);
const ROUTE_ACTION_REVERSIBILITY = new Set([
  "reversible_git_worktree",
  "operator_gate_required",
  "pending_classify",
]);
const WORK_ITEM_RECOVERY_KINDS = new Set([
  "none",
  "dispatchable",
  "in_flight",
  "needs_operator",
  "retryable",
  "terminal",
]);
const WORK_LANES = new Set(["friday_hub", "codex", "claude", "deepseek", "workflow", "channel", "human", "future_api"]);
const PLACEHOLDER_MARKERS = [
  "mission_pending_runtime_projection",
  "conversation_pending_runtime_projection",
  "pending-real-capture",
  "prep_contract_fallback",
  "prep fallback",
  "pending_rust_hub_projection",
  "TODO_FILL_AFTER_REAL_CAPTURE",
] as const;
const FORBIDDEN_MARKERS = [
  "provider_native_synced",
  "raw transcript",
  "raw_provider",
  "raw-channel",
  "raw-chat",
  "Authorization",
  "Bearer",
  "sk-",
  "/Users/",
  "/private/",
] as const;
const NON_COMPLETION_STATES = new Set<FridayMissionSpineLifecycleState>([
  "ready",
  "queued",
  "provider_ack",
  "waiting",
  "stale",
  "reconnecting",
  "timeline_read",
  "blocked",
  "error",
]);
const LIFECYCLE_STATES = new Set<FridayMissionSpineLifecycleState>([
  ...NON_COMPLETION_STATES,
  "completed_with_proof",
]);

function readMissionId(query: unknown): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const value = (query as { missionId?: unknown }).missionId;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ─── (Lane B) Organic mutation body validation ──────────────────────────────

const DEFAULT_DISPATCH_DISABLED_MESSAGE =
  "Mission Spine organic mutation dispatch is unavailable in this runtime; the Rust Hub sealed-WS dispatch seam has not been wired.";

/** Throw a typed 400 for an invalid organic-mutation body. Never echoes the raw body. */
function throwInvalidBody(surface: string, failures: readonly string[]): never {
  throw new FridayDomainError(
    "MISSION_SPINE_DISPATCH_REQUEST_INVALID",
    "Mission Spine organic mutation request body did not satisfy the dispatch contract.",
    {
      httpStatus: 400,
      details: { surface, failures },
    },
  );
}

function asBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** A required, trimmed, non-empty string field — or `undefined` (pushes a failure code). */
function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): string | undefined {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${field}_missing_or_empty`);
    return undefined;
  }
  return value.trim();
}

/** An optional, trimmed, non-empty string field — or `undefined` (a present-but-non-string is a failure). */
function readOptionalString(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${field}_invalid`);
    return undefined;
  }
  return value.trim();
}

function readOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    failures.push(`${field}_invalid`);
    return undefined;
  }
  return value;
}

function readOptionalStringArray(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${field}_invalid`);
    return undefined;
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      failures.push(`${field}_invalid`);
      return undefined;
    }
    items.push(entry.trim());
  }
  return items;
}

function readOptionalOrganicProvenance(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): FridayRustHubMissionIntakeRequest["organicProvenance"] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${field}_invalid`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const requiredStringFields = [
    "principal",
    "source",
    "attestationRef",
    "taskSha256",
    "issuedAt",
    "route",
  ] as const;
  if (record.organic !== true) failures.push(`${field}_organic_invalid`);
  for (const requiredField of requiredStringFields) {
    if (typeof record[requiredField] !== "string" || record[requiredField].trim().length === 0) {
      failures.push(`${field}_${requiredField}_invalid`);
    }
  }
  if (record.source !== "operator_signature") failures.push(`${field}_source_invalid`);
  if (record.publicKeyId !== undefined && typeof record.publicKeyId !== "string") {
    failures.push(`${field}_publicKeyId_invalid`);
  }
  if (failures.some((failure) => failure.startsWith(`${field}_`))) return undefined;
  return {
    organic: true,
    principal: (record.principal as string).trim(),
    source: "operator_signature",
    attestationRef: (record.attestationRef as string).trim(),
    ...(typeof record.publicKeyId === "string" && record.publicKeyId.trim().length > 0
      ? { publicKeyId: record.publicKeyId.trim() }
      : {}),
    taskSha256: (record.taskSha256 as string).trim().toLowerCase(),
    issuedAt: (record.issuedAt as string).trim(),
    route: (record.route as string).trim(),
  };
}

const WORK_ITEM_COMPLETED_WITH_PROOF = "completed_with_proof";

/** Validate a Mission intake body into the typed request (or throw a typed 400). */
function validateIntakeBody(body: unknown): FridayRustHubMissionIntakeRequest {
  const surface = "api:/v1/mission-spine/intake";
  const b = asBody(body);
  const failures: string[] = [];
  const fridayConversationId = readRequiredString(b, "fridayConversationId", failures);
  const ownerPrincipal = readRequiredString(b, "ownerPrincipal", failures);
  const surfaceThreadId = readRequiredString(b, "surfaceThreadId", failures);
  const surfaceKind = readRequiredString(b, "surfaceKind", failures);
  const deliveryRoute = readRequiredString(b, "deliveryRoute", failures);
  const visibilityPolicy = readRequiredString(b, "visibilityPolicy", failures);
  const missionId = readRequiredString(b, "missionId", failures);
  const workItemId = readRequiredString(b, "workItemId", failures);
  const title = readRequiredString(b, "title", failures);
  const intent = readRequiredString(b, "intent", failures);
  const lane = readRequiredString(b, "lane", failures);
  const targetProviderOrAgent = readOptionalString(b, "targetProviderOrAgent", failures);
  const capabilityId = readOptionalString(b, "capabilityId", failures);
  const bodyRef = readOptionalString(b, "bodyRef", failures);
  const proofRequirements = readOptionalStringArray(b, "proofRequirements", failures);
  const includesSensitiveContext = readOptionalBoolean(b, "includesSensitiveContext", failures);
  const organicProvenance = readOptionalOrganicProvenance(b, "organicProvenance", failures);
  if (
    failures.length > 0 ||
    fridayConversationId === undefined ||
    ownerPrincipal === undefined ||
    surfaceThreadId === undefined ||
    surfaceKind === undefined ||
    deliveryRoute === undefined ||
    visibilityPolicy === undefined ||
    missionId === undefined ||
    workItemId === undefined ||
    title === undefined ||
    intent === undefined ||
    lane === undefined
  ) {
    throwInvalidBody(surface, failures);
  }
  return {
    fridayConversationId,
    ownerPrincipal,
    surfaceThreadId,
    surfaceKind,
    deliveryRoute,
    visibilityPolicy,
    missionId,
    workItemId,
    title,
    intent,
    lane,
    ...(targetProviderOrAgent !== undefined ? { targetProviderOrAgent } : {}),
    ...(capabilityId !== undefined ? { capabilityId } : {}),
    ...(bodyRef !== undefined ? { bodyRef } : {}),
    ...(proofRequirements !== undefined ? { proofRequirements } : {}),
    ...(includesSensitiveContext !== undefined ? { includesSensitiveContext } : {}),
    ...(organicProvenance !== undefined ? { organicProvenance } : {}),
  };
}

/** Validate a Mission lifecycle body + path missionId into the typed request (or throw a typed 400). */
function validateLifecycleBody(missionId: string, body: unknown): FridayRustHubMissionLifecycleRequest {
  const surface = "api:/v1/mission-spine/:missionId/lifecycle";
  const b = asBody(body);
  const failures: string[] = [];
  const trimmedMissionId = typeof missionId === "string" ? missionId.trim() : "";
  if (trimmedMissionId.length === 0) failures.push("missionId_missing_or_empty");
  const fridayConversationId = readRequiredString(b, "fridayConversationId", failures);
  const targetStatus = readRequiredString(b, "targetStatus", failures);
  const actorRef = readRequiredString(b, "actorRef", failures);
  const reason = readRequiredString(b, "reason", failures);
  const proofRef = readOptionalString(b, "proofRef", failures);
  const mergedIntoMissionId = readOptionalString(b, "mergedIntoMissionId", failures);
  if (
    failures.length > 0 ||
    fridayConversationId === undefined ||
    targetStatus === undefined ||
    actorRef === undefined ||
    reason === undefined
  ) {
    throwInvalidBody(surface, failures);
  }
  return {
    fridayConversationId,
    missionId: trimmedMissionId,
    targetStatus,
    actorRef,
    reason,
    ...(proofRef !== undefined ? { proofRef } : {}),
    ...(mergedIntoMissionId !== undefined ? { mergedIntoMissionId } : {}),
  };
}

/** Validate a WorkItem status body + path workItemId into the typed request (or throw a typed 400). */
function validateWorkItemStatusBody(workItemId: string, body: unknown): FridayRustHubWorkItemStatusRequest {
  const surface = "api:/v1/mission-spine/work-items/:workItemId/status";
  const b = asBody(body);
  const failures: string[] = [];
  const trimmedWorkItemId = typeof workItemId === "string" ? workItemId.trim() : "";
  if (trimmedWorkItemId.length === 0) failures.push("workItemId_missing_or_empty");
  const targetStatus = readRequiredString(b, "targetStatus", failures);
  const actorRef = readRequiredString(b, "actorRef", failures);
  const reason = readRequiredString(b, "reason", failures);
  const proofReceipt = readOptionalString(b, "proofReceipt", failures);
  // Mirror the SERVER proof-on-completion invariant at the edge so a proofless completion is a
  // typed 400 here (the Rust persistence boundary ALSO rejects it as the load-bearing guard; this
  // is a fail-fast convenience, NOT a replacement for the server enforcement).
  if (targetStatus === WORK_ITEM_COMPLETED_WITH_PROOF && proofReceipt === undefined) {
    failures.push("proof_receipt_required_for_completion");
  }
  if (
    failures.length > 0 ||
    targetStatus === undefined ||
    actorRef === undefined ||
    reason === undefined
  ) {
    throwInvalidBody(surface, failures);
  }
  return {
    workItemId: trimmedWorkItemId,
    targetStatus,
    actorRef,
    reason,
    ...(proofReceipt !== undefined ? { proofReceipt } : {}),
  };
}

/** Validate a RouteDecision control body + path decisionId into the typed request (or throw 400). */
function validateRouteDecisionControlBody(
  decisionId: string,
  body: unknown,
): FridayRustHubRouteDecisionControlRequest {
  const surface = "api:/v1/mission-spine/route-decisions/:decisionId/control";
  const b = asBody(body);
  const failures: string[] = [];
  const trimmedDecisionId = typeof decisionId === "string" ? decisionId.trim() : "";
  if (trimmedDecisionId.length === 0) failures.push("decisionId_missing_or_empty");
  const controlKind = readRequiredString(b, "controlKind", failures);
  const missionId = readOptionalString(b, "missionId", failures);
  const workItemId = readOptionalString(b, "workItemId", failures);
  const overrideLane = readOptionalString(b, "overrideLane", failures);
  const overrideProviderOrAgent = readOptionalString(b, "overrideProviderOrAgent", failures);
  const actorRef = readRequiredString(b, "actorRef", failures);
  const reason = readRequiredString(b, "reason", failures);
  if (controlKind !== undefined && controlKind !== "veto" && controlKind !== "override") {
    failures.push("control_kind_invalid");
  }
  if (controlKind === "veto" && (overrideLane !== undefined || overrideProviderOrAgent !== undefined)) {
    failures.push("veto_cannot_carry_override_target");
  }
  if (controlKind === "override") {
    if (overrideLane === undefined) {
      failures.push("override_lane_required");
    } else if (!WORK_LANES.has(overrideLane)) {
      failures.push("override_lane_invalid");
    }
  }
  if (
    failures.length > 0 ||
    controlKind === undefined ||
    actorRef === undefined ||
    reason === undefined
  ) {
    throwInvalidBody(surface, failures);
  }
  const parsedControlKind = controlKind as "veto" | "override";
  return {
    decisionId: trimmedDecisionId,
    ...(missionId !== undefined ? { missionId } : {}),
    ...(workItemId !== undefined ? { workItemId } : {}),
    controlKind: parsedControlKind,
    ...(overrideLane !== undefined ? { overrideLane } : {}),
    ...(overrideProviderOrAgent !== undefined ? { overrideProviderOrAgent } : {}),
    actorRef,
    reason,
  };
}

function readPathParam(params: unknown, key: string): string {
  if (!params || typeof params !== "object") return "";
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isMissionIdProofEligible(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const missionId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId)
    && missionId.toLowerCase().includes("mission")
    && missionId !== "mission_pending_runtime_projection"
    && !missionId.includes("TODO");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushIfInvalid(failures: string[], condition: boolean, code: string): void {
  if (!condition) failures.push(code);
}

function validateSerializedSnapshot(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  const serialized = JSON.stringify(snapshot);

  for (const marker of PLACEHOLDER_MARKERS) {
    if (serialized.includes(marker)) {
      failures.push(`placeholder:${marker}`);
    }
  }
  for (const marker of FORBIDDEN_MARKERS) {
    if (serialized.includes(marker)) {
      failures.push(`forbidden:${marker}`);
    }
  }
}

function validateSnapshotHeader(
  snapshot: FridayMissionSpineWorkbenchSnapshot,
  failures: string[],
  requestedMissionId?: string,
): void {
  pushIfInvalid(failures, isMissionIdProofEligible(snapshot.missionId), "mission_id_missing_or_invalid");
  if (requestedMissionId) {
    pushIfInvalid(
      failures,
      snapshot.missionId === requestedMissionId,
      "requested_mission_id_mismatch",
    );
  }
  pushIfInvalid(failures, hasText(snapshot.fridayConversationId), "conversation_id_missing");
  pushIfInvalid(failures, snapshot.runtimeFeedStatus === "live_rust_hub_projection", "runtime_feed_not_live");
  pushIfInvalid(failures, Array.isArray(snapshot.statusLabels), "status_labels_not_array");
  if (Array.isArray(snapshot.statusLabels)) {
    for (const [index, label] of snapshot.statusLabels.entries()) {
      pushIfInvalid(
        failures,
        typeof label === "string" && ALLOWED_STATUS_LABELS.has(label as "stale" | "offline" | "error"),
        `status_label_invalid:${index}:${String(label)}`,
      );
    }
  }

  pushIfInvalid(failures, snapshot.duplicatePreflight.status === "opens_existing_mission", "duplicate_preflight_not_open_existing");
  pushIfInvalid(
    failures,
    snapshot.duplicatePreflight.duplicateMissionId === snapshot.missionId,
    "duplicate_preflight_mission_mismatch",
  );
  pushIfInvalid(failures, hasText(snapshot.duplicatePreflight.duplicateWorkItemId), "duplicate_work_item_missing");
  pushIfInvalid(failures, hasText(snapshot.routeDecision.advisorSummary), "route_decision_summary_missing");
  pushIfInvalid(failures, hasText(snapshot.routeDecision.selectedRoute), "route_decision_selected_missing");
  pushIfInvalid(failures, hasText(snapshot.routeDecision.controlRef), "route_decision_control_ref_missing");
  pushIfInvalid(failures, hasText(snapshot.routeDecision.workItemId), "route_decision_work_item_id_missing");
  pushIfInvalid(failures, TRUTH_LABELS.has(snapshot.routeDecision.truthLabel), "route_decision_truth_label_invalid");
  pushIfInvalid(failures, Array.isArray(snapshot.routeDecision.actionItems), "route_decision_action_items_not_array");
  if (Array.isArray(snapshot.routeDecision.actionItems)) {
    for (const [index, item] of snapshot.routeDecision.actionItems.entries()) {
      if (!isRecord(item)) {
        failures.push(`route_decision_action_not_object:${index}`);
        continue;
      }
      pushIfInvalid(failures, hasText(item.description), `route_decision_action_description_missing:${index}`);
      pushIfInvalid(
        failures,
        typeof item.targetKind === "string" && ROUTE_ACTION_TARGET_KINDS.has(item.targetKind),
        `route_decision_action_target_kind_invalid:${index}`,
      );
      pushIfInvalid(failures, hasText(item.targetRef), `route_decision_action_target_ref_missing:${index}`);
      pushIfInvalid(
        failures,
        typeof item.reversibility === "string" && ROUTE_ACTION_REVERSIBILITY.has(item.reversibility),
        `route_decision_action_reversibility_invalid:${index}`,
      );
      pushIfInvalid(failures, hasText(item.assignedLane), `route_decision_action_assigned_lane_missing:${index}`);
      pushIfInvalid(failures, hasText(item.routeReason), `route_decision_action_route_reason_missing:${index}`);
    }
  }
  pushIfInvalid(failures, Array.isArray(snapshot.providerReceiptRefs), "provider_receipt_refs_not_array");
  pushIfInvalid(failures, Array.isArray(snapshot.channelReceiptRefs), "channel_receipt_refs_not_array");
}

function validateWorkItems(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): Set<string> {
  const workItemIds = new Set<string>();
  let providerAckNotDone = false;
  let timelineReadNotDone = false;
  let completedWithProof = false;
  pushIfInvalid(failures, snapshot.workItems.length > 0, "work_items_missing");
  for (const item of snapshot.workItems) {
    if (hasText(item.id)) workItemIds.add(item.id);
    pushIfInvalid(failures, hasText(item.title), `work_item_title_missing:${item.id}`);
    pushIfInvalid(failures, TRUTH_LABELS.has(item.owner), `work_item_truth_label_invalid:${item.id}`);
    pushIfInvalid(failures, LIFECYCLE_STATES.has(item.state), `work_item_state_invalid:${item.id}:${item.state}`);
    pushIfInvalid(failures, hasText(item.blockingReason), `work_item_blocking_reason_missing:${item.id}`);
    pushIfInvalid(failures, WORK_ITEM_RECOVERY_KINDS.has(item.recoveryKind), `work_item_recovery_kind_invalid:${item.id}:${item.recoveryKind}`);
    pushIfInvalid(failures, typeof item.canRetry === "boolean", `work_item_can_retry_invalid:${item.id}`);
    pushIfInvalid(failures, typeof item.canCancel === "boolean", `work_item_can_cancel_invalid:${item.id}`);
    if (item.state === "stale") {
      pushIfInvalid(failures, item.recoveryKind === "retryable", `stale_work_item_not_retryable:${item.id}`);
      pushIfInvalid(failures, item.canRetry === true, `stale_work_item_retry_not_exposed:${item.id}`);
    }
    if (item.state === "completed_with_proof" || item.state === "timeline_read") {
      if (item.canRetry || item.canCancel) {
        failures.push(`non_actionable_work_item_exposes_recovery:${item.id}:${item.state}`);
      }
    }
    if (item.state === "provider_ack" && item.done === false) providerAckNotDone = true;
    if (item.state === "timeline_read" && item.done === false) timelineReadNotDone = true;
    if (NON_COMPLETION_STATES.has(item.state) && item.done === true) {
      failures.push(`non_completion_state_marked_done:${item.id}:${item.state}`);
    }
    if (item.state === "completed_with_proof") {
      if (item.done === true && hasText(item.proofRef)) {
        completedWithProof = true;
      } else {
        failures.push(`completed_with_proof_missing_ref:${item.id}`);
      }
    }
  }
  if (snapshot.providerReceiptRefs.length > 0) {
    pushIfInvalid(failures, providerAckNotDone || completedWithProof, "provider_receipt_without_provider_or_proof_state");
  }
  pushIfInvalid(failures, timelineReadNotDone || snapshot.timelinePages.length > 0, "timeline_read_projection_missing");
  return workItemIds;
}

function validateTimeline(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): Set<string> {
  const timelinePages = new Set(snapshot.timelinePages.map((page) => page.page));
  const timelineEventRefs = new Set<string>();
  pushIfInvalid(failures, timelinePages.has(1) && timelinePages.has(2), "timeline_pages_1_and_2_missing");
  for (const page of snapshot.timelinePages) {
    pushIfInvalid(failures, hasText(page.cursor), `timeline_cursor_missing:${page.page}`);
    pushIfInvalid(failures, page.eventRefs.length > 0, `timeline_event_refs_missing:${page.page}`);
    for (const eventRef of page.eventRefs) {
      if (hasText(eventRef)) timelineEventRefs.add(eventRef);
    }
  }
  return timelineEventRefs;
}

function validateMemoryCandidates(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  for (const candidate of snapshot.memoryCandidates) {
    pushIfInvalid(
      failures,
      candidate.state === "candidate_review_only" && candidate.grantsMemoryAuthority === false,
      `memory_candidate_not_review_only:${candidate.id}`,
    );
    pushIfInvalid(failures, hasText(candidate.evidenceRef), `memory_candidate_evidence_missing:${candidate.id}`);
  }
}

function validateCapabilityStates(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  const capabilityStates = Array.isArray(snapshot.capabilityStates) ? snapshot.capabilityStates : [];
  pushIfInvalid(failures, capabilityStates.length > 0, "capability_states_missing");
  for (const capability of capabilityStates) {
    pushIfInvalid(failures, hasText(capability.id), "capability_state_id_missing");
    pushIfInvalid(failures, hasText(capability.label), `capability_state_label_missing:${capability.id}`);
    pushIfInvalid(failures, CAPABILITY_KINDS.has(capability.kind), `capability_state_kind_invalid:${capability.id}`);
    pushIfInvalid(failures, TRUTH_LABELS.has(capability.truthLabel), `capability_state_truth_label_invalid:${capability.id}`);
    pushIfInvalid(failures, APPROVAL_STATES.has(capability.approvalState), `capability_state_approval_invalid:${capability.id}`);
    pushIfInvalid(failures, hasText(capability.summary), `capability_state_summary_missing:${capability.id}`);
    pushIfInvalid(failures, hasText(capability.proofRef), `capability_state_proof_ref_missing:${capability.id}`);
    if (capability.dispatchAllowed) {
      pushIfInvalid(
        failures,
        CONTROL_TRUTH_LABELS.has(capability.truthLabel),
        `capability_state_dispatch_truth_invalid:${capability.id}`,
      );
      pushIfInvalid(
        failures,
        capability.approvalState === "approved" || capability.approvalState === "not_required",
        `capability_state_dispatch_approval_invalid:${capability.id}`,
      );
    }
  }
}

function validateT3ProvisioningStatus(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  const status = snapshot.t3ProvisioningStatus;
  if (!status) return;
  pushIfInvalid(
    failures,
    status.truthLabel === "rust_hub_t3_provisioning_read_only_no_mint",
    "t3_provisioning_truth_label_invalid",
  );
  for (const [key, value] of Object.entries({
    deviceIdentityCount: status.deviceIdentityCount,
    trustedDeviceCount: status.trustedDeviceCount,
    activeTrustedDeviceCount: status.activeTrustedDeviceCount,
    trustGrantCount: status.trustGrantCount,
    activeTrustGrantCount: status.activeTrustGrantCount,
    contextPassportCount: status.contextPassportCount,
    contextPassportItemCount: status.contextPassportItemCount,
  })) {
    pushIfInvalid(failures, Number.isInteger(value) && value >= 0, `t3_provisioning_count_invalid:${key}`);
  }
  pushIfInvalid(failures, typeof status.paired === "boolean", "t3_provisioning_paired_invalid");
  if (status.latestDevice != null) {
    pushIfInvalid(failures, isRecord(status.latestDevice), "t3_provisioning_latest_device_invalid");
    if (isRecord(status.latestDevice)) {
      pushIfInvalid(failures, hasText(status.latestDevice.deviceId), "t3_latest_device_id_missing");
      pushIfInvalid(
        failures,
        typeof status.latestDevice.deviceId === "string" && status.latestDevice.deviceId.startsWith("proof://device/"),
        "t3_latest_device_id_not_redacted",
      );
      pushIfInvalid(failures, hasText(status.latestDevice.pubkeyFingerprint), "t3_latest_device_fingerprint_missing");
      pushIfInvalid(
        failures,
        typeof status.latestDevice.pubkeyFingerprint === "string"
          && !/^[0-9a-f]{64}$/i.test(status.latestDevice.pubkeyFingerprint),
        "t3_latest_device_raw_pubkey_leak",
      );
      pushIfInvalid(failures, Number.isInteger(status.latestDevice.pairedAt), "t3_latest_device_paired_at_invalid");
    }
  }
}

function validateTranscript(
  snapshot: FridayMissionSpineWorkbenchSnapshot,
  workItemIds: Set<string>,
  timelineEventRefs: Set<string>,
  failures: string[],
): void {
  const transcriptSurfaces = new Set<string>();
  const transcriptEvidenceFacets = new Set<string>();
  const transcriptEventIds = new Set<string>();
  let transcriptEventCount = 0;
  pushIfInvalid(failures, snapshot.transcriptSections.length > 0, "transcript_sections_missing");
  for (const section of snapshot.transcriptSections) {
    pushIfInvalid(failures, section.missionId === snapshot.missionId, `transcript_section_mission_mismatch:${section.id}`);
    pushIfInvalid(failures, TRUTH_LABELS.has(section.truthLabel), `transcript_section_truth_label_invalid:${section.id}`);
    pushIfInvalid(failures, LIFECYCLE_STATES.has(section.status), `transcript_section_status_invalid:${section.id}:${section.status}`);
    pushIfInvalid(failures, TRANSCRIPT_GROUP_KINDS.has(section.groupKind), `transcript_section_group_kind_invalid:${section.id}`);
    pushIfInvalid(failures, section.events.length > 0, `transcript_section_events_missing:${section.id}`);
    for (const event of section.events) {
      transcriptEventCount += 1;
      if (hasText(event.id)) {
        transcriptEventIds.add(event.id);
        pushIfInvalid(
          failures,
          timelineEventRefs.has(event.id),
          `transcript_event_missing_from_timeline:${event.id}`,
        );
      } else {
        failures.push("transcript_event_id_missing");
      }
      if (SURFACE_KINDS.has(event.surface)) {
        transcriptSurfaces.add(event.surface);
      } else {
        failures.push(`transcript_event_surface_invalid:${event.id}:${event.surface}`);
      }
      pushIfInvalid(failures, LIFECYCLE_STATES.has(event.status), `transcript_event_status_invalid:${event.id}:${event.status}`);
      pushIfInvalid(failures, TRUTH_LABELS.has(event.truthLabel), `transcript_event_truth_label_invalid:${event.id}`);
      const evidenceRefs = event.evidenceRefs && typeof event.evidenceRefs === "object"
        ? (event.evidenceRefs as Record<string, string | undefined>)
        : null;
      if (!evidenceRefs) {
        failures.push(`transcript_event_evidence_refs_missing:${event.id}`);
      } else {
        let eventEvidenceRefCount = 0;
        for (const [facet, ref] of Object.entries(evidenceRefs)) {
          if (hasText(ref)) {
            eventEvidenceRefCount += 1;
            transcriptEvidenceFacets.add(facet);
          }
        }
        pushIfInvalid(failures, eventEvidenceRefCount > 0, `transcript_event_evidence_refs_empty:${event.id}`);
      }
      pushIfInvalid(failures, event.missionId === snapshot.missionId, `transcript_event_mission_mismatch:${event.id}`);
      pushIfInvalid(
        failures,
        !event.workItemId || workItemIds.has(event.workItemId),
        `transcript_event_work_item_unknown:${event.id}`,
      );
      pushIfInvalid(failures, hasText(event.summary), `transcript_event_summary_missing:${event.id}`);
      pushIfInvalid(failures, hasText(event.capturedAt), `transcript_event_capture_missing:${event.id}`);
    }
  }
  pushIfInvalid(failures, transcriptSurfaces.size > 0, "transcript_surfaces_missing");
  pushIfInvalid(failures, transcriptEvidenceFacets.has("timelineRef"), "transcript_timeline_refs_missing");
  for (const facet of REQUIRED_TRANSCRIPT_EVIDENCE_FACETS) {
    if (transcriptEvidenceFacets.has(facet)) {
      pushIfInvalid(failures, facet !== "providerRef" || snapshot.providerReceiptRefs.length > 0, "provider_ref_without_provider_receipt");
      pushIfInvalid(failures, facet !== "channelRef" || snapshot.channelReceiptRefs.length > 0, "channel_ref_without_channel_receipt");
    }
  }
  pushIfInvalid(failures, transcriptEventCount > 0, "transcript_events_missing");
  for (const eventRef of timelineEventRefs) {
    pushIfInvalid(
      failures,
      transcriptEventIds.has(eventRef),
      `timeline_event_ref_missing_from_transcript:${eventRef}`,
    );
  }
}

function validateMissionSpineWorkbenchSnapshot(
  snapshot: FridayMissionSpineWorkbenchSnapshot,
  requestedMissionId?: string,
): string[] {
  const failures: string[] = [];
  validateSerializedSnapshot(snapshot, failures);
  validateSnapshotHeader(snapshot, failures, requestedMissionId);
  const workItemIds = validateWorkItems(snapshot, failures);
  const timelineEventRefs = validateTimeline(snapshot, failures);
  validateMemoryCandidates(snapshot, failures);
  validateCapabilityStates(snapshot, failures);
  validateT3ProvisioningStatus(snapshot, failures);
  validateTranscript(snapshot, workItemIds, timelineEventRefs, failures);

  return failures;
}

function throwInvalidSnapshot(failures: string[]): never {
  throw new FridayDomainError(
    "MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID",
    "Mission Spine workbench projection did not satisfy the live UI/device proof contract.",
    {
      httpStatus: 503,
      details: {
        surface: "api:/v1/mission-spine/workbench",
        projection: "rust_hub_invalid",
        proofReady: false,
        failures,
      },
    },
  );
}

export function createFridayMissionSpineRoutes(
  deps: FridayMissionSpineRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function disabledMessage(): string {
    return deps.disabledReason && deps.disabledReason.trim().length > 0
      ? deps.disabledReason
      : DEFAULT_DISABLED_MESSAGE;
  }

  function throwDisabled(): never {
    throw new FridayDomainError(
      "MISSION_SPINE_WORKBENCH_UNAVAILABLE",
      disabledMessage(),
      {
        httpStatus: 503,
        details: {
          surface: "api:/v1/mission-spine/workbench",
          projection: "rust_hub_unavailable",
          proofReady: false,
        },
      },
    );
  }

  // (Lane B) DEFAULT-OFF: `deps.dispatch` is null/undefined unless an adapter is wired, so each
  // POST route is honest-unavailable (503) by default — byte-identical to today for existing
  // traffic (a new route that's flag-OFF never alters any existing route's behavior).
  const dispatch = deps.dispatch ?? null;

  function dispatchDisabledMessage(): string {
    return deps.dispatchDisabledReason && deps.dispatchDisabledReason.trim().length > 0
      ? deps.dispatchDisabledReason
      : DEFAULT_DISPATCH_DISABLED_MESSAGE;
  }

  function throwDispatchDisabled(surface: string): never {
    throw new FridayDomainError(
      "MISSION_SPINE_DISPATCH_UNAVAILABLE",
      dispatchDisabledMessage(),
      {
        httpStatus: 503,
        details: { surface, dispatch: "rust_hub_unavailable", proofReady: false },
      },
    );
  }

  return [
    {
      operationId: "mission.spine.workbench.get",
      method: "GET",
      path: "/v1/mission-spine/workbench",
      auth: { public: true },
      async handler(ctx): Promise<FridayMissionSpineWorkbenchResponse> {
        if (!deps.workbench) {
          throwDisabled();
        }
        const missionId = readMissionId(ctx.query);
        const snapshot = await deps.workbench.getSnapshot({
          missionId,
          principalId: ctx.principal?.principalId,
          userId: ctx.principal?.userId,
          surface: "api:/v1/mission-spine/workbench",
        });
        const failures = validateMissionSpineWorkbenchSnapshot(snapshot, missionId);
        if (failures.length > 0) {
          throwInvalidSnapshot(failures);
        }
        return { snapshot };
      },
    },
    // (Lane B) ORGANIC MISSION INTAKE — POST. Order of guards: (1) dispatch-disabled (flag-OFF)
    // → 503 FIRST regardless of caller, so a flag-OFF route is a uniform honest-unavailable;
    // (2) bound-principal (refuse the synthetic public principal) → 401; (3) body validation
    // → 400; (4) seal + dispatch over the sealed-WS client. Refs-only result passthrough.
    {
      operationId: "mission.spine.intake.create",
      method: "POST",
      path: "/v1/mission-spine/intake",
      auth: { public: true },
      async handler(ctx): Promise<FridayMissionSpineIntakeResponse> {
        if (!dispatch) {
          throwDispatchDisabled("api:/v1/mission-spine/intake");
        }
        assertBoundPrincipalForOperation(ctx.principal ?? null, "mission.spine.intake", "api");
        const request = validateIntakeBody(ctx.body);
        const result = await dispatch.intakeMission(request);
        return { result };
      },
    },
    // (Lane B) ORGANIC MISSION LIFECYCLE — POST. Same guard order; the canonical missionId rides
    // the path. A `status` in the result is a Mission-management fact, not provider completion.
    {
      operationId: "mission.spine.lifecycle.transition",
      method: "POST",
      path: "/v1/mission-spine/:missionId/lifecycle",
      auth: { public: true },
      async handler(ctx): Promise<FridayMissionSpineLifecycleResponse> {
        if (!dispatch) {
          throwDispatchDisabled("api:/v1/mission-spine/:missionId/lifecycle");
        }
        assertBoundPrincipalForOperation(ctx.principal ?? null, "mission.spine.lifecycle", "api");
        const missionId = readPathParam(ctx.params, "missionId");
        const request = validateLifecycleBody(missionId, ctx.body);
        const result = await dispatch.transitionMission(request);
        return { result };
      },
    },
    // (Lane B) ORGANIC WORK-ITEM STATUS — POST. Same guard order; the workItemId rides the path
    // and the optional `proofReceipt` is a passthrough. Proof-on-completion is ENFORCED SERVER-
    // side (a proofless `completed_with_proof` is a typed `Error` ⇒ the client fails closed); the
    // edge validation rejects it as a 400 as a fail-fast convenience, never the load-bearing guard.
    {
      operationId: "mission.spine.workitem.status.transition",
      method: "POST",
      path: "/v1/mission-spine/work-items/:workItemId/status",
      auth: { public: true },
      async handler(ctx): Promise<FridayMissionSpineWorkItemStatusResponse> {
        if (!dispatch) {
          throwDispatchDisabled("api:/v1/mission-spine/work-items/:workItemId/status");
        }
        assertBoundPrincipalForOperation(ctx.principal ?? null, "mission.spine.workitem.status", "api");
        const workItemId = readPathParam(ctx.params, "workItemId");
        const request = validateWorkItemStatusBody(workItemId, ctx.body);
        const result = await dispatch.transitionWorkItem(request);
        return { result };
      },
    },
    // (D20 W1-S3) ROUTE-DECISION CONTROL — POST. This is the operator-triggerable control
    // surface for veto/override before dispatch. It is load-bearing because Rust storage checks the
    // persisted control at the ReadyToDispatch -> Dispatched transition.
    {
      operationId: "mission.spine.routedecision.control",
      method: "POST",
      path: "/v1/mission-spine/route-decisions/:decisionId/control",
      auth: { public: true },
      async handler(ctx): Promise<FridayMissionSpineRouteDecisionControlResponse> {
        if (!dispatch) {
          throwDispatchDisabled("api:/v1/mission-spine/route-decisions/:decisionId/control");
        }
        assertBoundPrincipalForOperation(ctx.principal ?? null, "mission.spine.routedecision.control", "api");
        const decisionId = readPathParam(ctx.params, "decisionId");
        const request = validateRouteDecisionControlBody(decisionId, ctx.body);
        const result = await dispatch.controlRouteDecision(request);
        return { result };
      },
    },
  ];
}
