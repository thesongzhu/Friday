import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export type FridaySystemHealthState =
  | "healthy"
  | "degraded"
  | "safe_mode"
  | "unavailable";

export type FridaySystemIntentAction =
  | "snapshot"
  | "open"
  | "focus"
  | "arrange_windows"
  | "launch_app"
  | "close_app"
  | "open_url"
  | "open_project"
  | "search_file"
  | "handoff_to_browser"
  | "handoff_to_terminal"
  | "read_notification"
  | "notification_list"
  | "notification_act"
  | "triage_notifications"
  | "resume_task"
  | "recover_ui"
  | "clipboard_read"
  | "clipboard_write"
  | "request_control"
  | "release_control"
  | "approve"
  | "deny";

export type FridaySystemNotificationAction = "open" | "dismiss" | "mark_read";
export type FridaySystemWindowLayout = "single_focus" | "dual_pane" | "triad";
export type FridaySystemCapabilityAvailability = "supported" | "fallback" | "unsupported";

export type FridaySystemIntentStatus =
  | "completed"
  | "blocked"
  | "failed"
  | "unavailable"
  | "queued";

export type FridaySystemApprovalDecision = "allow" | "deny" | "prompt";
export type FridaySystemRemoteMode = "trusted_private_network" | "disabled" | "unavailable";
export type FridaySystemRemoteDeviceStatus = "active" | "revoked";
export type FridaySystemRemotePasskeyDeviceType = "singleDevice" | "multiDevice";
export type FridaySystemRemoteSessionStatus = "active" | "closed";
export type FridaySystemRiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type FridayDesktopPlatform = "darwin" | "linux" | "win32" | "unknown";
export type FridayTrustedDevicePlatform = "browser" | "ios" | "android";
export type FridayDiagnosisIncidentStatus = "open" | "mitigated" | "resolved";
export type FridayAutoFixRiskTier = 0 | 1 | 2;
export type FridayAutoFixActionStatus = "planned" | "applied" | "rolled_back" | "rejected";
export type FridayAutoFixOutcome = "success" | "failed" | null;
export type FridayApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired";
export type FridayReleaseChannelKind =
  | "sparkle"
  | "homebrew"
  | "npm"
  | "testflight"
  | "play_internal";
export type FridaySystemCompanionRuntimeKind =
  | "embedded"
  | "node_daemon"
  | "swift_binary"
  | "swift_app"
  | "dotnet_winui_app"
  | "rust_gtk_app";
export type FridaySystemRuntimeKind =
  | FridaySystemCompanionRuntimeKind
  | "browser"
  | "ios_remote_console"
  | "android_remote_console";

export interface FridaySystemBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FridaySystemAppRef {
  id: string;
  name: string;
  bundleId?: string;
  pid?: number;
  running: boolean;
  frontmost: boolean;
}

export interface FridaySystemWindowRef {
  id: string;
  appId: string;
  title: string;
  focused: boolean;
  bounds?: FridaySystemBounds;
}

export interface FridaySystemNotificationRef {
  id: string;
  sourceApp?: string;
  title: string;
  body?: string;
  deepLinkUrl?: string;
  receivedAt: string;
  read: boolean;
}

export interface FridaySystemPermissionGrant {
  id: string;
  permission: string;
  status: "granted" | "denied" | "not_determined" | "restricted" | "not_applicable";
  grantInstructions?: string;
}

export interface FridaySystemControlLease {
  id: string;
  ownerId: string;
  ownerKind: "agent" | "api" | "remote" | "system";
  reason?: string;
  acquiredAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedReason?: string;
}

export interface FridaySystemApprovalRule {
  id: string;
  appIdentifier?: string;
  action: string;
  riskLevel: FridaySystemRiskLevel;
  decision: FridaySystemApprovalDecision;
  rationale?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface FridaySystemRemoteDevice {
  id: string;
  label: string;
  fingerprint: string;
  platform: FridayTrustedDevicePlatform;
  credentialId?: string;
  passkeyRegisteredAt?: string;
  passkeyLastUsedAt?: string;
  passkeyBackedUp?: boolean;
  passkeyDeviceType?: FridaySystemRemotePasskeyDeviceType;
  trustScope: Exclude<FridaySystemRemoteMode, "unavailable">;
  status: FridaySystemRemoteDeviceStatus;
  registeredAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface FridaySystemRemoteSession {
  id: string;
  deviceId: string;
  devicePlatform?: FridayTrustedDevicePlatform;
  status: FridaySystemRemoteSessionStatus;
  connectedAt: string;
  lastSeenAt: string;
  closedAt?: string;
  closedReason?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface FridayErrorIncidentEntity {
  incidentId: string;
  userId: string;
  runId?: string;
  nodeId?: string;
  ts: string;
  category: "tool" | "model" | "routing" | "config" | "workflow";
  severity: "low" | "medium" | "high";
  signature: string;
  context: Record<string, unknown>;
  autoFixEligible: boolean;
  status: FridayDiagnosisIncidentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FridayDiagnosisRecordEntity {
  id: string;
  incidentId?: string;
  runId?: string;
  nodeId?: string;
  errorFingerprint: string;
  confidence: number;
  diagnosis: Record<string, unknown>;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayAutoFixActionPlan {
  title: string;
  summary: string;
  steps: Array<{
    stepId: string;
    kind: string;
    target: string;
    payload: unknown;
    verify?: {
      method: string;
      timeoutMs: number;
    };
  }>;
  rollbackPlan?: {
    summary: string;
    steps: Array<{
      stepId: string;
      kind: string;
      target: string;
      payload: unknown;
    }>;
  };
  evidence: {
    fingerprint: string;
    matchedLessonIds: string[];
    diagnosisId: string;
    recurrenceCount: number;
  };
}

export interface FridayAutoFixActionEntity {
  actionId: string;
  incidentId: string;
  userId: string;
  riskTier: FridayAutoFixRiskTier;
  plan: FridayAutoFixActionPlan;
  rollbackPlan?: FridayAutoFixActionPlan["rollbackPlan"];
  status: FridayAutoFixActionStatus;
  outcome: FridayAutoFixOutcome;
  appliedAt?: string;
  rolledBackAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayApprovalRequestEntity {
  requestId: string;
  actionId: string;
  runId?: string;
  userId: string;
  description: string;
  riskTier: 2;
  plan: FridayAutoFixActionPlan;
  requestedAt: string;
  expiresAt: string;
  status: FridayApprovalRequestStatus;
  responseReason?: string;
  respondedAt?: string;
  respondedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayLearningMetricsEntity {
  day: string;
  successRate?: number;
  autoFixSuccessRate?: number;
  rollbackRate?: number;
  incidentsTotal: number;
  factsUpdated: number;
  actionsExecuted: number;
  createdAt: string;
  updatedAt: string;
}

export interface FridayDiagnosisSummary {
  incidentId: string;
  loopRunId?: string;
  diagnosisId?: string;
  confidence?: number;
  rootCauseSummary: string;
  matchedLessonIds: string[];
  suggestedFixes: string[];
  recurrenceCount: number;
  autoFixEligible: boolean;
  createdAt?: string;
}

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

export interface FridayFixExecutionEvidence {
  rootCauseSummary: string;
  selectedPlan: {
    title: string;
    summary: string;
    stepCount: number;
    rollbackPlanAvailable: boolean;
  };
  riskTier: FridayAutoFixRiskTier;
  approvalTrail?: {
    requestId: string;
    status: FridayApprovalRequestStatus;
    respondedAt?: string;
    respondedBy?: string;
    reason?: string;
  };
  executionResult: {
    status: FridayAutoFixActionStatus;
    outcome: FridayAutoFixOutcome;
    appliedAt?: string;
  };
  rollbackResult: {
    available: boolean;
    rolledBackAt?: string;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean;
  };
  acceptanceResult: {
    passed: boolean;
    reason: string;
  };
  extractedLesson?: {
    id: string;
    title: string;
    cause: string;
    fix: string;
  };
}

export interface FridayIssueCard {
  id: string;
  kind: "approval_required" | "incident" | "failed_fix";
  incidentId: string;
  actionId?: string;
  approvalRequestId?: string;
  title: string;
  summary: string;
  severity: FridayErrorIncidentEntity["severity"];
  status: string;
  createdAt: string;
  routeTarget: "/assistant";
}

export interface FridayFixPlanRecord {
  action: FridayAutoFixActionEntity;
  summary: FridayFixPlanSummary;
  approval: FridayApprovalRequestEntity | null;
  evidence: FridayFixExecutionEvidence;
}

export interface FridayDiagnosisIncidentRecord {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity | null;
  summary: FridayDiagnosisSummary;
  action?: FridayFixPlanRecord | null;
}

export interface FridayBeginnerIntentResolution {
  intent:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "review_issues"
    | "apply_fix"
    | "general_help";
  confidence: number;
  summary: string;
  routeTarget: "/assistant";
  suggestedTemplateIds: string[];
  state?: "ready_to_execute" | "needs_one_answer" | "blocked_by_policy" | "out_of_boundary";
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
}

export interface FridayActionTemplateSummary {
  id: string;
  label: string;
  description: string;
  category: "skills" | "workflows" | "issues" | "system";
  parameters: Array<{
    key: string;
    label: string;
    type: "text" | "boolean";
    required: boolean;
    placeholder?: string;
  }>;
}

export interface FridayGuidedWizardState {
  wizardId: string;
  contextId: string;
  title: string;
  status: "awaiting_input" | "ready" | "completed";
  currentStepId: string;
  steps: Array<{
    id: string;
    title: string;
    prompt: string;
    inputKey: string;
  }>;
  collectedValues: Record<string, unknown>;
  nextActionLabel?: string;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
}

export type FridayCommunicationMbti =
  | "INTJ" | "INTP" | "ENTJ" | "ENTP"
  | "INFJ" | "INFP" | "ENFJ" | "ENFP"
  | "ISTJ" | "ISFJ" | "ESTJ" | "ESFJ"
  | "ISTP" | "ISFP" | "ESTP" | "ESFP";

export type FridayCommunicationTone = "warm" | "neutral" | "analytical" | "encouraging";
export type FridayCommunicationVerbosity = "concise" | "balanced" | "detailed";
export type FridayCommunicationStructure = "compact" | "balanced" | "structured";
export type FridayCommunicationQuestionStyle = "minimal" | "guided" | "exploratory";
export type FridayCommunicationDirectness = "soft" | "balanced" | "direct";
export type FridayCommunicationEmojiStyle = "none" | "light";
export type FridayCommunicationJargonTolerance = "low" | "medium" | "high";
export type FridayCommunicationAssumptionStyle = "ask_first" | "balanced" | "infer_first";
export type FridayCommunicationConfirmationStyle = "minimal" | "balanced" | "explicit";
export type FridayCommunicationSettingSource = "explicit" | "learned" | "template" | "default";

export interface FridayCommunicationPersonaSettings {
  tone: FridayCommunicationTone;
  verbosity: FridayCommunicationVerbosity;
  structure: FridayCommunicationStructure;
  questionStyle: FridayCommunicationQuestionStyle;
  directness: FridayCommunicationDirectness;
  emojiStyle: FridayCommunicationEmojiStyle;
  jargonTolerance: FridayCommunicationJargonTolerance;
  assumptionStyle: FridayCommunicationAssumptionStyle;
  confirmationStyle: FridayCommunicationConfirmationStyle;
}

export interface FridayCommunicationPersonaPreview {
  styleLabel: string;
  sampleClarifier: string;
  sampleBoundary: string;
}

export interface FridayCommunicationPersona {
  category: "communication";
  mbti: FridayCommunicationMbti | null;
  settings: FridayCommunicationPersonaSettings;
  inheritedFrom: {
    mbti: FridayCommunicationSettingSource;
    settings: Record<keyof FridayCommunicationPersonaSettings, FridayCommunicationSettingSource>;
  };
  preview: FridayCommunicationPersonaPreview;
}

export interface FridayUserPreference {
  id: string;
  principalId: string;
  category: "notification" | "scheduling" | "formatting" | "disclosure" | "provider" | "communication";
  key: string;
  value: unknown;
  source: "explicit" | "implicit";
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface FridayListUserPreferencesResponse {
  items: FridayUserPreference[];
}

export interface FridayUpdateUserPreferencesRequest {
  preferences: Array<{
    category: FridayUserPreference["category"];
    key: string;
    value: unknown;
  }>;
}

export interface FridayUpdateUserPreferencesResponse {
  preferences: FridayUserPreference[];
  created: number;
  updated: number;
}

export interface FridayDeleteUserPreferenceResponse {
  deleted: true;
  preferenceId: string;
}

export interface FridayGetCommunicationPersonaResponse {
  persona: FridayCommunicationPersona;
}

export interface FridaySystemTransport {
  mode: "in_process" | "unix_socket" | "named_pipe";
  protocol: "jsonrpc-2.0";
  authenticated: boolean;
  socketPath?: string;
  pipeName?: string;
}

export interface FridaySystemCompanionSurfaceCapabilities {
  launchAtLogin: boolean;
  menuBar: boolean;
  overlay: boolean;
  globalHotkey: boolean;
  windowInventory: boolean;
  notificationIntake: boolean;
  screenCapture: boolean;
}

export interface FridaySystemCompanionActionCapabilities {
  snapshot: FridaySystemCapabilityAvailability;
  launch_app: FridaySystemCapabilityAvailability;
  focus: FridaySystemCapabilityAvailability;
  open_url: FridaySystemCapabilityAvailability;
  open_project: FridaySystemCapabilityAvailability;
  handoff_to_browser: FridaySystemCapabilityAvailability;
  handoff_to_terminal: FridaySystemCapabilityAvailability;
  arrange_windows: FridaySystemCapabilityAvailability;
  notification_list: FridaySystemCapabilityAvailability;
  read_notification: FridaySystemCapabilityAvailability;
  notification_act: FridaySystemCapabilityAvailability;
  recover_ui: FridaySystemCapabilityAvailability;
}

export interface FridaySystemCompanionCapabilities {
  surfaces: FridaySystemCompanionSurfaceCapabilities;
  actions: FridaySystemCompanionActionCapabilities;
}

export interface FridaySystemCompanionStatus {
  id: string;
  platform: FridayDesktopPlatform;
  runtimeKind: FridaySystemCompanionRuntimeKind;
  connected: boolean;
  transport: FridaySystemTransport;
  launchAtLoginEnabled: boolean;
  panicHotkey: string;
  safeMode: boolean;
  overlayVisible: boolean;
  lastHeartbeatAt: string;
  capabilities: FridaySystemCompanionCapabilities;
  permissions: FridaySystemPermissionGrant[];
}

export interface FridaySystemHealth {
  status: FridaySystemHealthState;
  safeMode: boolean;
  desktopConnected: boolean;
  companionConnected: boolean;
  reasons: string[];
  updatedAt: string;
}

export interface FridaySystemBrowserDiagnostics {
  configuredMode: "auto" | "headless" | "host_chrome_visible";
  activeMode: "headless" | "host_chrome_visible";
  targetBrowser: string;
  browserTarget?: string;
  fallbackReason?: string;
  sessionId?: string;
  tabId?: string;
}

export interface FridaySystemSnapshot {
  capturedAt: string;
  platform: FridayDesktopPlatform;
  workspaceRoot: string;
  apps: FridaySystemAppRef[];
  windows: FridaySystemWindowRef[];
  notifications: FridaySystemNotificationRef[];
  permissions: FridaySystemPermissionGrant[];
  mountedRoots: string[];
  frontmostAppId?: string;
  frontmostWindowId?: string;
  activeTask?: string;
  clipboard?: {
    available: boolean;
    textPreview?: string;
  };
  health: FridaySystemHealth;
  companion: FridaySystemCompanionStatus;
  browser?: FridaySystemBrowserDiagnostics;
  controlLease: FridaySystemControlLease | null;
  approvalsSummary: {
    total: number;
    highRiskAllowed: number;
  };
  remoteDevicesSummary: {
    total: number;
    active: number;
  };
  remoteSessionsSummary: {
    total: number;
    active: number;
    latestSeenAt?: string;
  };
}

export interface FridaySystemSession {
  id: string;
  mode: "agent_os";
  workspaceRoot: string;
  remoteMode: Exclude<FridaySystemRemoteMode, "unavailable">;
  cloudPlanningMode: "local_only" | "opt_in" | "hybrid";
  startedAt: string;
  companion: FridaySystemCompanionStatus;
  health: FridaySystemHealth;
}

export interface FridaySystemIntentResult {
  id: string;
  action: FridaySystemIntentAction;
  status: FridaySystemIntentStatus;
  message: string;
  performedAt: string;
  payload?: Record<string, unknown>;
  approvalRuleId?: string;
  controlLeaseId?: string;
}

export interface FridaySystemEvent {
  id: string;
  seq: number;
  event: string;
  emittedAt: string;
  payload: Record<string, unknown>;
}

export interface FridayGetSystemSessionResponse {
  session: FridaySystemSession;
}

export interface FridayGetSystemStateResponse {
  snapshot: FridaySystemSnapshot;
}

export interface FridayExecuteSystemIntentRequest {
  action: FridaySystemIntentAction;
  actorId?: string;
  actorKind?: "agent" | "api" | "remote" | "system";
  target?: string;
  targetKind?: "app" | "url" | "project";
  appIdentifier?: string;
  url?: string;
  projectPath?: string;
  query?: string;
  value?: string;
  notificationId?: string;
  notificationAction?: FridaySystemNotificationAction;
  approvalId?: string;
  deviceId?: string;
  riskLevel?: FridaySystemRiskLevel;
  reason?: string;
  force?: boolean;
  leaseTtlMs?: number;
  layout?: FridaySystemWindowLayout;
  idempotencyKey?: string;
}

export interface FridayExecuteSystemIntentResponse {
  result: FridaySystemIntentResult;
}

export interface FridayListSystemApprovalsResponse {
  items: FridaySystemApprovalRule[];
  nextCursor?: string;
}

export interface FridayUpdateSystemApprovalRequest {
  decision?: FridaySystemApprovalDecision;
  rationale?: string;
  idempotencyKey?: string;
}

export interface FridayUpdateSystemApprovalResponse {
  approval: FridaySystemApprovalRule;
}

export interface FridayListSystemEventsResponse {
  items: FridaySystemEvent[];
  nextAfterSeq?: number;
}

export interface FridayListSystemRemoteDevicesResponse {
  items: FridaySystemRemoteDevice[];
}

export interface FridayListSystemRemoteSessionsResponse {
  items: FridaySystemRemoteSession[];
}

export interface FridayRegisterSystemRemoteDeviceRequest {
  label: string;
  fingerprint: string;
  platform?: FridayTrustedDevicePlatform;
  credentialId?: string;
  idempotencyKey?: string;
}

export interface FridayRegisterSystemRemoteDeviceResponse {
  device: FridaySystemRemoteDevice;
}

export interface FridayDeleteSystemRemoteDeviceResponse {
  revoked: boolean;
  deviceId: string;
}

export interface FridayDeleteSystemRemotePasskeyResponse {
  cleared: boolean;
  deviceId: string;
  device: FridaySystemRemoteDevice;
}

export interface FridayDeleteSystemRemoteSessionResponse {
  closed: boolean;
  sessionId: string;
}

export interface FridayCreateSystemRemoteSessionRequest {
  deviceId: string;
  assertionToken: string;
  idempotencyKey?: string;
}

export interface FridayCreateSystemRemoteSessionResponse {
  session: FridaySystemRemoteSession;
}

export interface FridayBeginSystemRemotePasskeyRegistrationRequest {
  deviceId: string;
  idempotencyKey?: string;
}

export interface FridayBeginSystemRemotePasskeyRegistrationResponse {
  challengeId: string;
  deviceId: string;
  rpId: string;
  origin: string;
  expiresAt: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface FridayVerifySystemRemotePasskeyRegistrationRequest {
  deviceId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
  idempotencyKey?: string;
}

export interface FridayVerifySystemRemotePasskeyRegistrationResponse {
  device: FridaySystemRemoteDevice;
  credentialId: string;
  verifiedAt: string;
}

export interface FridayBeginSystemRemotePasskeyAssertionRequest {
  deviceId: string;
  idempotencyKey?: string;
}

export interface FridayBeginSystemRemotePasskeyAssertionResponse {
  challengeId: string;
  deviceId: string;
  rpId: string;
  origin: string;
  expiresAt: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface FridayVerifySystemRemotePasskeyAssertionRequest {
  deviceId: string;
  challengeId: string;
  response: AuthenticationResponseJSON;
  idempotencyKey?: string;
}

export interface FridayVerifySystemRemotePasskeyAssertionResponse {
  device: FridaySystemRemoteDevice;
  assertionToken: string;
  expiresAt: string;
  verifiedAt: string;
}

export interface FridayListDiagnosisIncidentsResponse {
  items: FridayDiagnosisIncidentRecord[];
}

export interface FridayGetDiagnosisIncidentResponse extends FridayDiagnosisIncidentRecord {}

export interface FridayGetIncidentDiagnosisResponse {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity | null;
  summary: FridayDiagnosisSummary;
  action?: FridayFixPlanRecord | null;
}

export interface FridayListAutoFixActionsResponse {
  items: FridayFixPlanRecord[];
}

export interface FridayGetAutoFixActionResponse extends FridayFixPlanRecord {}

export interface FridayAutoFixApprovalResponse {
  approval: FridayApprovalRequestEntity | null;
  action: FridayFixPlanRecord;
}

export interface FridayAutoFixExecutionResponse {
  action: FridayFixPlanRecord;
}

export interface FridayAutoFixMetricsResponse {
  metrics: FridayLearningMetricsEntity | FridayLearningMetricsEntity[];
}

export type FridayAgentLoopPolicyMode = "tiered_supervised";
export type FridayExpertAutonomyRiskClass =
  | "safe_probe"
  | "bounded_repair"
  | "destructive_or_sensitive";

export type FridayAgentLoopRunStatus =
  | "awaiting_approval"
  | "running"
  | "verified"
  | "rolled_back"
  | "failed"
  | "halted"
  | "paused"
  | "cancelled"
  | "cooldown";

export type FridayAgentLoopTrigger =
  | "incident_opened"
  | "approval_granted"
  | "manual_resume"
  | "cooldown_elapsed"
  | "repeated_failure_alert";

export type FridayAgentLoopHaltReason =
  | "policy_paused"
  | "approval_required"
  | "missing_rollback_plan"
  | "missing_acceptance_check"
  | "failure_budget_exhausted"
  | "verification_failed"
  | "execution_failed"
  | "action_rejected"
  | "probe_budget_exhausted"
  | "manual_pause"
  | "manual_cancel";

export interface FridayAgentLoopPolicy {
  id: string;
  mode: FridayAgentLoopPolicyMode;
  paused: boolean;
  autoApplyLowRisk: boolean;
  maxAttemptsPerFingerprint: number;
  cooldownMinutes: number;
  requireRollbackPlan: boolean;
  requireAcceptanceCheck: boolean;
  expertModeEnabled: boolean;
  expertModeUserIds: string[];
  expertModeWorkspaceIds: string[];
  expertModeEnvironments: string[];
  contextInferenceAllowed: boolean;
  multiStepHypothesisSearchAllowed: boolean;
  safeProbeExecutionAllowed: boolean;
  crossSurfaceOrchestrationAllowed: boolean;
  highRiskFinalApprovalRequired: boolean;
  productionDestructiveActionApprovalRequired: boolean;
  probeBudget: number;
  timeBudgetMinutes: number;
  updatedAt: string;
}

export interface FridayAgentLoopExpertModeSummary {
  enabled: boolean;
  activeForCurrentRuntime: boolean;
  allowedUserIds: string[];
  allowedWorkspaceIds: string[];
  allowedEnvironments: string[];
  contextInferenceAllowed: boolean;
  multiStepHypothesisSearchAllowed: boolean;
  safeProbeExecutionAllowed: boolean;
  crossSurfaceOrchestrationAllowed: boolean;
  highRiskFinalApprovalRequired: boolean;
  productionDestructiveActionApprovalRequired: boolean;
  probeBudget: number;
  timeBudgetMinutes: number;
}

export interface FridayExpertAutonomyHypothesis {
  id: string;
  summary: string;
  confidence: number;
  validationCost: "low" | "medium" | "high";
  supportingEvidence: string[];
  status: "candidate" | "validated" | "discarded" | "chosen";
}

export interface FridayExpertAutonomyProbeStep {
  id: string;
  title: string;
  kind:
    | "read_only_inspection"
    | "dry_run"
    | "sandbox_check"
    | "temporary_execution"
    | "simulation";
  summary: string;
  safe: boolean;
  status: "planned" | "completed" | "skipped" | "blocked";
  evidence?: string;
}

export interface FridayAgentLoopRun {
  loopRunId: string;
  userId: string;
  incidentId: string;
  actionId?: string;
  fingerprint: string;
  trigger: FridayAgentLoopTrigger;
  status: FridayAgentLoopRunStatus;
  riskTier: FridayAutoFixRiskTier;
  approvalRequired: boolean;
  attemptNumber: number;
  verificationPassed?: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  haltReason?: FridayAgentLoopHaltReason;
  lastError?: string;
  lessonId?: string;
  correlationId?: string;
  startedAt?: string;
  completedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  cancelledAt?: string;
  cooldownUntil?: string;
  expertModeEnabled: boolean;
  riskClass?: FridayExpertAutonomyRiskClass;
  requiresFinalApproval: boolean;
  assumptions: string[];
  unknowns: string[];
  hypotheses: FridayExpertAutonomyHypothesis[];
  probeSteps: FridayExpertAutonomyProbeStep[];
  probeBudget?: number;
  objective?: string;
  planSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayAgentLoopRunRecord {
  run: FridayAgentLoopRun;
  incident: FridayDiagnosisIncidentRecord | null;
  action: FridayFixPlanRecord | null;
}

export interface FridayGetAgentLoopPolicyResponse {
  policy: FridayAgentLoopPolicy;
}

export interface FridayUpdateAgentLoopPolicyRequest {
  paused?: boolean;
  autoApplyLowRisk?: boolean;
  maxAttemptsPerFingerprint?: number;
  cooldownMinutes?: number;
  requireRollbackPlan?: boolean;
  requireAcceptanceCheck?: boolean;
}

export interface FridayGetAgentLoopExpertModeResponse {
  expertMode: FridayAgentLoopExpertModeSummary;
}

export interface FridayUpdateAgentLoopExpertModeRequest {
  enabled?: boolean;
  allowedUserIds?: string[];
  allowedWorkspaceIds?: string[];
  allowedEnvironments?: string[];
  contextInferenceAllowed?: boolean;
  multiStepHypothesisSearchAllowed?: boolean;
  safeProbeExecutionAllowed?: boolean;
  crossSurfaceOrchestrationAllowed?: boolean;
  highRiskFinalApprovalRequired?: boolean;
  productionDestructiveActionApprovalRequired?: boolean;
  probeBudget?: number;
  timeBudgetMinutes?: number;
}

export interface FridayUpdateAgentLoopExpertModeResponse {
  expertMode: FridayAgentLoopExpertModeSummary;
}

export interface FridayUpdateAgentLoopPolicyResponse {
  policy: FridayAgentLoopPolicy;
}

export interface FridayListAgentLoopRunsResponse {
  items: FridayAgentLoopRunRecord[];
}

export interface FridayGetAgentLoopRunResponse extends FridayAgentLoopRunRecord {}

export interface FridayListExpertAgentLoopRunsResponse {
  items: FridayAgentLoopRunRecord[];
}

export interface FridayGetExpertAgentLoopRunResponse extends FridayAgentLoopRunRecord {}

export interface FridayAgentLoopRunControlResponse {
  run: FridayAgentLoopRunRecord;
}

export interface FridayWorkflowSpecSummary {
  workflowId: string;
  name: string;
  description?: string;
  startStepId?: string;
  steps: Array<{
    id: string;
    type: string;
    ref?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    when?: string;
  }>;
}

export interface FridayWorkflowVisualGraph {
  workflowId: string;
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  panelLayout: {
    leftOpen: boolean;
    rightOpen: boolean;
    bottomOpen: boolean;
  };
  nodes: Array<{
    nodeId: string;
    x: number;
    y: number;
  }>;
  edges: Array<{
    edgeKey: string;
  }>;
}

export interface FridayWorkflowEntity {
  id: string;
  slug: string;
  name: string;
  description?: string;
  tags: string[];
  latestVersionNumber: number;
  publishedVersionNumber?: number;
  isArchived: boolean;
  revision: number;
  etag: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayWorkflowVersionEntity {
  id: string;
  workflowId: string;
  versionNumber: number;
  checksum: string;
  createdByUserId?: string;
  isPublished: boolean;
  changeNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayWorkflowDraftEntity {
  draftId: string;
  workflowId: string;
  ownerUserId?: string;
  title: string;
  status: "active" | "archived" | "published" | "conflicted";
  revision: number;
  baseWorkflowVersionId?: string;
  spec: FridayWorkflowSpecSummary;
  visual: FridayWorkflowVisualGraph;
  createdAt: string;
  updatedAt: string;
  publishedVersionId?: string;
  autosave: {
    enabled: boolean;
    intervalMs: number;
    lastSavedAt?: string;
  };
}

export interface FridayWorkflowRunEntity {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  triggerType: string;
  startedByUserId?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface FridayWorkflowRunEvidenceExport {
  exportId: string;
  runId: string;
  artifactId: string;
  uri: string;
  checksum: string;
  createdAt: string;
  persisted: boolean;
  filePersisted: boolean;
}

export interface FridayWorkflowDeployEvidenceSummary {
  incidentId?: string;
  runId?: string;
  exportedBundleChecksum?: string;
  exportedAt?: string;
  traceSummary: string;
}

export interface FridayWorkflowDeployResult {
  workflowId: string;
  draftId: string;
  workflowVersionId: string;
  versionNumber: number;
  published: boolean;
  triggerSync: {
    requested: boolean;
    synced: boolean;
  };
  validation: {
    valid: boolean;
    issues: Array<{
      code: string;
      stage: string;
      severity: "error" | "warning" | "info";
      message: string;
      jsonPath?: string;
      stepId?: string;
    }>;
    generatedAt: string;
  };
  run?: FridayWorkflowRunEntity;
  exportBundle?: {
    bundleSchemaVersion: string;
    exportedAt: string;
    checksum: string;
    sourceType: "draft" | "workflow_version";
    sourceId: string;
    workflowId: string;
  };
  evidence: FridayWorkflowDeployEvidenceSummary;
}

export interface FridayWorkflowOverview {
  workflow: FridayWorkflowEntity;
  latestVersion?: FridayWorkflowVersionEntity;
  publishedVersion?: FridayWorkflowVersionEntity;
  drafts: FridayWorkflowDraftEntity[];
  latestDraft?: FridayWorkflowDraftEntity;
  recentRuns: FridayWorkflowRunEntity[];
  latestRun?: FridayWorkflowRunEntity;
  latestRunNodeTimeline: Array<{
    nodeId: string;
    attempt: number;
    status: string;
    message?: string;
    finishedAt?: string;
  }>;
  latestEvidenceExports: FridayWorkflowRunEvidenceExport[];
  versionHistory: FridayWorkflowVersionEntity[];
}

export interface FridayWorkflowVisualization {
  workflow: FridayWorkflowEntity;
  targetKind: "draft" | "published_version" | "version";
  draft?: FridayWorkflowDraftEntity;
  version?: FridayWorkflowVersionEntity;
  spec: FridayWorkflowSpecSummary;
  visual: FridayWorkflowVisualGraph;
  latestRun?: FridayWorkflowRunEntity;
  recentRuns: FridayWorkflowRunEntity[];
  nodeTimeline: Array<{
    nodeId: string;
    attempt: number;
    status: string;
    message?: string;
    finishedAt?: string;
  }>;
  latestEvidenceExports: FridayWorkflowRunEvidenceExport[];
}

export interface FridayAssistantWorkflowCard {
  kind: "session_started" | "draft_ready" | "deployment_result" | "export_ready" | "blocked";
  workflowId?: string;
  workflowName: string;
  draftId?: string;
  sessionId?: string;
  summary: string;
  routeTarget: "/assistant" | "/workflows";
  deployReady: boolean;
  questions?: string[];
  latestRun?: FridayWorkflowRunEntity;
  exportBundle?: FridayWorkflowDeployResult["exportBundle"];
  evidence?: FridayWorkflowDeployEvidenceSummary;
}

export interface FridayGetWorkflowOverviewResponse {
  overview: FridayWorkflowOverview;
}

export interface FridayGetWorkflowVisualizationResponse {
  visualization: FridayWorkflowVisualization;
}

export interface FridayDeployWorkflowDraftRequest {
  runNow?: boolean;
  resyncTriggers?: boolean;
  includeExport?: boolean;
  changeNote?: string;
  lockToken?: string;
  ownerSessionId?: string;
  lockTtlSec?: number;
}

export interface FridayDeployWorkflowDraftResponse {
  deployment: FridayWorkflowDeployResult;
}

export interface FridayUixTemplatesResponse {
  templates: FridayActionTemplateSummary[];
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

export interface FridayExecuteAssistantTemplateRequest {
  templateId: string;
  parameters?: Record<string, unknown>;
  assistantSessionKey?: string;
}

export interface FridayUixTemplateExecutionResponse {
  templateId: string;
  status: "preview" | "executed";
  summary: string;
  routeTarget: "/assistant";
  result?: Record<string, unknown>;
  workflow?: FridayAssistantWorkflowCard;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
  state?: FridayBeginnerIntentResolution["state"];
  harness?: FridayTemplateHarnessSummary | null;
}

export interface FridayUixIssuesResponse {
  items: FridayIssueCard[];
}

export interface FridayUixWizardResponse {
  wizard: FridayGuidedWizardState;
  summary?: string;
  result?: Record<string, unknown>;
  workflow?: FridayAssistantWorkflowCard;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
  state?: FridayBeginnerIntentResolution["state"];
  harness?: FridayTemplateHarnessSummary | null;
}

export interface FridayStartAssistantWizardRequest {
  wizardId: string;
  assistantSessionKey?: string;
}

export interface FridayContinueAssistantWizardRequest {
  wizardId: string;
  contextId: string;
  values?: Record<string, unknown>;
  assistantSessionKey?: string;
}

export type FridayObservabilityModule =
  | "rules"
  | "node-runner"
  | "acceptance"
  | "retry"
  | "uix"
  | "skills"
  | "learning"
  | "workflows"
  | "api"
  | "auth"
  | "observability"
  | "desktop";

export type FridayObservabilitySpanStatus = "unset" | "ok" | "error";
export type FridayObservabilityBucketSize = "1m" | "5m" | "1h" | "1d";
export type FridayObservabilityAuditOutcome = "success" | "failure" | "denied" | "error";
export type FridayObservabilityAuditActionCategory =
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "access"
  | "authorize"
  | "export";
export type FridayObservabilityAlertSeverity = "critical" | "warning" | "info";
export type FridayObservabilityAlertStatus =
  | "pending"
  | "firing"
  | "acknowledged"
  | "escalated"
  | "resolved";
export type FridayObservabilityHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface FridayObservabilityDependencyHealth {
  name: string;
  status: FridayObservabilityHealthStatus;
  message?: string;
  responseTimeMs?: number;
  lastCheckedAt: string;
}

export interface FridayObservabilityComponentHealth {
  name: string;
  module: FridayObservabilityModule;
  status: FridayObservabilityHealthStatus;
  message?: string;
  dependencies: FridayObservabilityDependencyHealth[];
  lastCheckedAt: string;
  checkDurationMs: number;
}

export interface FridayObservabilitySystemHealth {
  status: FridayObservabilityHealthStatus;
  components: FridayObservabilityComponentHealth[];
  message: string;
  checkedAt: string;
  healthyCount: number;
  degradedCount: number;
  unhealthyCount: number;
}

export interface FridayObservabilityTraceSummaryStats {
  totalTraces: number;
  errorTraces: number;
  okTraces: number;
  avgDurationMs: number;
  activeTraces: number;
}

export interface FridayObservabilityAuditSummaryStats {
  totalEntries: number;
  byCategory: Record<string, number>;
  byOutcome: Record<string, number>;
  byModule: Record<string, number>;
}

export interface FridayObservabilityAlertSummaryStats {
  activeAlerts: number;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  highestSeverity: FridayObservabilityAlertSeverity | null;
  totalRules: number;
}

export interface FridayObservabilityOverview {
  traces: FridayObservabilityTraceSummaryStats;
  audit: FridayObservabilityAuditSummaryStats;
  alerts: FridayObservabilityAlertSummaryStats;
  health: FridayObservabilitySystemHealth | null;
  generatedAt: string;
}

export interface FridayObservabilityTimeSeriesPoint {
  timestamp: string;
  value: number;
}

export interface FridayObservabilityTimeSeriesResult {
  metricName: string;
  points: FridayObservabilityTimeSeriesPoint[];
  bucketSize: FridayObservabilityBucketSize;
  startTime: string;
  endTime: string;
}

export interface FridayObservabilityTraceSummary {
  traceId: string;
  name: string;
  rootSpanId: string;
  status: FridayObservabilitySpanStatus;
  durationMs: number;
  spanCount: number;
  module: FridayObservabilityModule;
  workflowId?: string;
  runId?: string;
  principalId?: string;
  startedAt: string;
  endedAt?: string;
}

export interface FridayObservabilityAuditEntrySummary {
  id: string;
  sequenceNumber: number;
  actorDisplayName: string;
  actorType: string;
  actorId: string;
  actionCategory: FridayObservabilityAuditActionCategory;
  action: string;
  resourceType: string;
  resourceId: string;
  resourceDisplayName?: string;
  outcome: FridayObservabilityAuditOutcome;
  description: string;
  module: FridayObservabilityModule;
  traceId?: string;
  recordedAt: string;
}

export interface FridayObservabilityAlertSummary {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: FridayObservabilityAlertSeverity;
  status: FridayObservabilityAlertStatus;
  summary: string;
  module: FridayObservabilityModule;
  sloId?: string;
  detectedAt: string;
  firedAt?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  notifiedChannelCount: number;
  currentEscalationTier: number;
}

export type FridayObservabilitySloStatus = "healthy" | "warning" | "breached";

export interface FridayObservabilityErrorBudget {
  sloId: string;
  totalBudgetPercent: number;
  remainingBudgetPercent: number;
  consumedPercent: number;
  exhausted: boolean;
  currentValue: number;
  windowStart: string;
  windowEnd: string;
  computedAt: string;
}

export interface FridayObservabilityBurnRate {
  sloId: string;
  windowLabel: string;
  windowMinutes: number;
  rate: number;
  errorRateInWindow: number;
  errorBudgetRate: number;
  exceedsThreshold: boolean;
  threshold: number;
  computedAt: string;
}

export interface FridayObservabilitySloSummary {
  id: string;
  name: string;
  sliMetricName: string;
  target: number;
  status: FridayObservabilitySloStatus;
  enabled: boolean;
  currentValue?: number;
  budgetConsumedPercent?: number;
  budgetExhausted?: boolean;
  complianceWindowDays: number;
  updatedAt: string;
}

export interface FridayObservabilitySliMetric {
  name: string;
  displayName: string;
  description: string;
  type: string;
  unit: string;
  module: FridayObservabilityModule;
}

export interface FridayObservabilitySloDefinition {
  id: string;
  name: string;
  description: string;
  sliMetric: FridayObservabilitySliMetric;
  target: number;
  complianceWindowDays: number;
  status: FridayObservabilitySloStatus;
  enabled: boolean;
  tags: string[];
  alertRuleIds: string[];
  errorBudget?: FridayObservabilityErrorBudget;
  burnRates: FridayObservabilityBurnRate[];
  etag: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayGetObservabilitySloResponse {
  slo: FridayObservabilitySloDefinition;
  errorBudget: FridayObservabilityErrorBudget | null;
  burnRates: FridayObservabilityBurnRate[];
}

export type FridayAlertDestinationType = "slack" | "email";

export type FridayObservabilityAlertDestination =
  | {
    id: string;
    name: string;
    type: "slack";
    enabled: boolean;
    channel?: string;
    webhookConfigured: boolean;
    createdAt: string;
    updatedAt: string;
  }
  | {
    id: string;
    name: string;
    type: "email";
    enabled: boolean;
    recipients: string[];
    fromAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    username?: string;
    passwordConfigured: boolean;
    createdAt: string;
    updatedAt: string;
  };

export interface FridayListObservabilitySlosResponse
  extends FridayObservabilityPage<FridayObservabilitySloSummary> {}

export interface FridayListObservabilityAlertDestinationsResponse
  extends FridayObservabilityPage<FridayObservabilityAlertDestination> {}

export type FridayCreateObservabilityAlertDestinationRequest =
  | {
    type: "slack";
    name: string;
    enabled?: boolean;
    channel?: string;
    webhookUrl: string;
  }
  | {
    type: "email";
    name: string;
    enabled?: boolean;
    recipients: string[];
    fromAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure?: boolean;
    username?: string;
    password: string;
  };

export type FridayUpdateObservabilityAlertDestinationRequest =
  | {
    type?: "slack";
    name?: string;
    enabled?: boolean;
    channel?: string | null;
    webhookUrl?: string;
  }
  | {
    type?: "email";
    name?: string;
    enabled?: boolean;
    recipients?: string[];
    fromAddress?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    username?: string | null;
    password?: string;
  };

export interface FridayObservabilityAlertDispatchAttemptSummary {
  attemptId: string;
  destinationId: string;
  destinationType: FridayAlertDestinationType;
  status: "sent" | "failed" | "skipped";
  attemptNumber: number;
  dedupeKey: string;
  errorMessage?: string;
  sentAt?: string;
}

export interface FridayTestObservabilityAlertDispatchResponse {
  alertId: string;
  attempts: FridayObservabilityAlertDispatchAttemptSummary[];
}

export interface FridayObservabilityPage<TItem> {
  items: TItem[];
  nextCursor?: string;
}

export interface FridayGetObservabilityOverviewResponse {
  overview: FridayObservabilityOverview;
}

export interface FridayGetObservabilityTimeSeriesResponse {
  series: FridayObservabilityTimeSeriesResult;
}

export interface FridaySearchObservabilityTracesResponse
  extends FridayObservabilityPage<FridayObservabilityTraceSummary> {}

export interface FridaySearchObservabilityAuditResponse
  extends FridayObservabilityPage<FridayObservabilityAuditEntrySummary> {}

export interface FridayListObservabilityAlertsResponse
  extends FridayObservabilityPage<FridayObservabilityAlertSummary> {}

export interface FridayAcceptanceTestSummary {
  id: string;
  name: string;
  artifactType: string;
  enabled: boolean;
  priority: number;
  version: number;
  updatedAt: string;
  deletedAt?: string;
}

export interface FridayAcceptanceRunSummary {
  id: string;
  executionId: string;
  artifactUri: string;
  artifactType: string;
  overallVerdict: string;
  overallSeverity: string;
  state: string;
  checksTotal: number;
  checksFailed: number;
  checksWarned: number;
  durationMs: number;
  createdAt: string;
}

export interface FridayListAcceptanceTestsResponse {
  items: FridayAcceptanceTestSummary[];
  total: number;
}

export interface FridayListAcceptanceResultsResponse {
  items: FridayAcceptanceRunSummary[];
  total: number;
}

export interface FridayRetryEscalationSummary {
  id: string;
  traceId: string;
  target: string;
  channel: string;
  reason: string;
  failureCategory: string;
  attemptCount: number;
  totalCost: {
    tokens: number;
    apiCalls: number;
    computeMs: number;
  };
  acknowledged: boolean;
  escalatedAt: string;
  acknowledgedAt?: string;
}

export interface FridayRetryCircuitBreakerSummary {
  targetId: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  failureThreshold: number;
  lastOpenedAt?: string;
  tripCount: number;
  updatedAt: string;
}

export interface FridayRetryCostSummaryResponse {
  summary: {
    totalCost: {
      tokens: number;
      apiCalls: number;
      computeMs: number;
    };
    budgetExceeded: boolean;
    recordCount: number;
  };
  byCategory: Array<{
    category: string;
    totalCost: {
      tokens: number;
      apiCalls: number;
      computeMs: number;
    };
    totalAttempts: number;
    resolved: number;
    escalated: number;
  }>;
}

export interface FridayListRetryEscalationsResponse {
  items: FridayRetryEscalationSummary[];
  total: number;
}

export interface FridayListRetryCircuitBreakersResponse {
  items: FridayRetryCircuitBreakerSummary[];
}

export interface FridayRulesAuditLogEntry {
  id: string;
  ruleId?: string;
  policyBundleId?: string;
  decision: string;
  resource: string;
  action: string;
  redactionApplied: boolean;
  redactedFields: string[];
  durationMs: number;
  runId?: string;
  workflowId?: string;
  principalId?: string;
  createdAt: string;
}

export interface FridayListRulesAuditLogResponse {
  items: FridayRulesAuditLogEntry[];
  total: number;
}
