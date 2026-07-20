// ─── Friday API envelope types ───

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
  };
  requestId: string;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

// ─── Auth types ───

export interface FridayUser {
  id: string;
  email?: string;
  displayName: string;
  role: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  user: FridayUser;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

export interface MeResponse {
  user: FridayUser;
  scopes: string[];
  sessionExpiresAt?: string;
}

export interface AuthBootstrapStatusResponse {
  bootstrapRequired: boolean;
  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1): server-derived, fail-closed flag for whether
   * device-bound owner claim is the AUTHORITATIVE first-run path. `true` ONLY when
   * device-owner authority is enabled (requires native-IPC attestation). On the
   * current build it is `false`, so first-run honestly stays on the passphrase
   * gate. When `true`, RequireAuth routes first-run to the device-claim gate and
   * the passphrase gate is not offered as the authoritative path.
   *
   * Optional in the client type so an older backend (pre-CR-1) that omits the
   * field is treated as `false` (fail-closed → passphrase), never as available.
   */
  deviceClaimAvailable?: boolean;
}

export interface AuthBootstrapResponse {
  initialized: true;
  initializedAt: string;
  userId: string;
}

// ─── SEC-SETUP-BOOTSTRAP-001 (CR-1): device-bound owner claim ───

export interface AuthBootstrapChallengeResponse {
  challengeId: string;
  /** Raw single-use nonce — returned exactly once. */
  nonce: string;
  kind: "install_owner_claim";
  hubId: string;
  installId: string;
  osUser: string;
  origin: string;
  action: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1): server-issued single-use device-key LOGIN
 * challenge. The device signs `nonce` into a fresh owner-login transcript; the
 * backend CAS-consumes it atomically with the session mint, so the login proof is
 * not replayable.
 */
export interface AuthLoginChallengeResponse {
  challengeId: string;
  /** Raw single-use nonce — returned exactly once. */
  nonce: string;
  kind: "device_login_challenge";
  hubId: string;
  installId: string;
  osUser: string;
  origin: string;
  action: string;
  deviceId: string;
  devicePublicKeyHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthDeviceClaimResponse {
  claimed: true;
  claimedAt: string;
  userId: string;
  deviceId: string;
  devicePublicKeyHash: string;
  keyProtection: "secure_enclave_os_verified" | "keychain_acl_verified" | "software_dev_only" | "unverified";
  /** Always false in the release/default profile until native-IPC attestation lands. */
  deviceAuthorityEnabled: boolean;
}

// ─── Agent types ───

export type AgentRunStatus =
  | "pending"
  | "planning"
  | "awaiting_clarification"
  | "awaiting_plan_approval"
  | "awaiting_tool_approval"
  | "executing"
  | "testing"
  | "fixing"
  | "completed"
  | "failed"
  | "failed_tests"
  | "cancelled";

export type AgentTaskProfileId =
  | "default"
  | "deterministic"
  | "planning"
  | "review"
  | "creative";

export type AgentTaskProfileEffort = "low" | "medium" | "high";

export interface AgentTaskProfileInput {
  id?: AgentTaskProfileId;
  model?: string;
  temperature?: number;
  reasoningEffort?: AgentTaskProfileEffort;
  reason?: string;
}

export interface ResolvedAgentTaskProfile {
  id: AgentTaskProfileId;
  label: string;
  description: string;
  model?: string;
  temperature?: number;
  reasoningEffort: AgentTaskProfileEffort;
  reason?: string;
}

export interface AgentContextCostComponent {
  kind: "workspace_context" | "starter_skills" | "mcp" | "subagents" | "tool_routing" | "context_replay";
  estimatedChars: number;
  estimatedInputTokens: number;
  count?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentContextCostSummary {
  totalEstimatedChars: number;
  totalEstimatedInputTokens: number;
  components: AgentContextCostComponent[];
}

export type AgentRunHealthState =
  | "healthy"
  | "needs_approval"
  | "degraded"
  | "retryable"
  | "failed"
  | "rollback_available";

export interface AgentRunHealthSnapshot {
  state: AgentRunHealthState;
  rollbackAvailable: boolean;
  reasonCodes: string[];
}

export interface AgentRunContextSummarySnapshot {
  taskProfileId?: string;
  taskProfileLabel?: string;
  totalEstimatedChars?: number;
  totalEstimatedInputTokens?: number;
  dominantContextKinds: string[];
  learningAdjusted: boolean;
  fallbackAttemptCount: number;
  blockedToolCount: number;
  modelSelectionSource?: string;
}

export interface AgentPackContextMetadata {
  packId: string;
  surface?: string;
  updatedAt?: string;
}

export interface AgentRunMetadata {
  packContext?: AgentPackContextMetadata;
}

export type AgentEvidenceReceiptStatus =
  | "verified_receipt"
  | "blocked_or_failed"
  | "waiting_for_human"
  | "in_progress";

export interface AgentEvidenceReceiptFile {
  label: string;
  kind:
    | "run_record"
    | "tool_calls"
    | "test_results"
    | "response"
    | "artifacts"
    | "evidence_receipt"
    | "audit_endpoint"
    | "artifact";
  path?: string;
  href?: string;
}

export interface AgentEvidenceReceiptCounts {
  toolCalls: {
    total: number;
    succeeded: number;
    failed: number;
  };
  tests: {
    total: number;
    passed: number;
    failed: number;
  };
  artifacts: {
    total: number;
    byType: Record<string, number>;
  };
}

export interface AgentRunEvidenceReceipt {
  schemaVersion: "friday.agent.evidence_receipt.v1";
  receiptKind: "agent_run_replayable_evidence";
  receiptStatus: AgentEvidenceReceiptStatus;
  issuedAt: string;
  run: {
    runId: string;
    task: string;
    status: string;
    completedAt?: string;
    durationMs?: number;
    usageInput?: number;
    usageOutput?: number;
    costUsd?: number | null;
  };
  evidence: AgentEvidenceReceiptCounts & {
    auditEventCount?: number;
    decisionTraceAvailable?: boolean;
    decisionTraceActionCount?: number;
  };
  replay: {
    auditEndpoint: string;
    artifactDir?: string;
    files: AgentEvidenceReceiptFile[];
  };
  blockers: string[];
  limitations: string[];
  proofBoundary: string;
  userSummary: string;
}

export type AgentUnifiedTaskState =
  | "awaiting_clarification"
  | "awaiting_plan_approval"
  | "awaiting_tool_approval"
  | "executing"
  | "verified_receipt"
  | "blocked_recoverable";

export interface AgentUnifiedTaskStateSnapshot {
  schemaVersion: "friday.agent.unified_task_state.v1";
  state: AgentUnifiedTaskState;
  source:
    | "planning_gate"
    | "tool_approval_event"
    | "run_status"
    | "evidence_receipt"
    | "terminal_recovery";
  requiredAction:
    | "answer_clarification"
    | "approve_or_reject_plan"
    | "approve_or_reject_tool"
    | "wait_for_execution"
    | "read_verified_receipt"
    | "review_blocker_or_retry";
  summary: string;
  run: {
    runId: string;
    runStatus: AgentRunStatus;
    sourceSurface?: string;
    startedAt?: string;
    completedAt?: string;
  };
  evidence: {
    statePointer: {
      kind: "agent_run_event" | "agent_evidence_receipt" | "agent_run_record";
      runId: string;
      seq?: number;
      path?: string;
      href?: string;
    };
    receiptStatus?: AgentEvidenceReceiptStatus;
    auditEventCount: number;
    openToolApproval?: {
      grantId?: string;
      toolCallId?: string;
      toolName?: string;
      eventPointer: {
        kind: "agent_run_event" | "agent_evidence_receipt" | "agent_run_record";
        runId: string;
        seq?: number;
        path?: string;
        href?: string;
      };
    };
    terminalPointer?: {
      kind: "agent_run_event" | "agent_evidence_receipt" | "agent_run_record";
      runId: string;
      seq?: number;
      path?: string;
      href?: string;
    };
  };
  recovery: {
    retryable: boolean;
    reason?: string;
  };
  channelBoundary: {
    consumableByChannelAdapters: true;
    liveChannelProof: "not_claimed";
    message: string;
  };
  proofBoundary: string;
}

export interface AgentRunRecord {
  id: string;
  task: string;
  status: AgentRunStatus;
  model?: string;
  sessionKey?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  usageInput?: number;
  usageOutput?: number;
  costUsd?: number;
  output?: string;
  error?: string;
  responseText?: string;
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
  constraints?: {
    readOnly?: boolean;
    operationalMode?: "plan" | "execute" | "restricted";
  };
  planReview?: {
    plan: {
      task: string;
      stepCount: number;
      description: string;
    };
    gate?: {
      kind:
        | "generate_skill"
        | "generate_workflow"
        | "deploy_workflow"
        | "export_workflow_bundle"
        | "major_decision";
      state:
        | "awaiting_clarification"
        | "awaiting_plan_approval"
        | "approved"
        | "rejected"
        | "bypassed";
      clarificationQuestions?: string[];
      answers?: Array<{
        question?: string;
        answer: string;
      }>;
      planMarkdown?: string;
      planSummary?: string;
      approvalPrompt?: string;
      approvalUpdatedAt?: string;
    };
    decision?: {
      approved: boolean;
      mode: string;
      reason?: string;
      reviewedAt: string;
    };
  };
  actualExecution?: {
    actualProviderId?: string;
    actualModel?: string;
    actualProviderKind?: string;
    actualProviderApi?: string;
    totalCostUsd?: number;
    turns: Array<{
      providerId?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }>;
  };
  artifacts?: Array<{
    type: string;
    path?: string;
    skillId?: string;
    workflowId?: string;
  }>;
  testResults?: Array<{
    strategy: "syntax" | "execute" | "manifest" | "compile" | "llm_eval";
    passed: boolean;
    errors: Array<{
      message: string;
      file?: string;
      line?: number;
      severity: "error" | "warning";
    }>;
    durationMs: number;
  }>;
  artifactDir?: string;
  contextCostSummary?: AgentContextCostSummary;
  taskProfile?: ResolvedAgentTaskProfile;
  metadata?: AgentRunMetadata;
  health?: AgentRunHealthSnapshot;
  contextSummary?: AgentRunContextSummarySnapshot;
  rollbackAvailable?: boolean;
  unifiedTaskState?: AgentUnifiedTaskStateSnapshot;
}

export interface AgentAutomation {
  id: string;
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  schedule?: {
    type: "cron";
    cron: string;
    timezone?: string;
  };
  enabled: boolean;
  estimatedTimeSavedMinutes: number;
  reuseCount: number;
  promotionState: "private" | "team" | "public_boost_eligible" | "public";
  lastOutcomeScore: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Full automation record (matches backend FridayAgentAutomationRecord) ───

export interface AgentAutomationRecord {
  id: string;
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  schedule?: {
    type: "cron";
    cron: string;
    timezone?: string;
  };
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  runCount: number;
  estimatedTimeSavedMinutes: number;
  reuseCount: number;
  promotionState: "private" | "team" | "public_boost_eligible" | "public";
  lastOutcomeScore: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent runtime result (automation run response) ───

export interface AgentRuntimeResult {
  runId: string;
  status: AgentRunStatus;
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  eventStreamAvailable?: boolean;
  images?: string[];
  finalResponse?: string;
  contextCostSummary?: AgentContextCostSummary;
  taskProfile?: ResolvedAgentTaskProfile;
}

// ─── Skill UI schema types ───

export type SkillUiFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "json"
  | "file";

export type SkillUiOutputWidget =
  | "text"
  | "json"
  | "table"
  | "keyValue";

export interface SkillUiSection {
  id: string;
  label: string;
  fieldIds: string[];
}

export interface SkillUiField {
  id: string;
  inputKey: string;
  kind: SkillUiFieldKind;
  label: string;
  required: boolean;
  help?: string;
  placeholder?: string;
  defaultValue?: unknown;
  validation?: {
    regex?: string;
    min?: number;
    max?: number;
    enum?: string[];
  };
}

export interface SkillUiOutput {
  id: string;
  outputKey: string;
  label: string;
  widget: SkillUiOutputWidget;
}

export interface SkillUiAction {
  id: "run" | "reset";
  label: string;
  style: "primary" | "secondary";
}

export interface SkillUiSchemaV1 {
  schemaVersion: "1.0";
  title: string;
  description?: string;
  sections: SkillUiSection[];
  fields: SkillUiField[];
  outputs: SkillUiOutput[];
  actions: SkillUiAction[];
}

// ─── Skill generator types ───

export type SkillGeneratorSessionStatus =
  | "collecting_requirements"
  | "needs_clarification"
  | "generating"
  | "ready_for_review"
  | "approved"
  | "saved"
  | "failed"
  | "cancelled";

export interface SkillGenerationSession {
  sessionId: string;
  userId: string;
  channel: string;
  status: SkillGeneratorSessionStatus;
  goal: string;
  specSummary: string;
  openQuestions: string[];
  decisions: string[];
  draftSkillId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillGenerationTurn {
  turnId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export type SkillGenerationTurnMode =
  | "clarification_required"
  | "preview_ready"
  | "generation_failed";

export interface GeneratedSkillValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface GeneratedSkillValidationReport {
  ok: boolean;
  issues: GeneratedSkillValidationIssue[];
  repaired: boolean;
  repairAttempts: number;
}

export interface GeneratedSkillFile {
  path: string;
  language: "json" | "javascript" | "typescript" | "bash" | "markdown";
  executable?: boolean;
  content: string;
}

export interface GeneratedSkillDraft {
  manifest: SkillManifestSummary;
  files: GeneratedSkillFile[];
  uiSchema: SkillUiSchemaV1;
  runtimeKind: "shell" | "node";
  validation: GeneratedSkillValidationReport;
}

/** Minimal manifest info needed on the UI side */
export interface SkillManifestSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: { kind: string };
  tags: string[];
}

export interface StartSessionResponse {
  session: SkillGenerationSession;
  mode: SkillGenerationTurnMode;
  questions?: string[];
  draft?: GeneratedSkillDraft;
  errors?: GeneratedSkillValidationIssue[];
}

export interface GetSessionResponse {
  session: SkillGenerationSession;
  turns: SkillGenerationTurn[];
  draft?: GeneratedSkillDraft;
}

export interface SubmitTurnResponse {
  session: SkillGenerationSession;
  mode: SkillGenerationTurnMode;
  questions?: string[];
  draft?: GeneratedSkillDraft;
  errors?: GeneratedSkillValidationIssue[];
}

export interface GenerateResponse {
  draft: GeneratedSkillDraft;
}

export interface ApproveResponse {
  sessionId: string;
  skillId: string;
  skillDir: string;
  candidateId: string;
  candidateDir: string;
  savedFiles: string[];
  registryRefreshed: boolean;
  promotionStage: "candidate_staged";
  candidateManifestTags: string[];
  /** @deprecated Candidate staging no longer promotes a manifest; use candidateManifestTags. */
  promotedManifestTags: string[];
  evidence: SkillGenerationEvidence;
}

export type FridayTemplateHarnessStage =
  | "planning_spec"
  | "delivery_contract"
  | "draft_generation"
  | "qa_verdict"
  | "handoff_ready"
  | "completed";

export type FridayHarnessQaVerdict = "pass" | "fail" | "blocked";

export interface FridayTemplateHarnessSummary {
  stage: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
  verdict?: FridayHarnessQaVerdict;
  summary?: string;
}

export interface FridayHarnessQaVerdictRecord {
  artifactId: string;
  version: 1;
  scopeKind: "skill_generator" | "workflow_generator" | "uix_template" | "uix_wizard";
  scopeId: string;
  deliveryContractId: string;
  verdict: FridayHarnessQaVerdict;
  summary: string;
  passedCriteria: string[];
  failedCriteria: string[];
  blockedReasons: string[];
  warnings: string[];
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillGeneratorTestSummary {
  ok: boolean;
  executable: boolean;
  issues: GeneratedSkillValidationIssue[];
  durationMs: number;
  testedAt: string;
  behavioralCheck?: {
    attempted: boolean;
    satisfied: boolean;
    expectedMarkers: string[];
    matchedMarkers: string[];
    runStatus?: "completed" | "failed" | "cancelled" | "timeout";
    reason?: string;
  };
}

export interface SkillGenerationEvidence {
  sessionId: string;
  validationSummary: {
    ok: boolean;
    repaired: boolean;
    repairAttempts: number;
    issueCount: number;
  };
  repairSummary: {
    attempted: boolean;
    attempts: number;
  };
  executableTestSummary: SkillGeneratorTestSummary | null;
  approvalReadiness: {
    ready: boolean;
    reason: string;
  };
  qaVerdict?: FridayHarnessQaVerdictRecord | null;
  harness?: FridayTemplateHarnessSummary | null;
  stagedCandidateIdentity?: {
    skillId: string;
    candidateId?: string;
    candidateDir?: string;
    filesDir?: string;
  };
}

export interface WorkflowGenerationEvidence {
  sessionId: string;
  validationSummary: {
    ok: boolean;
    repaired: boolean;
    repairAttempts: number;
    issueCount: number;
  };
  approvalReadiness: {
    ready: boolean;
    reason: string;
  };
  qaVerdict?: FridayHarnessQaVerdictRecord | null;
  harness?: FridayTemplateHarnessSummary | null;
  publicationBoundary?: FridayWorkflowGeneratorPublicationBoundary;
}

export interface FridayWorkflowGeneratorPublicationBoundary {
  stage: "published_version";
  lifecyclePromotion: "not_lifecycle_promoted";
  proofBoundary: "crud_publish_only";
  summary: string;
}

// ─── Skills registry list types ───

export interface SkillListResponse {
  items: SkillLifecycleSummary[];
}

export interface SkillSourceRecord {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  trustPolicy: "strict" | "warn" | "permissive";
  pinnedKeyIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillLifecycleSummary {
  skillId: string;
  name: string;
  description?: string;
  source: string;
  origin: string;
  status: string;
  starter: boolean;
  category?: string;
  tags: string[];
  publisher?: string;
  latestVersion?: string;
  installedVersion?: string;
  updateAvailable: boolean;
  sourceId?: string;
  managed: boolean;
  registryLoaded: boolean;
  currentManifest?: Record<string, unknown>;
  originType: "generated" | "stabilized" | "cli-backed" | "mcp-backed";
  maturity: "draft" | "verified" | "stable";
}

export interface SkillCatalogItem {
  sourceId: string;
  skillId: string;
  skillName: string;
  publisher?: string;
  version: string;
  category?: string;
  releasedAt?: string;
  signatureValid: boolean;
  trustScore: number;
  starter: boolean;
  manifest: Record<string, unknown>;
  trustTier?: "bundled" | "managed" | "workspace" | "extra";
  implementationStatus?: "bundled" | "installed" | "catalog-only" | "generated-draft";
  blockedReasons?: string[];
  shadowedBy?: string[];
  recommendedNextAction?: string;
  firstUsePrompts?: string[];
  installed: boolean;
  installedVersion?: string;
  updateAvailable: boolean;
  sourceDetails?: SkillSourceRecord;
  originType?: "generated" | "stabilized" | "cli-backed" | "mcp-backed";
  maturity?: "draft" | "verified" | "stable";
}

export interface SkillVersionRecord {
  id: string;
  version: string;
  checksum: string;
  releasedAt: string;
  yankedAt?: string;
}

export interface SkillInstallationRecord {
  id: string;
  version: string;
  satelliteId?: string;
  status: string;
  permissionsGranted: string[];
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVerificationEvidence {
  skillId: string;
  verifiedAt: string;
  ok: boolean;
  preflight: {
    verdict: "ready" | "needs_review" | "blocked";
    counts: {
      blocking: number;
      warning: number;
      advisory: number;
    };
    checks: Array<{
      id:
        | "manifest"
        | "integrity"
        | "dependencies"
        | "requirements"
        | "permissions"
        | "runtime"
        | "trust";
      label: string;
      level: "pass" | "blocking" | "warning" | "advisory";
      summary: string;
      details: string[];
    }>;
  };
  manifestVerdict: {
    ok: boolean;
    issues: Array<{
      code: string;
      severity: "error" | "warning";
      message: string;
      path?: string;
    }>;
  };
  packageIntegrity: {
    available: boolean;
    ok: boolean;
    expectedChecksum?: string;
    actualChecksum?: string;
    archivePath?: string;
  };
  dependencyCheck: {
    ok: boolean;
    checkedBins: string[];
    missingBins: string[];
  };
  runtimeDryRun: {
    attempted: boolean;
    ok: boolean;
    executable: boolean;
    reason: string;
  };
  trustSummary: {
    verdict: "trusted" | "warning" | "blocked" | "local";
    policy?: string;
    score?: number;
    signatureValid?: boolean;
    reasons: string[];
  };
}

export interface SkillLifecycleDetail extends SkillLifecycleSummary {
  sourceDetails?: SkillSourceRecord;
  versions: SkillVersionRecord[];
  installations: SkillInstallationRecord[];
  catalogEntry?: SkillCatalogItem;
  verification?: SkillVerificationEvidence;
}

export interface SkillInstallResult {
  installationIds: string[];
  resolvedVersion: string;
  verification: {
    integrityValid: boolean;
    signatureValid: boolean;
    checks: string[];
  };
  trust: {
    total: number;
    signature: number;
    integrity: number;
    keyPinning: number;
    sourcePolicy: number;
    publisher: number;
    freshness: number;
    reasons: string[];
  };
}

export interface SkillInstallOutcome {
  skill: SkillLifecycleDetail;
  installation: SkillInstallResult;
}

export interface SkillUpdateOutcome extends SkillInstallOutcome {
  updated: boolean;
  previousVersion?: string;
}

export interface SkillDeleteOutcome {
  deleted: true;
  skillId: string;
}

export interface SkillManifestValidationOutcome {
  ok: boolean;
  issues: Array<{
    code: string;
    severity: "error" | "warning";
    message: string;
    path?: string;
  }>;
}

// ─── Skill converter types ───

export type SkillSourceFormat =
  | "friday-package"
  | "clawdbot-skill-md"
  | "adk-skill"
  | "n8n-node"
  | "openai-gpt-action"
  | "code-repo"
  | "undocumented-api"
  | "desktop-recording"
  | "unknown";

export interface SkillConversionSource {
  uri?: string;
  contentBase64?: string;
  formatHint?: SkillSourceFormat | "auto";
}

export interface ConverterInfo {
  id: string;
  displayName: string;
  sourceFormats: SkillSourceFormat[];
}

export interface SkillValidationIssue {
  stage: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ConvertedSkillDraft {
  manifest: SkillManifestSummary;
  uiSchema: SkillUiSchemaV1;
  files: Array<{ path: string; content: string; executable?: boolean }>;
  warnings: string[];
  conversionReport: {
    sourceFormat: SkillSourceFormat;
    sourceRef?: string;
    convertedAt: string;
    converterId: string;
  };
}

export interface ConvertResponse {
  converterId: string;
  detectedFormat: SkillSourceFormat;
  drafts: ConvertedSkillDraft[];
  validation: Array<{
    skillId: string;
    ok: boolean;
    issues: SkillValidationIssue[];
  }>;
}

export interface ExternalSkillCandidate {
  candidateId: string;
  shadowVersionId: string;
  skillId: string;
  version: string;
  converterId: string;
  detectedFormat: SkillSourceFormat;
  candidateDir: string;
  filesDir: string;
  stagedAt: string;
  validation: {
    ok: boolean;
    issues: SkillValidationIssue[];
    verifiedAt: string;
  };
}

export interface ImportResponse {
  converterId: string;
  detectedFormat: SkillSourceFormat;
  candidates: ExternalSkillCandidate[];
  validation: Array<{
    skillId: string;
    ok: boolean;
    issues: SkillValidationIssue[];
  }>;
  registryRefreshed: boolean;
}

export interface PackResponse {
  packageFile: string;
  checksumSha256: string;
}

// ─── SSE event types ───

export interface AgentRunStreamEvent {
  type: string;
  runId?: string;
  parentRunId?: string;
  timestamp?: string;
  seq?: number;
  emittedAt?: string;
  replayed?: boolean;
  phase?: AgentRunStatus;
  elapsedMs?: number;
  activeTool?: string;
  subagentCount?: number;
  latestSubagentId?: string;
  activeSubagentIds?: string[];
  eta?: number;
  etaConfidence?: "low" | "medium" | "high" | "unavailable";
  // text_delta
  delta?: string;
  // tool events
  toolName?: string;
  toolCallId?: string;
  params?: Record<string, unknown>;
  summary?: string;
  durationMs?: number;
  isError?: boolean;
  presentationMode?: "headless" | "host_chrome_visible";
  targetBrowser?: string;
  browserTarget?: string;
  sessionId?: string;
  tabId?: string;
  fallbackReason?: string;
  // subagent events
  subagentId?: string;
  childRunId?: string;
  subagentTask?: string;
  status?: AgentRunStatus;
  message?: string;
  questions?: string[];
  planMarkdown?: string;
  planSummary?: string;
  planKind?:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "major_decision";
  // status events
  output?: string;
  error?: string;
  // tool approval risk
  riskLevel?: "safe" | "guarded" | "destructive" | "blocked";
  // GAP status events
  reason?: string;
  level?: string;
  newMode?: string;
  fallbackCount?: number;
  // autonomous events
  goalId?: string;
  description?: string;
  stepId?: string;
  instruction?: string;
  index?: number;
  total?: number;
}

// ─── Sub-agent types ───

export interface SubagentRecord {
  id: string;
  parentRunId: string;
  task: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

// ─── Workflow types ───

export type WorkflowNodeType = "trigger" | "action" | "condition" | "data" | "ai" | "approval";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "compensating"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeAttemptStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "blocked_offline"
  | "cancelled";

export type FridayWorkflowStatus = "draft" | "published" | "archived";

export type FridayWorkflowActionType = "skill" | "ai_completion" | "http_request";

// ─── Workflow failure policy ───

export type WorkflowFailureStrategy =
  | "fail_fast"
  | "continue_on_error"
  | "fallback_step"
  | "compensate"
  | "pause_for_approval";

export interface WorkflowFailurePolicyV2 {
  onFailure: WorkflowFailureStrategy;
  fallbackStepId?: string;
  compensationWorkflowId?: string;
  notifyUser: boolean;
}

// ─── Spec types ───

export type FridayWorkflowSpecTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "event"; source: string; event: string };

export type FridayWorkflowSpecInputType = "string" | "number" | "boolean" | "object" | "array";

export interface FridayWorkflowSpecInput {
  key: string;
  type: FridayWorkflowSpecInputType;
  required: boolean;
  defaultValue?: unknown;
}

export type FridayWorkflowSpecStepType =
  | "skill_call"
  | "tool_call"
  | "condition"
  | "transform"
  | "human_approval";

export interface FridayWorkflowSpecStep {
  id: string;
  type: FridayWorkflowSpecStepType;
  ref?: string;
  args?: Record<string, unknown>;
  condition?: string;
  timeoutSec?: number;
  retry?: { maxAttempts: number; backoffMs: number };
}

export type FridayWorkflowSpecEdgeWhen = "success" | "failure" | "true" | "false";

export interface FridayWorkflowSpecEdge {
  from: string;
  to: string;
  when?: FridayWorkflowSpecEdgeWhen;
}

export interface FridayWorkflowSpecOutput {
  key: string;
  fromStep: string;
  path: string;
}

export interface FridayWorkflowSpecTestCase {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<string, { output: Record<string, unknown>; status?: "completed" | "failed" }>;
  assertions: Array<{
    path: string;
    operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
    expected: unknown;
  }>;
}

export interface FridayWorkflowSpecV1 {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger: FridayWorkflowSpecTrigger;
  inputs: FridayWorkflowSpecInput[];
  steps: FridayWorkflowSpecStep[];
  edges: FridayWorkflowSpecEdge[];
  outputs: FridayWorkflowSpecOutput[];
  errorPolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowSpecTestCase[];
}

// ─── Visual graph types ───

export interface FridayWorkflowCanvasViewportV1 {
  x: number;
  y: number;
  zoom: number;
}

export interface FridayWorkflowCanvasPanelLayoutV1 {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

export interface FridayWorkflowBuilderNodeLayoutV1 {
  nodeId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex?: number;
}

export interface FridayWorkflowBuilderEdgeLayoutV1 {
  edgeKey: string;
  sourceHandle?: string;
  targetHandle?: string;
  bendPoints?: Array<{ x: number; y: number }>;
}

export interface FridayWorkflowVisualGraphV1 {
  schemaVersion: "1.0";
  workflowId: string;
  viewport: FridayWorkflowCanvasViewportV1;
  selectedNodeId?: string;
  selectedEdgeKey?: string;
  panelLayout: FridayWorkflowCanvasPanelLayoutV1;
  nodes: FridayWorkflowBuilderNodeLayoutV1[];
  edges: FridayWorkflowBuilderEdgeLayoutV1[];
}

// ─── Compiled graph types ───

export interface FridayWorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, unknown>;
  retryPolicy?: {
    maxAttempts: number;
    backoff: "none" | "fixed" | "exponential";
    baseDelayMs: number;
    maxDelayMs: number;
    retryOn: string[];
  };
  timeoutMs?: number;
}

export interface FridayWorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  condition?: string;
  priority?: number;
}

export interface FridayCompiledWorkflowGraphV2 {
  schemaVersion: "2.0";
  workflowId: string;
  workflowVersionId: string;
  sourceSpecSchemaVersion: "1.0";
  graph: {
    nodes: FridayWorkflowNode[];
    edges: FridayWorkflowEdge[];
    variables?: Record<string, unknown>;
  };
  failurePolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowSpecTestCase[];
  checksum: string;
}

// ─── Workflow entity types ───

export interface FridayWorkflowEntity {
  id: string;
  slug: string;
  name: string;
  description?: string;
  tags: string[];
  ownerUserId?: string;
  latestVersionNumber: number;
  publishedVersionNumber?: number;
  isArchived: boolean;
  revision: number;
  etag: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  deletedBy?: string;
}

export interface FridayWorkflowVersionEntity {
  id: string;
  workflowId: string;
  versionNumber: number;
  checksum: string;
  graphJson: unknown;
  createdByUserId?: string;
  isPublished: boolean;
  changeNote?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Workflow run entity types ───

export interface FridayWorkflowRunEntity {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  status: WorkflowRunStatus;
  triggerType: string;
  triggerPayload?: Record<string, unknown>;
  startedByUserId?: string;
  startedBySatelliteId?: string;
  startedAt: string;
  finishedAt?: string;
  correlationId?: string;
  context?: Record<string, unknown>;
  failure?: {
    code: string;
    message: string;
    details?: unknown;
  };
  createdAt: string;
  updatedAt: string;
}

export interface FridayWorkflowRunNodeEntity {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  attemptId: string;
  status: NodeAttemptStatus;
  satelliteId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayRunTimelineEntry {
  seq: number;
  streamId: string;
  event: string;
  emittedAt: string;
  nodeId?: string;
  attempt?: number;
  status?: WorkflowRunStatus | NodeAttemptStatus;
  payload: Record<string, unknown>;
}

// ─── Draft types ───

export type FridayWorkflowDraftStatus = "active" | "archived" | "published" | "conflicted";

export interface FridayWorkflowDraftAutosaveState {
  enabled: boolean;
  intervalMs: number;
  lastSavedAt?: string;
}

export interface FridayWorkflowDraftSourceReview {
  source: "deeplink.workflow_template" | "bundle_import";
  sourceUrl?: string;
  importedAt: string;
  requiresReviewBeforePublish: boolean;
}

export interface FridayWorkflowDraftEntity {
  draftId: string;
  workflowId: string;
  ownerUserId?: string;
  title: string;
  status: FridayWorkflowDraftStatus;
  revision: number;
  baseWorkflowVersionId?: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  createdAt: string;
  updatedAt: string;
  publishedVersionId?: string;
  autosave: FridayWorkflowDraftAutosaveState;
  sourceReview?: FridayWorkflowDraftSourceReview;
}

export interface FridayWorkflowTemplateEntity {
  templateId: string;
  kind: "builtin" | "skill" | "user";
  scope: "global" | "user";
  ownerUserId?: string;
  name: string;
  description?: string;
  tags: string[];
  sourceSkillId?: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  createdAt: string;
  updatedAt: string;
}

export interface FridayStableWorkflowTemplate {
  id: string;
  label: string;
  description: string;
  preferredBinding: "stable-skill" | "built-in-tool";
  defaultTaskProfile: AgentTaskProfileId;
  tags: string[];
}

// ─── Validation types ───

export type FridayWorkflowValidationSeverity = "error" | "warning" | "info";

export type FridayWorkflowValidationStage =
  | "spec_schema"
  | "graph_compile"
  | "compiled_graph"
  | "skill_refs"
  | "expressions"
  | "tests"
  | "canvas";

export interface FridayWorkflowBuilderValidationIssue {
  code: string;
  stage: FridayWorkflowValidationStage;
  severity: FridayWorkflowValidationSeverity;
  message: string;
  jsonPath?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: FridayWorkflowSpecEdgeWhen };
}

export interface FridayWorkflowBuilderValidationReport {
  valid: boolean;
  issues: FridayWorkflowBuilderValidationIssue[];
  compiledGraphPreview?: FridayCompiledWorkflowGraphV2;
  generatedAt: string;
}

// ─── Lock types ───

export interface FridayWorkflowEditLock {
  workflowId: string;
  lockToken: string;
  ownerUserId: string;
  ownerSessionId?: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface FridayAcquireWorkflowLockResponse {
  acquired: boolean;
  lock?: FridayWorkflowEditLock;
  conflict?: FridayWorkflowEditLock;
}

// ─── Editor graph types ───

export type FridayWorkflowNodeConfig =
  | { triggerType: "manual" }
  | { triggerType: "cron"; cron: string; timezone: string }
  | { triggerType: "webhook"; method: "POST"; secretRef?: string; dedupeKeyPath?: string }
  | { triggerType: "event"; source: string; event: string; filterExpr?: string; pluginId?: string }
  | { actionType: "skill"; skillId: string; inputMapping?: Record<string, unknown> }
  | { actionType: "tool"; toolId: string; args?: Record<string, unknown> }
  | { actionType: "ai_completion"; prompt: string; model?: string; temperature?: number }
  | { actionType: "http_request"; method: string; url: string; headers?: Record<string, string>; body?: unknown }
  | { conditionType: "if" | "switch"; expression: string; cases?: Array<{ label: string; expression: string }> }
  | {
      transformType: "map" | "template" | "merge";
      mapping?: Record<string, unknown>;
      expression?: string;
      outputKey?: string;
    }
  | {
      approverUserId?: string;
      approverRole?: "owner" | "admin" | "operator";
      timeoutMs?: number;
      onReject?: "fail" | "reject_branch";
    };

export interface FridayWorkflowNodeDefinition extends Record<string, unknown> {
  id: string;
  type: WorkflowNodeType;
  name: string;
  config: FridayWorkflowNodeConfig;
  timeoutMs?: number;
  stepType?: FridayWorkflowSpecStepType;
  stepRef?: string;
  rawArgs?: Record<string, unknown>;
  stepCondition?: string;
  retry?: { maxAttempts: number; backoffMs: number };
}

export interface FridayWorkflowEditorGraphV1 {
  schemaVersion: "1.0";
  reactFlowVersion: "11";
  nodes: FridayWorkflowEditorNode[];
  edges: FridayWorkflowEditorEdge[];
  viewport?: FridayWorkflowEditorViewport;
  selectedNodeId?: string;
  selectedEdgeId?: string;
}

export interface FridayWorkflowEditorNode {
  id: string;
  type: "workflow_node";
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: FridayWorkflowNodeDefinition;
}

export interface FridayWorkflowEditorEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: {
    condition?: string;
    branch?: string;
    edgeKey?: string;
    bendPoints?: Array<{ x: number; y: number }>;
  };
}

export interface FridayWorkflowEditorViewport {
  x: number;
  y: number;
  zoom: number;
}

// ─── Generator types ───

export type FridayWorkflowGeneratorSessionStatus =
  | "collecting_requirements"
  | "needs_clarification"
  | "generating"
  | "ready_for_review"
  | "approved"
  | "saved"
  | "retryable_provider_failure"
  | "draft_ready_needs_repair"
  | "terminal_failed"
  | "cancelled";

export interface FridayWorkflowGenerationSession {
  sessionId: string;
  userId: string;
  channel: string;
  status: FridayWorkflowGeneratorSessionStatus;
  goal: string;
  requirementsSummary: string;
  openQuestions: string[];
  decisions: string[];
  draftWorkflowId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayWorkflowGenerationTurn {
  turnId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export type FridayWorkflowGenerationTurnMode =
  | "clarification_required"
  | "preview_ready"
  | "draft_needs_repair"
  | "retryable_provider_failure"
  | "generation_failed";

export interface FridayGeneratedWorkflowValidationIssue {
  code: string;
  stage: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: FridayWorkflowSpecEdgeWhen };
}

export interface FridayGeneratedWorkflowValidationReport {
  ok: boolean;
  issues: FridayGeneratedWorkflowValidationIssue[];
  repaired: boolean;
  repairAttempts: number;
}

export interface FridayGeneratedWorkflowDraft {
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  tests: FridayWorkflowSpecTestCase[];
  compiledGraph: FridayCompiledWorkflowGraphV2;
  validation: FridayGeneratedWorkflowValidationReport;
}

export interface FridayWorkflowGeneratorStartSessionResponse {
  session: FridayWorkflowGenerationSession;
  mode: FridayWorkflowGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedWorkflowDraft;
  errors?: FridayGeneratedWorkflowValidationIssue[];
}

export interface FridayWorkflowGeneratorGetSessionResponse {
  session: FridayWorkflowGenerationSession;
  turns: FridayWorkflowGenerationTurn[];
  draft?: FridayGeneratedWorkflowDraft;
}

export interface FridayWorkflowGeneratorSubmitMessageResponse {
  session: FridayWorkflowGenerationSession;
  mode: FridayWorkflowGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedWorkflowDraft;
  errors?: FridayGeneratedWorkflowValidationIssue[];
}

export interface FridayWorkflowGeneratorGenerateResponse {
  draft: FridayGeneratedWorkflowDraft;
}

export interface FridayWorkflowGeneratorEvidenceResponse {
  evidence: WorkflowGenerationEvidence;
}

export interface FridayWorkflowGeneratorApproveResponse {
  sessionId: string;
  workflowId: string;
  workflowVersionId: string;
  versionNumber: number;
  slug: string;
  published: boolean;
  publicationBoundary: FridayWorkflowGeneratorPublicationBoundary;
  evidence?: WorkflowGenerationEvidence;
}

export interface AssistantDiagnosticsRunSummary {
  runId: string;
  task: string;
  status: AgentRunStatus;
  startedAt?: string;
  completedAt?: string;
  contextCostSummary?: AgentContextCostSummary;
  taskProfile?: ResolvedAgentTaskProfile;
  health?: AgentRunHealthSnapshot;
  contextSummary?: AgentRunContextSummarySnapshot;
  rollbackAvailable?: boolean;
}

export interface McpServerState {
  serverId: string;
  transport: "stdio" | "http";
  state: "configured" | "discoverable" | "loaded" | "deferred";
  lazyDiscovery: boolean;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  lastLoadedAt?: string;
}

export interface ChannelRegistryView {
  kind: string;
  running: boolean;
  status: "disconnected" | "connecting" | "connected" | "error";
  health: {
    state: "disconnected" | "connecting" | "connected" | "error";
    restartCount: number;
    lastError?: string;
    blockedReason?: string;
    credentialStatus: "unknown" | "configured" | "missing" | "invalid";
  };
  diagnostics?: Record<string, unknown>;
  contract?: {
    curatedSkillIds?: string[];
    supports?: {
      directMessages: boolean;
      groupMessages: boolean;
      threads: boolean;
      typing: boolean;
    };
    toolRestrictions?: {
      allowlist?: string[];
      blocklist?: string[];
    };
  };
  allowlist: {
    hasAllowedUsers: boolean;
    allowedUsersCount: number;
    hasAllowedChats: boolean;
    allowedChatsCount: number;
  };
}

export interface AssistantDiagnostics {
  generatedAt: string;
  taskProfilePresets: ResolvedAgentTaskProfile[];
  recentRuns: AssistantDiagnosticsRunSummary[];
  mcpServerStates: McpServerState[];
  supportedPreprocessors: Array<
    "test_output" | "log_excerpt" | "browser_snapshot" | "diff_excerpt"
  >;
}

// ─── Errors ───

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: string;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    retryable = false,
    retryAfterMs?: number,
    details?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

export class AuthExpiredError extends ApiError {
  constructor() {
    super("AUTH_EXPIRED", "Session expired. Please log in again.", 401);
    this.name = "AuthExpiredError";
  }
}

// ─── Session types ───

export type FridaySessionStatus = "active" | "idle" | "archived" | "pruned";
export type FridaySessionRole = "system" | "user" | "assistant" | "tool";
export type FridaySessionChatKind = "dm" | "group" | "channel" | "thread";

export interface FridaySessionRecord {
  id: string;
  key: string;
  channel: string;
  accountId: string;
  chatId: string;
  userId?: string;
  chatKind: FridaySessionChatKind;
  status: FridaySessionStatus;
  memoryNamespace?: string;
  parentSessionKey?: string;
  rootSessionKey?: string;
  forkedFromMessageId?: string;
  metadata: Record<string, unknown>;
  contextInputTokens: number;
  contextOutputTokens: number;
  contextTotalTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  statusChangedAt?: string;
  idleAt?: string;
  archivedAt?: string;
  prunedAt?: string;
}

export interface FridaySessionMessageRecord {
  id: string;
  sessionId: string;
  sessionKey: string;
  sequence: number;
  role: FridaySessionRole;
  content: unknown;
  contentText: string;
  toolCalls?: unknown[];
  tokenCount: number;
  idempotencyKey?: string;
  parentMessageId?: string;
  metadata: Record<string, unknown>;
  memoryExtractStatus: "pending" | "extracted" | "skipped" | "failed";
  memoryExtractedAt?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  inherited?: boolean;
  inheritedFromSessionKey?: string;
  inheritedFromMessageId?: string;
}

export interface FridaySessionPruneResult {
  archivedToPrunedCount: number;
  hardDeletedCount: number;
  sessionKeys: string[];
}

export interface FridaySessionSweepResult {
  idledCount: number;
  archivedCount: number;
  prunedCount: number;
  hardDeletedCount: number;
}

export interface FridaySessionForkCreateResult {
  forkSession: FridaySessionRecord;
  inheritedMessageCount: number;
  forkedFromMessageId?: string;
}

export interface FridaySessionForkMergeResult {
  parentMessage: FridaySessionMessageRecord;
  forkSession: FridaySessionRecord;
}

export interface FridaySessionMemoryExtractionRunResult {
  jobId?: string;
  sessionKey: string;
  trigger: "auto" | "manual" | "retry";
  mode: "queued" | "inline";
  queued: boolean;
  processedMessageCount: number;
  extractedMessageCount: number;
  skippedMessageCount: number;
  failedMessageCount: number;
  memoryItemsCreated: number;
}

export interface FridaySessionMemoryExtractionStatus {
  sessionKey: string;
  pendingMessages: number;
  extractedMessages: number;
  skippedMessages: number;
  failedMessages: number;
  queuedJobs: number;
  runningJobs: number;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface FridaySessionMemoryRetryResult {
  sessionsQueued: string[];
  resetMessageCount: number;
}

// ─── Memory types ───

export type FridayMemoryType =
  | "fact"
  | "preference"
  | "procedure"
  | "episode"
  | "correction";

export interface FridayMemoryItem {
  id: string;
  namespace: string;
  key: string;
  content: string;
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
  ttlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  memoryType?: FridayMemoryType;
  confidence?: number;
  accessCount?: number;
  lastAccessedAt?: string;
}

export interface FridayMemorySearchResult {
  item: FridayMemoryItem;
  score: number;
  ftsScore: number;
  semanticScore: number;
  matchedBy: Array<"fts" | "semantic" | "substring">;
  snippet: string;
}

export interface FridayMemoryPruneResult {
  deletedCount: number;
  deletedIds: string[];
  dryRun: boolean;
}

// ─── Provider types ───

export type FridayProviderKind =
  | "openai"
  | "openai-codex"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "google-antigravity"
  | "google-gemini-cli"
  | "openrouter"
  | "xai"
  | "mistral"
  | "groq"
  | "cerebras"
  | "github-copilot"
  | "huggingface"
  | "opencode"
  | "vercel-ai-gateway"
  | "kilocode"
  | "moonshot"
  | "kimi-coding"
  | "qwen"
  | "qwen-portal"
  | "volcengine"
  | "byteplus"
  | "synthetic"
  | "minimax"
  | "ollama"
  | "vllm"
  | "litellm"
  | "together"
  | "nvidia"
  | "qianfan"
  | "venice"
  | "xiaomi"
  | "zai"
  | "glm"
  | "deepseek"
  | "bedrock"
  | "cloudflare-ai-gateway"
  | "openai-compatible";

export type FridayProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "ollama";

export type FridayProviderBackendKind = "http" | "cli" | "sdk";

export type FridayProviderAuthMode = "api-key" | "bearer-token" | "oauth" | "token" | "external-session" | "none";

export type FridayProviderTemplateTier = "official" | "verified" | "community" | "experimental";
export type FridayProviderTemplateStatus = "ready" | "requires_configuration" | "experimental";

export interface FridayProviderCliConfig {
  backendId: "codex-cli" | "claude-cli" | "gemini-cli";
  binaryPath?: string;
  fixedArgProfile?: string;
  envAllowlist?: string[];
  cwdPolicy?: "workspace" | "process";
}

export interface FridayProviderValidationState {
  status: "never" | "ok" | "failed";
  checkedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
}

export type FridayRuntimeCapabilityId =
  | "text"
  | "vision"
  | "ocr"
  | "embedding"
  | "web_search"
  | "web_fetch"
  | "pdf_parse"
  | "file_read"
  | "file_write"
  | "tts"
  | "browser"
  | "mcp"
  | "skills"
  | "custom";

export interface FridayProviderRuntimeCapabilityDeclaration {
  capability: FridayRuntimeCapabilityId;
  model?: string;
  status?: "declared" | "verified" | "failed";
  verified?: boolean;
  verifiedAt?: string;
  notes?: string;
}

export interface FridayProviderConfigJson {
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  backendKind?: FridayProviderBackendKind;
  deploymentKind?: "hosted" | "local" | "self-hosted" | "consumer-cli";
  regionTag?: "global" | "us" | "china" | "local" | "custom";
  oauthProvider?: string;
  keySource: { kind: string; refKey?: string; envVar?: string; path?: string; command?: string };
  supportedModels: string[];
  headers?: Record<string, string>;
  cliConfig?: FridayProviderCliConfig;
  runtimeCapabilities?: FridayProviderRuntimeCapabilityDeclaration[];
  validation?: FridayProviderValidationState;
}

export interface FridayProviderProfile {
  id: string;
  kind: FridayProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  defaultModel?: string;
  config: FridayProviderConfigJson;
  createdAt: string;
  updatedAt: string;
}

export interface FridayProviderTemplateSecretRequirement {
  key: string;
  label: string;
  required: boolean;
  acceptedRefs: Array<"inline" | "env-ref" | "secret-ref" | "file-ref" | "command-ref">;
  helpText?: string;
}

export interface FridayProviderTemplate {
  id: string;
  providerKind: FridayProviderKind;
  displayName: string;
  description: string;
  tier: FridayProviderTemplateTier;
  status: FridayProviderTemplateStatus;
  api: FridayProviderApi;
  backendKind: FridayProviderBackendKind;
  deploymentKind: "hosted" | "local" | "self-hosted" | "consumer-cli";
  regionTag: "global" | "us" | "china" | "local" | "custom";
  authModes: FridayProviderAuthMode[];
  baseUrlHints: string[];
  modelDefaults: {
    recommended?: string;
    fallback?: string;
    examples: string[];
  };
  reasoningHints: string[];
  requiredSecrets: FridayProviderTemplateSecretRequirement[];
}

export interface FridayProviderHealthSnapshotItem {
  providerId: string;
  providerKind: FridayProviderKind;
  lane: "primary" | "fallback" | "standby" | "disabled";
  enabled: boolean;
  defaultModel?: string;
  backendKind: FridayProviderBackendKind;
  authMode: FridayProviderAuthMode;
  backendHealth: "healthy" | "degraded" | "missing" | "unsupported" | "status_unknown";
  authHealth: "healthy" | "degraded" | "missing" | "unsupported" | "status_unknown";
  routingEligible: boolean;
  validationStatus: "never" | "ok" | "failed";
  circuitState: "closed" | "cooldown" | "unknown";
  cooldownRemainingMs?: number;
  lastFailureAt?: string;
  reasons: string[];
  suggestedAction: string;
}

export type FridayProviderCapabilityHealthState =
  | "available"
  | "setup_needed"
  | "proof_pending"
  | "disabled"
  | "unsupported";

export interface FridayProviderCapabilityHealthCapabilityItem {
  capability: FridayRuntimeCapabilityId;
  model?: string;
  state: FridayProviderCapabilityHealthState;
  source: "runtime_capability_snapshot" | "provider_health_snapshot" | "declared_configuration";
  message: string;
  blockerCodes: string[];
  checkedAt?: string;
  lastVerifiedAt?: string;
}

export interface FridayProviderCapabilityHealthSnapshotItem {
  providerId: string;
  providerKind: FridayProviderKind;
  providerName: string;
  lane: "primary" | "fallback" | "standby" | "disabled";
  enabled: boolean;
  validationStatus: "never" | "ok" | "failed";
  capabilities: FridayProviderCapabilityHealthCapabilityItem[];
}

export interface FridayModelRoutingConfig {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
  costMode?: "frugal" | "standard" | "strict";
  enforceRequestedModel?: boolean;
}

export interface FridayOAuthLoginInitiation {
  providerId: string;
  oauthProvider: string;
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  scopes: string[];
}

export interface FridayOAuthDeviceAuthorizationRequest {
  providerId: string;
  oauthProvider: string;
  deviceCodeId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  intervalMs: number;
  scopes: string[];
}

export interface FridayOAuthLoginResult {
  providerId: string;
  oauthProvider: string;
  connected: true;
  expiresAt: string;
  tokenType: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

export interface FridayCliSessionStatus {
  backendId: "codex-cli" | "claude-cli" | "gemini-cli";
  binaryPath?: string;
  status: "healthy" | "degraded" | "missing" | "unsupported" | "status_unknown";
  version?: string;
  loggedIn?: boolean;
  checkedAt: string;
  message?: string;
  account?: {
    email?: string;
    orgId?: string;
    orgName?: string;
    subscriptionType?: string;
    authMethod?: string;
  };
}

export interface FridayProviderDoctorReport {
  providerId: string;
  providerKind: FridayProviderKind;
  backendKind: FridayProviderBackendKind;
  authMode: FridayProviderAuthMode;
  checkedAt: string;
  backendHealth: "healthy" | "degraded" | "missing" | "unsupported" | "status_unknown";
  authHealth: "healthy" | "degraded" | "missing" | "unsupported" | "status_unknown";
  routingEligible: boolean;
  reasons: string[];
  activeProfileKey?: string;
  cliSession?: FridayCliSessionStatus;
}

export interface FridayProviderRoutingSelection {
  providerId: string;
  providerKind: FridayProviderKind;
  model: string;
  backendKind: FridayProviderBackendKind;
}

export interface FridayProviderRoutingExplainCandidate {
  providerId: string;
  providerKind: FridayProviderKind;
  model: string;
  backendKind: FridayProviderBackendKind;
  originalRank: number;
  finalRank: number;
  selected: boolean;
  eligible: boolean;
  ineligibilityReasons: string[];
  pinned: boolean;
  routePenalty?: number;
  historicalSuccessRate?: number;
  historicalFailureRate?: number;
  sampleCount?: number;
  baseRankScore: number;
  historyScore: number;
  patternScore: number;
  lessonScore: number;
  routePenaltyScore: number;
  pinBonus: number;
  finalScore: number;
  historyStats?: {
    sampleCount: number;
    successRate: number;
    failureRate: number;
  };
  matchedLessonIds: string[];
  matchedPatternIds: string[];
}

export interface FridayProviderRoutingExplainReport {
  requestedProviderId?: string;
  requestedModel?: string;
  taskProfileId?: string;
  costMode: "frugal" | "standard" | "strict";
  requiresNativeTools: boolean;
  selectedBeforeLearning?: FridayProviderRoutingSelection;
  selectedAfterLearning?: FridayProviderRoutingSelection;
  selected?: FridayProviderRoutingExplainCandidate;
  candidates: FridayProviderRoutingExplainCandidate[];
  candidateScores: FridayProviderRoutingExplainCandidate[];
  learningAdjusted: boolean;
  learningSignalsPresent: boolean;
  orderingAdjusted: boolean;
  selectedAdjusted: boolean;
  reasonCode: string;
  reason: string;
  reasonText: string;
  historyWindow: {
    sampleLimit: number;
  };
}

export type FridayRuntimeCapabilityState =
  | "available"
  | "configured_but_unverified"
  | "needs_user_auth"
  | "installable_with_approval"
  | "buildable_with_approval"
  | "unsupported"
  | "failed_verification";

export interface FridayRuntimeCapabilitySource {
  kind: "provider" | "tool" | "skill" | "mcp" | "builtin" | "custom";
  id: string;
  label: string;
  status: "verified" | "declared" | "inferred" | "unverified" | "failed";
  providerId?: string;
  providerKind?: FridayProviderKind;
  model?: string;
  verifiedAt?: string;
  detail?: string;
}

export interface FridayRuntimeCapabilityRepairOption {
  id: string;
  label: string;
  description: string;
  kind: "configure_provider" | "open_docs" | "enable_builtin" | "install_skill" | "install_mcp" | "generate_tool" | "custom";
  requiresApproval: boolean;
  providerKind?: FridayProviderKind;
  setupHref?: string;
  href?: string;
  risks: string[];
}

export interface FridayRuntimeCapabilityItem {
  capability: FridayRuntimeCapabilityId;
  label: string;
  description: string;
  state: FridayRuntimeCapabilityState;
  sources: FridayRuntimeCapabilitySource[];
  blockers: string[];
  repairOptions: FridayRuntimeCapabilityRepairOption[];
  lastVerifiedAt?: string;
}

export interface FridayRuntimeCapabilityMatrix {
  schemaVersion: "1.0";
  generatedAt: string;
  items: FridayRuntimeCapabilityItem[];
  summary: {
    available: number;
    needsVerification: number;
    needsUserAction: number;
    installable: number;
    unsupported: number;
  };
}

export interface FridayLearningLessonRecord {
  lesson: {
    id: string;
    title: string;
    cause: string;
    fix: string;
    confidence: number;
    createdAt: string;
    updatedAt: string;
  };
  disabled: boolean;
  disabledReason?: string;
}

export interface FridayLearningPatternRecord {
  patternId: string;
  userId: string;
  kind: string;
  description: string;
  pattern: Record<string, unknown>;
  confidence: number;
  sampleCount: number;
  lastUpdated: string;
  createdAt: string;
  demoted: boolean;
  demotionFactor?: number;
  demotionReason?: string;
}

export interface FridayLearningRouteAdjustmentRecord {
  kind: "pin" | "penalty";
  key: string;
  taskProfileId?: string;
  providerId?: string;
  model?: string;
  backendKind?: FridayProviderBackendKind;
  confidence: number;
  value: Record<string, unknown>;
}

export interface FridayRouteDecisionDiffRecord {
  runId: string;
  createdAt: string;
  taskProfileId?: string;
  requestedProviderId?: string;
  requestedModel?: string;
  actualProviderId?: string;
  actualModel?: string;
  reasonCode?: string;
  reasonText?: string;
  learningAdjusted: boolean;
  learningSignalsPresent: boolean;
  selectedBeforeLearning?: FridayProviderRoutingSelection;
  selectedAfterLearning?: FridayProviderRoutingSelection;
  matchedLessonIds: string[];
  matchedPatternIds: string[];
  trace: {
    candidateScores: FridayProviderRoutingExplainCandidate[];
  };
}

export interface FridayBlockedRouteRecord {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
  reasons: string[];
  count: number;
  lastSeenAt: string;
}

export interface FridayRejectedFixRecord {
  actionId: string;
  incidentId: string;
  title: string;
  fingerprint: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayRollbackHotspotRecord {
  fingerprint: string;
  rolledBackCount: number;
  appliedCount: number;
  rejectedCount: number;
  totalCount: number;
  lastSeenAt: string;
}

export interface FridayLearningOverview {
  lessons: FridayLearningLessonRecord[];
  patterns: FridayLearningPatternRecord[];
  routeAdjustments: FridayLearningRouteAdjustmentRecord[];
  routeBiases: FridayLearningRouteAdjustmentRecord[];
  operatorPins: FridayLearningRouteAdjustmentRecord[];
  penaltyFacts: FridayLearningRouteAdjustmentRecord[];
  recentDecisionDiffs: FridayRouteDecisionDiffRecord[];
  blockedRoutes: FridayBlockedRouteRecord[];
  rejectedFixes: FridayRejectedFixRecord[];
  recentRejectedFixes: FridayRejectedFixRecord[];
  rollbackHotspots: FridayRollbackHotspotRecord[];
  coverage: {
    lessons: number;
    patterns: number;
    routeAdjustments: number;
    recentDecisionDiffs: number;
    blockedRoutes: number;
    rejectedFixes: number;
    rollbackHotspots: number;
    incidents: number;
    diagnoses: number;
    autoFixActions: number;
    autoFixOutcomeBuckets: {
      recordedActions: number;
      verifiedRepairs: number;
      diagnosticOnly: number;
      failed: number;
      rolledBack: number;
      rejected: number;
      pending: number;
      rollbackAttempted: number;
      rollbackFailed: number;
    };
  };
}

export type FridayAutoFixRiskTier = 0 | 1 | 2;
export type FridayAutoFixActionStatus = "planned" | "applied" | "rolled_back" | "rejected";
export type FridayAutoFixOutcome = "success" | "failed" | null;
export type FridayAutoFixRunReadySkipReason =
  | "approval_required"
  | "outside_data_protection_policy"
  | "auto_apply_blocked"
  | "not_ready";

export interface FridayFixPlanSummary {
  actionId: string;
  incidentId: string;
  loopRunId?: string;
  title: string;
  summary: string;
  riskTier: FridayAutoFixRiskTier;
  status: FridayAutoFixActionStatus;
  outcome: FridayAutoFixOutcome;
  requiresApproval: boolean;
  autoApplyAllowed: boolean;
  rollbackPlanAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FridayFixPlanRecord {
  summary: FridayFixPlanSummary;
  action: {
    actionId: string;
    incidentId: string;
    userId: string;
    riskTier: FridayAutoFixRiskTier;
    status: FridayAutoFixActionStatus;
    outcome: FridayAutoFixOutcome;
    createdAt: string;
    updatedAt: string;
    appliedAt?: string;
    rolledBackAt?: string;
    plan?: unknown;
    rollbackPlan?: unknown;
  };
  approval: unknown | null;
  evidence: unknown;
}

export interface FridayAutoFixExecutionResponse {
  action: FridayFixPlanRecord;
  result: {
    success: boolean;
    verificationPassed: boolean;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean;
    errorMessage?: string;
  };
}

export interface FridayAutoFixRunReadyResponse {
  summary: {
    inspected: number;
    executed: number;
    succeeded: number;
    failed: number;
    requiresApproval: number;
    blockedByPolicy: number;
    notReady: number;
    dataProtected: true;
    maxRiskTier: 0 | 1;
    limit: number;
  };
  executed: FridayAutoFixExecutionResponse[];
  skipped: Array<{
    action: FridayFixPlanRecord;
    reason: FridayAutoFixRunReadySkipReason;
    reasonText: string;
  }>;
}

// ─── Provider usage types ───

export interface FridayProviderUsageSummaryRow {
  day?: string;
  providerId?: string;
  model?: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface FridayProviderUsageSummary {
  from: string;
  to: string;
  groupBy: "day" | "provider" | "model";
  rows: FridayProviderUsageSummaryRow[];
  totals: {
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

export type FridayBudgetState = "ok" | "near_limit" | "over_limit";

export interface FridayLlmBudgetConfig {
  monthlyLimitUsd: number;
}

export interface FridayLlmBudgetStatus {
  month: string;
  config: FridayLlmBudgetConfig | null;
  spentUsd: number;
  remainingUsd: number | null;
  state: FridayBudgetState;
}

// ─── Security types ───

export type FridayHealthState = "healthy" | "degraded" | "critical";
export type FridayTrustBand = "low" | "medium" | "high";

export interface FridaySecurityFinding {
  id: string;
  severity: "low" | "medium" | "high";
  type: "token_scope_risk" | "revocation_gap" | "offline_high_privilege" | "trust_mismatch";
  message: string;
  satelliteId?: string;
  tokenId?: string;
  detectedAt: string;
}

export interface FridaySecurityCenterResponse {
  generatedAt: string;
  tokens: {
    active: number;
    expired: number;
    revoked24h: number;
    highPrivilegeActive: number;
  };
  satellites: {
    restricted: number;
    trusted: number;
    revoked: number;
    pendingPairings: number;
  };
  findings: FridaySecurityFinding[];
}

export interface FridayRevokeTokenResponse {
  revoked: boolean;
  tokenId: string;
}

export interface FridayRevokeSatelliteResponse {
  revoked: true;
  satelliteId: string;
}

// ─── Fleet types ───

export interface FridayFleetOverviewResponse {
  generatedAt: string;
  totals: {
    satellites: number;
    pending: number;
    paired: number;
    online: number;
    degraded: number;
    offline: number;
    revoked: number;
  };
  queue: {
    queued: number;
    leased: number;
    failed: number;
    deadLetter: number;
  };
  workflows: {
    activeRuns: number;
    completed1h: number;
    failed1h: number;
  };
  health: {
    score: number;
    state: FridayHealthState;
    reasons: string[];
  };
  trust: {
    averageScore: number;
    lowTrustCount: number;
    restrictedCount: number;
    revokedCount: number;
  };
}

export interface FridayFleetSatelliteCard {
  satelliteId: string;
  type: string;
  displayName: string;
  pairingStatus: string;
  trustLevel: string;
  trustScore: number;
  trustBand: FridayTrustBand;
  healthScore: number;
  healthState: FridayHealthState;
  lastSeenAt?: string;
  heartbeatAgeMs?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  loadAvg1m?: number;
  queueDepth?: number;
  activeRuns?: number;
  tags: string[];
  alerts: string[];
}

export type FridayFleetRemediationRiskClass =
  | "safe_probe"
  | "bounded_repair"
  | "destructive_or_sensitive";

export type FridayFleetRemediationActionStatus =
  | "ready"
  | "blocked"
  | "completed"
  | "skipped";

export interface FridayFleetRemediationActionExecutionResult {
  satelliteId: string;
  actionId: string;
  status: Exclude<FridayFleetRemediationActionStatus, "ready">;
  summary: string;
  affectedCount: number;
  requiresApproval: boolean;
  riskClass: FridayFleetRemediationRiskClass;
}

export interface FridayFleetRemediationAction {
  actionId: string;
  title: string;
  summary: string;
  reason: string;
  status: FridayFleetRemediationActionStatus;
  riskClass: FridayFleetRemediationRiskClass;
  requiresApproval: boolean;
}

export interface FridayFleetRemediationPlan {
  generatedAt: string;
  satelliteId: string;
  status: "stable" | "attention_required" | "blocked";
  summary: string;
  reasons: string[];
  actions: FridayFleetRemediationAction[];
}

export interface FridayFleetSatelliteRuntimeRecovery {
  state: "stable" | "retrying" | "degraded" | "halted";
  continuationMode: "already_dispatched_only";
  offlinePlanningMode: "deferred";
  summary: string;
  reasons: string[];
  queueRecoveryState: "stable" | "retrying" | "blocked";
  syncRecoveryState: "stable" | "recovering" | "blocked";
  requiresOperatorIntervention: boolean;
  autoRetryActive: boolean;
  nextOperatorAction:
    | "monitor_only"
    | "restore_heartbeat"
    | "re_authorize_satellite"
    | "requeue_expired_leases"
    | "expire_stale_messages"
    | "resume_blocked_work";
}

export interface FridayFleetSatelliteDetailResponse {
  satellite: FridayFleetSatelliteCard;
  capabilities: Array<{
    key: string;
    available: boolean;
    limits?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
  queue: {
    queued: number;
    leased: number;
    failed: number;
    deadLetter: number;
  };
  workflowLoad: {
    queuedNodes: number;
    runningNodes: number;
    retryingNodes: number;
    blockedOfflineNodes: number;
  };
  runtimeRecovery: FridayFleetSatelliteRuntimeRecovery;
  trustBreakdown: {
    identityScore: number;
    statusScore: number;
    hygieneScore: number;
    incidentPenalty: number;
    finalScore: number;
    band: FridayTrustBand;
    reasons: string[];
  };
  healthBreakdown: {
    heartbeatScore: number;
    resourceScore: number;
    queueScore: number;
    reliabilityScore: number;
    finalScore: number;
    state: FridayHealthState;
  };
  remediation: FridayFleetRemediationPlan;
}

export interface FridayPendingSatellitePairingRequest {
  requestId: string;
  satelliteId: string;
  displayName: string;
  type: string;
  pairingCode: string;
  createdAt: string;
  expiresAt: string;
}

export interface FridayApproveSatellitePairingResponse {
  token: string;
  tokenId: string;
  expiresAt: string;
  configRevision: number;
  tokenVersion: number;
}

export interface FridayRejectSatellitePairingResponse {
  ok: true;
  rejectedAt: string;
}

// ─── Health types ───

export interface FridayHealthResponse {
  status: string;
  version: string;
  uptime: number;
  capabilities?: {
    schemaVersion: string;
    plugins?: {
      runtimeMode?: "stub" | "full";
    };
    channels?: {
      supportedKinds?: string[];
      enabledKinds?: string[];
    };
    search?: {
      provider?: string;
      latestness?: "provider_backed" | "unverified";
      warning?: string;
    };
    runtime?: FridayRuntimeCapabilityMatrix;
    system?: {
      enabled?: boolean;
      remoteMode?: "trusted_private_network" | "disabled" | "unavailable";
      healthStatus?: "healthy" | "degraded" | "safe_mode" | "unavailable";
      companionConnected?: boolean;
      companionReadiness?: "ready" | "degraded" | "unavailable";
      reasons?: string[];
      warning?: string;
    };
  };
}
