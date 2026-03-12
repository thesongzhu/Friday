// ─── Acceptance Testing Domain Model ───

export {
  FRIDAY_ACCEPTANCE_VERDICT_PRIORITY,
  FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY,
  AcceptanceRunState,
  ACCEPTANCE_RUN_STATE_TRANSITIONS,
  canTransitionAcceptanceRunState,
  assertAcceptanceRunStateTransition,
} from "./friday-acceptance.types.js";

export type {
  // Artifact types
  FridayAcceptanceArtifactType,

  // Check types
  FridayAcceptanceCheckType,

  // Check configuration
  FridayAcceptanceSchemaCheckConfig,
  FridayAcceptanceQuantOperator,
  FridayAcceptanceQuantCheckConfig,
  FridayAcceptanceQualityDimension,
  FridayAcceptanceQualityCheckConfig,
  FridayAcceptanceCustomCheckConfig,
  FridayAcceptanceCheckConfig,

  // Verdict
  FridayAcceptanceVerdictOutcome,
  FridayAcceptanceSeverity,

  // Evidence
  FridayAcceptanceEvidence,
  FridayAcceptanceVerdict,

  // Check result
  FridayAcceptanceCheck,
  FridayExecutedAcceptanceCheck,
  FridaySkippedAcceptanceCheck,

  // Run state machine
  AcceptanceRunTransitionReason,
  FridayAcceptanceRunStateTransition,
  FridayAcceptanceRollbackEvent,

  // Acceptance test
  FridayAcceptanceTest,

  // Registry
  FridayAcceptanceTestRegistry,

  // Run result
  FridayAcceptanceRunResult,

  // Pipeline integration
  FridayAcceptancePipelineContext,
  FridayAcceptancePipelineResult,

  // Persistence row types
  FridayAcceptanceTestRow,
  FridayAcceptanceTestVersion,
  FridayAcceptanceTestVersionRow,
  FridayAcceptanceRunRow,
  FridayAcceptanceCheckResultRow,
} from "./friday-acceptance.types.js";
