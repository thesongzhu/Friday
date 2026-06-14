import type {
  FridayAgentContextCostSummary,
  FridayAgentExecutionContext,
  FridayAgentRunConstraints,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentTaskProfileInput,
  FridayAgentUnifiedTaskStateSnapshot,
  FridayResolvedAgentTaskProfile,
} from "#agent";
import type { FridayPaginationQuery } from "./friday-api-common.types.js";

export interface FridayStartAgentRunRequest {
  task: string;
  taskPrompt?: string;
  providerId?: string;
  requestedProviderId?: string;
  model?: string;
  requestedModel?: string;
  replyToMessageId?: string;
  sessionKey?: string;
  timezone?: string;
  timeoutMs?: number;
  requireReview?: boolean;
  constraints?: FridayAgentRunConstraints;
  taskProfile?: FridayAgentTaskProfileInput;
  executionContext?: FridayAgentExecutionContext;
  /**
   * execrun-replacement S-F-compose (DARK): the explicit, positive, per-run grant of the
   * Rust read-tool set. Additive + optional — every existing caller omits it. When the
   * default-OFF `routeAgentRunViaRust` flag is on, ONLY a request that positively grants
   * exactly the 4 Rust read tools (read_file/list_dir/stat_file/search) can qualify for the
   * Rust read-only route. Absent ⇒ disqualified ⇒ today's unchanged 503. Never derived from
   * readOnly — this is the independent clause-4 gate.
   */
  allowedRustRouteTools?: string[];
  /**
   * (A2b Phase 2, mutation-relax — DARK, default-off) the explicit POSITIVE grant of mutating
   * Rust tools (a subset of write_file/append_file/edit_file/delete_file/move_file/run_command)
   * and the REQUIRED operator-signed gate opt-in marker (`"operator_signed_ed25519"`). Additive +
   * optional — every existing caller omits BOTH. A `readOnly:false` run is admitted to the Rust
   * route ONLY when the default-OFF `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag is on AND it carries a
   * non-empty grant ⊆ the closed mutating allow-list AND `mutationGate === "operator_signed_ed25519"`
   * AND a bound owner principal. These admit CANDIDACY only — the Rust runtime gate Pauses every
   * mutating tool pending an operator-signed Ed25519 approval (the signature, NOT this field, is the
   * authority). Absent / flag-off ⇒ a `readOnly:false` run stays disqualified ⇒ today's 503.
   */
  mutatingToolGrant?: string[];
  mutationGate?: string;
  /**
   * (NS45-PR2 / mission-bound driver — DARK, additive-optional) the FIRST-CLASS Mission handle this
   * run is BOUND to. A real handle `{fridayConversationId, missionId, workItemId}` (all three
   * REQUIRED, non-empty — matching the Rust `MissionWorkItemContextWire`) is threaded UNCHANGED down
   * the route→compose→dispatch chain to the sealed client (#750), which emits the snake_case
   * `mission_context` wire block ONLY when present. ABSENT (or any field missing/blank ⇒ treated as
   * absent at the route) ⇒ the field is OMITTED end-to-end and the dispatch is BYTE-IDENTICAL to
   * today's unbound run. The Rust server walks the mission-bound run path behind its default-off
   * `FRIDAY_MISSION_BOUND_RUN` flag, so carrying the handle changes no live behavior until that flag
   * is on. **SECURITY: this only SELECTS which Mission/WorkItem the run binds to; it confers NO
   * authority — the bound owner is the authenticated `forwarded_principal`, gated server-side, never
   * this handle.** Does NOT change Rust-route QUALIFICATION (it rides ALONGSIDE the qualifying
   * fields). Mirrors the `allowedRustRouteTools`/`mutatingToolGrant` additive-optional discipline.
   */
  missionContext?: {
    fridayConversationId: string;
    missionId: string;
    workItemId: string;
  };
}

export interface FridayAgentRunExecutionResponse {
  runId: string;
  status: FridayAgentRunStatus;
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  images?: string[];
  finalResponse?: string;
  contextCostSummary?: FridayAgentContextCostSummary;
  taskProfile?: FridayResolvedAgentTaskProfile;
}

export interface FridayStartAgentRunResponse extends FridayAgentRunExecutionResponse {
  eventStreamAvailable: true;
}

export interface FridayListAgentRunsQuery extends FridayPaginationQuery {
  status?: FridayAgentRunStatus;
}

export interface FridayAgentRunWithUnifiedTaskState extends FridayAgentRunRecord {
  unifiedTaskState: FridayAgentUnifiedTaskStateSnapshot;
}

export interface FridayListAgentRunsResponse {
  items: FridayAgentRunWithUnifiedTaskState[];
}

export interface FridayGetAgentRunResponse {
  run: FridayAgentRunWithUnifiedTaskState;
}

export interface FridayCancelAgentRunResponse {
  cancelled: boolean;
  runId: string;
}

/**
 * (S6 mutating-chat — DARK, default-off) The REFS-ONLY outcome of relaying an operator-signed
 * approval to RESUME a paused mutating run. Mirrors the Rust `AgentRunControlResult` the sealed-WS
 * resume returns: the coarse op/accepted/status + an optional soft audit ref — NEVER the mutation
 * body, args, or answer. `accepted=false` is a fail-closed refusal (forged/replayed/expired
 * signature, unprovisioned verify key, or a rejected/cancelled run); `status` says why at a coarse
 * grain. The TS route is a pure courier — it relays the OPAQUE signed blob verbatim and NEVER
 * inspects the signature/digest (INV-1: verification happens ONLY in Rust under the operator key).
 */
export interface FridayResumeAgentRunResponse {
  runId: string;
  op: string;
  accepted: boolean;
  status: string;
  auditRef?: string;
}
