/**
 * Phase 13.5A task workflow policy service.
 *
 * Implements the thin task workflow policy on top of existing Friday
 * primitives. The service holds all enforcement:
 *
 *  - Required deterministic gates cannot be disabled by supervisor mode
 *    or user configuration (HTTP 400 `REQUIRED_GATE_UNDISABLE_REFUSED`).
 *  - Verified claims require an evidence ref AND an evidence-bearing
 *    claim kind. Docs/spec intent, summary/context replay, CLI self-report,
 *    and provider fallback cannot reach `verified` status.
 *  - Whole-repo context packages are refused.
 *  - Preview never persists.
 *  - /v1/agent/runs state is never written or mutated by this service.
 *
 * @module task-workflows/friday-task-workflow-service
 */

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";

import { validateFridayTaskWorkflowContextPackage } from "./friday-task-workflow-context-package.js";
import {
  defaultFridayTaskWorkflowBoundaryRefs,
} from "./friday-task-workflow-boundaries.js";
import {
  composeFridayTaskWorkflowChannelDispatchedDisclosure,
  composeFridayTaskWorkflowChannelIssuedDisclosure,
  FRIDAY_TASK_WORKFLOW_CHANNEL_COMMAND_DEFAULT_TTL_MS,
  getFridayTaskWorkflowChannelDispatchedAction,
  hashFridayChannelIdentifier,
  issueFridayChannelCommandConfirmationToken,
} from "./friday-task-workflow-channel-commands.js";
import {
  getFridayTaskWorkflowAllowedRefSources,
  isFridayTaskWorkflowCliShapedRefKind,
  isFridayTaskWorkflowRefSourceCompatible,
} from "./friday-task-workflow-compatibility.js";
import { evaluateFridayTaskWorkflowCloseoutGates } from "./friday-task-workflow-closeout-gates.js";
import {
  projectFridayEvidenceExplorerEntry,
  redactFridayEvidenceRefForDrilldown,
} from "./friday-task-workflow-evidence-explorer.js";
import {
  defaultFridayTaskWorkflowBudget,
  FRIDAY_TASK_WORKFLOW_BUILTIN_GATES,
  isFridayKnownGate,
  isFridayRequiredGate,
  planFridayTaskWorkflowGates,
} from "./friday-task-workflow-gates.js";
import {
  computeFridayTaskWorkflowLaneContextSnapshotHash,
  resolveFridayTaskWorkflowVerifierIndependence,
} from "./friday-task-workflow-lanes.js";
import { computeFridayTaskWorkflowSpecHash } from "./friday-task-workflow-spec-hash.js";
import { buildFridayTaskWorkflowSupervisorOverview } from "./friday-task-workflow-supervisor-view.js";
import type { FridayTaskWorkflowCliAdapter } from "./friday-task-workflow-cli-adapter.js";
import type { FridayTaskWorkflowRepository } from "./friday-task-workflow-repository.js";
import type {
  FridayTaskWorkflowAttachEvidenceRefInput,
  FridayTaskWorkflowBlockClaimInput,
  FridayTaskWorkflowChannelCommandRecord,
  FridayTaskWorkflowChannelIntentKind,
  FridayTaskWorkflowClaimKind,
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowCliHandoffRecord,
  FridayTaskWorkflowCloseoutGateOutcome,
  FridayTaskWorkflowCloseoutReceipt,
  FridayTaskWorkflowCompleteLaneInput,
  FridayTaskWorkflowConfirmChannelCommandInput,
  FridayTaskWorkflowConfirmChannelCommandResult,
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowCreateInput,
  FridayTaskWorkflowDraftClaimInput,
  FridayTaskWorkflowEvidenceExplorerEntry,
  FridayTaskWorkflowEvidenceExplorerQuery,
  FridayTaskWorkflowEvidenceRawDrilldown,
  FridayTaskWorkflowEvidenceRefRecord,
  FridayTaskWorkflowGatePlanEntry,
  FridayTaskWorkflowIssueChannelCommandInput,
  FridayTaskWorkflowIssueChannelCommandResult,
  FridayTaskWorkflowLaneRecord,
  FridayTaskWorkflowOpenExecutorLaneInput,
  FridayTaskWorkflowOpenVerifierLaneInput,
  FridayTaskWorkflowPreview,
  FridayTaskWorkflowRecord,
  FridayTaskWorkflowRecordCliHandoffInput,
  FridayTaskWorkflowReviseInput,
  FridayTaskWorkflowRevisionRecord,
  FridayTaskWorkflowRisk,
  FridayTaskWorkflowStage,
  FridayTaskWorkflowSubmitVerifierVerdictInput,
  FridayTaskWorkflowSupervisorMode,
  FridayTaskWorkflowSupervisorOverview,
  FridayTaskWorkflowVerifyClaimInput,
} from "./friday-task-workflow.types.js";

const DEFAULT_TASK_KIND = "general";
const DEFAULT_RISK: FridayTaskWorkflowRisk = "medium";
const DEFAULT_SUPERVISOR_MODE: FridayTaskWorkflowSupervisorMode = "standard";

const NON_EVIDENCE_CLAIM_KINDS: ReadonlySet<FridayTaskWorkflowClaimKind> = new Set([
  "docs_intent",
  "summary_replay",
  "cli_self_report",
  "provider_fallback",
]);

const EVIDENCE_CLAIM_KIND_REASON: Readonly<Record<string, string>> = {
  docs_intent:
    "docs/spec/intent references describe intended behavior only; they cannot satisfy a verified behavior claim without runtime, code, API, or artifact evidence.",
  summary_replay:
    "summary/context replay output is unconfirmed; verified status requires separate fresh evidence.",
  cli_self_report:
    "CLI backend self-report is unconfirmed until Friday fresh-reads referenced evidence; CLI text alone cannot satisfy verified status.",
  provider_fallback:
    "provider fallback records availability only; it is not an independent fact audit and cannot satisfy verified status.",
};

export interface CreateFridayTaskWorkflowServiceDeps {
  readonly db: FridaySqliteLayer;
  readonly repository: FridayTaskWorkflowRepository;
  readonly idGenerator: () => string;
  readonly nowIso: () => string;
  /**
   * Phase 13.5C CLI backend adapter. Optional: when omitted, the service
   * still accepts laneRole='cli' lanes, but `recordCliHandoff` returns
   * HTTP 503 TASK_WORKFLOW_CLI_ADAPTER_DISABLED so the route surface
   * never silently succeeds. The hub bootstrap wires a live adapter
   * backed by `runFridayCliBackendTextCompletion`; tests can inject a
   * deterministic fake.
   */
  readonly cliAdapter?: FridayTaskWorkflowCliAdapter;
}

export interface FridayTaskWorkflowService {
  preview(input: FridayTaskWorkflowCreateInput): FridayTaskWorkflowPreview;
  create(input: FridayTaskWorkflowCreateInput): FridayTaskWorkflowRecord;
  get(workflowId: string): FridayTaskWorkflowRecord;
  list(options?: { limit?: number }): readonly FridayTaskWorkflowRecord[];
  revise(
    workflowId: string,
    input: FridayTaskWorkflowReviseInput,
  ): {
    readonly workflow: FridayTaskWorkflowRecord;
    readonly revision: FridayTaskWorkflowRevisionRecord;
  };
  listRevisions(workflowId: string): readonly FridayTaskWorkflowRevisionRecord[];
  draftClaim(
    workflowId: string,
    input: FridayTaskWorkflowDraftClaimInput,
  ): FridayTaskWorkflowClaimRecord;
  listClaims(workflowId: string): readonly FridayTaskWorkflowClaimRecord[];
  getClaim(workflowId: string, claimId: string): FridayTaskWorkflowClaimRecord;
  attachEvidenceRef(
    workflowId: string,
    claimId: string,
    input: FridayTaskWorkflowAttachEvidenceRefInput,
  ): {
    readonly evidenceRef: FridayTaskWorkflowEvidenceRefRecord;
    readonly claim: FridayTaskWorkflowClaimRecord;
  };
  listEvidenceRefs(
    workflowId: string,
    claimId: string,
  ): readonly FridayTaskWorkflowEvidenceRefRecord[];
  verifyClaim(
    workflowId: string,
    claimId: string,
    input: FridayTaskWorkflowVerifyClaimInput,
  ): FridayTaskWorkflowClaimRecord;
  blockClaim(
    workflowId: string,
    claimId: string,
    input: FridayTaskWorkflowBlockClaimInput,
  ): FridayTaskWorkflowClaimRecord;
  closeout(workflowId: string): FridayTaskWorkflowCloseoutReceipt;
  openExecutorLane(
    workflowId: string,
    input: FridayTaskWorkflowOpenExecutorLaneInput,
  ): FridayTaskWorkflowLaneRecord;
  openVerifierLane(
    workflowId: string,
    input: FridayTaskWorkflowOpenVerifierLaneInput,
  ): FridayTaskWorkflowLaneRecord;
  completeLane(
    workflowId: string,
    laneId: string,
    input: FridayTaskWorkflowCompleteLaneInput,
  ): FridayTaskWorkflowLaneRecord;
  submitVerifierVerdict(
    workflowId: string,
    verifierLaneId: string,
    input: FridayTaskWorkflowSubmitVerifierVerdictInput,
  ): FridayTaskWorkflowClaimRecord;
  listLanes(workflowId: string): readonly FridayTaskWorkflowLaneRecord[];
  getLane(workflowId: string, laneId: string): FridayTaskWorkflowLaneRecord;
  /**
   * Phase 13.5C live binding: invoke the CLI backend adapter for a
   * laneRole='cli' lane and persist the normalized handoff. The
   * persisted record always carries `verified=false` and the
   * machine-readable capability label produced by the adapter. CLI
   * verifier verdict promotion remains refused at all risk levels, and
   * the `cli_self_report_unconfirmed` closeout gate continues to block
   * any verified CLI claim regardless of how it was drafted.
   */
  recordCliHandoff(
    workflowId: string,
    laneId: string,
    input: FridayTaskWorkflowRecordCliHandoffInput,
  ): Promise<FridayTaskWorkflowCliHandoffRecord>;
  listCliHandoffsByLane(
    workflowId: string,
    laneId: string,
  ): readonly FridayTaskWorkflowCliHandoffRecord[];
  listCliHandoffsByWorkflow(
    workflowId: string,
  ): readonly FridayTaskWorkflowCliHandoffRecord[];
  /**
   * Phase 13.5D supervisor view — read-only assembled overview that
   * mirrors what the UI supervisor panel renders. Touches only task
   * workflow tables and never `/v1/agent/runs`.
   */
  getSupervisorOverview(workflowId: string): FridayTaskWorkflowSupervisorOverview;
  /**
   * Phase 13.5D configured-channel command flow — issue a confirmation
   * token for a canonical task workflow intent. The service hashes the
   * channel chat / message / sender identifiers before persistence;
   * raw channel text never reaches the task workflow tables. Callers
   * pipe the returned `outboundDisclosure` text through the existing
   * channel registry send adapter.
   */
  issueChannelCommand(
    workflowId: string,
    input: FridayTaskWorkflowIssueChannelCommandInput,
  ): FridayTaskWorkflowIssueChannelCommandResult;
  /**
   * Confirm a previously issued channel command via its opaque
   * confirmation token. On success the command is moved to
   * `dispatched` and the canonical dispatched-action label is recorded.
   * The service does not actually run the dispatched action here — it
   * marks the dispatch boundary so callers route through the existing
   * task workflow service APIs (e.g. `getSupervisorOverview`,
   * `closeout`) afterwards.
   */
  confirmChannelCommand(
    workflowId: string,
    input: FridayTaskWorkflowConfirmChannelCommandInput,
  ): FridayTaskWorkflowConfirmChannelCommandResult;
  listChannelCommands(
    workflowId: string,
  ): readonly FridayTaskWorkflowChannelCommandRecord[];
  /**
   * Global Evidence Explorer v1 — metadata-only index over existing
   * evidence refs. Raw payload fields are never exposed by this
   * surface; use `getEvidenceRefRawDrilldown` for the gated drilldown
   * route.
   */
  queryEvidenceExplorer(
    query: FridayTaskWorkflowEvidenceExplorerQuery,
  ): readonly FridayTaskWorkflowEvidenceExplorerEntry[];
  /**
   * Gated raw drilldown. The caller MUST supply an explicit
   * `gateConfirmed=true` flag; the service refuses bypass attempts
   * with HTTP 403. The returned payload is always server-redacted.
   */
  getEvidenceRefRawDrilldown(
    evidenceRefId: string,
    gateConfirmed: boolean,
  ): FridayTaskWorkflowEvidenceRawDrilldown;
}

export function createFridayTaskWorkflowService(
  deps: CreateFridayTaskWorkflowServiceDeps,
): FridayTaskWorkflowService {
  function normalizeCreateInput(input: FridayTaskWorkflowCreateInput): {
    readonly charter: string;
    readonly taskKind: string;
    readonly risk: FridayTaskWorkflowRisk;
    readonly supervisorMode: FridayTaskWorkflowSupervisorMode;
    readonly contextPackage: FridayTaskWorkflowContextPackage;
    readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
    readonly boundaryRefs: readonly string[];
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly budget: number;
  } {
    if (typeof input.charter !== "string" || input.charter.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "charter is required and must be a non-empty string.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.taskKind !== "string" || input.taskKind.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "taskKind is required and must be a non-empty string.",
        { httpStatus: 400 },
      );
    }
    const taskKind = input.taskKind.trim();
    const risk = input.risk ?? DEFAULT_RISK;
    const supervisorMode = input.supervisorMode ?? DEFAULT_SUPERVISOR_MODE;
    const contextPackage = validateFridayTaskWorkflowContextPackage(
      input.contextPackage,
    );
    enforceRequiredGatesAreNotDisabled(input.additionalGateIds);
    const gatePlan = planFridayTaskWorkflowGates({
      risk,
      supervisorMode,
      additionalGateIds: input.additionalGateIds,
    });
    const boundaryRefs = defaultFridayTaskWorkflowBoundaryRefs();
    const metadata = input.metadata ?? {};
    const budget = defaultFridayTaskWorkflowBudget(supervisorMode);
    return {
      charter: input.charter.trim(),
      taskKind: taskKind || DEFAULT_TASK_KIND,
      risk,
      supervisorMode,
      contextPackage,
      gatePlan,
      boundaryRefs,
      metadata,
      budget,
    };
  }

  function preview(input: FridayTaskWorkflowCreateInput): FridayTaskWorkflowPreview {
    const normalized = normalizeCreateInput(input);
    const specHash = computeFridayTaskWorkflowSpecHash({
      charter: normalized.charter,
      taskKind: normalized.taskKind,
      risk: normalized.risk,
      supervisorMode: normalized.supervisorMode,
      contextPackage: normalized.contextPackage,
      gatePlan: normalized.gatePlan,
      boundaryRefs: normalized.boundaryRefs,
    });
    return {
      specHash,
      risk: normalized.risk,
      supervisorMode: normalized.supervisorMode,
      budget: normalized.budget,
      contextPackage: normalized.contextPackage,
      gatePlan: normalized.gatePlan,
      boundaryRefs: normalized.boundaryRefs,
    };
  }

  function create(input: FridayTaskWorkflowCreateInput): FridayTaskWorkflowRecord {
    const normalized = normalizeCreateInput(input);
    const specHash = computeFridayTaskWorkflowSpecHash({
      charter: normalized.charter,
      taskKind: normalized.taskKind,
      risk: normalized.risk,
      supervisorMode: normalized.supervisorMode,
      contextPackage: normalized.contextPackage,
      gatePlan: normalized.gatePlan,
      boundaryRefs: normalized.boundaryRefs,
    });
    const now = deps.nowIso();
    const record: FridayTaskWorkflowRecord = {
      id: deps.idGenerator(),
      charter: normalized.charter,
      specHash,
      parentSpecHash: null,
      taskKind: normalized.taskKind,
      risk: normalized.risk,
      supervisorMode: normalized.supervisorMode,
      budget: normalized.budget,
      stage: "charter",
      contextPackage: normalized.contextPackage,
      gatePlan: normalized.gatePlan,
      boundaryRefs: normalized.boundaryRefs,
      metadata: normalized.metadata,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertWorkflow(db, record);
      deps.repository.upsertSupervisorCursor(db, {
        workflowId: record.id,
        currentStage: record.stage,
        blockers: [],
        lastEventRef: null,
        updatedAt: now,
      });
    });
    return record;
  }

  function get(workflowId: string): FridayTaskWorkflowRecord {
    const found = deps.db.withReadConnection((db) =>
      deps.repository.getWorkflow(db, workflowId),
    );
    if (!found) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_NOT_FOUND",
        `task workflow "${workflowId}" not found.`,
        { httpStatus: 404 },
      );
    }
    return found;
  }

  function list(
    options?: { limit?: number },
  ): readonly FridayTaskWorkflowRecord[] {
    return deps.db.withReadConnection((db) =>
      deps.repository.listWorkflows(db, options),
    );
  }

  function revise(
    workflowId: string,
    input: FridayTaskWorkflowReviseInput,
  ): {
    readonly workflow: FridayTaskWorkflowRecord;
    readonly revision: FridayTaskWorkflowRevisionRecord;
  } {
    if (typeof input.charter !== "string" || input.charter.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "charter is required and must be a non-empty string for revisions.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "reason is required and must be a non-empty string for revisions.",
        { httpStatus: 400 },
      );
    }
    const current = get(workflowId);
    enforceRequiredGatesAreNotDisabled(input.additionalGateIds);
    const supervisorMode = input.supervisorMode ?? current.supervisorMode;
    const contextPackage = input.contextPackage
      ? validateFridayTaskWorkflowContextPackage(input.contextPackage)
      : current.contextPackage;
    const gatePlan = planFridayTaskWorkflowGates({
      risk: current.risk,
      supervisorMode,
      additionalGateIds: input.additionalGateIds,
    });
    const boundaryRefs = current.boundaryRefs;
    const charter = input.charter.trim();
    const reason = input.reason.trim();
    const specHash = computeFridayTaskWorkflowSpecHash({
      charter,
      taskKind: current.taskKind,
      risk: current.risk,
      supervisorMode,
      contextPackage,
      gatePlan,
      boundaryRefs,
      parentSpecHash: current.specHash,
    });
    const now = deps.nowIso();
    const budget = defaultFridayTaskWorkflowBudget(supervisorMode);
    const newWorkflow: FridayTaskWorkflowRecord = {
      ...current,
      charter,
      specHash,
      parentSpecHash: current.specHash,
      supervisorMode,
      budget,
      stage: "revised" satisfies FridayTaskWorkflowStage,
      contextPackage,
      gatePlan,
      updatedAt: now,
    };
    const revision: FridayTaskWorkflowRevisionRecord = {
      id: deps.idGenerator(),
      workflowId,
      specHash,
      parentSpecHash: current.specHash,
      charter,
      reason,
      createdAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertRevision(db, revision);
      deps.repository.updateWorkflowAfterRevision(db, newWorkflow);
      deps.repository.upsertSupervisorCursor(db, {
        workflowId,
        currentStage: newWorkflow.stage,
        blockers: [],
        lastEventRef: null,
        updatedAt: now,
      });
    });
    return { workflow: newWorkflow, revision };
  }

  function listRevisions(
    workflowId: string,
  ): readonly FridayTaskWorkflowRevisionRecord[] {
    get(workflowId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listRevisions(db, workflowId),
    );
  }

  function draftClaim(
    workflowId: string,
    input: FridayTaskWorkflowDraftClaimInput,
  ): FridayTaskWorkflowClaimRecord {
    const workflow = get(workflowId);
    if (typeof input.claimText !== "string" || input.claimText.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "claimText is required and must be a non-empty string.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.claimKind !== "string") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "claimKind is required.",
        { httpStatus: 400 },
      );
    }
    const claimKind = input.claimKind as FridayTaskWorkflowClaimKind;
    const now = deps.nowIso();
    const record: FridayTaskWorkflowClaimRecord = {
      id: deps.idGenerator(),
      workflowId,
      specHash: workflow.specHash,
      claimText: input.claimText.trim(),
      claimKind,
      status: "draft",
      reason: null,
      verifierVerdict: null,
      verifierLaneId: null,
      evidenceRefCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertClaim(db, record);
    });
    return record;
  }

  function listClaims(
    workflowId: string,
  ): readonly FridayTaskWorkflowClaimRecord[] {
    get(workflowId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listClaims(db, workflowId),
    );
  }

  function getClaim(
    workflowId: string,
    claimId: string,
  ): FridayTaskWorkflowClaimRecord {
    get(workflowId);
    const found = deps.db.withReadConnection((db) =>
      deps.repository.getClaim(db, claimId),
    );
    if (!found || found.workflowId !== workflowId) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLAIM_NOT_FOUND",
        `claim "${claimId}" not found for workflow "${workflowId}".`,
        { httpStatus: 404 },
      );
    }
    return found;
  }

  function attachEvidenceRef(
    workflowId: string,
    claimId: string,
    input: FridayTaskWorkflowAttachEvidenceRefInput,
  ): {
    readonly evidenceRef: FridayTaskWorkflowEvidenceRefRecord;
    readonly claim: FridayTaskWorkflowClaimRecord;
  } {
    const claim = getClaim(workflowId, claimId);
    if (claim.status === "verified") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLAIM_VERIFIED",
        "evidence refs cannot be attached after a claim is verified; revise the claim first.",
        { httpStatus: 409 },
      );
    }
    if (typeof input.refKind !== "string" || input.refKind.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "evidence ref `refKind` is required.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.refId !== "string" || input.refId.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "evidence ref `refId` is required.",
        { httpStatus: 400 },
      );
    }
    if (!isFridayTaskWorkflowRefSourceCompatible(claim.claimKind, input.refSource)) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE",
        `evidence ref source "${input.refSource}" is not compatible with claim kind "${claim.claimKind}". ` +
          `Allowed sources: ${getFridayTaskWorkflowAllowedRefSources(claim.claimKind).join(", ") || "<none>"}.`,
        {
          httpStatus: 400,
          details: {
            claimKind: claim.claimKind,
            refSource: input.refSource,
            allowedRefSources: getFridayTaskWorkflowAllowedRefSources(claim.claimKind),
          },
        },
      );
    }
    if (
      !NON_EVIDENCE_CLAIM_KINDS.has(claim.claimKind) &&
      isFridayTaskWorkflowCliShapedRefKind(input.refKind)
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
        `evidence ref refKind "${input.refKind}" is a CLI-shaped reference; CLI handoff / self-report is bounded text only (nativeToolProof=false) and cannot satisfy a verified ${claim.claimKind} claim. Attach a non-CLI evidence ref backed by Friday verifier fresh-reading runtime / code / api / artifact evidence instead.`,
        {
          httpStatus: 400,
          details: {
            claimKind: claim.claimKind,
            refKind: input.refKind,
          },
        },
      );
    }
    const now = deps.nowIso();
    const evidenceRef: FridayTaskWorkflowEvidenceRefRecord = {
      id: deps.idGenerator(),
      workflowId,
      claimId,
      refKind: input.refKind.trim(),
      refId: input.refId.trim(),
      refHash: input.refHash?.trim() ?? null,
      refSource: input.refSource,
      createdAt: now,
    };
    let nextClaimStatus = claim.status;
    if (claim.status === "draft") {
      nextClaimStatus = "unverified";
    }
    const updatedClaim: FridayTaskWorkflowClaimRecord = {
      ...claim,
      status: nextClaimStatus,
      reason:
        nextClaimStatus !== "blocked"
          ? null
          : claim.reason,
      evidenceRefCount: claim.evidenceRefCount + 1,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertEvidenceRef(db, evidenceRef);
      deps.repository.updateClaim(db, updatedClaim);
    });
    return { evidenceRef, claim: updatedClaim };
  }

  function listEvidenceRefs(
    workflowId: string,
    claimId: string,
  ): readonly FridayTaskWorkflowEvidenceRefRecord[] {
    getClaim(workflowId, claimId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listEvidenceRefs(db, claimId),
    );
  }

  function verifyClaim(
    workflowId: string,
    claimId: string,
    input: FridayTaskWorkflowVerifyClaimInput,
  ): FridayTaskWorkflowClaimRecord {
    const workflow = get(workflowId);
    const claim = getClaim(workflowId, claimId);
    if (
      typeof input.verifierVerdict !== "string" ||
      input.verifierVerdict.trim().length === 0
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "verifierVerdict must be a non-empty string.",
        { httpStatus: 400 },
      );
    }
    if (claim.status === "blocked") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLAIM_BLOCKED",
        "claim is blocked; unblock or revise the workflow before verifying.",
        { httpStatus: 409 },
      );
    }
    if (NON_EVIDENCE_CLAIM_KINDS.has(claim.claimKind)) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
        EVIDENCE_CLAIM_KIND_REASON[claim.claimKind] ??
          "this claim kind cannot satisfy verified status.",
        {
          httpStatus: 400,
          details: { claimKind: claim.claimKind },
        },
      );
    }
    if (claim.evidenceRefCount <= 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLAIM_EVIDENCE_REQUIRED",
        "verified claims require at least one evidence ref to be attached first.",
        { httpStatus: 400 },
      );
    }
    const attachedRefs = deps.db.withReadConnection((db) =>
      deps.repository.listEvidenceRefs(db, claimId),
    );
    const incompatibleRefs = attachedRefs.filter(
      (ref) => !isFridayTaskWorkflowRefSourceCompatible(claim.claimKind, ref.refSource),
    );
    if (incompatibleRefs.length > 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLAIM_REFSOURCE_INCOMPATIBLE",
        `claim "${claim.id}" of kind "${claim.claimKind}" has evidence ref(s) with incompatible refSource(s); cannot reach verified.`,
        {
          httpStatus: 400,
          details: {
            claimKind: claim.claimKind,
            offendingRefIds: incompatibleRefs.map((r) => r.id),
            offendingRefSources: incompatibleRefs.map((r) => r.refSource),
            allowedRefSources: getFridayTaskWorkflowAllowedRefSources(claim.claimKind),
          },
        },
      );
    }
    const cliShapedRefs = attachedRefs.filter((ref) =>
      isFridayTaskWorkflowCliShapedRefKind(ref.refKind),
    );
    if (cliShapedRefs.length > 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
        `claim "${claim.id}" of kind "${claim.claimKind}" has CLI-shaped evidence ref(s); CLI handoff / self-report cannot satisfy verified status. Attach evidence refs backed by Friday verifier fresh-reading runtime / code / api / artifact evidence instead.`,
        {
          httpStatus: 400,
          details: {
            claimKind: claim.claimKind,
            offendingRefIds: cliShapedRefs.map((r) => r.id),
            offendingRefKinds: cliShapedRefs.map((r) => r.refKind),
          },
        },
      );
    }
    let resolvedVerifierLaneId: string | null = null;
    if (input.verifierLaneId !== undefined) {
      if (
        typeof input.verifierLaneId !== "string" ||
        input.verifierLaneId.trim().length === 0
      ) {
        throw new FridayDomainError(
          "TASK_WORKFLOW_INVALID",
          "verifierLaneId must be a non-empty string when provided.",
          { httpStatus: 400 },
        );
      }
      const lane = deps.db.withReadConnection((db) =>
        deps.repository.getLane(db, input.verifierLaneId as string),
      );
      if (!lane || lane.workflowId !== workflowId) {
        throw new FridayDomainError(
          "TASK_WORKFLOW_LANE_NOT_FOUND",
          `verifierLaneId "${input.verifierLaneId}" not found for workflow "${workflowId}".`,
          { httpStatus: 404 },
        );
      }
      if (lane.laneKind !== "verifier") {
        throw new FridayDomainError(
          "TASK_WORKFLOW_LANE_KIND_INVALID",
          `lane "${lane.id}" is a ${lane.laneKind} lane; verifierLaneId must point at a verifier lane.`,
          { httpStatus: 400, details: { laneKind: lane.laneKind } },
        );
      }
      if (lane.laneRole === "cli") {
        throw new FridayDomainError(
          "TASK_WORKFLOW_CLI_VERIFIER_LANE_REFUSED",
          `CLI verifier lane "${lane.id}" cannot promote a claim to verified. CLI output remains draft / unverified; verdict promotion requires a Friday native or provider verifier lane that fresh-reads referenced evidence.`,
          {
            httpStatus: 400,
            details: {
              laneId: lane.id,
              laneRole: lane.laneRole,
              workflowRisk: workflow.risk,
            },
          },
        );
      }
      if (lane.status === "blocked") {
        throw new FridayDomainError(
          "TASK_WORKFLOW_LANE_BLOCKED",
          `verifier lane "${lane.id}" is blocked; submit a new verifier lane before verifying.`,
          { httpStatus: 409 },
        );
      }
      if (workflow.risk === "high" && lane.independence !== "independent") {
        throw new FridayDomainError(
          "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
          `high-risk workflow refuses verifier lane "${lane.id}" with independence="${lane.independence}"; an independent verifier surface is required.`,
          {
            httpStatus: 400,
            details: {
              resolvedIndependence: lane.independence,
              workflowRisk: workflow.risk,
              verifierLaneId: lane.id,
            },
          },
        );
      }
      resolvedVerifierLaneId = lane.id;
    } else if (workflow.risk === "high") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_LANE_REQUIRED",
        "high-risk workflows require a verifierLaneId pointing at an independent verifier lane.",
        { httpStatus: 400, details: { workflowRisk: workflow.risk } },
      );
    }
    const now = deps.nowIso();
    const updated: FridayTaskWorkflowClaimRecord = {
      ...claim,
      status: "verified",
      reason: null,
      verifierVerdict: input.verifierVerdict.trim(),
      verifierLaneId: resolvedVerifierLaneId,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.updateClaim(db, updated);
    });
    return updated;
  }

  function blockClaim(
    workflowId: string,
    claimId: string,
    input: FridayTaskWorkflowBlockClaimInput,
  ): FridayTaskWorkflowClaimRecord {
    const claim = getClaim(workflowId, claimId);
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "reason is required when blocking a claim.",
        { httpStatus: 400 },
      );
    }
    const now = deps.nowIso();
    const updated: FridayTaskWorkflowClaimRecord = {
      ...claim,
      status: "blocked",
      reason: input.reason.trim(),
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.updateClaim(db, updated);
    });
    return updated;
  }

  function closeout(workflowId: string): FridayTaskWorkflowCloseoutReceipt {
    const workflow = get(workflowId);
    const { claims, evidenceRefsByClaim, lanes } = deps.db.withReadConnection(
      (db) => {
        const claimList = deps.repository.listClaims(db, workflowId);
        const refMap = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>();
        for (const claim of claimList) {
          refMap.set(claim.id, deps.repository.listEvidenceRefs(db, claim.id));
        }
        const laneList = deps.repository.listLanes(db, workflowId);
        return {
          claims: claimList,
          evidenceRefsByClaim: refMap,
          lanes: laneList,
        };
      },
    );
    const summary = {
      draft: claims.filter((c) => c.status === "draft").length,
      unverified: claims.filter((c) => c.status === "unverified").length,
      verified: claims.filter((c) => c.status === "verified").length,
      blocked: claims.filter((c) => c.status === "blocked").length,
    } as const;
    const gateOutcomes: readonly FridayTaskWorkflowCloseoutGateOutcome[] =
      evaluateFridayTaskWorkflowCloseoutGates({
        gatePlan: workflow.gatePlan,
        claims,
        evidenceRefsByClaim,
        contextPackage: workflow.contextPackage,
        lanes,
        risk: workflow.risk,
        workflowSpecHash: workflow.specHash,
      });
    const blockers: string[] = [];
    if (summary.blocked > 0) {
      blockers.push(`${summary.blocked} claim(s) blocked`);
    }
    if (summary.draft > 0 || summary.unverified > 0) {
      blockers.push(
        `${summary.draft + summary.unverified} claim(s) not verified`,
      );
    }
    const blockingGates = gateOutcomes.filter((g) =>
      isFridayBlockingGateOutcomeForRisk(g, workflow.risk),
    );
    for (const gate of blockingGates) {
      const label = gate.required ? "required gate" : "risk-mandatory gate";
      blockers.push(
        `${label} "${gate.gateId}" blocked: ${gate.reason ?? "no reason recorded"}`,
      );
    }
    const status: "complete" | "partial" | "blocked" =
      summary.blocked > 0 || blockingGates.length > 0
        ? "blocked"
        : summary.draft === 0 && summary.unverified === 0
          ? "complete"
          : "partial";
    const now = deps.nowIso();
    const receipt: FridayTaskWorkflowCloseoutReceipt = {
      id: deps.idGenerator(),
      workflowId,
      specHash: workflow.specHash,
      status,
      claimSummary: summary,
      blockers,
      gateOutcomes,
      createdAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertCloseoutReceipt(db, receipt);
      deps.repository.upsertSupervisorCursor(db, {
        workflowId,
        currentStage: "closeout",
        blockers,
        lastEventRef: null,
        updatedAt: now,
      });
    });
    return receipt;
  }

  function openExecutorLane(
    workflowId: string,
    input: FridayTaskWorkflowOpenExecutorLaneInput,
  ): FridayTaskWorkflowLaneRecord {
    const workflow = get(workflowId);
    validateLaneRole(input.laneRole);
    const providerId = normalizeProviderId(input.providerId);
    const now = deps.nowIso();
    const record: FridayTaskWorkflowLaneRecord = {
      id: deps.idGenerator(),
      workflowId,
      laneKind: "executor",
      laneRole: input.laneRole,
      parentLaneId: null,
      status: "open",
      independence: "not_applicable",
      executorRunRef: null,
      providerId,
      routeTraceRef: null,
      contextSnapshotHash: computeFridayTaskWorkflowLaneContextSnapshotHash({
        contextPackage: workflow.contextPackage,
        boundaryRefs: workflow.boundaryRefs,
      }),
      contextSnapshotSpecHash: workflow.specHash,
      fallbackAvailability: null,
      blocker: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertLane(db, record);
    });
    return record;
  }

  function openVerifierLane(
    workflowId: string,
    input: FridayTaskWorkflowOpenVerifierLaneInput,
  ): FridayTaskWorkflowLaneRecord {
    const workflow = get(workflowId);
    validateLaneRole(input.laneRole);
    if (
      typeof input.parentLaneId !== "string" ||
      input.parentLaneId.trim().length === 0
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "parentLaneId is required when opening a verifier lane.",
        { httpStatus: 400 },
      );
    }
    const parentLane = deps.db.withReadConnection((db) =>
      deps.repository.getLane(db, input.parentLaneId),
    );
    if (!parentLane || parentLane.workflowId !== workflowId) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_LANE_NOT_FOUND",
        `parentLaneId "${input.parentLaneId}" not found for workflow "${workflowId}".`,
        { httpStatus: 404 },
      );
    }
    if (parentLane.laneKind !== "executor") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_LANE_KIND_INVALID",
        `parentLaneId "${parentLane.id}" must be an executor lane; got "${parentLane.laneKind}".`,
        { httpStatus: 400, details: { laneKind: parentLane.laneKind } },
      );
    }
    if (
      input.independenceClaim !== "independent" &&
      input.independenceClaim !== "degraded_unavailable" &&
      input.independenceClaim !== "degraded_same_provider"
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "independenceClaim must be one of 'independent', 'degraded_unavailable', 'degraded_same_provider' for verifier lanes.",
        { httpStatus: 400 },
      );
    }
    const providerId = normalizeProviderId(input.providerId);
    const resolvedIndependence = resolveFridayTaskWorkflowVerifierIndependence({
      verifierLaneRole: input.laneRole,
      verifierProviderId: providerId,
      parentLaneRole: parentLane.laneRole,
      parentProviderId: parentLane.providerId,
      independenceClaim: input.independenceClaim,
    });
    if (workflow.risk === "high" && resolvedIndependence !== "independent") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
        `high-risk workflow refuses verifier lane with independence="${resolvedIndependence}"; an independent verifier surface is required.`,
        {
          httpStatus: 400,
          details: { resolvedIndependence, workflowRisk: workflow.risk },
        },
      );
    }
    const now = deps.nowIso();
    const record: FridayTaskWorkflowLaneRecord = {
      id: deps.idGenerator(),
      workflowId,
      laneKind: "verifier",
      laneRole: input.laneRole,
      parentLaneId: parentLane.id,
      status: "open",
      independence: resolvedIndependence,
      executorRunRef: null,
      providerId,
      routeTraceRef: null,
      contextSnapshotHash: computeFridayTaskWorkflowLaneContextSnapshotHash({
        contextPackage: workflow.contextPackage,
        boundaryRefs: workflow.boundaryRefs,
      }),
      contextSnapshotSpecHash: workflow.specHash,
      fallbackAvailability: null,
      blocker: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertLane(db, record);
    });
    return record;
  }

  function completeLane(
    workflowId: string,
    laneId: string,
    input: FridayTaskWorkflowCompleteLaneInput,
  ): FridayTaskWorkflowLaneRecord {
    get(workflowId);
    const lane = deps.db.withReadConnection((db) =>
      deps.repository.getLane(db, laneId),
    );
    if (!lane || lane.workflowId !== workflowId) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_LANE_NOT_FOUND",
        `lane "${laneId}" not found for workflow "${workflowId}".`,
        { httpStatus: 404 },
      );
    }
    if (lane.status === "completed" || lane.status === "blocked") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_LANE_CLOSED",
        `lane "${lane.id}" is already ${lane.status}; reopen by creating a new lane.`,
        { httpStatus: 409, details: { status: lane.status } },
      );
    }
    if (input.status !== "completed" && input.status !== "blocked") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "completeLane status must be 'completed' or 'blocked'.",
        { httpStatus: 400 },
      );
    }
    if (input.status === "blocked") {
      if (typeof input.blocker !== "string" || input.blocker.trim().length === 0) {
        throw new FridayDomainError(
          "TASK_WORKFLOW_INVALID",
          "blocker reason is required when transitioning a lane to 'blocked'.",
          { httpStatus: 400 },
        );
      }
    }
    if (
      input.fallbackAvailability !== undefined &&
      input.fallbackAvailability !== "not_used" &&
      input.fallbackAvailability !== "used_same_provider" &&
      input.fallbackAvailability !== "used_alternate_provider"
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "fallbackAvailability must be 'not_used', 'used_same_provider', or 'used_alternate_provider' when provided.",
        { httpStatus: 400 },
      );
    }
    const now = deps.nowIso();
    const updated: FridayTaskWorkflowLaneRecord = {
      ...lane,
      status: input.status,
      executorRunRef:
        input.executorRunRef === undefined
          ? lane.executorRunRef
          : input.executorRunRef === null
            ? null
            : String(input.executorRunRef).trim() || null,
      routeTraceRef:
        input.routeTraceRef === undefined
          ? lane.routeTraceRef
          : input.routeTraceRef === null
            ? null
            : String(input.routeTraceRef).trim() || null,
      fallbackAvailability:
        input.fallbackAvailability === undefined
          ? lane.fallbackAvailability
          : input.fallbackAvailability,
      blocker:
        input.status === "blocked"
          ? (input.blocker as string).trim()
          : input.blocker === undefined
            ? lane.blocker
            : input.blocker === null
              ? null
              : String(input.blocker).trim() || null,
      updatedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.updateLane(db, updated);
    });
    return updated;
  }

  function submitVerifierVerdict(
    workflowId: string,
    verifierLaneId: string,
    input: FridayTaskWorkflowSubmitVerifierVerdictInput,
  ): FridayTaskWorkflowClaimRecord {
    if (
      typeof input.claimId !== "string" ||
      input.claimId.trim().length === 0
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "claimId is required.",
        { httpStatus: 400 },
      );
    }
    return verifyClaim(workflowId, input.claimId, {
      verifierVerdict: input.verifierVerdict,
      verifierLaneId,
    });
  }

  function listLanes(
    workflowId: string,
  ): readonly FridayTaskWorkflowLaneRecord[] {
    get(workflowId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listLanes(db, workflowId),
    );
  }

  function getLane(
    workflowId: string,
    laneId: string,
  ): FridayTaskWorkflowLaneRecord {
    get(workflowId);
    const lane = deps.db.withReadConnection((db) =>
      deps.repository.getLane(db, laneId),
    );
    if (!lane || lane.workflowId !== workflowId) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_LANE_NOT_FOUND",
        `lane "${laneId}" not found for workflow "${workflowId}".`,
        { httpStatus: 404 },
      );
    }
    return lane;
  }

  async function recordCliHandoff(
    workflowId: string,
    laneId: string,
    input: FridayTaskWorkflowRecordCliHandoffInput,
  ): Promise<FridayTaskWorkflowCliHandoffRecord> {
    if (!deps.cliAdapter) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLI_ADAPTER_DISABLED",
        "CLI backend adapter is not wired in this runtime; recordCliHandoff cannot be invoked.",
        { httpStatus: 503 },
      );
    }
    const workflow = get(workflowId);
    const lane = getLane(workflowId, laneId);
    if (lane.laneRole !== "cli") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CLI_LANE_REQUIRED",
        `lane "${lane.id}" has laneRole='${lane.laneRole}'; recordCliHandoff requires a laneRole='cli' lane.`,
        {
          httpStatus: 400,
          details: { laneRole: lane.laneRole },
        },
      );
    }
    if (lane.status === "completed" || lane.status === "blocked") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_LANE_CLOSED",
        `lane "${lane.id}" is already ${lane.status}; reopen by creating a new CLI lane before invoking the adapter.`,
        { httpStatus: 409, details: { status: lane.status } },
      );
    }
    if (
      typeof input.systemPrompt !== "string" ||
      input.systemPrompt.trim().length === 0
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "systemPrompt is required and must be a non-empty string.",
        { httpStatus: 400 },
      );
    }
    if (
      typeof input.conversation !== "string" ||
      input.conversation.trim().length === 0
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "conversation is required and must be a non-empty string.",
        { httpStatus: 400 },
      );
    }
    if (input.backendId !== "codex-cli" && input.backendId !== "claude-cli") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "backendId must be one of 'codex-cli', 'claude-cli'.",
        { httpStatus: 400 },
      );
    }
    const handoff = await deps.cliAdapter.produceHandoff({
      backendId: input.backendId,
      systemPrompt: input.systemPrompt,
      conversation: input.conversation,
      contextPackage: workflow.contextPackage,
      boundaryRefs: workflow.boundaryRefs,
      model: input.model,
      timeoutMs: input.timeoutMs,
      minSummaryChars: input.minSummaryChars,
    });
    const now = deps.nowIso();
    const record: FridayTaskWorkflowCliHandoffRecord = {
      id: deps.idGenerator(),
      workflowId,
      laneId: lane.id,
      backendId: handoff.backendId,
      status: handoff.status,
      summaryDraft: handoff.summaryDraft,
      capabilityLabel: handoff.capabilityLabel,
      repairAttempts: handoff.repairAttempts,
      elapsedMs: handoff.elapsedMs,
      failureReason: handoff.failureReason,
      producedAt: handoff.producedAt,
      createdAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertCliHandoff(db, record);
    });
    return record;
  }

  function listCliHandoffsByLane(
    workflowId: string,
    laneId: string,
  ): readonly FridayTaskWorkflowCliHandoffRecord[] {
    getLane(workflowId, laneId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listCliHandoffsByLane(db, laneId),
    );
  }

  function listCliHandoffsByWorkflow(
    workflowId: string,
  ): readonly FridayTaskWorkflowCliHandoffRecord[] {
    get(workflowId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listCliHandoffsByWorkflow(db, workflowId),
    );
  }

  function getSupervisorOverview(
    workflowId: string,
  ): FridayTaskWorkflowSupervisorOverview {
    const workflow = get(workflowId);
    const { cursor, claims, lanes, commands, receipt } = deps.db.withReadConnection(
      (db) => ({
        cursor: deps.repository.getSupervisorCursor(db, workflowId),
        claims: deps.repository.listClaims(db, workflowId),
        lanes: deps.repository.listLanes(db, workflowId),
        commands: deps.repository.listChannelCommandsByWorkflow(db, workflowId),
        receipt: deps.repository.getLatestCloseoutReceipt(db, workflowId),
      }),
    );
    return buildFridayTaskWorkflowSupervisorOverview({
      workflow,
      supervisorCursor: cursor,
      claims,
      lanes,
      channelCommands: commands,
      closeoutReceipt: receipt,
    });
  }

  function issueChannelCommand(
    workflowId: string,
    input: FridayTaskWorkflowIssueChannelCommandInput,
  ): FridayTaskWorkflowIssueChannelCommandResult {
    get(workflowId);
    if (typeof input.channelKind !== "string" || input.channelKind.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "channelKind is required.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.channelChatId !== "string" || input.channelChatId.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "channelChatId is required.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.channelMessageId !== "string" || input.channelMessageId.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "channelMessageId is required.",
        { httpStatus: 400 },
      );
    }
    if (typeof input.senderId !== "string" || input.senderId.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "senderId is required.",
        { httpStatus: 400 },
      );
    }
    if (!isFridayChannelIntent(input.intentKind)) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "intentKind must be one of 'progress_query','closeout_request','supervisor_mode_preview','confirm_token'.",
        { httpStatus: 400 },
      );
    }
    const ttlMs =
      typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) && input.ttlMs > 0
        ? Math.floor(input.ttlMs)
        : FRIDAY_TASK_WORKFLOW_CHANNEL_COMMAND_DEFAULT_TTL_MS;
    const now = deps.nowIso();
    const issuedAtMs = Date.parse(now);
    const expiresAtMs = Number.isFinite(issuedAtMs)
      ? issuedAtMs + ttlMs
      : Date.now() + ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const confirmationToken = issueFridayChannelCommandConfirmationToken();
    const channelKey = `${input.channelKind}:${input.channelChatId}`;
    const messageKey = `${input.channelKind}:${input.channelMessageId}`;
    const senderKey = `${input.channelKind}:${input.senderId}`;
    const record: FridayTaskWorkflowChannelCommandRecord = {
      id: deps.idGenerator(),
      workflowId,
      channelKind: input.channelKind.trim(),
      channelChatHash: hashFridayChannelIdentifier(channelKey),
      channelMessageHash: hashFridayChannelIdentifier(messageKey),
      senderHash: hashFridayChannelIdentifier(senderKey),
      intentKind: input.intentKind,
      confirmationToken,
      status: "issued",
      dispatchedAction: null,
      declinedReason: null,
      issuedAt: now,
      confirmedAt: null,
      dispatchedAt: null,
      expiresAt,
      createdAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.insertChannelCommand(db, record);
    });
    const outboundDisclosure = composeFridayTaskWorkflowChannelIssuedDisclosure({
      workflowId,
      intentKind: record.intentKind,
      confirmationToken: record.confirmationToken,
      expiresAt: record.expiresAt,
    });
    return { command: record, outboundDisclosure };
  }

  function confirmChannelCommand(
    workflowId: string,
    input: FridayTaskWorkflowConfirmChannelCommandInput,
  ): FridayTaskWorkflowConfirmChannelCommandResult {
    get(workflowId);
    if (
      typeof input.confirmationToken !== "string" ||
      input.confirmationToken.trim().length === 0
    ) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "confirmationToken is required.",
        { httpStatus: 400 },
      );
    }
    const token = input.confirmationToken.trim();
    const existing = deps.db.withReadConnection((db) =>
      deps.repository.getChannelCommandByToken(db, token),
    );
    if (!existing || existing.workflowId !== workflowId) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CHANNEL_COMMAND_NOT_FOUND",
        `channel command for token not found for workflow "${workflowId}".`,
        { httpStatus: 404 },
      );
    }
    if (existing.status !== "issued") {
      throw new FridayDomainError(
        "TASK_WORKFLOW_CHANNEL_COMMAND_CLOSED",
        `channel command is already ${existing.status}; issue a new token to retry.`,
        { httpStatus: 409, details: { status: existing.status } },
      );
    }
    const now = deps.nowIso();
    const nowMs = Date.parse(now);
    const expiresMs = Date.parse(existing.expiresAt);
    if (Number.isFinite(nowMs) && Number.isFinite(expiresMs) && nowMs > expiresMs) {
      const expired: FridayTaskWorkflowChannelCommandRecord = {
        ...existing,
        status: "expired",
        declinedReason: "token_expired",
      };
      deps.db.withWriteTransaction((db) => {
        deps.repository.updateChannelCommand(db, expired);
      });
      throw new FridayDomainError(
        "TASK_WORKFLOW_CHANNEL_COMMAND_EXPIRED",
        "channel command confirmation token has expired; issue a new token.",
        { httpStatus: 409 },
      );
    }
    const dispatchedAction = getFridayTaskWorkflowChannelDispatchedAction(
      existing.intentKind,
    );
    const updated: FridayTaskWorkflowChannelCommandRecord = {
      ...existing,
      status: "dispatched",
      dispatchedAction,
      confirmedAt: now,
      dispatchedAt: now,
    };
    deps.db.withWriteTransaction((db) => {
      deps.repository.updateChannelCommand(db, updated);
    });
    const outboundDisclosure = composeFridayTaskWorkflowChannelDispatchedDisclosure({
      workflowId,
      intentKind: updated.intentKind,
      dispatchedAction,
    });
    return { command: updated, dispatchedAction, outboundDisclosure };
  }

  function listChannelCommands(
    workflowId: string,
  ): readonly FridayTaskWorkflowChannelCommandRecord[] {
    get(workflowId);
    return deps.db.withReadConnection((db) =>
      deps.repository.listChannelCommandsByWorkflow(db, workflowId),
    );
  }

  function queryEvidenceExplorer(
    query: FridayTaskWorkflowEvidenceExplorerQuery,
  ): readonly FridayTaskWorkflowEvidenceExplorerEntry[] {
    return deps.db.withReadConnection((db) => {
      const refs = deps.repository.queryEvidenceRefs(db, query);
      const entries: FridayTaskWorkflowEvidenceExplorerEntry[] = [];
      const claimCache = new Map<string, FridayTaskWorkflowClaimRecord>();
      for (const ref of refs) {
        let claim = claimCache.get(ref.claimId);
        if (!claim) {
          const fresh = deps.repository.getClaim(db, ref.claimId);
          if (!fresh) continue;
          claim = fresh;
          claimCache.set(claim.id, claim);
        }
        entries.push(
          projectFridayEvidenceExplorerEntry({ evidenceRef: ref, claim }),
        );
      }
      return entries;
    });
  }

  function getEvidenceRefRawDrilldown(
    evidenceRefId: string,
    gateConfirmed: boolean,
  ): FridayTaskWorkflowEvidenceRawDrilldown {
    if (gateConfirmed !== true) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_EVIDENCE_RAW_GATE_REQUIRED",
        "raw evidence drilldown requires an explicit gate confirmation.",
        { httpStatus: 403 },
      );
    }
    if (typeof evidenceRefId !== "string" || evidenceRefId.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "evidenceRefId is required.",
        { httpStatus: 400 },
      );
    }
    const evidenceRef = deps.db.withReadConnection((db) =>
      deps.repository.getEvidenceRefById(db, evidenceRefId),
    );
    if (!evidenceRef) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_EVIDENCE_REF_NOT_FOUND",
        `evidence ref "${evidenceRefId}" not found.`,
        { httpStatus: 404 },
      );
    }
    return redactFridayEvidenceRefForDrilldown(evidenceRef);
  }

  return {
    preview,
    create,
    get,
    list,
    revise,
    listRevisions,
    draftClaim,
    listClaims,
    getClaim,
    attachEvidenceRef,
    listEvidenceRefs,
    verifyClaim,
    blockClaim,
    closeout,
    openExecutorLane,
    openVerifierLane,
    completeLane,
    submitVerifierVerdict,
    listLanes,
    getLane,
    recordCliHandoff,
    listCliHandoffsByLane,
    listCliHandoffsByWorkflow,
    getSupervisorOverview,
    issueChannelCommand,
    confirmChannelCommand,
    listChannelCommands,
    queryEvidenceExplorer,
    getEvidenceRefRawDrilldown,
  };
}

function isFridayChannelIntent(
  value: unknown,
): value is FridayTaskWorkflowChannelIntentKind {
  return (
    value === "progress_query" ||
    value === "closeout_request" ||
    value === "supervisor_mode_preview" ||
    value === "confirm_token"
  );
}

function validateLaneRole(
  role: unknown,
): asserts role is "native" | "provider" | "cli" {
  if (role !== "native" && role !== "provider" && role !== "cli") {
    throw new FridayDomainError(
      "TASK_WORKFLOW_INVALID",
      "laneRole must be 'native', 'provider', or 'cli'.",
      { httpStatus: 400 },
    );
  }
}

/**
 * A gate outcome blocks closeout when its evaluator emitted `block` AND
 * either the outcome is required by the workflow's gate plan, or the
 * built-in gate metadata marks the gate as mandatoryForRisk for the
 * current workflow risk. This keeps optional-by-default gates (e.g.
 * `independent_verifier_required`) from silently sliding past closeout
 * for the risk levels the registry says they must block at, without
 * relabelling the receipt's per-outcome `required` flag.
 */
function isFridayBlockingGateOutcomeForRisk(
  outcome: FridayTaskWorkflowCloseoutGateOutcome,
  risk: FridayTaskWorkflowRisk,
): boolean {
  if (outcome.status !== "block") return false;
  if (outcome.required) return true;
  const meta = FRIDAY_TASK_WORKFLOW_BUILTIN_GATES.find(
    (gate) => gate.gateId === outcome.gateId,
  );
  return meta?.mandatoryForRisk.includes(risk) === true;
}

function normalizeProviderId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new FridayDomainError(
      "TASK_WORKFLOW_INVALID",
      "providerId must be a string when provided.",
      { httpStatus: 400 },
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Refuse any user-supplied additionalGateIds set that would (1) name a
 * required gate alongside a disable intent, or (2) attempt to remove a
 * required gate from the plan. Unknown gate IDs are dropped silently by
 * the planner, so we only need to throw when a known required gate is
 * present in a way that implies disablement.
 *
 * Currently the API does not expose a `disabledGateIds` field — adding
 * required gate IDs is harmless. This guard exists so future supervisor
 * settings or callers cannot smuggle disable intents through this lane.
 */
function enforceRequiredGatesAreNotDisabled(
  additionalGateIds: readonly string[] | undefined,
): void {
  for (const gateId of additionalGateIds ?? []) {
    if (typeof gateId !== "string" || gateId.trim().length === 0) {
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        "additionalGateIds must be an array of non-empty strings.",
        { httpStatus: 400 },
      );
    }
    if (gateId.startsWith("!")) {
      const target = gateId.slice(1);
      if (isFridayRequiredGate(target)) {
        throw new FridayDomainError(
          "REQUIRED_GATE_UNDISABLE_REFUSED",
          `gate "${target}" is a required deterministic gate and cannot be disabled by user configuration or supervisor mode.`,
          { httpStatus: 400, details: { rejectedGateId: target } },
        );
      }
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        `additionalGateIds entry "${gateId}" looks like a disable directive; this surface is additive only.`,
        { httpStatus: 400 },
      );
    }
    if (!isFridayKnownGate(gateId) && !gateId.includes(".")) {
      // Unknown gate id without dot-prefix is suspicious; reject explicitly so
      // typos surface to callers instead of silently being dropped.
      throw new FridayDomainError(
        "TASK_WORKFLOW_INVALID",
        `additionalGateIds contains unknown gate "${gateId}". Only known built-in gates are accepted.`,
        { httpStatus: 400, details: { rejectedGateId: gateId } },
      );
    }
  }
}
