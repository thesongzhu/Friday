import * as fs from "node:fs/promises";
import path from "node:path";
import {
  asArray,
  asString,
  browserRuntimeBlockedResult,
  requireBrowserContext,
} from "../_shared/friday-runtime-skill-utils.mjs";
import {
  ensureDir,
  findRepoRoot,
  readJsonFile,
  readWorkspaceRoot,
  safePathSegment,
  skillEvidenceRoot,
  writeSkillEvidenceJson,
} from "../_shared/devops-skill-utils.mjs";

const SKILL_ID = "release-canary-check";
const URL_PATTERN = /https?:\/\/[^\s)]+/gi;

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function pickUrls(input) {
  const urls = unique(
    asArray(input.urls)
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean),
  );
  if (urls.length > 0) {
    return urls.slice(0, 5);
  }
  if (typeof input.url === "string" && input.url.trim().length > 0) {
    return [input.url.trim()];
  }
  const goal = asString(input.goal ?? input.text);
  const matches = goal.match(URL_PATTERN) ?? [];
  if (matches.length > 0) {
    return unique(matches.map((value) => value.trim())).slice(0, 5);
  }
  return ["http://127.0.0.1:5173"];
}

function pickExpectedText(input) {
  const raw = input.expectedTexts ?? input.expectedText;
  if (typeof raw === "string") {
    return [raw.trim()].filter(Boolean);
  }
  return unique(asArray(raw).map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean));
}

async function readLatestRun(evidenceRoot, slug) {
  const runsDir = path.join(evidenceRoot, "runs", slug);
  await ensureDir(runsDir);
  try {
    const entries = await fs.readdir(runsDir);
    const files = entries.filter((entry) => entry.endsWith(".json")).sort();
    const latest = files.at(-1);
    return latest ? await readJsonFile(path.join(runsDir, latest)) : null;
  } catch {
    return null;
  }
}

function buildFindings(inspection, expectedTexts, previousRun) {
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
      title: "Request failures detected",
      detail: inspection.requestFailures
        .slice(0, 3)
        .map((entry) => `${entry.method} ${entry.url}`)
        .join(" | "),
    });
  }
  for (const text of expectedTexts) {
    if (!inspection.snapshot.toLowerCase().includes(text.toLowerCase())) {
      findings.push({
        severity: "medium",
        title: "Expected text missing",
        detail: `Expected to find "${text}" in the rendered accessibility snapshot.`,
      });
    }
  }

  const previousSummary = previousRun?.summary ?? null;
  if (previousSummary) {
    const previousConsoleErrorCount = Array.isArray(previousSummary.consoleErrors)
      ? previousSummary.consoleErrors.length
      : 0;
    const previousRequestFailureCount = Array.isArray(previousSummary.requestFailures)
      ? previousSummary.requestFailures.length
      : 0;
    const previousLoadMs = Number(previousSummary.timings?.loadMs);
    const currentLoadMs = Number(inspection.timings?.loadMs);

    if (inspection.consoleErrors.length > previousConsoleErrorCount) {
      findings.push({
        severity: "high",
        title: "New console errors appeared since the last canary run",
        detail: `Console errors increased from ${previousConsoleErrorCount} to ${inspection.consoleErrors.length}.`,
      });
    }
    if (inspection.requestFailures.length > previousRequestFailureCount) {
      findings.push({
        severity: "high",
        title: "New request failures appeared since the last canary run",
        detail: `Request failures increased from ${previousRequestFailureCount} to ${inspection.requestFailures.length}.`,
      });
    }
    if (
      Number.isFinite(previousLoadMs)
      && previousLoadMs > 0
      && Number.isFinite(currentLoadMs)
      && currentLoadMs >= previousLoadMs * 1.2
    ) {
      const deltaPercent = Math.round(((currentLoadMs - previousLoadMs) / previousLoadMs) * 100);
      findings.push({
        severity: "medium",
        title: "Page load timing regressed since the last canary run",
        detail: `Load time moved from ${previousLoadMs}ms to ${currentLoadMs}ms (${deltaPercent}% slower).`,
      });
    }
  }

  return findings;
}

export async function execute(input = {}, ctx = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const evidenceRoot = skillEvidenceRoot(repoRoot, SKILL_ID);
  const urls = pickUrls(input);
  const expectedTexts = pickExpectedText(input);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  const sessions = new Set();
  let browser;

  try {
    browser = requireBrowserContext(ctx);
  } catch (error) {
    const blocked = browserRuntimeBlockedResult({
      error,
      skillLabel: "Release canary check",
      suggestedSkillId: "release-canary-check",
      details: {
        urls,
        expectedTexts,
      },
    });
    if (blocked) {
      return blocked;
    }
    throw error;
  }

  try {
    for (const url of urls) {
      const slug = safePathSegment(url, "default");
      const previousRun = await readLatestRun(evidenceRoot, slug);
      let inspection;
      try {
        inspection = await browser.inspectPage({
          url,
          waitUntil: "load",
          screenshotName: `canary-${slug}`,
        });
      } catch (error) {
        const blocked = browserRuntimeBlockedResult({
          error,
          skillLabel: "Release canary check",
          suggestedSkillId: "release-canary-check",
          details: {
            urls,
            expectedTexts,
          },
        });
        if (blocked) {
          return blocked;
        }
        throw error;
      }
      sessions.add(inspection.sessionId);

      const findings = buildFindings(inspection, expectedTexts, previousRun);
      const runPayload = {
        url,
        checkedAt: new Date().toISOString(),
        summary: {
          finalUrl: inspection.finalUrl,
          status: inspection.status,
          title: inspection.title,
          screenshotPath: inspection.screenshotPath,
          consoleErrors: inspection.consoleErrors,
          consoleWarnings: inspection.consoleWarnings,
          pageErrors: inspection.pageErrors,
          requestFailures: inspection.requestFailures,
          timings: inspection.timings,
          findings,
        },
        previousRunPath: previousRun?.runPath ?? null,
      };
      const runPath = await writeSkillEvidenceJson(repoRoot, SKILL_ID, path.join("runs", slug, `${timestamp}.json`), {
        ...runPayload,
        runPath: path.join(".friday", "skills", SKILL_ID, "runs", slug, `${timestamp}.json`),
      });
      results.push({
        url,
        slug,
        findings,
        status: inspection.status,
        finalUrl: inspection.finalUrl,
        title: inspection.title,
        screenshotPath: inspection.screenshotPath,
        consoleErrors: inspection.consoleErrors,
        requestFailures: inspection.requestFailures,
        timings: inspection.timings,
        runPath,
      });
    }

    const allFindings = results.flatMap((result) => result.findings);
    const highSeverity = allFindings.find((finding) => finding.severity === "high");

    return {
      summary: allFindings.length > 0
        ? `Release canary check: ${allFindings.length} issue(s) detected across ${results.length} page(s).`
        : `Release canary check: ${results.length} page(s) passed without blocking canary issues.`,
      nextStep: highSeverity
        ? `Investigate the first blocking canary issue: ${highSeverity.title}.`
        : "Keep this canary report as the current local reference or rerun it after the next deploy.",
      details: {
        urls,
        expectedTexts,
        findings: allFindings,
        pages: results,
        suggestedSkillId: allFindings.length > 0 ? "browser-qa-fix" : "page-benchmark-report",
      },
    };
  } finally {
    for (const sessionId of sessions) {
      await browser.closeSession(sessionId).catch(() => undefined);
    }
  }
}
