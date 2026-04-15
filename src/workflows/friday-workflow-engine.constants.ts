// ─── Workflow Engine Constants ───

export const FRIDAY_WORKFLOW_TRIGGER_TYPES = {
  CRON: "cron",
  WEBHOOK: "webhook",
  EVENT: "event",
} as const;

export const FRIDAY_WORKFLOW_NODE_TYPES = {
  TRIGGER: "trigger",
  ACTION: "action",
  CONDITION: "condition",
  TRANSFORM: "transform",
  APPROVAL: "approval",
  DATA: "data",
  AI: "ai",
} as const;

export const FRIDAY_WORKFLOW_ACTION_TYPES = {
  SKILL: "skill",
  AI_COMPLETION: "ai_completion",
  HTTP_REQUEST: "http_request",
} as const;

export const FRIDAY_WORKFLOW_RUN_STATUSES = {
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export const FRIDAY_WORKFLOW_NODE_STATUSES = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  WAITING_APPROVAL: "waiting_approval",
  CANCELLED: "cancelled",
  RETRYING: "retrying",
} as const;

export const FRIDAY_WORKFLOW_DEFAULT_NODE_TIMEOUT_MS = 300_000;
export const FRIDAY_WORKFLOW_DEFAULT_RUN_TIMEOUT_MS = 3_600_000;
export const FRIDAY_WORKFLOW_APPROVAL_DEFAULT_TIMEOUT_MS = 86_400_000;
export const FRIDAY_WORKFLOW_WEBHOOK_PATH_TOKEN_BYTES = 24;

export const FRIDAY_WORKFLOW_BUILTIN_SKILL_AI_COMPLETION = "friday.builtin.ai-completion";
export const FRIDAY_WORKFLOW_BUILTIN_SKILL_HTTP_REQUEST = "friday.builtin.http-request";
