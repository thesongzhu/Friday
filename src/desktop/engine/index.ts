// ─── Desktop Control Runtime — Core Engine ───

// Adapter Manager
export { createAdapterManager } from "./adapter-manager.js";

export type {
  AdapterManager,
  AdapterManagerConfig,
} from "./adapter-manager.js";

// Permission Guard
export { createPermissionGuard } from "./permission-guard.js";

export type {
  PermissionGuard,
  PermissionGuardConfig,
  PermissionCheckResult,
  PermissionPromptResolver,
} from "./permission-guard.js";

// Element Inspector
export { createElementInspector } from "./element-inspector.js";

export type {
  ElementInspector,
  ElementInspectorConfig,
  ElementInspectionResult,
} from "./element-inspector.js";

// Action Executor
export { createActionExecutor } from "./action-executor.js";

export type {
  ActionExecutor,
  ActionExecutorConfig,
  ExecuteActionOptions,
} from "./action-executor.js";

// Recording Engine
export { createRecordingEngine } from "./recording-engine.js";

export type {
  RecordingEngine,
  RecordingEngineConfig,
  StartRecordingOptions,
  ReplayOptions,
  ReplayStepResult,
  ReplayResult,
  ReplayActionExecutor,
} from "./recording-engine.js";

// Session Manager
export { createDesktopSessionManager } from "./session-manager.js";

export type {
  DesktopSessionManager,
  DesktopSessionState,
  DesktopSessionInfo,
  SessionManagerConfig,
} from "./session-manager.js";

// Platform Adapters (C-001)
export {
  createDarwinAdapter,
  createWin32Adapter,
  createLinuxAdapter,
  createPlatformAdapter,
  checkAdapterHealth,
} from "./friday-desktop-adapters.js";

export type {
  DesktopAdapterConfig,
  ExecResult,
  AdapterHealthCheck,
} from "./friday-desktop-adapters.js";
