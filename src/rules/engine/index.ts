/**
 * Rules Engine Runtime — barrel export.
 *
 * @module rules/engine
 */

// ─── Rule Engine (main facade) ───

export { FridayRuleEngine } from "./rule-engine.js";
export type {
  AuditLogEntry,
  AuditLogSink,
  FridayRuleEngineOptions,
  FridayRuleEngineTransitionHandler,
  FridayRuleEvaluationOptions,
} from "./rule-engine.js";

// ─── Rule Index ───

export { FridayRuleIndex, buildIndexKey } from "./rule-index.js";
export type { CompiledRule } from "./rule-index.js";

// ─── Policy Bundle Manager ───

export { FridayPolicyBundleManager } from "./policy-bundle-manager.js";
export type {
  LoadedBundle,
  BundleManagerStats,
  FridayPolicyBundleManagerOptions,
} from "./policy-bundle-manager.js";

// ─── Policy Bundle Signature ───

export {
  assertPolicyBundleSignatureValid,
  canonicalizePolicyBundlePayload,
  createDomainBundleSigningPayload,
  createParsedBundleSigningPayload,
  createPolicyBundleSignature,
  PolicyBundleSignatureError,
  verifyPolicyBundleSignature,
} from "./policy-bundle-signature.js";
export type {
  PolicyBundleSignatureErrorCode,
  PolicyBundleSignatureVerificationOptions,
} from "./policy-bundle-signature.js";

// ─── DSL Parser ───

export {
  parsePolicyBundleDocument,
  parsePolicyBundleYaml,
  parsePolicyBundleJson,
  validateRegexPattern,
  RuleDslParseError,
} from "./dsl-parser.js";

// ─── Condition Evaluator ───

export {
  evaluateCondition,
  evaluateConditionGroup,
  evaluateOperator,
  clearCache,
  resolveField,
} from "./condition-evaluator.js";

// ─── Context Redactor ───

export { redactContext } from "./context-redactor.js";
export type { RedactionResult } from "./context-redactor.js";
