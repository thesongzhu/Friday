import { FridayDomainError } from "#errors";

/**
 * Permission Guard — Multi-layer permission checking for desktop actions.
 *
 * Implements the three-layer permission stack described in the RFC:
 * 1. OS Permissions — checks adapter-reported OS permission status
 * 2. Friday Policy — evaluates action against loaded policy rules
 * 3. Human Confirmation — prompts for high-risk / critical actions
 *
 * The guard emits permission prompts and records decisions. Policy evaluation
 * is performed in-memory against loaded policy rules; Rules Engine delegation
 * is modelled as a callback for loose coupling.
 *
 * @module desktop/engine/permission-guard
 */

import type {
  FridayDesktopAction,
  FridayDesktopActionType,
  FridayDesktopAdapterRuntime,
  FridayDesktopCapability,
  FridayDesktopEngineConfig,
  FridayDesktopErrorCode,
  FridayDesktopPermission,
  FridayDesktopPermissionDecision,
  FridayDesktopPermissionDecisionValue,
  FridayDesktopPermissionHumanDecision,
  FridayDesktopPermissionPrompt,
  FridayDesktopPolicy,
  FridayDesktopPolicyDecision,
  FridayDesktopPolicyRule,
  FridayDesktopRiskLevel,
  FridayDesktopRuleEvaluationContext,
  ISODateTime,
  UUID,
} from "../model/friday-desktop.types.js";

import {
  FRIDAY_DESKTOP_ERROR_CODES,
  FRIDAY_DESKTOP_RISK_LEVELS,
} from "../model/friday-desktop.types.js";

// ─── Public Types ───

/** Result of the full permission evaluation pipeline. */
export interface PermissionCheckResult {
  /** Whether the action is allowed to proceed. */
  readonly allowed: boolean;
  /** The denial reason code (if not allowed). */
  readonly denialCode?: FridayDesktopErrorCode;
  /** Human-readable denial message. */
  readonly denialMessage?: string;
  /** Matched policy rule (if any). */
  readonly matchedRule?: FridayDesktopPolicyRule;
  /** Risk level determined by policy evaluation. */
  readonly riskLevel: FridayDesktopRiskLevel;
  /** Policy decision (if a rule matched). */
  readonly policyDecision?: FridayDesktopPolicyDecision;
  /** Permission prompt emitted (if human confirmation was needed). */
  readonly prompt?: FridayDesktopPermissionPrompt;
  /** Permission decision recorded (if human responded). */
  readonly decision?: FridayDesktopPermissionDecision;
}

/** Callback for resolving human confirmation prompts. */
export type PermissionPromptResolver = (
  prompt: FridayDesktopPermissionPrompt,
) => Promise<{ decision: FridayDesktopPermissionHumanDecision; rationale?: string } | null>;

export interface DesktopPolicyRulesEngineResult {
  readonly decision: FridayDesktopPolicyDecision;
  readonly riskLevel?: FridayDesktopRiskLevel;
  readonly denialMessage?: string;
}

export type DesktopPolicyRulesEngineEvaluator = (
  context: FridayDesktopRuleEvaluationContext,
  rule: FridayDesktopPolicyRule,
) => Promise<DesktopPolicyRulesEngineResult>;

/** Configuration for permission guard creation. */
export interface PermissionGuardConfig {
  readonly generateId: FridayDesktopEngineConfig["generateId"];
  readonly nowIso: FridayDesktopEngineConfig["nowIso"];
  readonly permissionPromptTimeoutMs: number;
  /** Optional callback to resolve human confirmation prompts. */
  readonly promptResolver?: PermissionPromptResolver;
  /** Optional Rules Engine bridge for delegated desktop policy rules. */
  readonly rulesEngineEvaluator?: DesktopPolicyRulesEngineEvaluator;
  /** Principal ID for the current session. */
  readonly principalId: string;
}

/** Permission guard interface. */
export interface PermissionGuard {
  /** Run the full three-layer permission check for an action. */
  check(
    action: FridayDesktopAction,
    adapter: FridayDesktopAdapterRuntime,
  ): Promise<PermissionCheckResult>;

  /** Load policies for evaluation. Replaces any previously loaded policies. */
  loadPolicies(policies: readonly FridayDesktopPolicy[]): void;

  /** Get currently loaded policies. */
  getPolicies(): readonly FridayDesktopPolicy[];

  /** Record a permission decision (for external prompt resolution). */
  recordDecision(decision: FridayDesktopPermissionDecision): void;

  /** Get all recorded decisions. */
  getDecisions(): readonly FridayDesktopPermissionDecision[];
}

// ─── Capability Mapping ───

/**
 * Maps action types to the adapter capability required to execute them.
 * Some actions map to multiple capabilities depending on sub-operation;
 * this map covers the primary capability check.
 */
const ACTION_CAPABILITY_MAP: Readonly<
  Record<Exclude<FridayDesktopActionType, "clipboard" | "file_operation">, FridayDesktopCapability>
> = {
  click: "click",
  type: "type",
  keypress: "keypress",
  scroll: "scroll",
  drag: "drag",
  screenshot: "screenshot",
  read_element: "read_element",
  launch_app: "launch_app",
  close_app: "close_app",
};

const SYSTEM_PERMISSION_PRINCIPAL = "desktop-permission-system";

/** Default risk levels for action types (used when no policy rule matches). */
const DEFAULT_RISK_MAP: Readonly<Record<FridayDesktopActionType, FridayDesktopRiskLevel>> = {
  click: "low",
  type: "medium",
  keypress: "low",
  scroll: "none",
  drag: "low",
  screenshot: "low",
  read_element: "none",
  launch_app: "medium",
  close_app: "high",
  clipboard: "medium",
  file_operation: "high",
};

// ─── Internal Helpers ───

function getActionAppBundleId(action: FridayDesktopAction): string | undefined {
  switch (action.type) {
    case "click":
    case "type":
    case "keypress":
    case "scroll":
    case "read_element":
      return action.selector?.appBundleId;
    case "drag":
      return "from" in action && "strategy" in action.from
        ? (action.from as { appBundleId?: string }).appBundleId
        : undefined;
    case "screenshot":
      return action.selector?.appBundleId;
    case "launch_app":
    case "close_app":
      return action.appIdentifier;
    case "clipboard":
    case "file_operation":
      return undefined;
    default:
      return undefined;
  }
}

function getActionElementDescriptors(action: FridayDesktopAction): readonly string[] {
  const values: string[] = [];
  const addSelector = (selector: { readonly strategy?: string; readonly value?: string; readonly windowTitle?: string } | undefined) => {
    if (!selector) return;
    if (selector.value) {
      values.push(selector.value);
      if (selector.strategy) {
        values.push(`${selector.strategy}:${selector.value}`);
      }
    }
    if (selector.windowTitle) {
      values.push(`window:${selector.windowTitle}`);
    }
  };

  switch (action.type) {
    case "click":
    case "type":
    case "keypress":
    case "scroll":
    case "screenshot":
    case "read_element":
      addSelector(action.selector);
      break;
    case "drag":
      if ("strategy" in action.from) addSelector(action.from);
      if ("strategy" in action.to) addSelector(action.to);
      break;
    case "launch_app":
    case "close_app":
    case "clipboard":
    case "file_operation":
      break;
    default:
      break;
  }

  return values;
}

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

function toFrozenSnapshot<T>(value: T): Readonly<T> {
  return deepFreeze(deepClone(value));
}

function findMatchingRule(
  policies: readonly FridayDesktopPolicy[],
  actionType: FridayDesktopActionType,
  appBundleId?: string,
  elementDescriptors: readonly string[] = [],
): FridayDesktopPolicyRule | undefined {
  const sortedPolicies = [...policies]
    .filter((p) => p.enabled)
    .sort((a, b) => b.priority - a.priority);

  for (const policy of sortedPolicies) {
    const sortedRules = [...policy.rules].sort((a, b) => b.priority - a.priority);
    for (const rule of sortedRules) {
      if (rule.actionType !== actionType) continue;
      if (appBundleId && !matchesGlob(rule.appFilter, appBundleId)) continue;
      if (!appBundleId && rule.appFilter !== "*") continue;
      if (
        rule.elementFilter &&
        rule.elementFilter !== "*" &&
        !elementDescriptors.some((descriptor) => matchesGlob(rule.elementFilter!, descriptor))
      ) {
        continue;
      }
      return rule;
    }
  }

  return undefined;
}

function getActionFilePath(action: FridayDesktopAction): string | undefined {
  return action.type === "file_operation" ? action.path : undefined;
}

function getActionOperationType(action: FridayDesktopAction): string | undefined {
  if (action.type === "file_operation" || action.type === "clipboard") {
    return action.operation;
  }
  return undefined;
}

function buildRulesEngineContext(
  action: FridayDesktopAction,
  adapter: FridayDesktopAdapterRuntime,
  appBundleId: string | undefined,
  riskLevel: FridayDesktopRiskLevel,
  principalId: string,
): FridayDesktopRuleEvaluationContext {
  return {
    resource: "desktop",
    action: action.type,
    args: {
      platform: adapter.metadata.platform,
      ...(appBundleId ? { appBundleId } : {}),
      ...(getActionFilePath(action) ? { filePath: getActionFilePath(action) } : {}),
      ...(getActionOperationType(action) ? { operationType: getActionOperationType(action) } : {}),
      riskLevel,
    },
    source: "agent",
    principalId,
  };
}

function riskRequiresConfirmation(riskLevel: FridayDesktopRiskLevel): boolean {
  return riskLevel === "critical";
}

function assertNever(value: never): never {
  throw new FridayDomainError("INTERNAL_ERROR", `Unhandled desktop action variant: ${JSON.stringify(value)}`, { httpStatus: 500 });
}

function resolveRequiredCapability(action: FridayDesktopAction): FridayDesktopCapability {
  switch (action.type) {
    case "clipboard": {
      switch (action.operation) {
        case "read":
          return "clipboard_read";
        case "write":
        case "clear":
          return "clipboard_write";
        default:
          return assertNever(action);
      }
    }
    case "file_operation": {
      switch (action.operation) {
        case "read":
          return "file_read";
        case "write":
          return "file_write";
        case "move":
          return "file_move";
        case "copy":
          return "file_copy";
        case "delete":
          return "file_delete";
        case "list":
          return "file_list";
        case "stat":
          return "file_stat";
        default:
          return assertNever(action);
      }
    }
    case "click":
    case "type":
    case "keypress":
    case "scroll":
    case "drag":
    case "screenshot":
    case "read_element":
    case "launch_app":
    case "close_app":
      return ACTION_CAPABILITY_MAP[action.type];
    default:
      return assertNever(action);
  }
}

// ─── OS Permission Required Mapping ───

const OS_PERMISSIONS_FOR_CAPABILITY: Readonly<
  Partial<Record<FridayDesktopCapability, string>>
> = {
  click: "accessibility",
  type: "accessibility",
  keypress: "accessibility",
  scroll: "accessibility",
  drag: "accessibility",
  read_element: "accessibility",
  element_search: "accessibility",
  element_tree: "accessibility",
  screenshot: "screen_recording",
  clipboard_read: "automation",
  clipboard_write: "automation",
  file_read: "file_access",
  file_write: "file_access",
  file_move: "file_access",
  file_copy: "file_access",
  file_delete: "file_access",
  file_list: "file_access",
  file_stat: "file_access",
};

// ─── Factory ───

/** Create a permission guard instance. */
export function createPermissionGuard(config: PermissionGuardConfig): PermissionGuard {
  let policies: FridayDesktopPolicy[] = [];
  const decisions: FridayDesktopPermissionDecision[] = [];

  return {
    async check(
      action: FridayDesktopAction,
      adapter: FridayDesktopAdapterRuntime,
    ): Promise<PermissionCheckResult> {
      // Layer 1: OS permissions
      const requiredCapability = resolveRequiredCapability(action);
      const requiredOsPermission = OS_PERMISSIONS_FOR_CAPABILITY[requiredCapability];

      if (requiredOsPermission) {
        const osPermissions = await adapter.checkPermissions();
        const relevantPermission = osPermissions.find(
          (p) => p.permissionType === requiredOsPermission,
        );
        if (relevantPermission && relevantPermission.status === "denied") {
          return {
            allowed: false,
            denialCode: FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_OS,
            denialMessage: relevantPermission.grantInstructions
              ?? `OS permission '${requiredOsPermission}' is denied`,
            riskLevel: DEFAULT_RISK_MAP[action.type],
          };
        }
      }

      // Check adapter capability
      const capabilities = adapter.getCapabilities();
      if (!capabilities.includes(requiredCapability)) {
        return {
          allowed: false,
          denialCode: FRIDAY_DESKTOP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          denialMessage: `Adapter does not support capability '${requiredCapability}'`,
          riskLevel: DEFAULT_RISK_MAP[action.type],
        };
      }

      // Layer 2: Friday policy
      const appBundleId = getActionAppBundleId(action);
      const elementDescriptors = getActionElementDescriptors(action);
      const matchedRule = findMatchingRule(
        policies,
        action.type,
        appBundleId,
        elementDescriptors,
      );

      let riskLevel = matchedRule?.riskLevel ?? DEFAULT_RISK_MAP[action.type];
      let policyDecision = matchedRule?.decision;
      let policyDenialMessage: string | undefined;

      if (matchedRule?.engineDelegate) {
        if (!config.rulesEngineEvaluator) {
          return {
            allowed: false,
            denialCode: FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_POLICY,
            denialMessage: `Policy rule '${matchedRule.id}' requires Rules Engine delegation, but no evaluator is configured`,
            matchedRule,
            riskLevel,
            policyDecision: "deny",
          };
        }

        const engineResult = await config.rulesEngineEvaluator(
          buildRulesEngineContext(action, adapter, appBundleId, riskLevel, config.principalId),
          matchedRule,
        );
        riskLevel = engineResult.riskLevel ?? riskLevel;
        policyDecision = engineResult.decision;
        policyDenialMessage = engineResult.denialMessage;
      }

      if (policyDecision === "deny") {
        return {
          allowed: false,
          denialCode: FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_POLICY,
          denialMessage:
            policyDenialMessage ??
            matchedRule?.description ??
            `Action '${action.type}' denied by policy`,
          matchedRule,
          riskLevel,
          policyDecision,
        };
      }

      // Layer 3: Human confirmation for critical risk
      if (riskRequiresConfirmation(riskLevel)) {
        const now = config.nowIso();
        const expiresAtMs = new Date(now).getTime() + config.permissionPromptTimeoutMs;
        const expiresAt = new Date(expiresAtMs).toISOString();

        const prompt: FridayDesktopPermissionPrompt = {
          id: config.generateId(),
          actionType: action.type,
          action,
          riskLevel,
          appBundleId,
          policyRuleId: matchedRule?.id,
          reason: matchedRule?.description ?? `Action '${action.type}' classified as ${riskLevel} risk`,
          timeoutMs: config.permissionPromptTimeoutMs,
          createdAt: now,
          expiresAt,
        };

        if (config.promptResolver) {
          let response:
            | { decision: FridayDesktopPermissionHumanDecision; rationale?: string }
            | null;
          try {
            response = await config.promptResolver(prompt);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const decision: FridayDesktopPermissionDecision = {
              id: config.generateId(),
              promptId: prompt.id,
              actionType: action.type,
              appBundleId,
              riskLevel,
              decision: "denied",
              decidedBy: SYSTEM_PERMISSION_PRINCIPAL,
              rationale: `Prompt resolver error: ${message}`,
              createdAt: config.nowIso(),
            };
            decisions.push(decision);

            return {
              allowed: false,
              denialCode: FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_USER,
              denialMessage: `Permission prompt resolver failed: ${message}`,
              matchedRule,
              riskLevel,
              policyDecision,
              prompt,
              decision,
            };
          }
          const decisionValue: FridayDesktopPermissionDecisionValue =
            response?.decision ?? "timeout";

          const decision: FridayDesktopPermissionDecision = {
            id: config.generateId(),
            promptId: prompt.id,
            actionType: action.type,
            appBundleId,
            riskLevel,
            decision: decisionValue,
            decidedBy:
              decisionValue === "timeout"
                ? SYSTEM_PERMISSION_PRINCIPAL
                : config.principalId,
            rationale: response?.rationale,
            createdAt: config.nowIso(),
          };

          decisions.push(decision);

          if (decisionValue !== "approved") {
            return {
              allowed: false,
              denialCode:
                decisionValue === "timeout"
                  ? FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_PROMPT_EXPIRED
                  : FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_USER,
              denialMessage:
                decisionValue === "timeout"
                  ? "Permission prompt timed out"
                  : `Action denied by user: ${response?.rationale ?? "no rationale"}`,
              matchedRule,
              riskLevel,
              policyDecision,
              prompt,
              decision,
            };
          }

          return {
            allowed: true,
            matchedRule,
            riskLevel,
            policyDecision,
            prompt,
            decision,
          };
        }

        // No resolver available — deny by default for critical actions
        return {
          allowed: false,
          denialCode: FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_USER,
          denialMessage: "No prompt resolver configured for critical-risk action",
          matchedRule,
          riskLevel,
          policyDecision,
          prompt,
        };
      }

      // Allowed
      return {
        allowed: true,
        matchedRule,
        riskLevel,
        policyDecision,
      };
    },

    loadPolicies(newPolicies: readonly FridayDesktopPolicy[]): void {
      policies = [...newPolicies];
    },

    getPolicies(): readonly FridayDesktopPolicy[] {
      return toFrozenSnapshot(policies);
    },

    recordDecision(decision: FridayDesktopPermissionDecision): void {
      decisions.push(decision);
    },

    getDecisions(): readonly FridayDesktopPermissionDecision[] {
      return toFrozenSnapshot(decisions);
    },
  };
}
