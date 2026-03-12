// ─── NodeRunner Domain Model ───

export {
  FRIDAY_NODE_RUNNER_STEP_ORDER,
  FRIDAY_NODE_RUNNER_TRANSITIONS,
} from "./friday-node-runner.types.js";

export type {
  // Pipeline step identifiers
  FridayNodeRunnerStepName,

  // Execution status (state machine)
  FridayNodeExecutionStatus,
  FridayNodeRunnerStateTransition,

  // Step result
  FridayNodeRunnerStepOutcome,
  FridayNodeRunnerStepResult,

  // Validation
  FridayValidationError,
  FridayValidationResult,

  // Execution context
  FridayNodeExecutionContext,
  FridayNodeArtifact,

  // Execution result
  FridayNodeExecutionResult,

  // Node adapter
  FridayNodeAdapter,
  FridayNodeAdapterRegistry,

  // Pipeline
  FridayNodeRunnerPipeline,
  FridayNodeRunnerPipelineConfig,

  // Persistence row types
  FridayNodeExecutionLogRow,
  FridayNodeExecutionStepLogRow,
} from "./friday-node-runner.types.js";
