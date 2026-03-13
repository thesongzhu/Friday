import {
  countBy,
  requireAutofixContext,
  summarizeActionRecord,
} from "../_shared/friday-runtime-skill-utils.mjs";

function parseLimit(input) {
  return typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(20, Math.floor(input.limit)))
    : 8;
}

function parseStatus(input) {
  return typeof input.status === "string" && input.status.trim().length > 0
    ? input.status.trim().toLowerCase()
    : undefined;
}

export async function execute(input = {}, ctx = {}) {
  const autofix = requireAutofixContext(ctx);
  const limit = parseLimit(input);
  const status = parseStatus(input);
  const actions = await autofix.listActions(limit, status);
  const summarizedActions = actions
    .map((action) => summarizeActionRecord(action))
    .sort((left, right) => {
      if (left.requiresApproval !== right.requiresApproval) {
        return Number(right.requiresApproval) - Number(left.requiresApproval);
      }
      if (left.riskTier !== right.riskTier) {
        return right.riskTier - left.riskTier;
      }
      return left.status.localeCompare(right.status);
    });

  const countsByStatus = countBy(summarizedActions, (action) => action.status);
  const countsByRiskTier = countBy(summarizedActions, (action) => `tier_${String(action.riskTier)}`);
  const approvalRequiredCount = summarizedActions.filter((action) => action.requiresApproval).length;
  const autoApplyAllowedCount = summarizedActions.filter((action) => action.autoApplyAllowed).length;
  const topAction = summarizedActions[0] ?? null;

  let nextStep = "No auto-fix plan is queued right now. Use review-open-issues first to identify a concrete incident.";
  if (topAction?.requiresApproval) {
    nextStep = "A higher-risk fix is waiting on approval. Review the plan, rollback coverage, and approval trail before executing anything.";
  } else if (topAction) {
    nextStep = "The safest next step is still to review the bounded fix plan and its acceptance checks before running it.";
  }

  const summary = summarizedActions.length > 0
    ? `Friday has ${summarizedActions.length} planned auto-fix action(s): ${approvalRequiredCount} approval-gated and ${autoApplyAllowedCount} low-risk candidate(s).`
    : "Friday does not currently have any planned auto-fix actions.";

  return {
    summary,
    nextStep,
    details: {
      actionCount: summarizedActions.length,
      countsByStatus,
      countsByRiskTier,
      approvalRequiredCount,
      autoApplyAllowedCount,
      topAction,
      actions: summarizedActions.slice(0, 6),
      recommendedTemplateId: "review-issues",
    },
  };
}
