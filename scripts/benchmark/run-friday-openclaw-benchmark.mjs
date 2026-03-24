import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BENCHMARK_CASES } from "./friday-openclaw-mixed-round1-cases.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultOutputRoot = path.join(repoRoot, "docs", "reports", "benchmark", "openclaw-mixed-round1");
const fridayBaseUrl = process.env.FRIDAY_BENCHMARK_BASE_URL ?? "http://127.0.0.1:4123";
const fridayPassphrase = process.env.FRIDAY_BENCHMARK_LOCAL_PASSPHRASE ?? "benchmark-passphrase";
const openClawRepo = process.env.OPENCLAW_REPO_PATH ?? "../openclaw-dev";
const openAiModel = process.env.FRIDAY_BENCHMARK_MODEL ?? "gpt-4o-mini";

function parseArgs(argv) {
  const result = {
    repeats: 1,
    systems: ["friday", "openclaw"],
    outputRoot: defaultOutputRoot,
    cases: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repeats") {
      result.repeats = Number(argv[index + 1] ?? "1");
      index += 1;
    } else if (arg === "--systems") {
      result.systems = String(argv[index + 1] ?? "friday,openclaw").split(",").map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--output-root") {
      result.outputRoot = path.resolve(argv[index + 1] ?? defaultOutputRoot);
      index += 1;
    } else if (arg === "--cases") {
      result.cases = String(argv[index + 1] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
    }
  }
  return result;
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function ensureFridayToken() {
  const login = await apiJson(`${fridayBaseUrl}/v1/auth/login`, {
    method: "POST",
    body: JSON.stringify({ localPassphrase: fridayPassphrase }),
  });
  return login.data?.accessToken ?? login.accessToken;
}

async function ensureFridayProvider(accessToken) {
  const headers = { authorization: `Bearer ${accessToken}` };
  const providersRes = await apiJson(`${fridayBaseUrl}/v1/providers`, { headers });
  const providers = providersRes.data?.items ?? providersRes.items ?? [];
  let provider = [...providers]
    .reverse()
    .find((item) => item.name === "Benchmark OpenAI Completions" && item.kind === "openai");
  if (!provider) {
    const created = await apiJson(`${fridayBaseUrl}/v1/providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "openai",
        name: "Benchmark OpenAI Completions",
        baseUrl: "https://api.openai.com",
        enabled: true,
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        defaultModel: openAiModel,
        supportedModels: [openAiModel, "gpt-4o"],
      }),
    });
    provider = created.data?.provider ?? created.provider;
  }
  await apiJson(`${fridayBaseUrl}/v1/model-routing`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      defaultProviderId: provider.id,
      fallbackProviderIds: [],
      defaultModel: openAiModel,
    }),
  });
  return provider.id;
}

async function snapshotDirectory(dir) {
  const map = new Map();
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dir, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath);
        map.set(relativePath, createHash("sha1").update(content).digest("hex"));
      }
    }
  }
  await walk(dir);
  return map;
}

function diffSnapshots(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [file, hash] of after.entries()) {
    if (!before.has(file)) {
      added.push(file);
    } else if (before.get(file) !== hash) {
      changed.push(file);
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) {
      removed.push(file);
    }
  }
  return { added, changed, removed };
}

async function runFridayCase({ caseDef, prompt, sandboxDir, accessToken, providerId }) {
  const headers = { authorization: `Bearer ${accessToken}` };
  const startedAt = Date.now();
  const startPayload = await apiJson(`${fridayBaseUrl}/v1/agent/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      task: prompt,
      providerId,
      model: openAiModel,
      timeoutMs: 120000,
    }),
  });
  const completedAt = Date.now();
  const startData = startPayload.data ?? startPayload;
  const runId = startData.runId ?? startPayload.runId;
  const runRes = await apiJson(`${fridayBaseUrl}/v1/agent/runs/${runId}`, { headers });
  const run = runRes.data?.run ?? runRes.run;
  const responseText = run.responseText ?? run.summary ?? startData.response ?? "";
  return {
    systemUnderTest: "friday",
    runId,
    finalStatus: run.status,
    responseText,
    durationMs: run.durationMs ?? startData.durationMs ?? (completedAt - startedAt),
    toolCallCount: run.toolCallCount ?? startData.toolCallCount ?? 0,
    artifacts: run.artifacts ?? [],
    artifactDir: run.artifactDir ?? null,
    transcript: [
      {
        role: "user",
        content: prompt,
      },
      {
        role: "assistant",
        content: responseText,
      },
    ],
    notes: `Friday run ${runId} completed with status ${run.status}.`,
  };
}

function parseLastJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new Error(`Unable to parse JSON from output: ${stdout}`);
}

async function runOpenClawCase({ prompt }) {
  const startedAt = Date.now();
  const { stdout, stderr } = await execFileAsync(
    "node",
    [path.join(openClawRepo, "dist", "entry.js"), "agent", "--message", prompt, "--agent", "main", "--local", "--json"],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const completedAt = Date.now();
  const payload = parseLastJson(stdout);
  const responseText = payload.payloads?.map((item) => item.text).filter(Boolean).join("\n").trim() ?? "";
  return {
    systemUnderTest: "openclaw",
    runId: payload.meta?.runId ?? null,
    finalStatus: "completed",
    responseText,
    durationMs: completedAt - startedAt,
    toolCallCount: payload.meta?.toolCallCount ?? null,
    artifacts: [],
    artifactDir: null,
    transcript: [
      {
        role: "user",
        content: prompt,
      },
      {
        role: "assistant",
        content: responseText,
      },
    ],
    rawStdout: stdout,
    rawStderr: stderr,
    meta: payload.meta ?? {},
    notes: "OpenClaw CLI run completed.",
  };
}

function makeOpenClawAgentName({ benchmarkRunId, caseId, repeatIndex }) {
  return `benchmark-${benchmarkRunId}-${caseId}-${repeatIndex}`
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .slice(0, 96);
}

function makeFailedRunResult({ systemUnderTest, prompt, error, startedAt }) {
  const completedAt = Date.now();
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    systemUnderTest,
    runId: null,
    finalStatus: "failed",
    responseText: "",
    durationMs: completedAt - startedAt,
    toolCallCount: 0,
    artifacts: [],
    artifactDir: null,
    transcript: [
      {
        role: "user",
        content: prompt,
      },
      {
        role: "assistant",
        content: "",
      },
    ],
    notes: `${systemUnderTest} benchmark run failed: ${errorMessage}`,
    errorMessage,
  };
}

function summarizeRepeatedResults(results) {
  const successCount = results.filter((item) => item.evaluation?.success).length;
  const totalScore = results.reduce((sum, item) => sum + scoreTotal(item.evaluation?.scoreBreakdown), 0);
  const failureClasses = [...new Set(results.map((item) => item.evaluation?.failureClass).filter(Boolean))];
  return {
    repeats: results.length,
    successCount,
    successRate: results.length === 0 ? 0 : successCount / results.length,
    averageScore: results.length === 0 ? 0 : totalScore / results.length,
    unstable: successCount > 0 && successCount < results.length,
    failureClasses,
  };
}

function scoreTotal(scoreBreakdown) {
  return Object.values(scoreBreakdown ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
}

function compareSystems(fridayResults, openClawResults, caseDef) {
  if (caseDef.deferredByDesign || !caseDef.inFridayCanonicalBoundary || !caseDef.inOpenClawOverlapScope) {
    return {
      verdict: "Boundary by design",
      notes: "Case is outside the intended direct parity boundary for this round.",
    };
  }
  const fridaySummary = summarizeRepeatedResults(fridayResults);
  const openClawSummary = summarizeRepeatedResults(openClawResults);

  if (fridaySummary.successRate === 1 && openClawSummary.successRate === 1) {
    if (Math.abs(fridaySummary.averageScore - openClawSummary.averageScore) <= 1) {
      return {
        verdict: "Equivalent",
        notes: "Both systems completed all repeats with similar automatic scores.",
      };
    }
    if (fridaySummary.averageScore > openClawSummary.averageScore) {
      return {
        verdict: "Friday stronger",
        notes: "Friday completed all repeats with a stronger automatic score.",
      };
    }
    return {
      verdict: "Weaker but acceptable",
      notes: "Friday completed all repeats but scored lower than OpenClaw.",
    };
  }

  if (fridaySummary.successRate === openClawSummary.successRate && fridaySummary.successRate > 0) {
    if (Math.abs(fridaySummary.averageScore - openClawSummary.averageScore) <= 1) {
      return {
        verdict: "Equivalent",
        notes: "Both systems reached the same repeat success rate with similar average scores.",
      };
    }
    return fridaySummary.averageScore > openClawSummary.averageScore
      ? {
          verdict: "Friday stronger",
          notes: "Both systems had the same repeat success rate, but Friday scored higher on average.",
        }
      : {
          verdict: "Weaker but acceptable",
          notes: "Both systems had the same repeat success rate, but Friday scored lower on average.",
        };
  }

  if (fridaySummary.successRate < openClawSummary.successRate) {
    if (fridaySummary.successCount >= 2 && openClawSummary.successCount === 3) {
      return {
        verdict: "Weaker but acceptable",
        notes: "Friday succeeded on most repeats but was less stable than OpenClaw.",
      };
    }
    return {
      verdict: "Gap",
      notes: "OpenClaw outperformed Friday on repeat success rate.",
    };
  }

  if (fridaySummary.successRate > openClawSummary.successRate) {
    return {
      verdict: "Friday stronger",
      notes: "Friday outperformed OpenClaw on repeat success rate.",
    };
  }
  return {
    verdict: "Gap",
    notes: "Neither system completed enough repeats cleanly; manual review is required.",
  };
}

async function runCaseOnce({ caseDef, system, repeatIndex, accessToken, providerId, runOutputRoot, benchmarkRunId }) {
  const sandboxDir = path.join(runOutputRoot, "sandboxes", caseDef.id, system, `repeat-${repeatIndex}`);
  await rm(sandboxDir, { recursive: true, force: true });
  await mkdir(sandboxDir, { recursive: true });
  await caseDef.setup({ sandboxDir, repoRoot });
  const before = await snapshotDirectory(sandboxDir);
  const prompt = caseDef.buildPrompt({ sandboxDir, repoRoot });
  const startedAt = Date.now();
  let rawResult;
  try {
    rawResult = system === "friday"
      ? await runFridayCase({ caseDef, prompt, sandboxDir, accessToken, providerId })
      : await runOpenClawCase({
          caseDef,
          prompt,
          sandboxDir,
          agentName: makeOpenClawAgentName({ benchmarkRunId, caseId: caseDef.id, repeatIndex }),
        });
  } catch (error) {
    rawResult = makeFailedRunResult({
      systemUnderTest: system,
      prompt,
      error,
      startedAt,
    });
  }
  const after = await snapshotDirectory(sandboxDir);
  const fileChanges = diffSnapshots(before, after);
  const evaluation = await caseDef.evaluate({
    sandboxDir,
    repoRoot,
    responseText: rawResult.responseText,
    artifacts: rawResult.artifacts,
    artifactDir: rawResult.artifactDir,
    fileChanges,
    rawResult,
  });
  return {
    caseId: caseDef.id,
    title: caseDef.title,
    scenarioFamily: caseDef.scenarioFamily,
    systemUnderTest: system,
    finalStatus: rawResult.finalStatus,
    durationMs: rawResult.durationMs,
    toolCallCount: rawResult.toolCallCount,
    transcript: rawResult.transcript,
    responseText: rawResult.responseText,
    artifactEvidence: {
      artifactDir: rawResult.artifactDir,
      artifacts: rawResult.artifacts,
      expectedArtifacts: evaluation.expectedArtifacts,
      sandboxDir,
      fileChanges,
    },
    boundary: {
      inFridayCanonicalBoundary: caseDef.inFridayCanonicalBoundary,
      inOpenClawOverlapScope: caseDef.inOpenClawOverlapScope,
      deferredByDesign: caseDef.deferredByDesign,
    },
    evaluation,
    notes: rawResult.notes,
  };
}

function buildGapRanking(comparisons) {
  const counts = new Map();
  for (const comparison of comparisons) {
    if (comparison.verdict !== "Gap") continue;
    const classification = comparison.friday?.summary?.failureClasses?.[0] ?? "unclassified";
    counts.set(classification, (counts.get(classification) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([classification, count]) => ({ classification, count }));
}

function toMarkdown({ summary, comparisons }) {
  const lines = [];
  lines.push("# Friday vs OpenClaw Mixed Benchmark Round 1");
  lines.push("");
  lines.push(`Generated at: ${summary.generatedAt}`);
  lines.push(`Repeats per system: ${summary.repeats}`);
  lines.push(`Friday base URL: ${summary.fridayBaseUrl}`);
  lines.push("");
  lines.push("## Verdict Matrix");
  lines.push("");
  lines.push("| Case | Family | Verdict | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const comparison of comparisons) {
    lines.push(`| ${comparison.caseId} | ${comparison.scenarioFamily} | ${comparison.verdict} | ${comparison.notes.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## Gap Ranking");
  lines.push("");
  if (summary.gapRanking.length === 0) {
    lines.push("- No `Gap` verdicts in this run.");
  } else {
    for (const item of summary.gapRanking) {
      lines.push(`- ${item.classification}: ${item.count}`);
    }
  }
  lines.push("");
  lines.push("## Key Totals");
  lines.push("");
  lines.push(`- Equivalent: ${summary.totals.equivalent}`);
  lines.push(`- Friday stronger: ${summary.totals.fridayStronger}`);
  lines.push(`- Weaker but acceptable: ${summary.totals.weakerButAcceptable}`);
  lines.push(`- Gap: ${summary.totals.gap}`);
  lines.push(`- Boundary by design: ${summary.totals.boundaryByDesign}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selectedCases = options.cases
    ? BENCHMARK_CASES.filter((caseDef) => options.cases.includes(caseDef.id))
    : BENCHMARK_CASES;
  if (options.cases) {
    const missingCaseIds = options.cases.filter((caseId) => !selectedCases.some((caseDef) => caseDef.id === caseId));
    if (missingCaseIds.length > 0) {
      throw new Error(`Unknown benchmark case id(s): ${missingCaseIds.join(", ")}`);
    }
  }
  if (selectedCases.length === 0) {
    throw new Error("No benchmark cases selected");
  }

  await mkdir(options.outputRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  const runOutputRoot = path.join(options.outputRoot, timestamp);
  await mkdir(runOutputRoot, { recursive: true });

  let accessToken = null;
  let providerId = null;
  if (options.systems.includes("friday")) {
    accessToken = await ensureFridayToken();
    providerId = await ensureFridayProvider(accessToken);
  }

  const results = [];
  for (const caseDef of selectedCases) {
    for (const system of options.systems) {
      for (let repeatIndex = 1; repeatIndex <= options.repeats; repeatIndex += 1) {
        results.push(
          await runCaseOnce({
            caseDef,
            system,
            repeatIndex,
            accessToken,
            providerId,
            runOutputRoot,
            benchmarkRunId: timestamp,
          }),
        );
      }
    }
  }

  const comparisons = [];
  for (const caseDef of selectedCases) {
    const fridayResults = results.filter((item) => item.caseId === caseDef.id && item.systemUnderTest === "friday");
    const openClawResults = results.filter((item) => item.caseId === caseDef.id && item.systemUnderTest === "openclaw");
    if (fridayResults.length === 0 || openClawResults.length === 0) continue;
    const comparison = compareSystems(fridayResults, openClawResults, caseDef);
    comparisons.push({
      caseId: caseDef.id,
      title: caseDef.title,
      scenarioFamily: caseDef.scenarioFamily,
      ...comparison,
      friday: {
        repeats: fridayResults,
        summary: summarizeRepeatedResults(fridayResults),
      },
      openclaw: {
        repeats: openClawResults,
        summary: summarizeRepeatedResults(openClawResults),
      },
    });
  }

  const totals = {
    equivalent: comparisons.filter((item) => item.verdict === "Equivalent").length,
    fridayStronger: comparisons.filter((item) => item.verdict === "Friday stronger").length,
    weakerButAcceptable: comparisons.filter((item) => item.verdict === "Weaker but acceptable").length,
    gap: comparisons.filter((item) => item.verdict === "Gap").length,
    boundaryByDesign: comparisons.filter((item) => item.verdict === "Boundary by design").length,
  };

  const summary = {
    generatedAt: new Date().toISOString(),
    repeats: options.repeats,
    systems: options.systems,
    fridayBaseUrl,
    openClawRepo,
    caseIds: selectedCases.map((caseDef) => caseDef.id),
    totals,
    gapRanking: buildGapRanking(comparisons),
  };

  await writeFile(path.join(runOutputRoot, "results.json"), JSON.stringify({ summary, comparisons, results }, null, 2) + "\n", "utf8");
  await writeFile(path.join(runOutputRoot, "summary.md"), toMarkdown({ summary, comparisons }), "utf8");
  await writeFile(path.join(options.outputRoot, "latest.json"), JSON.stringify({ summary, runDir: runOutputRoot }, null, 2) + "\n", "utf8");
  await writeFile(path.join(options.outputRoot, "latest.md"), toMarkdown({ summary, comparisons }), "utf8");

  process.stdout.write(JSON.stringify({ ok: true, outputDir: runOutputRoot, totals }, null, 2) + "\n");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
