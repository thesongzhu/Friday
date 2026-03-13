import {
  asString,
  compact,
  findWorkflowDeployIssue,
  requireAutofixContext,
  requireDiagnosisContext,
  summarizeActionRecord,
  summarizeIncidentRecord,
} from "../_shared/friday-runtime-skill-utils.mjs";

export async function execute(input = {}, ctx = {}) {
  const diagnosis = requireDiagnosisContext(ctx);
  const autofix = requireAutofixContext(ctx);
  const requestedIncidentId = typeof input.incidentId === "string" && input.incidentId.trim().length > 0
    ? input.incidentId.trim()
    : undefined;

  const issueCards = await diagnosis.listIssueCards(10);
  const incidentRecord = requestedIncidentId ? await diagnosis.getIncident(requestedIncidentId) : null;
  const incidents = incidentRecord ? [incidentRecord] : await diagnosis.listIncidents(12);
  const match = findWorkflowDeployIssue(issueCards, incidents);
  const incidentSummary = match.incidentRecord ? summarizeIncidentRecord(match.incidentRecord) : null;

  let actionDetails = null;
  const matchedActionId =
    asString(match.issueCard?.actionId)
    || asString(match.incidentRecord?.action?.actionId);
  if (matchedActionId) {
    actionDetails = await autofix.getAction(matchedActionId);
  }
  const actionSummary = actionDetails
    ? summarizeActionRecord(actionDetails)
    : match.incidentRecord?.action
      ? summarizeActionRecord(match.incidentRecord.action)
      : null;

  let nextStep = "Friday does not currently have a workflow/deploy incident to recover. Use review-open-issues to inspect the broader issue queue.";
  if (actionSummary?.requiresApproval) {
    nextStep = "A deploy recovery action exists but needs approval. Review the rollback plan and approval trail before executing it.";
  } else if (actionSummary) {
    nextStep = "A bounded recovery action is available. Review the plan summary and verify the workflow after the fix path is chosen.";
  } else if (incidentSummary) {
    nextStep = "Use the root-cause summary to narrow the failure source before generating or approving any repair.";
  }

  const summary = incidentSummary
    ? compact(
      `Failed deploy recovery: ${incidentSummary.rootCauseSummary} Severity is ${incidentSummary.severity}${actionSummary ? `; suggested action: ${actionSummary.title}.` : "."}`,
      220,
    )
    : "Friday does not currently have an open failed-deploy incident to summarize.";

  return {
    summary,
    nextStep,
    details: {
      issueCard: match.issueCard,
      incident: incidentSummary,
      action: actionSummary,
      recommendedTemplateId: "recover-failed-deploy",
      recommendedSkillId: actionSummary ? "autofix-readiness-review" : "review-open-issues",
    },
  };
}
