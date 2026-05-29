import type { FridayWorkflowCrudService } from "../services/friday-workflow-crud-service.js";
import type { FridayWorkflowExecutionService } from "../services/friday-workflow-execution-service.js";
import type { FridayWorkflowTriggerService } from "../services/friday-workflow-trigger-service.js";
import type { FridayWorkflowApprovalService } from "../services/friday-workflow-approval-service.types.js";
import type {
  FridayNodeCompletionVerification,
  FridayWorkflowRunEntity,
  FridayWorkflowRunEvidenceStatus,
  ISODateTime,
  UUID,
} from "../model/friday-workflow.types.js";

export type FridayWorkflowEvidenceModule =
  | "rules"
  | "node-runner"
  | "acceptance"
  | "retry"
  | "playbook";

export interface FridayWorkflowRunEvidenceQuery {
  modules?: FridayWorkflowEvidenceModule[];
  eventNames?: string[];
  nodeId?: string;
  attempt?: number;
  limit?: number;
}

export interface FridayWorkflowEvidenceEvent {
  eventId: string;
  event: string;
  module: FridayWorkflowEvidenceModule;
  emittedAt: ISODateTime;
  redacted: boolean;
  correlation: {
    runId: string;
    workflowId?: string;
    nodeId?: string;
    attempt?: number;
    traceId?: string;
    spanId?: string;
  };
  payload: Record<string, unknown>;
}

export interface FridayWorkflowRetryEvidenceTrace {
  runId: UUID;
  nodeId: string;
  attempt: number;
  category: string;
  errorCode: string;
  errorMessage?: string;
  decision: {
    shouldRetry: boolean;
    delayMs: number;
    reason: string;
    maxAttempts: number;
    budgetExhausted: boolean;
    circuitOpen: boolean;
    escalateToDlq: boolean;
  };
  timestamp: ISODateTime;
}

export interface FridayWorkflowPlaybookEvidenceTrace {
  runId: UUID;
  workflowId: UUID;
  phase: "intake" | "feedback";
  timestamp: ISODateTime;
  intake?: {
    decision: string;
    playbookId: string | null;
    versionNumber: number | null;
    matchScore: number | null;
    evaluatedAt: ISODateTime;
  };
  feedback?: {
    candidateId: string | null;
    promotedPlaybookId: string | null;
    promotionDecision: string | null;
    scoreRecalculated: boolean;
    recordedAt: ISODateTime;
  };
}

export interface FridayWorkflowRunEvidenceSummary {
  totalEvents: number;
  byModule: Record<FridayWorkflowEvidenceModule, number>;
  retryTraceCount: number;
  playbookTraceCount: number;
  acceptanceDecisions: {
    passed: number;
    warned: number;
    failed: number;
  };
}

export interface FridayWorkflowRunEvidenceCorrelationRow {
  nodeId: string;
  attempt: number;
  eventCount: number;
  modules: FridayWorkflowEvidenceModule[];
  retryTraceCount: number;
}

export interface FridayWorkflowRunEvidenceResponse {
  run: FridayWorkflowRunEntity | null;
  exportedAt: ISODateTime;
  query: FridayWorkflowRunEvidenceQuery;
  summary: FridayWorkflowRunEvidenceSummary;
  events: FridayWorkflowEvidenceEvent[];
  playbook: {
    traces: FridayWorkflowPlaybookEvidenceTrace[];
  };
  acceptance: {
    events: FridayWorkflowEvidenceEvent[];
  };
  retry: {
    events: FridayWorkflowEvidenceEvent[];
    traces: FridayWorkflowRetryEvidenceTrace[];
  };
  correlation: {
    items: FridayWorkflowRunEvidenceCorrelationRow[];
  };
  /**
   * Phase 14.5C: honest evidence persistence status for this run. Mirrors
   * the runtime-tracked status so consumers can render an accurate proof
   * receipt — `degraded` and `unavailable` block any proof claim.
   */
  evidenceStatus: FridayWorkflowRunEvidenceStatus;
  /**
   * Audit C: orthogonal run-level completion-verification truth (worst node
   * label observed). SEPARATE from `evidenceStatus` — a run can be
   * `available` (healthy persistence) yet `proof_pending` (a side-effect node
   * lacked deterministic evidence). A non-`verified` value means the run is
   * not a clean/verified completion and cannot back a proof claim, for a
   * reason distinct from persistence durability.
   */
  completionVerification: FridayNodeCompletionVerification;
}

export interface FridayWorkflowRunEvidenceExport {
  exportId: UUID;
  runId: UUID;
  artifactId: UUID;
  uri: string;
  checksum: string;
  createdAt: ISODateTime;
  persisted: boolean;
  filePersisted: boolean;
  query: FridayWorkflowRunEvidenceQuery;
  summary: FridayWorkflowRunEvidenceSummary;
}

export interface FridayWorkflowRunEvidenceExportRecord {
  export: FridayWorkflowRunEvidenceExport;
  evidence: FridayWorkflowRunEvidenceResponse;
}

export interface FridayWorkflowRunEvidenceExportDownload {
  export: FridayWorkflowRunEvidenceExport;
  file: {
    uri: string;
    path?: string;
    exists: boolean;
    sizeBytes?: number;
  };
  content: string;
}

export interface FridayWorkflowEvidenceService {
  getRunEvidence(
    runId: UUID,
    query?: FridayWorkflowRunEvidenceQuery,
  ): FridayWorkflowRunEvidenceResponse;
  exportRunEvidence(
    runId: UUID,
    query?: FridayWorkflowRunEvidenceQuery,
  ): FridayWorkflowRunEvidenceExportRecord;
  getRunEvidenceExport(
    runId: UUID,
    exportId: UUID,
  ): FridayWorkflowRunEvidenceExportRecord | null;
  listRunEvidenceExports(
    runId: UUID,
    limit?: number,
  ): FridayWorkflowRunEvidenceExport[];
  downloadRunEvidenceExport(
    runId: UUID,
    exportId: UUID,
  ): FridayWorkflowRunEvidenceExportDownload | null;
  /**
   * Phase 14.5C: deterministic per-run evidence persistence status. Returns
   * `available` when the run has never observed an evidence-store degrade,
   * `degraded` when at least one write or read swallowed a "no such table"
   * style error, and `unavailable` while persistence is paused for the run.
   * Reads are honest across the runtime, the task workflow service, and any
   * downstream verifier — there is no fallback that masks degraded state.
   */
  getRunEvidenceStatus(runId: UUID): FridayWorkflowRunEvidenceStatus;
  /**
   * Audit C: deterministic per-run completion-verification truth, ORTHOGONAL
   * to `getRunEvidenceStatus`. Returns `verified` only for a terminally
   * `completed` run whose every node was a clean/verified completion; a
   * side-effect node lacking deterministic evidence yields `proof_pending`,
   * and a non-settled run is never `verified` (fail-closed against the
   * mid-flight race). The task workflow verifier reads this to refuse a
   * non-verified run as proof backing — never conflated with persistence.
   */
  getRunCompletionVerification(runId: UUID): FridayNodeCompletionVerification;
}

/**
 * Composite runtime surface that exposes all Phase 3 services
 * for integration with hub gateway and other hub services.
 */
export interface FridayWorkflowRuntime {
  crud: FridayWorkflowCrudService;
  execution: FridayWorkflowExecutionService;
  triggers: FridayWorkflowTriggerService;
  approval: FridayWorkflowApprovalService;
  evidence: FridayWorkflowEvidenceService;
}
