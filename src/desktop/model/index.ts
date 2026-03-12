// ─── Desktop Control Runtime Domain Model ───

export {
  FRIDAY_DESKTOP_PLATFORMS,
  FRIDAY_DESKTOP_CAPABILITIES,
  FRIDAY_DESKTOP_SELECTOR_STRATEGIES,
  FRIDAY_DESKTOP_ACTION_TYPES,
  FRIDAY_DESKTOP_MOUSE_BUTTONS,
  FRIDAY_DESKTOP_MODIFIER_KEYS,
  FRIDAY_DESKTOP_CLICK_TYPES,
  FRIDAY_DESKTOP_SCROLL_DIRECTIONS,
  FRIDAY_DESKTOP_SCREENSHOT_FORMATS,
  FRIDAY_DESKTOP_CLIPBOARD_OPERATIONS,
  FRIDAY_DESKTOP_FILE_OPERATIONS,
  FRIDAY_DESKTOP_ERROR_CODES,
  FRIDAY_DESKTOP_ACTION_STATUSES,
  FRIDAY_DESKTOP_RECORDING_STATES,
  FRIDAY_DESKTOP_RECORDING_STATE_TRANSITIONS,
  FRIDAY_DESKTOP_PARAMETER_TYPES,
  FRIDAY_DESKTOP_RISK_LEVELS,
  FRIDAY_DESKTOP_POLICY_DECISIONS,
  FRIDAY_DESKTOP_OS_PERMISSION_TYPES,
  FRIDAY_DESKTOP_OS_PERMISSION_STATUSES,
  FRIDAY_DESKTOP_PERMISSION_DECISION_VALUES,
  FRIDAY_DESKTOP_PERMISSION_HUMAN_DECISIONS,
  FRIDAY_DESKTOP_ENGINE_DEFAULTS,
} from "./friday-desktop.types.js";

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // Observability bridge
  FridayDesktopSpanAttributes,

  // Rules Engine bridge
  FridayDesktopRuleAction,
  FridayDesktopRuleEvaluationContext,

  // Error codes
  FridayDesktopErrorCode,

  // Platform adapters
  FridayDesktopPlatform,
  FridayDesktopCapability,
  FridayDesktopAdapter,
  FridayDesktopAdapterRuntime,

  // Target elements
  FridayDesktopSelectorStrategy,
  FridayDesktopElementSelector,
  FridayDesktopElement,
  FridayDesktopBounds,

  // Action types
  FridayDesktopActionType,
  FridayDesktopMouseButton,
  FridayDesktopModifierKey,
  FridayDesktopClickType,
  FridayDesktopScrollDirection,
  FridayDesktopScreenshotFormat,
  FridayDesktopClipboardOperation,
  FridayDesktopFileOperation,

  // Action variants
  FridayDesktopClickAction,
  FridayDesktopTypeAction,
  FridayDesktopKeypressAction,
  FridayDesktopScrollAction,
  FridayDesktopDragAction,
  FridayDesktopScreenshotAction,
  FridayDesktopReadElementAction,
  FridayDesktopLaunchAppAction,
  FridayDesktopCloseAppAction,
  FridayDesktopClipboardAction,
  FridayDesktopClipboardWriteAction,
  FridayDesktopClipboardReadAction,
  FridayDesktopClipboardClearAction,
  FridayDesktopFileOperationAction,
  FridayDesktopFileReadAction,
  FridayDesktopFileWriteAction,
  FridayDesktopFileMoveAction,
  FridayDesktopFileCopyAction,
  FridayDesktopFileDeleteAction,
  FridayDesktopFileListAction,
  FridayDesktopFileStatAction,
  FridayDesktopAction,

  // Action execution
  FridayDesktopActionStatus,
  FridayDesktopActionResult,
  FridayDesktopFileEntry,

  // Recording
  FridayDesktopRecordingState,
  FridayDesktopParameterType,
  FridayDesktopRecordingParameterEntry,
  FridayDesktopRecordingParameterMap,
  FridayDesktopRecordingStep,
  FridayDesktopRecording,

  // Policy
  FridayDesktopRiskLevel,
  FridayDesktopPolicyDecision,
  FridayDesktopPolicyRule,
  FridayDesktopPolicy,

  // Permissions
  FridayDesktopOsPermissionType,
  FridayDesktopOsPermissionStatus,
  FridayDesktopPermission,
  FridayDesktopPermissionDecisionValue,
  FridayDesktopPermissionHumanDecision,
  FridayDesktopPermissionPrompt,
  FridayDesktopPermissionDecision,

  // Engine configuration
  FridayDesktopEngineConfig,

  // Persistence row types
  FridayDesktopRecordingRow,
  FridayDesktopRecordingStepRow,
  FridayDesktopPolicyRow,
  FridayDesktopPolicyRuleRow,
  FridayDesktopPermissionDecisionRow,
  FridayDesktopActionLogRow,
  FridayDesktopRowMapper,
} from "./friday-desktop.types.js";
