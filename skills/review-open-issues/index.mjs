import {
  countBy,
  pickTopIssueCard,
  requireDiagnosisContext,
  severityRank,
  summarizeIncidentRecord,
  summarizeIssueCard,
} from "../_shared/friday-runtime-skill-utils.mjs";

function parseLimit(input) {
  return typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(20, Math.floor(input.limit)))
    : 8;
}

export async function execute(input = {}, ctx = {}) {
  const diagnosis = requireDiagnosisContext(ctx);
  const limit = parseLimit(input);
  const issueCards = await diagnosis.listIssueCards(limit);
  const incidents = await diagnosis.listIncidents(limit);
  const summarizedIncidents = incidents
    .map((incident) => summarizeIncidentRecord(incident))
    .sort((left, right) => {
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff !== 0) return severityDiff;
      return Number(right.autoFixEligible) - Number(left.autoFixEligible);
    });
  const topIssue = pickTopIssueCard(issueCards);
  const issueCounts = countBy(issueCards, (issue) => issue.kind);
  const topIncident = summarizedIncidents[0] ?? null;

  let nextStep = "Run system-health-snapshot if you need runtime context before choosing a fix path.";
  if (topIssue?.kind === "approval_required") {
    nextStep = "Run autofix-readiness-review to see which planned fix is blocked on approval and whether it has a rollback path.";
  } else if (topIssue) {
    nextStep = "Open the review-issues assistant flow or inspect the top incident directly before changing anything.";
  } else if (topIncident) {
    nextStep = "Review the top incident summary and only move into recovery after the root-cause summary is clear.";
  }

  const summary = issueCards.length > 0
    ? `Friday has ${issueCards.length} open issue card(s). Top issue: ${summarizeIssueCard(topIssue)}`
    : incidents.length > 0
      ? `Friday has ${incidents.length} diagnosis incident(s) but no issue cards. Top incident: ${topIncident?.rootCauseSummary ?? "No diagnosis summary yet."}`
      : "Friday does not currently have any open issue cards or diagnosis incidents.";

  return {
    summary,
    nextStep,
    details: {
      issueCount: issueCards.length,
      incidentCount: incidents.length,
      issueCounts,
      topIssue,
      topIncident,
      issueCards: issueCards.slice(0, 6),
      incidents: summarizedIncidents.slice(0, 6),
      recommendedTemplateId: "review-issues",
      recommendedSkillId: topIssue?.kind === "approval_required" ? "autofix-readiness-review" : "system-health-snapshot",
    },
  };
}
