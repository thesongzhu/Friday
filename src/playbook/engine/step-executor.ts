/**
 * Step Executor — Execute playbook steps with parameter substitution.
 *
 * Takes a playbook version's execution pattern and an incoming context,
 * resolves parameter placeholders, and produces an execution plan that
 * the NodeRunner can consume.
 *
 * @module playbook/engine
 */

import type {
  FridayPlaybookEngineConfig,
  FridayPlaybookSelector,
  FridayPlaybookVersion,
  JsonObject,
  JsonValue,
  UUID,
} from "../model/friday-playbook.types.js";

import type { PlaybookStore } from "./playbook-store.js";

// ─── Execution Plan Types ───

/** A single step in an execution plan derived from a playbook. */
export interface PlaybookStep {
  /** Step index (0-based). */
  index: number;
  /** Node type for this step. */
  nodeType: string;
  /** Adapter type (optional). */
  adapterType?: string;
  /** Resolved parameters for this step. */
  parameters: JsonObject;
  /** Tool preferences for this step. */
  toolPreferences: string[];
}

/** An execution plan produced by applying a playbook to a context. */
export interface PlaybookExecutionPlan {
  /** Unique plan identifier. */
  id: UUID;
  /** Source playbook ID. */
  playbookId: UUID;
  /** Source playbook version number. */
  versionNumber: number;
  /** Ordered execution steps. */
  steps: PlaybookStep[];
  /** Metadata to pass through to NodeRunner. */
  metadata: JsonObject;
  /** When the plan was generated. */
  generatedAt: string;
}

/** Execution outcome for a single step. */
export interface StepExecutionResult {
  /** Step index that was executed. */
  stepIndex: number;
  /** Whether the step succeeded. */
  success: boolean;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Output produced (if any). */
  output?: JsonObject;
  /** Error message (if failed). */
  error?: string;
}

// ─── Parameter Substitution ───

/** Parameter binding context for template resolution. */
export interface ParameterContext {
  /** Parameters from the incoming selector/trigger. */
  input: JsonObject;
  /** Environment variables or runtime context. */
  runtime: JsonObject;
  /** Previous step outputs (indexed by step index as string). */
  stepOutputs: Record<string, JsonObject>;
}

/**
 * Resolve parameter placeholders in a value.
 *
 * Supports `{{input.key}}`, `{{runtime.key}}`, and `{{steps.N.key}}` syntax.
 * Non-string values and values without placeholders are returned unchanged.
 */
export function resolveParameters(value: JsonValue, context: ParameterContext): JsonValue {
  if (typeof value === "string") {
    return resolveStringTemplate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveParameters(item, context));
  }
  if (value !== null && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveParameters(val, context);
    }
    return result;
  }
  return value;
}

/**
 * Resolve template placeholders in a string.
 * Pattern: `{{scope.path.to.value}}`
 */
function resolveStringTemplate(template: string, context: ParameterContext): JsonValue {
  const placeholderPattern = /\{\{(\w+)\.([^}]+)\}\}/g;
  let hasPlaceholder = false;
  let fullMatchValue: JsonValue | undefined;

  // Check if the entire string is a single placeholder (return typed value)
  const fullMatch = /^\{\{(\w+)\.([^}]+)\}\}$/.exec(template);
  if (fullMatch) {
    fullMatchValue = lookupValue(fullMatch[1], fullMatch[2], context);
    if (fullMatchValue !== undefined) return fullMatchValue;
    return template;
  }

  // Otherwise do string interpolation
  const result = template.replace(placeholderPattern, (_match, scope: string, path: string) => {
    hasPlaceholder = true;
    const resolved = lookupValue(scope, path, context);
    return resolved !== undefined && resolved !== null ? String(resolved) : _match;
  });

  return hasPlaceholder ? result : template;
}

/**
 * Look up a value from the parameter context by scope and dotted path.
 */
function lookupValue(scope: string, path: string, context: ParameterContext): JsonValue | undefined {
  let source: JsonObject | undefined;

  switch (scope) {
    case "input":
      source = context.input;
      break;
    case "runtime":
      source = context.runtime;
      break;
    case "steps": {
      const dotIndex = path.indexOf(".");
      if (dotIndex === -1) return undefined;
      const stepIndex = path.substring(0, dotIndex);
      const stepPath = path.substring(dotIndex + 1);
      source = context.stepOutputs[stepIndex];
      if (!source) return undefined;
      return resolveDottedPath(source, stepPath);
    }
    default:
      return undefined;
  }

  if (!source) return undefined;
  return resolveDottedPath(source, path);
}

/**
 * Resolve a dotted path against a JSON object.
 */
function resolveDottedPath(obj: JsonObject, path: string): JsonValue | undefined {
  const parts = path.split(".");
  let current: JsonValue = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

// ─── Step Executor ───

/** Dependencies for creating a step executor. */
export interface StepExecutorDeps {
  store: PlaybookStore;
  config: FridayPlaybookEngineConfig;
}

/** Step executor interface. */
export interface StepExecutor {
  /** Generate an execution plan from a playbook version and selector context. */
  generatePlan(
    playbookId: UUID,
    versionNumber: number,
    selector: FridayPlaybookSelector,
  ): PlaybookExecutionPlan | null;

  /** Resolve parameters for a single step given a parameter context. */
  resolveStep(step: PlaybookStep, context: ParameterContext): PlaybookStep;
}

/** Create a step executor instance. */
export function createStepExecutor(deps: StepExecutorDeps): StepExecutor {
  const { store, config } = deps;

  return {
    generatePlan(playbookId, versionNumber, selector) {
      const playbook = store.getPlaybook(playbookId);
      if (!playbook) return null;

      const version = store.getVersionByNumber(playbookId, versionNumber);
      if (!version) return null;

      const steps = buildSteps(version, selector);

      return {
        id: config.generateId(),
        playbookId,
        versionNumber,
        steps,
        metadata: {
          workflowType: selector.workflowType,
          runId: selector.runId,
          workflowId: selector.workflowId,
          tags: selector.tags as unknown as JsonValue,
        },
        generatedAt: config.nowIso(),
      };
    },

    resolveStep(step, context) {
      return {
        ...step,
        parameters: resolveParameters(step.parameters, context) as JsonObject,
      };
    },
  };

  function buildSteps(version: FridayPlaybookVersion, selector: FridayPlaybookSelector): PlaybookStep[] {
    const pattern = version.pattern;
    const nodeSequence = pattern["nodeSequence"];
    if (!Array.isArray(nodeSequence)) return [];

    const toolsUsed = Array.isArray(pattern["toolsUsed"]) ? (pattern["toolsUsed"] as string[]) : [];
    const parameterKeys = Array.isArray(pattern["parameterKeys"])
      ? (pattern["parameterKeys"] as string[])
      : [];

    return nodeSequence.map((node, index) => {
      const nodeObj = node as JsonObject;
      const nodeType = String(nodeObj["nodeType"] ?? "");
      const adapterType = nodeObj["adapterType"] !== undefined ? String(nodeObj["adapterType"]) : undefined;

      // Build parameter stubs from parameter keys
      const parameters: JsonObject = {};
      for (const key of parameterKeys) {
        parameters[key] = `{{input.${key}}}`;
      }

      return {
        index,
        nodeType,
        ...(adapterType !== undefined ? { adapterType } : {}),
        parameters,
        toolPreferences: toolsUsed,
      };
    });
  }
}
