import path from "node:path";
import {
  asNumber,
  asString,
  browserRuntimeBlockedResult,
  requireBrowserContext,
} from "../_shared/friday-runtime-skill-utils.mjs";
import {
  findRepoRoot,
  readJsonFile,
  readWorkspaceRoot,
  safePathSegment,
  skillEvidenceRoot,
  writeSkillEvidenceJson,
} from "../_shared/devops-skill-utils.mjs";

const URL_PATTERN = /https?:\/\/[^\s)]+/i;
const SKILL_ID = "page-benchmark-report";

function pickUrl(input) {
  if (typeof input.url === "string" && input.url.trim().length > 0) {
    return input.url.trim();
  }
  const goal = asString(input.goal ?? input.text);
  const match = goal.match(URL_PATTERN);
  return match?.[0] ?? "http://127.0.0.1:5173";
}

function clampRepeats(input) {
  const repeats = Math.round(asNumber(input.repeats, 3));
  return Math.min(5, Math.max(1, repeats));
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarizeSamples(samples) {
  return {
    sampleCount: samples.length,
    statusCodes: [...new Set(samples.map((sample) => sample.status).filter((value) => value != null))],
    domContentLoadedMsMedian: median(samples.map((sample) => sample.timings.domContentLoadedMs)),
    loadMsMedian: median(samples.map((sample) => sample.timings.loadMs)),
    consoleErrorCount: samples.reduce((sum, sample) => sum + sample.consoleErrors.length, 0),
    requestFailureCount: samples.reduce((sum, sample) => sum + sample.requestFailures.length, 0),
    screenshotPaths: samples.map((sample) => sample.screenshotPath).filter(Boolean),
  };
}

function compareAgainstBaseline(current, baseline) {
  if (!baseline) {
    return {
      state: "baseline_created",
      findings: [],
    };
  }

  const findings = [];
  const compareMetric = (label, currentValue, baselineValue) => {
    if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue) || baselineValue <= 0) {
      return;
    }
    const deltaRatio = (currentValue - baselineValue) / baselineValue;
    if (deltaRatio >= 0.15) {
      findings.push({
        severity: "medium",
        title: `${label} regressed`,
        detail: `${label} moved from ${baselineValue}ms to ${currentValue}ms (${Math.round(deltaRatio * 100)}% slower).`,
      });
    } else if (deltaRatio <= -0.15) {
      findings.push({
        severity: "low",
        title: `${label} improved`,
        detail: `${label} moved from ${baselineValue}ms to ${currentValue}ms (${Math.abs(Math.round(deltaRatio * 100))}% faster).`,
      });
    }
  };

  compareMetric("DOM content loaded", current.domContentLoadedMsMedian, baseline.metrics?.domContentLoadedMsMedian);
  compareMetric("Load event", current.loadMsMedian, baseline.metrics?.loadMsMedian);

  if ((current.consoleErrorCount ?? 0) > (baseline.metrics?.consoleErrorCount ?? 0)) {
    findings.push({
      severity: "high",
      title: "New console errors appeared",
      detail: `Console errors increased from ${baseline.metrics?.consoleErrorCount ?? 0} to ${current.consoleErrorCount}.`,
    });
  }
  if ((current.requestFailureCount ?? 0) > (baseline.metrics?.requestFailureCount ?? 0)) {
    findings.push({
      severity: "high",
      title: "New request failures appeared",
      detail: `Request failures increased from ${baseline.metrics?.requestFailureCount ?? 0} to ${current.requestFailureCount}.`,
    });
  }

  const hasRegression = findings.some((finding) => finding.severity === "high" || /regressed/.test(finding.title));
  const hasImprovement = findings.some((finding) => /improved/.test(finding.title));
  return {
    state: hasRegression ? "regression" : hasImprovement ? "improved" : "stable",
    findings,
  };
}

export async function execute(input = {}, ctx = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const url = pickUrl(input);
  const repeats = clampRepeats(input);
  const slug = safePathSegment(url, "default");
  const expectedText = asString(input.expectedText);
  const refreshBaseline = input.refreshBaseline === true;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceRoot = skillEvidenceRoot(repoRoot, SKILL_ID);
  const baselinePath = path.join(evidenceRoot, "baselines", `${slug}.json`);
  let baseline = await readJsonFile(baselinePath);
  let sessionId = "";
  let browser;

  try {
    browser = requireBrowserContext(ctx);
  } catch (error) {
    const blocked = browserRuntimeBlockedResult({
      error,
      skillLabel: "Page benchmark report",
      suggestedSkillId: "page-benchmark-report",
      details: {
        url,
        repeats,
        baselinePath,
      },
    });
    if (blocked) {
      return blocked;
    }
    throw error;
  }

  try {
    const samples = [];
    for (let index = 0; index < repeats; index += 1) {
      let inspection;
      try {
        inspection = await browser.inspectPage({
          url,
          sessionId: sessionId || undefined,
          waitUntil: "load",
          screenshotName: `benchmark-${index + 1}`,
        });
      } catch (error) {
        const blocked = browserRuntimeBlockedResult({
          error,
          skillLabel: "Page benchmark report",
          suggestedSkillId: "page-benchmark-report",
          details: {
            url,
            repeats,
            baselinePath,
          },
        });
        if (blocked) {
          return blocked;
        }
        throw error;
      }
      sessionId = inspection.sessionId;
      samples.push(inspection);
    }

    const metrics = summarizeSamples(samples);
    const comparison = compareAgainstBaseline(metrics, baseline);
    if (expectedText && !samples.at(-1)?.snapshot?.toLowerCase().includes(expectedText.toLowerCase())) {
      comparison.findings.push({
        severity: "medium",
        title: "Expected text missing from benchmark target",
        detail: `Expected to find "${expectedText}" in the rendered accessibility snapshot.`,
      });
    }

    const runPayload = {
      url,
      repeats,
      sampledAt: new Date().toISOString(),
      metrics,
      findings: comparison.findings,
      baselinePath,
      samples: samples.map((sample) => ({
        finalUrl: sample.finalUrl,
        status: sample.status,
        title: sample.title,
        screenshotPath: sample.screenshotPath,
        consoleErrors: sample.consoleErrors,
        requestFailures: sample.requestFailures,
        timings: sample.timings,
      })),
    };

    const runPath = await writeSkillEvidenceJson(repoRoot, SKILL_ID, path.join("runs", `${timestamp}-${slug}.json`), runPayload);
    let baselineUpdated = false;
    if (!baseline || refreshBaseline) {
      baseline = {
        createdAt: new Date().toISOString(),
        url,
        metrics,
        sourceRunPath: runPath,
      };
      await writeSkillEvidenceJson(repoRoot, SKILL_ID, path.join("baselines", `${slug}.json`), baseline);
      baselineUpdated = true;
    }

    const summary = comparison.state === "baseline_created"
      ? `Page benchmark report: created a local baseline for ${url}.`
      : comparison.state === "regression"
        ? `Page benchmark report: regression detected on ${url}.`
        : comparison.state === "improved"
          ? `Page benchmark report: ${url} improved relative to the saved baseline.`
          : `Page benchmark report: ${url} is stable relative to the saved baseline.`;

    return {
      summary,
      nextStep: comparison.state === "regression"
        ? "Inspect the slowest metric and any new errors before landing or deploying."
        : baselineUpdated
          ? "Rerun this benchmark after the next material change to measure drift."
          : "Use this baseline in release canary checks or rerun after the next significant UI change.",
      details: {
        url,
        repeats,
        metrics,
        comparisonState: comparison.state,
        findings: comparison.findings,
        runPath,
        baselinePath,
        baselineUpdated,
        suggestedSkillId: comparison.state === "regression" ? "release-canary-check" : "browser-qa-report",
      },
    };
  } finally {
    if (sessionId) {
      await browser.closeSession(sessionId).catch(() => undefined);
    }
  }
}
