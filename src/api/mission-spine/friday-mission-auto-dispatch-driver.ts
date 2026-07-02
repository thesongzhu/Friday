import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MISSION_DISPATCH_TIMEOUT_MS,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
} from "../runtime/friday-rust-route-constants.js";

import type {
  FridayOrganicRunProvenance,
  FridayRustHubAgentRunMissionContext,
  FridayRustHubMissionIntakeRequest,
  FridayRustHubMissionIntakeResult,
} from "./friday-rust-hub-agent-run-ws-sealed-client.js";

/**
 * (Organic mission→run binding PRODUCER — DARK, default-OFF) The thin TS driver that closes the #1
 * organic-driver gap: today NOTHING originates a `mission_context` handle on a live run, so the
 * mission→run binding loop never closes outside an operator-hand-fed test. This driver is the
 * MISSING producer — when `POST /v1/mission-spine/intake` births a Mission + a Ready WorkItem (the
 * server-validated `MissionIntakeResultWire`), it immediately (async, non-blocking) starts a
 * READ-ONLY bound agent-run carrying that server-produced handle. The already-merged route→sealed-
 * client `missionContext` road (#752) + the Rust bound seam + the DB resolver then walk the WorkItem
 * `ready_to_dispatch → … → completed_with_proof` (a read-only Finished closes WITHOUT an operator
 * signature). The driver selects only provider/model shapes the Rust route qualifier already admits.
 *
 * ## Trigger contract (mirrors the Rust producer predicate exactly)
 * Dispatch fires ONLY for a FRESH ready intake — `status === "ready" && createdOrReady === true`
 * AND a present `workItemId`. This is the camelCase mirror of `mission_intake_allows_new_work`
 * (`friday-ffi/src/lib.rs`: `status.trim() == "ready" && created_or_ready`) plus the workItem
 * presence guard the bound run requires. A blocked/duplicate intake (`status:"blocked"` /
 * `createdOrReady:false`) dispatches NOTHING — no re-spend on a duplicate.
 *
 * ## The handle is the SERVER-PRODUCED result — NEVER a raw client body
 * The `missionContext` is built from the intake RESULT's `{fridayConversationId, missionId,
 * workItemId}` (the values the Rust persistence boundary minted/validated), NOT from the inbound
 * request body. The request supplies ONLY the task text (title/intent) + the bound owner principal.
 * The Rust resolver re-validates the handle and the owner gate re-asserts on the bound run, so this
 * driver SELECTS a binding but confers NO authority.
 *
 * ## Read-only is load-bearing
 * The dispatched run carries `constraints.readOnly:true` + EXACTLY the 4 Rust read tools — the shape
 * that qualifies for the Rust read-only route AND closes the WorkItem WITHOUT an operator signature.
 *
 * ## NO-DEGRADE / dark-safety
 * The driver is constructed ONLY when both `FRIDAY_MISSION_AUTO_DISPATCH` and the mission-spine route
 * flag resolve true (bootstrap). With the flag off the driver is never built, the dispatch adapter's
 * `autoDispatchDriver` option is omitted, `intakeMission` is byte-identical, and no auto-dispatch
 * ever fires. `onIntakeReady` is also fully error-isolated (see below) so even a misconfigured
 * flag-ON host can never perturb the intake response.
 */

/**
 * The narrow `startRun` seam the driver needs — the routing `startRun` exposed on the api runtime
 * (`apiRuntime.agent.startRun`, the `routeStartRun` wrapper). Typed structurally to the EXACT fields
 * the driver sets so the driver stays decoupled from the full route signature and is trivially
 * stubbable in tests. The return value is intentionally `unknown`/awaited-and-discarded — the driver
 * is fire-and-forget; the run's outcome is observed via the bound seam, not here.
 */
export type MissionAutoDispatchStartRun = (input: {
  task: string;
  principalId?: string;
  providerId?: string;
  model?: string;
  constraints?: { readOnly?: boolean };
  allowedRustRouteTools?: string[];
  missionContext?: FridayRustHubAgentRunMissionContext;
  organicProvenance?: FridayOrganicRunProvenance;
  timeoutMs?: number;
}) => Promise<unknown>;

export interface CreateFridayMissionAutoDispatchDriverOptions {
  /**
   * The routing `startRun` (`apiRuntime.agent.startRun`). Provided via a THUNK so bootstrap can
   * construct the driver BEFORE the api runtime exists (the adapter is built before `create
   * FridayApiRuntime`), then populate the ref afterward. `onIntakeReady` only fires at request
   * time, by which point the ref is populated. A thunk returning `undefined` ⇒ harmless no-op.
   */
  readonly startRun: () => MissionAutoDispatchStartRun | undefined;
  /**
   * DeepSeek provider id the Rust read-only route qualifier requires (clause 3). Injected from the
   * api-runtime constant so the driver never retypes the literal.
   */
  readonly deepseekProviderId: string;
  /**
   * DeepSeek-flash model the Rust read-only route qualifier requires (clause 3). Injected from the
   * api-runtime constant.
   */
  readonly deepseekFlashModel: string;
  /** Codex provider id for mission-bound observe-wrapper WorkItems. */
  readonly codexProviderId: string;
  /** Codex model for mission-bound observe-wrapper WorkItems. */
  readonly codexModel: string;
  /** Claude provider id for mission-bound mirror WorkItems. */
  readonly claudeProviderId: string;
  /** Claude model for mission-bound mirror WorkItems. */
  readonly claudeModel: string;
  /**
   * Optional sink for the fire-and-forget run's rejection (never throws into the intake path).
   * Defaults to a silent swallow — the bound seam is the observability surface, not this driver.
   */
  readonly onDispatchError?: (error: unknown) => void;
  readonly verifyOrganicProvenance?: (input: {
    request: FridayRustHubMissionIntakeRequest;
    provenance: FridayOrganicRunProvenance;
  }) => boolean;
}

export interface FridayMissionAutoDispatchDriver {
  /**
   * Invoked by the mission-spine dispatch adapter AFTER a successful intake, BEFORE the result is
   * returned verbatim. SYNCHRONOUS + void + fully error-isolated: it inspects the trigger condition,
   * and for a fresh-ready intake FIRES `startRun` without awaiting it (the intake response returns
   * immediately) and swallows any synchronous throw / async rejection so the intake path is NEVER
   * perturbed. For a non-qualifying intake it is a no-op.
   */
  onIntakeReady(
    request: FridayRustHubMissionIntakeRequest,
    result: FridayRustHubMissionIntakeResult,
  ): void;
}

/**
 * Derive the bound run's task text from the intake REQUEST. Title is the primary handle; intent is
 * appended when present + distinct so the read-only run has the mission's own framing. Falls back to
 * a stable phrasing keyed on the (server-validated) workItemId so the task is never empty.
 */
function deriveTask(
  request: FridayRustHubMissionIntakeRequest,
  result: FridayRustHubMissionIntakeResult,
): string {
  const title = typeof request.title === "string" ? request.title.trim() : "";
  const intent =
    typeof request.intent === "string" ? request.intent.trim() : "";
  if (title.length > 0 && intent.length > 0 && intent !== title) {
    return `${title} — ${intent}`;
  }
  if (title.length > 0) return title;
  if (intent.length > 0) return intent;
  return `Advance mission work item ${result.workItemId ?? ""}`.trim();
}

function selectedLane(
  request: FridayRustHubMissionIntakeRequest,
  result: FridayRustHubMissionIntakeResult,
): string {
  return (result.selectedLane ?? request.lane).trim();
}

function selectedTargetProviderOrAgent(
  request: FridayRustHubMissionIntakeRequest,
  result: FridayRustHubMissionIntakeResult,
): string | undefined {
  return (result.selectedTargetProviderOrAgent ?? request.targetProviderOrAgent)?.trim();
}

function isCodexMissionTarget(
  request: FridayRustHubMissionIntakeRequest,
  result: FridayRustHubMissionIntakeResult,
): boolean {
  return selectedLane(request, result) === "codex" &&
    selectedTargetProviderOrAgent(request, result) === "codex";
}

function isClaudeMissionTarget(
  request: FridayRustHubMissionIntakeRequest,
  result: FridayRustHubMissionIntakeResult,
): boolean {
  return selectedLane(request, result) === RUST_ROUTE_CLAUDE_PROVIDER_ID &&
    selectedTargetProviderOrAgent(request, result) === RUST_ROUTE_CLAUDE_PROVIDER_ID;
}

function isCodexOrganicSpawn(request: FridayRustHubMissionIntakeRequest): boolean {
  return request.deliveryRoute.trim() === "ops://codex-organic-spawn";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function attestationPathFromRef(attestationRef: string): string | null {
  try {
    return fileURLToPath(attestationRef);
  } catch {
    return null;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function verifyOperatorSignatureProvenanceFromAttestationRef(input: {
  request: FridayRustHubMissionIntakeRequest;
  provenance: FridayOrganicRunProvenance;
}): boolean {
  const verifyKeyPath = process.env.FRIDAY_CODEX_ORGANIC_ATTESTATION_VERIFY_KEY;
  if (!verifyKeyPath || verifyKeyPath.trim().length === 0) return false;
  const attestationPath = attestationPathFromRef(input.provenance.attestationRef);
  if (!attestationPath) return false;
  try {
    const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
    const signedPayload = {
      issuedAt: attestation.issuedAt,
      principal: attestation.principal,
      publicKeyId: attestation.publicKeyId,
      route: attestation.route,
      schema: attestation.schema,
      source: attestation.source,
      taskSha256: attestation.taskSha256,
    };
    if (signedPayload.schema !== "friday.operator_organic_attestation.v1") return false;
    if (signedPayload.source !== "operator_signature") return false;
    if (signedPayload.route !== input.request.deliveryRoute.trim()) return false;
    const operatorTask = typeof input.request.intent === "string" ? input.request.intent.trim() : "";
    if (operatorTask.length === 0) return false;
    if (signedPayload.taskSha256 !== sha256Hex(operatorTask)) return false;
    if (signedPayload.taskSha256 !== input.provenance.taskSha256.toLowerCase()) return false;
    if (signedPayload.principal !== input.provenance.principal) return false;
    if (signedPayload.publicKeyId !== input.provenance.publicKeyId) return false;
    if (signedPayload.issuedAt !== input.provenance.issuedAt) return false;
    if (typeof attestation.signature !== "string") return false;
    const publicKey = createPublicKey(readFileSync(verifyKeyPath, "utf8"));
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      Buffer.from(stableStringify(signedPayload), "utf8"),
      publicKey,
      Buffer.from(attestation.signature, "base64"),
    );
  } catch {
    return false;
  }
}

function validOperatorSignatureProvenance(
  request: FridayRustHubMissionIntakeRequest,
  verifyProvenance: (input: {
    request: FridayRustHubMissionIntakeRequest;
    provenance: FridayOrganicRunProvenance;
  }) => boolean,
): FridayOrganicRunProvenance | null {
  const provenance = request.organicProvenance;
  if (!provenance) return null;
  if (provenance.organic !== true) return null;
  if (provenance.source !== "operator_signature") return null;
  if (provenance.route !== request.deliveryRoute.trim()) return null;
  if (provenance.principal.trim().length === 0) return null;
  if (provenance.attestationRef.trim().length === 0) return null;
  if (!/^[a-f0-9]{64}$/i.test(provenance.taskSha256)) return null;
  const normalized = {
    ...provenance,
    principal: provenance.principal.trim(),
    attestationRef: provenance.attestationRef.trim(),
    taskSha256: provenance.taskSha256.toLowerCase(),
    route: provenance.route.trim(),
  };
  return verifyProvenance({ request, provenance: normalized }) ? normalized : null;
}

export function createFridayMissionAutoDispatchDriver(
  options: CreateFridayMissionAutoDispatchDriverOptions,
): FridayMissionAutoDispatchDriver {
  const {
    startRun: resolveStartRun,
    deepseekProviderId,
    deepseekFlashModel,
    codexProviderId,
    codexModel,
    claudeProviderId,
    claudeModel,
    onDispatchError,
    verifyOrganicProvenance = verifyOperatorSignatureProvenanceFromAttestationRef,
  } = options;

  return {
    onIntakeReady(
      request: FridayRustHubMissionIntakeRequest,
      result: FridayRustHubMissionIntakeResult,
    ): void {
      try {
        // Trigger ONLY for a FRESH ready intake with a present workItem (mirror of the Rust
        // `mission_intake_allows_new_work` predicate + the workItem-presence guard). A blocked /
        // duplicate intake (status !== "ready" OR createdOrReady !== true OR no workItemId)
        // dispatches NOTHING — no re-spend.
        if (
          typeof result.status !== "string" ||
          result.status.trim() !== "ready" ||
          result.createdOrReady !== true ||
          typeof result.workItemId !== "string" ||
          result.workItemId.trim().length === 0
        ) {
          return;
        }

        const startRun = resolveStartRun();
        if (!startRun) {
          // Thunk not yet populated / runtime had no agent surface ⇒ harmless no-op.
          return;
        }

        // Build the handle from the SERVER-PRODUCED result — NEVER the raw client body. The owner
        // and task text are the only values taken from the request.
        const missionContext: FridayRustHubAgentRunMissionContext = {
          fridayConversationId: result.fridayConversationId,
          missionId: result.missionId,
          workItemId: result.workItemId,
        };
        const ownerPrincipal =
          typeof request.ownerPrincipal === "string" &&
          request.ownerPrincipal.trim().length > 0
            ? request.ownerPrincipal.trim()
            : undefined;
        const codexMissionTarget = isCodexMissionTarget(request, result);
        const claudeMissionTarget = isClaudeMissionTarget(request, result);
        const organicProvenance = isCodexOrganicSpawn(request)
          ? validOperatorSignatureProvenance(request, verifyOrganicProvenance)
          : null;
        if (isCodexOrganicSpawn(request) && !organicProvenance) {
          onDispatchError?.(
            new Error("Codex organic spawn requires verified operator_signature provenance."),
          );
          return;
        }
        const route = codexMissionTarget
          ? { providerId: codexProviderId, model: codexModel }
          : claudeMissionTarget
            ? { providerId: claudeProviderId, model: claudeModel }
            : { providerId: deepseekProviderId, model: deepseekFlashModel };

        // Fire-and-forget: invoke startRun WITHOUT awaiting. The intake response returns
        // immediately; the bound run walks the WorkItem via the Rust seam. A synchronous throw
        // from startRun is caught by the outer try/catch; an async rejection is swallowed via
        // `.catch` so there is no unhandled rejection and the intake path is never perturbed.
        void startRun({
          task: deriveTask(request, result),
          ...(ownerPrincipal !== undefined
            ? { principalId: ownerPrincipal }
            : {}),
          providerId: route.providerId,
          model: route.model,
          constraints: { readOnly: true },
          allowedRustRouteTools: [...RUST_ROUTE_READ_TOOL_ALLOWLIST],
          missionContext,
          ...(organicProvenance ? { organicProvenance } : {}),
          ...(codexMissionTarget
            ? { timeoutMs: RUST_ROUTE_CODEX_MISSION_DISPATCH_TIMEOUT_MS }
            : {}),
        }).catch((error: unknown) => {
          onDispatchError?.(error);
        });
      } catch (error) {
        // NO-DEGRADE: a synchronous throw inside the trigger (e.g. a malformed result) must NEVER
        // surface into the intake response. Swallow + report via the optional sink.
        onDispatchError?.(error);
      }
    },
  };
}
