/**
 * Rule DSL Parser — parses YAML/JSON policy bundle definitions
 * into typed FridayPolicyBundleYaml objects.
 *
 * Validates structure, condition operators, regex safety, and
 * resource/action enums at parse time.
 *
 * @module rules/engine
 */

import type {
  FridayPolicyBundleYaml,
  FridayPolicyBundleYamlRule,
  FridayRuleAction,
  FridayRuleCondition,
  FridayRuleConditionGroup,
  FridayRuleConditionOperator,
  FridayRuleDecision,
  FridayRulePresenceCondition,
  FridayRulePresenceOperator,
  FridayRuleResource,
  FridayRuleValueCondition,
  FridayRuleValueOperator,
  JsonValue,
} from "../model/friday-rules-engine.types.js";
import { precompileRegexPattern } from "./condition-evaluator.js";

// ─── Constants ───

const VALID_API_VERSION = "friday/rules/v1";
const VALID_KIND = "PolicyBundle";
const MAX_REGEX_LENGTH = 256;

const VALID_RESOURCES: ReadonlySet<string> = new Set<FridayRuleResource>([
  "filesystem", "network", "channel", "tool", "memory", "device",
  "shell", "skill", "workflow", "agent", "artifact", "retry", "playbook", "desktop",
]);

const VALID_ACTIONS: ReadonlySet<string> = new Set<FridayRuleAction>([
  "read", "write", "connect", "send", "receive", "execute", "capture",
  "create", "delete", "update", "accept", "promote", "select", "click",
  "type", "keypress", "scroll", "drag", "screenshot", "read_element",
  "launch_app", "close_app", "clipboard", "file_operation",
]);

const VALID_DECISIONS: ReadonlySet<string> = new Set<FridayRuleDecision>([
  "allow", "deny", "warn", "audit",
]);

const VALID_OPERATORS: ReadonlySet<string> = new Set<FridayRuleConditionOperator>([
  "equals", "not_equals", "contains", "matches", "in", "not_in",
  "gt", "gte", "lt", "lte", "exists", "not_exists",
]);

const PRESENCE_OPERATORS: ReadonlySet<string> = new Set(["exists", "not_exists"]);
const VALID_CONDITION_GROUP_KEYS: ReadonlySet<string> = new Set(["all", "any", "none"]);
const FORBIDDEN_FIELD_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const VALID_FIELD_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  /\$\{/,
  /\{\{/,
  /\}\}/,
  /`/,
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
];

// ─── Parse Error ───

export class RuleDslParseError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly details?: string,
  ) {
    super(`DSL parse error at ${path}: ${message}${details ? ` (${details})` : ""}`);
    this.name = "RuleDslParseError";
  }
}

// ─── Public API ───

/**
 * Parse a raw object (from YAML.parse or JSON.parse) into a validated
 * FridayPolicyBundleYaml. Throws RuleDslParseError on validation failure.
 */
export function parsePolicyBundleDocument(raw: unknown): FridayPolicyBundleYaml {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleDslParseError("Document must be a non-null object", "root");
  }

  const doc = raw as Record<string, unknown>;

  // Validate top-level fields.
  validateApiVersion(doc);
  validateKind(doc);

  const metadata = validateMetadata(doc);
  const rules = validateRules(doc);

  return {
    apiVersion: VALID_API_VERSION,
    kind: VALID_KIND,
    metadata,
    rules,
  };
}

/**
 * Parse a YAML string into a validated FridayPolicyBundleYaml.
 * Dynamically imports the `yaml` package (already in package.json).
 */
export async function parsePolicyBundleYaml(yamlContent: string): Promise<FridayPolicyBundleYaml> {
  const { parse } = await import("yaml");
  const raw = parse(yamlContent) as unknown;
  return parsePolicyBundleDocument(raw);
}

/**
 * Parse a JSON string into a validated FridayPolicyBundleYaml.
 */
export function parsePolicyBundleJson(jsonContent: string): FridayPolicyBundleYaml {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonContent) as unknown;
  } catch (e) {
    throw new RuleDslParseError("Invalid JSON", "root", (e as Error).message);
  }
  return parsePolicyBundleDocument(raw);
}

// ─── Regex Validation ───

/**
 * Validate a regex pattern for safety.
 * Returns null if valid, or an error message if invalid.
 */
export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Regex pattern exceeds maximum length of ${MAX_REGEX_LENGTH} characters`;
  }

  if (containsBackreference(pattern)) {
    return "Regex backreferences are not allowed";
  }

  if (hasNestedQuantifiers(pattern)) {
    return "Regex nested quantifiers are not allowed";
  }

  try {
    precompileRegexPattern(pattern);
    return null;
  } catch (e) {
    return `Invalid regex: ${(e as Error).message}`;
  }
}

// ─── Internal Validation ───

function validateApiVersion(doc: Record<string, unknown>): void {
  if (doc.apiVersion !== VALID_API_VERSION) {
    throw new RuleDslParseError(
      `Expected apiVersion "${VALID_API_VERSION}", got "${String(doc.apiVersion)}"`,
      "apiVersion",
    );
  }
}

function validateKind(doc: Record<string, unknown>): void {
  if (doc.kind !== VALID_KIND) {
    throw new RuleDslParseError(
      `Expected kind "${VALID_KIND}", got "${String(doc.kind)}"`,
      "kind",
    );
  }
}

function validateMetadata(doc: Record<string, unknown>): FridayPolicyBundleYaml["metadata"] {
  const meta = doc.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new RuleDslParseError("metadata must be a non-null object", "metadata");
  }

  const m = meta as Record<string, unknown>;

  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new RuleDslParseError("id is required and must be a non-empty string", "metadata.id");
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new RuleDslParseError("name is required and must be a non-empty string", "metadata.name");
  }
  if (typeof m.version !== "number" || !Number.isInteger(m.version) || m.version < 1) {
    throw new RuleDslParseError("version is required and must be a positive integer", "metadata.version");
  }

  if (m.description !== undefined && typeof m.description !== "string") {
    throw new RuleDslParseError("description must be a string", "metadata.description");
  }
  if (m.priority !== undefined && (typeof m.priority !== "number" || !Number.isInteger(m.priority))) {
    throw new RuleDslParseError("priority must be an integer", "metadata.priority");
  }
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
    throw new RuleDslParseError("enabled must be a boolean", "metadata.enabled");
  }
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === "string")) {
      throw new RuleDslParseError("tags must be an array of strings", "metadata.tags");
    }
  }

  const signature = validateMetadataSignature(m.signature, "metadata.signature");

  return {
    id: m.id as string,
    name: m.name as string,
    version: m.version as number,
    description: m.description as string | undefined,
    priority: m.priority as number | undefined,
    enabled: m.enabled as boolean | undefined,
    tags: m.tags as string[] | undefined,
    signature,
  };
}

function validateMetadataSignature(
  raw: unknown,
  path: string,
): FridayPolicyBundleYaml["metadata"]["signature"] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleDslParseError("signature must be a non-null object", path);
  }

  const signature = raw as Record<string, unknown>;

  if (signature.algorithm !== "hmac-sha256") {
    throw new RuleDslParseError('signature.algorithm must be "hmac-sha256"', `${path}.algorithm`);
  }
  if (typeof signature.keyId !== "string" || signature.keyId.trim().length === 0) {
    throw new RuleDslParseError("signature.keyId must be a non-empty string", `${path}.keyId`);
  }
  if (typeof signature.value !== "string" || signature.value.trim().length === 0) {
    throw new RuleDslParseError("signature.value must be a non-empty string", `${path}.value`);
  }

  return {
    algorithm: "hmac-sha256",
    keyId: signature.keyId.trim(),
    value: signature.value.trim(),
  };
}

function validateRules(doc: Record<string, unknown>): FridayPolicyBundleYamlRule[] {
  const rules = doc.rules;
  if (!Array.isArray(rules)) {
    throw new RuleDslParseError("rules must be an array", "rules");
  }

  const seenIds = new Set<string>();
  return rules.map((rule, index) => validateRule(rule, index, seenIds));
}

function validateRule(raw: unknown, index: number, seenIds: Set<string>): FridayPolicyBundleYamlRule {
  const path = `rules[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleDslParseError("Rule must be a non-null object", path);
  }

  const r = raw as Record<string, unknown>;

  // Required fields.
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new RuleDslParseError("id is required and must be a non-empty string", `${path}.id`);
  }
  if (seenIds.has(r.id as string)) {
    throw new RuleDslParseError(`Duplicate rule id "${r.id as string}"`, `${path}.id`);
  }
  seenIds.add(r.id as string);

  if (typeof r.name !== "string" || r.name.length === 0) {
    throw new RuleDslParseError("name is required and must be a non-empty string", `${path}.name`);
  }
  if (!VALID_RESOURCES.has(r.resource as string)) {
    throw new RuleDslParseError(`Invalid resource "${String(r.resource)}"`, `${path}.resource`);
  }
  if (!VALID_ACTIONS.has(r.action as string)) {
    throw new RuleDslParseError(`Invalid action "${String(r.action)}"`, `${path}.action`);
  }
  if (!VALID_DECISIONS.has(r.decision as string)) {
    throw new RuleDslParseError(`Invalid decision "${String(r.decision)}"`, `${path}.decision`);
  }

  // Optional fields.
  if (r.description !== undefined && typeof r.description !== "string") {
    throw new RuleDslParseError("description must be a string", `${path}.description`);
  }
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
    throw new RuleDslParseError("enabled must be a boolean", `${path}.enabled`);
  }
  if (r.message !== undefined && typeof r.message !== "string") {
    throw new RuleDslParseError("message must be a string", `${path}.message`);
  }
  if (r.priority !== undefined && (typeof r.priority !== "number" || !Number.isInteger(r.priority))) {
    throw new RuleDslParseError("priority must be an integer", `${path}.priority`);
  }

  // Conditions (optional).
  const conditions = r.conditions !== undefined
    ? validateConditionGroup(r.conditions, `${path}.conditions`)
    : undefined;

  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | undefined,
    enabled: r.enabled as boolean | undefined,
    resource: r.resource as FridayRuleResource,
    action: r.action as FridayRuleAction,
    conditions,
    decision: r.decision as FridayRuleDecision,
    message: r.message as string | undefined,
    priority: r.priority as number | undefined,
  };
}

function validateConditionGroup(raw: unknown, path: string): FridayRuleConditionGroup {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleDslParseError("Condition group must be a non-null object", path);
  }

  const g = raw as Record<string, unknown>;
  for (const key of Object.keys(g)) {
    if (!VALID_CONDITION_GROUP_KEYS.has(key)) {
      throw new RuleDslParseError(`Unknown condition group key "${key}"`, `${path}.${key}`);
    }
  }

  const result: FridayRuleConditionGroup = {};
  let validGroupCount = 0;

  if (g.all !== undefined) {
    if (!Array.isArray(g.all)) {
      throw new RuleDslParseError("all must be an array", `${path}.all`);
    }
    if (g.all.length === 0) {
      throw new RuleDslParseError("all must not be empty", `${path}.all`);
    }
    result.all = g.all.map((c, i) => validateCondition(c, `${path}.all[${i}]`));
    validGroupCount++;
  }

  if (g.any !== undefined) {
    if (!Array.isArray(g.any)) {
      throw new RuleDslParseError("any must be an array", `${path}.any`);
    }
    if (g.any.length === 0) {
      throw new RuleDslParseError("any must not be empty", `${path}.any`);
    }
    result.any = g.any.map((c, i) => validateCondition(c, `${path}.any[${i}]`));
    validGroupCount++;
  }

  if (g.none !== undefined) {
    if (!Array.isArray(g.none)) {
      throw new RuleDslParseError("none must be an array", `${path}.none`);
    }
    if (g.none.length === 0) {
      throw new RuleDslParseError("none must not be empty", `${path}.none`);
    }
    result.none = g.none.map((c, i) => validateCondition(c, `${path}.none[${i}]`));
    validGroupCount++;
  }

  if (validGroupCount === 0) {
    throw new RuleDslParseError(
      "conditions must include at least one non-empty group (all, any, or none)",
      path,
    );
  }

  return result;
}

function validateCondition(raw: unknown, path: string): FridayRuleCondition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleDslParseError("Condition must be a non-null object", path);
  }

  const c = raw as Record<string, unknown>;

  if (typeof c.field !== "string" || c.field.length === 0) {
    throw new RuleDslParseError("field is required and must be a non-empty string", `${path}.field`);
  }
  validateFieldPath(c.field, `${path}.field`);
  if (!VALID_OPERATORS.has(c.operator as string)) {
    throw new RuleDslParseError(`Invalid operator "${String(c.operator)}"`, `${path}.operator`);
  }

  const operator = c.operator as FridayRuleConditionOperator;

  // Presence operators must not have a value.
  if (PRESENCE_OPERATORS.has(operator)) {
    if (c.value !== undefined) {
      throw new RuleDslParseError(`Operator "${operator}" must not have a value`, `${path}.value`);
    }
    const presenceCondition: FridayRulePresenceCondition = {
      field: c.field as string,
      operator: operator as FridayRulePresenceOperator,
    };
    return presenceCondition;
  }

  // Value operators must have a value.
  if (c.value === undefined) {
    throw new RuleDslParseError(`Operator "${operator}" requires a value`, `${path}.value`);
  }

  // Validate regex patterns.
  if (operator === "matches" && typeof c.value === "string") {
    const regexError = validateRegexPattern(c.value);
    if (regexError) {
      throw new RuleDslParseError(regexError, `${path}.value`);
    }
  }

  const valueCondition: FridayRuleValueCondition = {
    field: c.field as string,
    operator: operator as FridayRuleValueOperator,
    value: c.value as JsonValue,
  };
  return valueCondition;
}

function validateFieldPath(field: string, path: string): void {
  if (field.startsWith(".") || field.endsWith(".") || field.includes("..")) {
    throw new RuleDslParseError("field path must not start/end with dot or include empty segments", path);
  }

  for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
    if (pattern.test(field)) {
      throw new RuleDslParseError("field path contains forbidden injection pattern", path);
    }
  }

  const segments = field.split(".");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new RuleDslParseError("field path contains empty segment", path);
    }
    if (FORBIDDEN_FIELD_SEGMENTS.has(segment)) {
      throw new RuleDslParseError(`field path contains forbidden segment "${segment}"`, path);
    }
    if (!VALID_FIELD_SEGMENT_PATTERN.test(segment)) {
      throw new RuleDslParseError(
        "field path segment contains unsupported characters",
        path,
      );
    }
  }
}

function containsBackreference(pattern: string): boolean {
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!inCharClass && next !== undefined) {
        if (/[1-9]/.test(next)) return true;
        if (next === "k" && pattern[i + 2] === "<") return true;
      }
      i++;
      continue;
    }

    if (ch === "[" && !inCharClass) {
      inCharClass = true;
      continue;
    }

    if (ch === "]" && inCharClass) {
      inCharClass = false;
    }
  }

  return false;
}

function hasNestedQuantifiers(pattern: string): boolean {
  interface GroupState {
    hasQuantifier: boolean;
  }

  const stack: GroupState[] = [];
  let inCharClass = false;
  let lastToken: "none" | "atom" | "group" = "none";
  let lastClosedGroupHasQuantifier = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (inCharClass) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "]") {
        inCharClass = false;
        lastToken = "atom";
      }
      continue;
    }

    if (ch === "\\") {
      i++;
      lastToken = "atom";
      continue;
    }

    if (ch === "[") {
      inCharClass = true;
      continue;
    }

    if (ch === "(") {
      stack.push({ hasQuantifier: false });
      lastToken = "none";
      continue;
    }

    if (ch === ")") {
      const current = stack.pop();
      if (!current) continue;

      if (current.hasQuantifier && stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }

      lastClosedGroupHasQuantifier = current.hasQuantifier;
      lastToken = "group";
      continue;
    }

    const quantifierLength = readQuantifierLength(pattern, i);
    if (quantifierLength > 0) {
      if (lastToken === "group" && lastClosedGroupHasQuantifier) {
        return true;
      }

      if (stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }

      i += quantifierLength - 1;
      lastToken = "none";
      continue;
    }

    if (ch === "|" || ch === "^" || ch === "$") {
      lastToken = "none";
      continue;
    }

    lastToken = "atom";
  }

  return false;
}

function readQuantifierLength(pattern: string, start: number): number {
  const ch = pattern[start];
  if (ch === "*" || ch === "+" || ch === "?") {
    return 1;
  }

  if (ch !== "{") {
    return 0;
  }

  const match = pattern.slice(start).match(/^\{(\d+)(,\d*)?\}/);
  return match ? match[0].length : 0;
}
