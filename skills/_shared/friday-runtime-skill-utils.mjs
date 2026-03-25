function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function requireSystemContext(ctx) {
  if (!ctx?.system || typeof ctx.system.getSnapshot !== "function") {
    throw new Error("This skill requires Friday's readonly system runtime context.");
  }
  return ctx.system;
}

export function requireDiagnosisContext(ctx) {
  if (
    !ctx?.diagnosis
    || typeof ctx.diagnosis.listIssueCards !== "function"
    || typeof ctx.diagnosis.listIncidents !== "function"
    || typeof ctx.diagnosis.getIncident !== "function"
  ) {
    throw new Error("This skill requires Friday's readonly diagnosis runtime context.");
  }
  return ctx.diagnosis;
}

export function requireAutofixContext(ctx) {
  if (
    !ctx?.autofix
    || typeof ctx.autofix.listActions !== "function"
    || typeof ctx.autofix.getAction !== "function"
  ) {
    throw new Error("This skill requires Friday's readonly autofix runtime context.");
  }
  return ctx.autofix;
}

export function requireBrowserContext(ctx) {
  if (
    !ctx?.browser
    || typeof ctx.browser.inspectPage !== "function"
    || typeof ctx.browser.closeSession !== "function"
  ) {
    throw new Error("This skill requires Friday's readonly browser runtime context.");
  }
  return ctx.browser;
}

function errorMessage(error) {
  if (typeof error === "string") {
    return error.trim();
  }
  if (error instanceof Error) {
    return error.message.trim();
  }
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message.trim();
  }
  return "";
}

export function describeBrowserRuntimeFailure(error) {
  const message = errorMessage(error);
  if (!message) {
    return null;
  }
  if (
    message === "This skill requires Friday's readonly browser runtime context."
    || /browserType\.launch:/i.test(message)
    || /Executable doesn't exist/i.test(message)
    || /Please run the following command/i.test(message)
  ) {
    return {
      reason: message,
      nextStep:
        "Install Playwright browsers with `npx playwright install chromium`, or rerun Friday in a browser-enabled runtime, then retry this skill.",
    };
  }
  return null;
}

export function browserRuntimeBlockedResult(input) {
  const failure = describeBrowserRuntimeFailure(input.error);
  if (!failure) {
    return null;
  }
  return {
    summary: `${input.skillLabel}: browser runtime is unavailable, so Friday returned a blocked report instead of failing the run.`,
    nextStep: input.nextStep ?? failure.nextStep,
    details: {
      ...(input.details ?? {}),
      runtimeUnavailable: true,
      requiresRuntimeSetup: true,
      blockedReason: failure.reason,
      suggestedSkillId: input.suggestedSkillId,
    },
  };
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value) {
  return isRecord(value) ? value : {};
}

export function asString(value, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function severityRank(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

export function compact(text, max = 180) {
  const value = asString(text);
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function pickTopIssueCard(issueCards) {
  return [...issueCards].sort((left, right) => {
    const kindScore = (value) => {
      if (value === "approval_required") return 3;
      if (value === "failed_fix") return 2;
      if (value === "incident") return 1;
      return 0;
    };
    const severityDiff = severityRank(right.severity) - severityRank(left.severity);
    if (severityDiff !== 0) return severityDiff;
    const kindDiff = kindScore(right.kind) - kindScore(left.kind);
    if (kindDiff !== 0) return kindDiff;
    return asString(left.createdAt).localeCompare(asString(right.createdAt));
  })[0] ?? null;
}

export function summarizeIssueCard(issueCard) {
  if (!issueCard) {
    return "Friday does not currently have any open issue cards.";
  }
  return compact(
    `${asString(issueCard.title, "Issue")}: ${asString(issueCard.summary, "No summary yet.")}`,
    220,
  );
}

export function summarizeIncidentRecord(incidentRecord) {
  const incident = asRecord(incidentRecord?.incident);
  const summary = asRecord(incidentRecord?.summary);
  return {
    incidentId: asString(incident.incidentId),
    category: asString(incident.category, "unknown"),
    severity: asString(incident.severity, "unknown"),
    status: asString(incident.status, "unknown"),
    rootCauseSummary:
      asString(summary.rootCauseSummary)
      || asString(asRecord(incidentRecord?.diagnosis).diagnosis?.summary)
      || "No diagnosis summary yet.",
    autoFixEligible: Boolean(summary.autoFixEligible ?? incident.autoFixEligible),
  };
}

export function summarizeActionRecord(actionRecord) {
  const action = asRecord(actionRecord?.action);
  const risk = asRecord(actionRecord?.risk);
  const evidence = asRecord(actionRecord?.evidence);
  const selectedPlan = asRecord(evidence.selectedPlan);
  const approval = asRecord(actionRecord?.approval);
  return {
    actionId: asString(action.actionId),
    incidentId: asString(action.incidentId),
    status: asString(action.status, "unknown"),
    outcome: action.outcome ?? null,
    riskTier: asNumber(action.riskTier, asNumber(risk.riskTier, -1)),
    requiresApproval: Boolean(risk.requiresApproval),
    autoApplyAllowed: Boolean(risk.autoApplyAllowed),
    title: asString(selectedPlan.title) || asString(asRecord(action.plan).title, "Auto-fix action"),
    summary: asString(selectedPlan.summary) || asString(asRecord(action.plan).summary, "No action summary yet."),
    approvalStatus: asString(approval.status),
  };
}

export function findWorkflowDeployIssue(issueCards, incidents) {
  const workflowIssueCard = issueCards.find((issue) =>
    /workflow|deploy/i.test(`${asString(issue.title)} ${asString(issue.summary)}`),
  );
  if (workflowIssueCard) {
    return {
      issueCard: workflowIssueCard,
      incidentRecord: incidents.find((incident) => asString(asRecord(incident?.incident).incidentId) === workflowIssueCard.incidentId) ?? null,
    };
  }

  const workflowIncident = incidents.find((incident) => {
    const incidentData = asRecord(incident?.incident);
    const summary = asRecord(incident?.summary);
    return incidentData.category === "workflow"
      || /workflow|deploy/i.test(`${asString(summary.rootCauseSummary)} ${asString(incidentData.signature)}`);
  });

  return {
    issueCard: workflowIncident
      ? issueCards.find((issue) => issue.incidentId === asString(asRecord(workflowIncident.incident).incidentId)) ?? null
      : null,
    incidentRecord: workflowIncident ?? null,
  };
}
