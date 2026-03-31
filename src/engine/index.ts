/**
 * Engine module — unified orchestration engine (Initiative A).
 */

// Types
export type {
  FridayEngineRunInput,
  FridayEngineRunResult,
  FridayRunTerminalStatus,
  FridayRunErrorCategory,
  FridayRunError,
  FridayOrchestrationEngine,
} from "./friday-orchestration-engine.types.js";

// Concrete engine
export { createFridayOrchestrationEngine } from "./friday-orchestration-engine.js";
export type { CreateFridayOrchestrationEngineDeps } from "./friday-orchestration-engine.js";

// Turn preparer
export { createFridayEngineTurnPreparer } from "./friday-engine-turn-preparer.js";
export type {
  FridayPreparedEngineContext,
  FridayTurnPreparerInput,
  CreateFridayEngineTurnPreparerDeps,
  FridayEngineTurnPreparerSessionDeps,
  FridayExecutionCategory,
  FridayExecutionClassification,
} from "./friday-engine-turn-preparer.js";

// Run executor
export { createFridayEngineRunExecutor } from "./friday-engine-run-executor.js";
export type {
  CreateFridayEngineRunExecutorDeps,
  FridayEngineRunExecutorAgentRuntime,
  FridayEnginePlanningGate,
} from "./friday-engine-run-executor.js";

// Entry adapters
export { createFridayApiEntryAdapter } from "./adapters/friday-api-entry-adapter.js";
export type {
  FridayApiSessionRunRequest,
  FridayApiSessionRunResponse,
} from "./adapters/friday-api-entry-adapter.js";

export { createFridayChannelEntryAdapter } from "./adapters/friday-channel-entry-adapter.js";
export type {
  FridayChannelInboundMessage,
} from "./adapters/friday-channel-entry-adapter.js";

// Run resume
export { createFridayEngineRunResume } from "./friday-engine-run-resume.js";
export type {
  FridayEngineResumeResult,
  FridayEngineRunRecordReader,
  FridayEngineRunEventReader,
} from "./friday-engine-run-resume.js";

// Guards (Initiative F)
export { createFridayBudgetGuard } from "./guards/friday-engine-budget-guard.js";
export type {
  FridayBudgetPolicy,
  FridayBudgetCheckResult,
  FridayBudgetUsage,
  FridayBudgetGuard,
} from "./guards/friday-engine-budget-guard.js";

export { createFridayContentGuard } from "./guards/friday-engine-content-guard.js";
export type {
  FridayContentGuardResult,
  FridayContentGuardMode,
  FridayContentGuardOptions,
  FridayContentGuard,
} from "./guards/friday-engine-content-guard.js";
