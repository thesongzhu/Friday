/**
 * Policy Extension Chain — Layered policy evaluation with deny-only extensions.
 *
 * Provides a chain-of-responsibility pattern for policy evaluation where:
 * - A core policy decision is evaluated first
 * - Extensions can only tighten (deny) decisions, never loosen (allow) what core denied
 * - All decisions are fully auditable with the triggering extension identified
 *
 * This follows the same deny-wins semantics as the PolicyEngine but adds
 * an extension mechanism for pluggable, composable policy layers.
 *
 * @module security/policy-extension-chain
 */

// ─── Types ───

/** The context passed through the policy extension chain for evaluation. */
export interface PolicyExtensionContext {
  /** The principal (user/service) requesting access. */
  readonly principalId: string;
  /** The resource being accessed. */
  readonly resource: string;
  /** The action being performed on the resource. */
  readonly action: string;
  /** Optional resource identifier. */
  readonly resourceId?: string;
  /** Additional attributes for condition evaluation. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** The decision returned by a single policy extension. */
export type PolicyExtensionDecision = "pass" | "deny" | "abstain";

/** A named policy extension that can evaluate access decisions. */
export interface PolicyExtension {
  /** Unique name identifying this extension (used for audit trails). */
  readonly name: string;
  /** Evaluate the given context and return a decision. */
  evaluate(context: PolicyExtensionContext): PolicyExtensionDecision;
}

/** The core policy decision before extensions are applied. */
export type CorePolicyDecision = "allow" | "deny";

/** An individual record of an extension's evaluation result. */
export interface ExtensionEvaluationRecord {
  /** The name of the extension that was evaluated. */
  readonly extensionName: string;
  /** The decision returned by this extension. */
  readonly decision: PolicyExtensionDecision;
}

/** The final, auditable result of the full extension chain evaluation. */
export interface PolicyExtensionChainResult {
  /** The final decision after the chain has been evaluated. */
  readonly decision: "allow" | "deny";
  /** The core policy decision before extensions were applied. */
  readonly coreDecision: CorePolicyDecision;
  /** Which extension triggered the final deny, if any. `null` if core denied or no extension denied. */
  readonly decidedBy: string | null;
  /** Whether the final decision was triggered by an extension overriding core. */
  readonly overriddenByExtension: boolean;
  /** Full ordered record of every extension evaluation for audit purposes. */
  readonly evaluations: readonly ExtensionEvaluationRecord[];
  /** The context that was evaluated. */
  readonly context: PolicyExtensionContext;
}

// ─── Policy Extension Chain ───

/**
 * Evaluate a core policy decision through a chain of extensions.
 *
 * Semantics:
 * - If the core decision is "deny", the result is always "deny" regardless of extensions.
 *   Extensions are still evaluated for audit completeness but cannot change the outcome.
 * - If the core decision is "allow", each extension is evaluated in order.
 *   The first extension that returns "deny" short-circuits the chain and the
 *   final decision becomes "deny".
 * - Extensions returning "pass" or "abstain" do not alter the decision.
 * - If all extensions abstain or pass, the original core decision is preserved.
 */
export function evaluatePolicyExtensionChain(
  coreDecision: CorePolicyDecision,
  extensions: readonly PolicyExtension[],
  context: PolicyExtensionContext,
): PolicyExtensionChainResult {
  const evaluations: ExtensionEvaluationRecord[] = [];
  let decidedBy: string | null = null;
  let overriddenByExtension = false;

  if (coreDecision === "deny") {
    // Core denied — extensions cannot override. Evaluate all for audit trail.
    for (const extension of extensions) {
      const decision = extension.evaluate(context);
      evaluations.push({
        extensionName: extension.name,
        decision,
      });
    }

    return {
      decision: "deny",
      coreDecision,
      decidedBy: null,
      overriddenByExtension: false,
      evaluations,
      context,
    };
  }

  // Core allowed — extensions can tighten to deny.
  for (const extension of extensions) {
    const decision = extension.evaluate(context);
    evaluations.push({
      extensionName: extension.name,
      decision,
    });

    if (decision === "deny" && decidedBy === null) {
      decidedBy = extension.name;
      overriddenByExtension = true;
      // Do NOT evaluate remaining extensions — first deny wins.
      break;
    }
  }

  const finalDecision: "allow" | "deny" = overriddenByExtension ? "deny" : "allow";

  return {
    decision: finalDecision,
    coreDecision,
    decidedBy,
    overriddenByExtension,
    evaluations,
    context,
  };
}

/**
 * Create a reusable PolicyExtensionChain instance that holds a fixed set
 * of extensions and can evaluate multiple contexts against them.
 */
export class PolicyExtensionChain {
  private readonly extensions: readonly PolicyExtension[];

  constructor(extensions: readonly PolicyExtension[]) {
    this.extensions = [...extensions];
  }

  /** Evaluate a core decision through all registered extensions. */
  evaluate(
    coreDecision: CorePolicyDecision,
    context: PolicyExtensionContext,
  ): PolicyExtensionChainResult {
    return evaluatePolicyExtensionChain(coreDecision, this.extensions, context);
  }

  /** Return the list of registered extension names (for diagnostics/audit). */
  get extensionNames(): readonly string[] {
    return this.extensions.map((e) => e.name);
  }
}
