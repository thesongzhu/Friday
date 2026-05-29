/**
 * Workflow node acceptance classification (audit C, Stage 1).
 *
 * Locked product direction: a workflow node may NOT use "any non-empty output"
 * as *verified* completion. A side-effect / external-action / mutating /
 * user-visible-claim node that lacks deterministic evidence (a real tool
 * receipt / state delta / provider-channel confirmation, or an explicit safe
 * refusal) cannot be a clean (verified) completion — it is truth-labeled
 * `proof_pending` (or `blocked`/`recovery_needed`) instead. Pure-informational /
 * low-risk nodes may complete but are truth-labeled (`verified` for
 * deterministic compute, `model_assessed_unverified` for model-driven nodes) and
 * must never be treated as release proof when unverified.
 *
 * This is an ORTHOGONAL truth dimension layered on top of the existing run/node
 * execution status — it does not change whether a node ran, only whether its
 * completion is *verified*. Classification is derived from the node's declared
 * capability (node type + skill manifest permission grants), NEVER from the
 * node output (the untrusted artifact being gated).
 *
 * Stage 2 (follow-up): once the node execution result carries real tool/receipt/
 * state-delta evidence, the gate can deterministically upgrade `proof_pending`
 * side-effect nodes to `verified` (or down to `blocked`). Until then any
 * side-effect node is honestly `proof_pending`.
 */

import type { FridayWorkflowNode } from "../model/friday-workflow-graph.types.js";

/** Orthogonal completion-verification truth label (independent of run/node status). */
export type FridayNodeCompletionVerification =
  | "verified" // deterministic / pure-compute node; safe as proof
  | "model_assessed_unverified" // informational model-driven node; NOT release proof
  | "proof_pending" // side-effect node lacking deterministic evidence (Stage 2 upgrades)
  | "recovery_needed"
  | "blocked";

export type FridayNodeSideEffectClass = "side_effect" | "informational";

/**
 * PermissionActions that denote a real external side effect / state mutation.
 * Mirrors the codebase's own danger set (PermissionPromptToken:
 * filesystem.write / network.connect / shell.execute / channel.send /
 * device.capture). `read` / `receive` are informational.
 */
const SIDE_EFFECTING_PERMISSION_ACTIONS: ReadonlySet<string> = new Set([
  "write",
  "connect",
  "send",
  "capture",
  "execute",
]);

/**
 * Defensively extract declared permission `action`s from whatever
 * `resolveSkill` returns. The runtime types `resolveSkill` as `unknown` (it is
 * only contractually an existence probe), but the hub implementation returns the
 * registered skill carrying `manifest.permissions.grants`. Any unexpected shape
 * yields `null` so the caller fails closed (treats the node as side-effecting).
 */
function extractDeclaredPermissionActions(skill: unknown): string[] | null {
  if (skill == null || typeof skill !== "object") return null;
  const manifest = (skill as { manifest?: unknown }).manifest;
  if (manifest == null || typeof manifest !== "object") return null;
  const permissions = (manifest as { permissions?: unknown }).permissions;
  if (permissions == null || typeof permissions !== "object") return null;

  // Modern PermissionPolicyV2: { grants: PermissionGrant[] }
  const grants = (permissions as { grants?: unknown }).grants;
  if (Array.isArray(grants)) {
    return grants
      .map((g) => (g != null && typeof g === "object" ? (g as { action?: unknown }).action : undefined))
      .filter((a): a is string => typeof a === "string");
  }

  // Legacy v1 shape: network/filesystem/memoryScope/tools — map to side-effect actions.
  const legacy = permissions as {
    network?: unknown;
    filesystem?: unknown;
    memoryScope?: unknown;
    tools?: unknown;
  };
  const legacyActions: string[] = [];
  if (legacy.network === true) legacyActions.push("connect");
  if (typeof legacy.filesystem === "string" && legacy.filesystem !== "none") legacyActions.push("write");
  if (legacy.memoryScope === "readwrite") legacyActions.push("write");
  if (Array.isArray(legacy.tools) && legacy.tools.length > 0) legacyActions.push("execute");
  // A legacy policy object with no side-effect signals is treated as having an
  // empty (but present) declaration → caller fail-closes on empty grants.
  return legacyActions;
}

/**
 * Classify a workflow node as side-effecting vs informational from its DECLARED
 * capability — never from its output. Fail-closed: an `action` node whose skill
 * cannot be resolved, has no skill id, or has no declared grants is treated as
 * side-effecting (empty grants are common and legal, so empty != safe).
 */
export function classifyWorkflowNodeSideEffect(
  node: Pick<FridayWorkflowNode, "type" | "config">,
  resolveSkill: (skillId: string) => unknown,
): FridayNodeSideEffectClass {
  switch (node.type) {
    case "trigger":
    case "condition":
    case "data":
      return "informational"; // pure compute / passthrough; no external action
    case "ai":
    case "approval":
      return "informational"; // model/human-gated; truth-labeled, not clean-verified
    case "action": {
      const cfg = (node.config ?? {}) as Record<string, unknown>;
      const skillId = typeof cfg.skillId === "string"
        ? cfg.skillId
        : typeof cfg.ref === "string"
          ? cfg.ref
          : undefined;
      if (!skillId) return "side_effect"; // no identity → fail closed
      const actions = extractDeclaredPermissionActions(resolveSkill(skillId));
      if (!actions || actions.length === 0) return "side_effect"; // unresolved / empty → fail closed
      return actions.some((a) => SIDE_EFFECTING_PERMISSION_ACTIONS.has(a))
        ? "side_effect"
        : "informational"; // only when every grant is read/receive
    }
    default:
      return "side_effect"; // unreachable (closed enum) but fail closed
  }
}

/**
 * Resolve the orthogonal completion-verification label for a node, given its
 * side-effect class and (Stage 2) whether deterministic evidence backs it.
 * Today `hasDeterministicEvidence` is always false (no evidence plumbing), so
 * side-effect nodes are honestly `proof_pending`.
 */
export function resolveNodeCompletionVerification(
  node: Pick<FridayWorkflowNode, "type">,
  sideEffectClass: FridayNodeSideEffectClass,
  hasDeterministicEvidence = false,
): FridayNodeCompletionVerification {
  if (sideEffectClass === "side_effect") {
    return hasDeterministicEvidence ? "verified" : "proof_pending";
  }
  // informational
  if (node.type === "ai" || node.type === "approval") {
    return "model_assessed_unverified";
  }
  return "verified"; // trigger / condition / data — deterministic pure compute
}

/** A completion-verification label that is safe to treat as release proof. */
export function isVerifiedCompletion(v: FridayNodeCompletionVerification): boolean {
  return v === "verified";
}
