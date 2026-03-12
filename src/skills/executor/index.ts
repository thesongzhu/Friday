export type {
  FridayShellRunOptions,
  FridayShellRunResult,
  FridayShellExecutor,
  FridaySkillAiHelperContext,
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
export { createFridayNodeExecutor } from "./friday-node-executor.js";
export { createFridaySkillExecutor } from "./friday-skill-executor.js";

// ─── Desktop Helper (C-002) ───
export { createFridaySkillDesktopHelper } from "./friday-skill-desktop-helper.js";
export type {
  FridaySkillDesktopHelperContext,
  CreateFridaySkillDesktopHelperOptions,
} from "./friday-skill-desktop-helper.js";
