import path from "node:path";
import { resolveLatestPointerPath, writeJson, writeText } from "./io.mjs";
import { summarizeNumbers } from "./stats.mjs";

const RESULT_ORDER = ["failed", "manual_review", "partial", "blocked", "passed"];

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function safeRate(numerator, denominator) {
  if (!denominator) return undefined;
  return numerator / denominator;
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function worstResult(results) {
  for (const result of RESULT_ORDER) {
    if (results.includes(result)) return result;
  }
  return "passed";
}

function groupArtifacts(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const key = `${artifact.scenarioId}::${artifact.lane}`;
    const list = groups.get(key) ?? [];
    list.push(artifact);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, items]) => {
    const metrics = {};
    for (const metricName of new Set(items.flatMap((item) => Object.keys(item.metrics ?? {})))) {
      metrics[metricName] = summarizeNumbers(items.map((item) => item.metrics?.[metricName]));
    }
    return {
      key,
      scenarioId: items[0].scenarioId,
      lane: items[0].lane,
      attempts: items.length,
      worstResult: worstResult(items.map((item) => item.result)),
      resultCounts: countBy(items.map((item) => item.result)),
      metrics,
      failures: items.filter((item) => item.result !== "passed"),
    };
  });
}

function summarizeAggregates({ artifacts, grouped, envTruth }) {
  const executedArtifacts = artifacts.filter((artifact) => !["blocked", "manual_review"].includes(artifact.result));
  const misrouteArtifacts = executedArtifacts.filter((artifact) =>
    artifact.misrouteClass || artifact.failureClass === "ui_misroute" || artifact.failureClass === "llm_misroute"
  );
  const uiWrongSurfaceFailures = artifacts.filter((artifact) => artifact.failureClass === "ui_misroute");
  const contextEstimatedInputTokens = summarizeNumbers(artifacts.map((artifact) => artifact.metrics?.contextEstimatedInputTokens));
  const uiRequestCount = summarizeNumbers(artifacts.map((artifact) => artifact.metrics?.uiRequestCount));

  const defaultArtifacts = executedArtifacts.filter((artifact) => artifact.lane === "default");
  const fallbackArtifacts = executedArtifacts.filter((artifact) => artifact.lane === "fallback");
  const fallbackComparison = {
    defaultAttempts: defaultArtifacts.length,
    fallbackAttempts: fallbackArtifacts.length,
    defaultPassRate: safeRate(defaultArtifacts.filter((artifact) => artifact.result === "passed").length, defaultArtifacts.length),
    fallbackPassRate: safeRate(fallbackArtifacts.filter((artifact) => artifact.result === "passed").length, fallbackArtifacts.length),
    delta: undefined,
    perScenario: [],
  };
  if (typeof fallbackComparison.defaultPassRate === "number" && typeof fallbackComparison.fallbackPassRate === "number") {
    fallbackComparison.delta = fallbackComparison.fallbackPassRate - fallbackComparison.defaultPassRate;
  }

  for (const scenarioId of [...new Set(grouped.map((entry) => entry.scenarioId))]) {
    const defaultEntry = grouped.find((entry) => entry.scenarioId === scenarioId && entry.lane === "default");
    const fallbackEntry = grouped.find((entry) => entry.scenarioId === scenarioId && entry.lane === "fallback");
    if (!defaultEntry || !fallbackEntry) continue;
    const defaultPassRate = safeRate(defaultEntry.resultCounts.passed ?? 0, defaultEntry.attempts);
    const fallbackPassRate = safeRate(fallbackEntry.resultCounts.passed ?? 0, fallbackEntry.attempts);
    fallbackComparison.perScenario.push({
      scenarioId,
      defaultAttempts: defaultEntry.attempts,
      fallbackAttempts: fallbackEntry.attempts,
      defaultPassRate,
      fallbackPassRate,
      delta: typeof defaultPassRate === "number" && typeof fallbackPassRate === "number"
        ? fallbackPassRate - defaultPassRate
        : undefined,
    });
  }

  return {
    misrouteRate: safeRate(misrouteArtifacts.length, executedArtifacts.length),
    misrouteCount: misrouteArtifacts.length,
    executedArtifactCount: executedArtifacts.length,
    uiWrongSurfaceFailures: uiWrongSurfaceFailures.length,
    contextEstimatedInputTokens,
    uiRequestCount,
    fallbackComparison,
    setupUserProfileTruthMismatch: envTruth?.derived?.setupUserProfileTruthMismatch === true,
  };
}

function countProviderAttempts(artifacts) {
  return artifacts.filter((artifact) =>
    artifact?.lane === "default" || artifact?.lane === "fallback"
  ).length;
}

function countBrowserProbeAttempts(artifacts) {
  return artifacts.filter((artifact) =>
    typeof artifact?.metrics?.uiRequestCount === "number"
  ).length;
}

function renderCoverageMatrix({ scenarios, grouped }) {
  const byKey = new Map(grouped.map((entry) => [`${entry.scenarioId}::${entry.lane}`, entry]));
  const lines = [
    "# Coverage Matrix",
    "",
    "| Scenario | Layer | Lane | Attempts | Worst | Notes |",
    "| --- | --- | --- | ---: | --- | --- |",
  ];
  for (const scenario of scenarios) {
    const matching = grouped.filter((entry) => entry.scenarioId === scenario.id);
    if (matching.length === 0) {
      lines.push(`| ${scenario.id} | ${scenario.layer} | - | 0 | not-run | filtered or blocked before execution |`);
      continue;
    }
    for (const entry of matching) {
      const sampleFailure = entry.failures[0];
      lines.push(
        `| ${scenario.id} | ${scenario.layer} | ${entry.lane} | ${String(entry.attempts)} | ${entry.worstResult} | ${sampleFailure?.notes?.[0] ?? ""} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function renderStabilityReport({ artifacts, grouped, envTruth, aggregates }) {
  const authLabel = envTruth.auth.ok
    ? `ok (${envTruth.auth.user?.id ?? "unknown user"} via ${envTruth.auth.source ?? envTruth.auth.mode ?? "unknown"})`
    : `failed (${envTruth.auth.error}${envTruth.auth.source ? `; source=${envTruth.auth.source}` : ""})`;
  const lines = [
    "# Stability Report",
    "",
    `- Collected at: ${envTruth.collectedAt}`,
    `- Public health: ${envTruth.publicChecks.health.ok ? "ok" : "failed"} (${String(envTruth.publicChecks.health.status)})`,
    `- Auth: ${authLabel}`,
    `- needsSetup: ${String(envTruth.setupStatus?.needsSetup ?? "unknown")}`,
    `- userProfile.profileType: ${envTruth.userProfile?.profileType ?? "null"}`,
    `- userProfile.onboardedAt: ${envTruth.userProfile?.onboardedAt ?? "null"}`,
    `- setup/user-profile truth mismatch: ${aggregates.setupUserProfileTruthMismatch ? "yes" : "no"}`,
    "",
    "## Result Summary",
    "",
  ];
  const results = countBy(artifacts.map((artifact) => artifact.result));
  for (const result of RESULT_ORDER.slice().reverse()) {
    if (results[result]) {
      lines.push(`- ${result}: ${String(results[result])}`);
    }
  }
  lines.push("", "## Aggregate Signals", "");
  lines.push(`- misroute rate: ${formatPercent(aggregates.misrouteRate)} (${String(aggregates.misrouteCount)}/${String(aggregates.executedArtifactCount)})`);
  lines.push(`- ui wrong-surface failures: ${String(aggregates.uiWrongSurfaceFailures)}`);
  lines.push(`- fallback completion delta: ${typeof aggregates.fallbackComparison.delta === "number" ? formatPercent(aggregates.fallbackComparison.delta) : "n/a"}`);
  lines.push("", "## Failing Scenario/Lane Groups", "");
  for (const entry of grouped.filter((item) => item.worstResult !== "passed")) {
    const sampleFailure = entry.failures[0];
    lines.push(
      `- ${entry.scenarioId} [${entry.lane}] -> ${entry.worstResult}; failure=${sampleFailure?.failureClass ?? "n/a"}; note=${sampleFailure?.notes?.[0] ?? "n/a"}`,
    );
  }
  if (!grouped.some((item) => item.worstResult !== "passed")) {
    lines.push("- No failing groups.");
  }
  return lines.join("\n") + "\n";
}

function renderPerformanceReport({ grouped, aggregates }) {
  const lines = [
    "# Performance Report",
    "",
    "## Signal Highlights",
    "",
    `- contextEstimatedInputTokens p50/p95: ${aggregates.contextEstimatedInputTokens.p50 ?? "n/a"} / ${aggregates.contextEstimatedInputTokens.p95 ?? "n/a"}`,
    `- uiRequestCount p50/p95: ${aggregates.uiRequestCount.p50 ?? "n/a"} / ${aggregates.uiRequestCount.p95 ?? "n/a"}`,
    "",
    "## Metrics",
    "",
    "| Scenario | Lane | Metric | p50 | p95 | p99 | Avg |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const entry of grouped) {
    for (const [metricName, summary] of Object.entries(entry.metrics)) {
      if (summary.count === 0) continue;
      lines.push(
        `| ${entry.scenarioId} | ${entry.lane} | ${metricName} | ${summary.p50 ?? ""} | ${summary.p95 ?? ""} | ${summary.p99 ?? ""} | ${summary.average ?? ""} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function renderDefectLedger({ artifacts }) {
  const failing = artifacts.filter((artifact) => artifact.result !== "passed");
  const lines = [
    "# Defect Ledger",
    "",
    "| Scenario | Lane | Severity | Result | Failure Class | Bucket | Human Review | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const artifact of failing) {
    lines.push(
      `| ${artifact.scenarioId} | ${artifact.lane} | ${artifact.severity ?? ""} | ${artifact.result} | ${artifact.failureClass ?? ""} | ${artifact.defectBucket ?? ""} | ${artifact.humanReviewRequired ? "yes" : "no"} | ${(artifact.observedEvidence ?? []).slice(0, 2).join("; ")} |`,
    );
  }
  if (failing.length === 0) {
    lines.push("| - | - | - | - | - | - | - | No defects captured |");
  }
  return lines.join("\n") + "\n";
}

function renderIndex({ runId, suite, scenarios, grouped, envTruth, aggregates }) {
  const lines = [
    "# Real-World Validation Run",
    "",
    `- Run id: ${runId}`,
    `- Suite: ${suite}`,
    `- Scenario count: ${String(scenarios.length)}`,
    `- Executed lane groups: ${String(grouped.length)}`,
    `- Base URL: ${envTruth.baseUrl}`,
    `- UI Base URL: ${envTruth.uiBaseUrl}`,
    `- Auth mode: ${envTruth.auth.mode ?? "unknown"}`,
    `- Auth source: ${envTruth.auth.source ?? "unknown"}`,
    `- Setup/User-Profile Truth Mismatch: ${aggregates.setupUserProfileTruthMismatch ? "yes" : "no"}`,
    "",
    "## Reports",
    "",
    "- `coverage-matrix.md`",
    "- `stability-report.md`",
    "- `performance-report.md`",
    "- `defect-ledger.md`",
    "",
    "## Provider Lanes",
    "",
    `- Default: ${envTruth.providerLanes.default ? `${envTruth.providerLanes.default.providerName} / ${envTruth.providerLanes.default.model}` : "missing"}`,
    `- Fallback: ${envTruth.providerLanes.fallback ? `${envTruth.providerLanes.fallback.providerName} / ${envTruth.providerLanes.fallback.model}` : "missing"}`,
    "",
    "## Aggregate Signals",
    "",
    `- Misroute rate: ${formatPercent(aggregates.misrouteRate)}`,
    `- UI wrong-surface failures: ${String(aggregates.uiWrongSurfaceFailures)}`,
    `- Fallback completion delta: ${typeof aggregates.fallbackComparison.delta === "number" ? formatPercent(aggregates.fallbackComparison.delta) : "n/a"}`,
  ];
  return lines.join("\n") + "\n";
}

export function writeReports({
  repoRoot,
  reportRoot,
  runId,
  suite,
  scenarios,
  artifacts,
  envTruth,
  options,
}) {
  const grouped = groupArtifacts(artifacts);
  const aggregates = summarizeAggregates({ artifacts, grouped, envTruth });
  const resultCounts = countBy(artifacts.map((artifact) => artifact.result));
  const failingArtifacts = artifacts.filter((artifact) => artifact.result !== "passed");
  const failureClassCounts = countBy(
    failingArtifacts
      .map((artifact) => artifact.failureClass)
      .filter((value) => typeof value === "string" && value.length > 0),
  );
  const defectBucketCounts = countBy(
    failingArtifacts
      .map((artifact) => artifact.defectBucket)
      .filter((value) => typeof value === "string" && value.length > 0),
  );
  const summary = {
    runId,
    suite,
    generatedAt: new Date().toISOString(),
    scenarioCount: scenarios.length,
    selectedScenarioCount: scenarios.length,
    artifactCount: artifacts.length,
    groupedCount: grouped.length,
    results: resultCounts,
    resultCounts,
    providerAttemptCount: countProviderAttempts(artifacts),
    browserProbeAttemptCount: countBrowserProbeAttempts(artifacts),
    failureClassCounts,
    defectBucketCounts,
    baseUrl: envTruth.baseUrl,
    uiBaseUrl: envTruth.uiBaseUrl,
    providerLanes: envTruth.providerLanes,
    aggregates,
    options,
  };

  writeJson(path.join(reportRoot, "summary.json"), summary);
  writeJson(path.join(reportRoot, "environment-truth.json"), envTruth);
  writeJson(path.join(reportRoot, "catalog.json"), scenarios);
  writeJson(path.join(reportRoot, "artifacts.json"), artifacts);
  writeJson(path.join(reportRoot, "grouped.json"), grouped);
  writeText(path.join(reportRoot, "coverage-matrix.md"), renderCoverageMatrix({ scenarios, grouped }));
  writeText(path.join(reportRoot, "stability-report.md"), renderStabilityReport({ artifacts, grouped, envTruth, aggregates }));
  writeText(path.join(reportRoot, "performance-report.md"), renderPerformanceReport({ grouped, aggregates }));
  writeText(path.join(reportRoot, "defect-ledger.md"), renderDefectLedger({ artifacts }));
  writeText(path.join(reportRoot, "index.md"), renderIndex({ runId, suite, scenarios, grouped, envTruth, aggregates }));
  writeJson(resolveLatestPointerPath(repoRoot), {
    runId,
    suite,
    generatedAt: summary.generatedAt,
    reportRoot,
  });
  return summary;
}
