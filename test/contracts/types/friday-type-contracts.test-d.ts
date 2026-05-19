/**
 * MECHANISM-4 — Type Contract Tests (Compile-Time)
 *
 * These are purely compile-time assertions using vitest's `expectTypeOf`.
 * If any type union changes (members added/removed/renamed), the test
 * will fail at typecheck time — surfacing the diff in CI.
 *
 * Run: npm run test:contracts:types
 */

import { expectTypeOf } from "vitest";

// ─── Workflow types ────────────────────────────────────────────────────────

import type { WorkflowRunStatus } from "../../../src/workflows/model/friday-workflow.types.js";
import type {
  FridayWorkflowStatus,
  FridayWorkflowRunStatus,
  FridayWorkflowNodeStatus,
} from "../../../src/workflows/model/friday-workflow-engine.types.js";

// ─── Agent types ───────────────────────────────────────────────────────────

import type { FridayAgentRunStatus } from "../../../src/agent/model/friday-agent.types.js";
import type { FridaySubagentRunStatus } from "../../../src/agent/subagent/friday-subagent.types.js";

// ─── API types ─────────────────────────────────────────────────────────────

import type { FridayApiErrorCode } from "../../../src/api/model/friday-api-error-codes.js";
import type { FridayHttpMethod } from "../../../src/api/model/friday-api-common.types.js";
import type {
  FridayRole,
  FridayScope,
  FridayTokenKind,
} from "../../../src/api/model/friday-api-auth.types.js";
import type {
  FridayAlertDestinationSummary,
  FridayCreateAlertDestinationRequest,
  FridayListAlertDestinationsResponse,
} from "../../../src/api/index.js";

// ─── Session types ─────────────────────────────────────────────────────────

import type {
  FridaySessionStatus,
  FridaySessionRole,
} from "../../../src/sessions/model/friday-session.types.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// §1 — Workflow Model Contracts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// WorkflowRunStatus (from friday-workflow.types.ts — the core engine status)
expectTypeOf<WorkflowRunStatus>().toEqualTypeOf<
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "compensating"
  | "completed"
  | "failed"
  | "cancelled"
>();

// FridayWorkflowStatus (lifecycle status for workflow entities)
expectTypeOf<FridayWorkflowStatus>().toEqualTypeOf<
  "draft" | "published" | "archived"
>();

// FridayWorkflowRunStatus (API-facing run status)
expectTypeOf<FridayWorkflowRunStatus>().toEqualTypeOf<
  "pending" | "running" | "paused" | "completed" | "failed" | "cancelled"
>();

// FridayWorkflowNodeStatus (node-level execution status)
expectTypeOf<FridayWorkflowNodeStatus>().toEqualTypeOf<
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "cancelled"
  | "retrying"
>();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// §2 — Agent Model Contracts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// FridayAgentRunStatus
expectTypeOf<FridayAgentRunStatus>().toEqualTypeOf<
  | "pending"
  | "planning"
  | "executing"
  | "testing"
  | "fixing"
  | "completed"
  | "failed"
  | "failed_tests"
  | "cancelled"
>();

// FridaySubagentRunStatus
expectTypeOf<FridaySubagentRunStatus>().toEqualTypeOf<
  "pending" | "running" | "completed" | "failed" | "cancelled"
>();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// §3 — API Model Contracts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// FridayApiErrorCode
expectTypeOf<FridayApiErrorCode>().toEqualTypeOf<
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_JSON"
  | "INVALID_PATH"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR"
  | "UNKNOWN_ERROR"
>();

// FridayHttpMethod
expectTypeOf<FridayHttpMethod>().toEqualTypeOf<
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
>();

expectTypeOf<FridayListAlertDestinationsResponse["items"][number]>().toEqualTypeOf<FridayAlertDestinationSummary>();
expectTypeOf<FridayCreateAlertDestinationRequest>().toMatchTypeOf<
  | { type: "slack"; name: string; webhookUrl: string }
  | { type: "email"; name: string; recipients: string[]; fromAddress: string; smtpHost: string; smtpPort: number; password: string }
>();

// FridayRole
expectTypeOf<FridayRole>().toEqualTypeOf<
  "owner" | "admin" | "operator" | "viewer"
>();

// FridayScope
expectTypeOf<FridayScope>().toEqualTypeOf<
  | "hub.admin"
  | "workflow.read"
  | "workflow.write"
  | "workflow.run"
  | "workflow.conflict.resolve"
  | "satellite.read"
  | "satellite.write"
  | "fleet.read"
  | "security.read"
  | "security.write"
  | "session.read"
  | "session.write"
  | "diagnosis.read"
  | "diagnosis.write"
  | "skill.read"
  | "skill.write"
  | "plugin.read"
  | "plugin.write"
  | "plugin.install"
>();

// FridayTokenKind
expectTypeOf<FridayTokenKind>().toEqualTypeOf<
  "access" | "refresh" | "api" | "satellite"
>();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// §4 — Session Model Contracts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// FridaySessionStatus
expectTypeOf<FridaySessionStatus>().toEqualTypeOf<
  "active" | "idle" | "archived" | "pruned"
>();

// FridaySessionRole
expectTypeOf<FridaySessionRole>().toEqualTypeOf<
  "system" | "user" | "assistant" | "tool"
>();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// §5 — Module Alias Import Contracts (#rules, #node-runner, #acceptance,
//       #retry, #playbook)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── #rules alias ─────────────────────────────────────────────────────────

import type {
  FridayRulesErrorCode,
  FridayRuleDecision,
  FridayRule,
  FridayPolicyBundle,
  FridayEvaluationResult,
} from "#rules";

import {
  FRIDAY_RULES_ERROR_CODES,
  FRIDAY_RULE_DECISION_PRIORITY,
  FridayRuleEngine,
  FridayPolicyBundleManager,
} from "#rules";

expectTypeOf(FRIDAY_RULES_ERROR_CODES).toBeObject();
expectTypeOf(FRIDAY_RULE_DECISION_PRIORITY).toBeObject();
expectTypeOf(FridayRuleEngine).toBeFunction();
expectTypeOf(FridayPolicyBundleManager).toBeFunction();

// ─── #node-runner alias ───────────────────────────────────────────────────

import type {
  FridayNodeRunnerErrorCode,
  FridayNodeExecutionStatus,
  FridayNodeRunnerStepName,
  FridayNodeAdapter,
  FridayNodeExecutionResult,
} from "#node-runner";

import {
  FRIDAY_NODE_RUNNER_ERROR_CODES,
  FRIDAY_NODE_RUNNER_STEP_ORDER,
  FRIDAY_NODE_RUNNER_TRANSITIONS,
  NodeRunnerPipeline,
  NodeAdapterRegistry,
} from "#node-runner";

expectTypeOf(FRIDAY_NODE_RUNNER_ERROR_CODES).toBeObject();
expectTypeOf(FRIDAY_NODE_RUNNER_STEP_ORDER).toBeArray();
expectTypeOf(FRIDAY_NODE_RUNNER_TRANSITIONS).toBeObject();
expectTypeOf(NodeRunnerPipeline).toBeFunction();
expectTypeOf(NodeAdapterRegistry).toBeFunction();

// ─── #acceptance alias ────────────────────────────────────────────────────

import type {
  FridayAcceptanceErrorCode,
  FridayAcceptanceCheckType,
  FridayAcceptanceVerdictOutcome,
  FridayAcceptanceTest,
  FridayAcceptanceRunResult,
} from "#acceptance";

import {
  FRIDAY_ACCEPTANCE_ERROR_CODES,
  FRIDAY_ACCEPTANCE_VERDICT_PRIORITY,
  FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY,
  AcceptanceTestSuiteRunner,
  AcceptanceCoverageTracker,
} from "#acceptance";

expectTypeOf(FRIDAY_ACCEPTANCE_ERROR_CODES).toBeObject();
expectTypeOf(FRIDAY_ACCEPTANCE_VERDICT_PRIORITY).toBeObject();
expectTypeOf(FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY).toBeObject();
expectTypeOf(AcceptanceTestSuiteRunner).toBeFunction();
expectTypeOf(AcceptanceCoverageTracker).toBeFunction();

// ─── #retry alias ─────────────────────────────────────────────────────────

import type {
  FridayRetryErrorCode,
  FridayFailureCategory,
  FridayRetryStrategy,
  FridayRetryDecision,
  FridayRetryTrace,
} from "#retry";

import {
  FRIDAY_RETRY_ERROR_CODES,
  FRIDAY_FAILURE_CATEGORY_PRIORITY,
  RetryOrchestrator,
  createRetryOrchestrator,
  createCircuitBreakerManager,
} from "#retry";

expectTypeOf(FRIDAY_RETRY_ERROR_CODES).toBeObject();
expectTypeOf(FRIDAY_FAILURE_CATEGORY_PRIORITY).toBeObject();
expectTypeOf(RetryOrchestrator).toBeFunction();
expectTypeOf(createRetryOrchestrator).toBeFunction();
expectTypeOf(createCircuitBreakerManager).toBeFunction();

// ─── #playbook alias ─────────────────────────────────────────────────────

import type {
  FridayPlaybookErrorCode,
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPromotionDecision,
  FridayPlaybookScore,
} from "#playbook";

import {
  FRIDAY_PLAYBOOK_ERROR_CODES,
  FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS,
  FRIDAY_PLAYBOOK_SCORE_DECAY_RATE,
  createPlaybookStore,
  createLearningEngine,
  createPlaybookMatcher,
} from "#playbook";

expectTypeOf(FRIDAY_PLAYBOOK_ERROR_CODES).toBeObject();
expectTypeOf(FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS).toBeObject();
expectTypeOf(FRIDAY_PLAYBOOK_SCORE_DECAY_RATE).toBeNumber();
expectTypeOf(createPlaybookStore).toBeFunction();
expectTypeOf(createLearningEngine).toBeFunction();
expectTypeOf(createPlaybookMatcher).toBeFunction();
