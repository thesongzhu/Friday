export type {
  FridayShellRunOptions,
  FridayShellRunResult,
  FridayShellExecutor,
  FridaySkillAiHelperContext,
  FridaySkillReadonlyBrowserInspectOptions,
  FridaySkillReadonlyBrowserInspection,
  FridaySkillReadonlyBrowserContext,
  FridayNodeRunOptions,
  FridayNodeRunResult,
  FridayNodeExecutor,
  FridaySkillExecuteRequest,
  FridaySkillExecuteStatus,
  FridaySkillExecuteResult,
  FridaySkillExecuteHandle,
  FridaySkillExecutor,
  CreateFridaySkillExecutorDeps,
  FridayProviderServiceLike,
} from "./friday-skill-executor.types.js";
export { createFridayShellExecutor } from "./friday-shell-executor.js";
export {
  createFridayNodeExecutor,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
} from "./friday-node-executor.js";
export {
  FRIDAY_SKILL_PYTHON_BIN_ENV,
  getFridayPythonRuntimeUnavailableMessage,
  probeFridayExecutable,
  resolveFridayPythonCommand,
} from "./friday-runtime-probe.js";
export type {
  EvaluateFridaySkillExecutionReadinessInput,
  FridaySkillExecutionReadiness,
  FridaySkillExecutionReadinessRequirements,
} from "./friday-skill-execution-readiness.js";
export {
  evaluateFridaySkillExecutionReadiness,
  getFridayLocalSkillExecutionContext,
} from "./friday-skill-execution-readiness.js";
export { createFridaySkillExecutor } from "./friday-skill-executor.js";

// ─── Desktop Helper (C-002) ───
export { createFridaySkillDesktopHelper } from "./friday-skill-desktop-helper.js";
export type {
  FridaySkillDesktopHelperContext,
  CreateFridaySkillDesktopHelperOptions,
} from "./friday-skill-desktop-helper.js";
