import {
  requireBrowserContext,
  asString,
  browserRuntimeBlockedResult,
} from "../_shared/friday-runtime-skill-utils.mjs";

const URL_PATTERN = /https?:\/\/[^\s)]+/i;

function pickUrl(input) {
  if (typeof input.url === "string" && input.url.trim().length > 0) {
    return input.url.trim();
  }
  const goal = typeof input.goal === "string" ? input.goal : typeof input.text === "string" ? input.text : "";
  const match = goal.match(URL_PATTERN);
  return match?.[0] ?? "http://127.0.0.1:5173";
}

function buildFindings(inspection) {
  const findings = [];
  if (typeof inspection.status === "number" && inspection.status >= 400) {
    findings.push({
      severity: "high",
      title: "Page returned an error status",
      detail: `${inspection.finalUrl} returned HTTP ${String(inspection.status)}.`,
    });
  }
  if (inspection.consoleErrors.length > 0) {
    findings.push({
      severity: "high",
      title: "Console errors detected",
      detail: inspection.consoleErrors.slice(0, 3).map((entry) => entry.text).join(" | "),
    });
  }
  if (inspection.pageErrors.length > 0) {
    findings.push({
      severity: "high",
      title: "Unhandled page errors detected",
      detail: inspection.pageErrors.slice(0, 3).join(" | "),
    });
  }
  if (inspection.requestFailures.length > 0) {
    findings.push({
      severity: "medium",
      title: "Network request failures detected",
      detail: inspection.requestFailures
        .slice(0, 3)
        .map((entry) => `${entry.method} ${entry.url}`)
        .join(" | "),
    });
  }
  if (!inspection.title) {
    findings.push({
      severity: "low",
      title: "Page title is empty",
      detail: "The browser reached the page, but the document title is blank.",
    });
  }
  return findings;
}

export async function execute(input = {}, ctx = {}) {
  const url = pickUrl(input);
  const expectedText = asString(input.expectedText);
  let sessionId = "";
  let browser;

  try {
    browser = requireBrowserContext(ctx);
  } catch (error) {
    const blocked = browserRuntimeBlockedResult({
      error,
      skillLabel: "Browser QA report",
      suggestedSkillId: "browser-qa-report",
      details: {
        requestedUrl: url,
      },
    });
    if (blocked) {
      return blocked;
    }
    throw error;
  }

  try {
    let inspection;
    try {
      inspection = await browser.inspectPage({
        url,
        screenshotName: "browser-qa-report",
        waitUntil: "domcontentloaded",
      });
    } catch (error) {
      const blocked = browserRuntimeBlockedResult({
        error,
        skillLabel: "Browser QA report",
        suggestedSkillId: "browser-qa-report",
        details: {
          requestedUrl: url,
        },
      });
      if (blocked) {
        return blocked;
      }
      throw error;
    }
    sessionId = inspection.sessionId;

    const findings = buildFindings(inspection);
    if (expectedText && !inspection.snapshot.toLowerCase().includes(expectedText.toLowerCase())) {
      findings.push({
        severity: "medium",
        title: "Expected text was not visible in the accessibility snapshot",
        detail: `Expected to find "${expectedText}" in the rendered page snapshot.`,
      });
    }

    return {
      summary: findings.length === 0
        ? `Browser QA report: no blocking issues detected on ${inspection.finalUrl}.`
        : `Browser QA report: ${String(findings.length)} issue(s) detected on ${inspection.finalUrl}.`,
      nextStep: findings.length === 0
        ? "Capture the next critical route or proceed to release validation with this evidence."
        : `Fix the highest-severity issue first: ${findings[0].title}.`,
      details: {
        requestedUrl: inspection.requestedUrl,
        finalUrl: inspection.finalUrl,
        title: inspection.title,
        status: inspection.status,
        screenshotPath: inspection.screenshotPath,
        snapshot: inspection.snapshot,
        findings,
        consoleErrors: inspection.consoleErrors,
        consoleWarnings: inspection.consoleWarnings,
        pageErrors: inspection.pageErrors,
        requestFailures: inspection.requestFailures,
        timings: inspection.timings,
        suggestedSkillId: findings.length > 0 ? "workspace-diff-review" : "release-doc-sync",
      },
    };
  } finally {
    if (sessionId) {
      await browser.closeSession(sessionId).catch(() => undefined);
    }
  }
}
