#!/usr/bin/env node

import path from "node:path";

import {
  DATE_STAMP,
  REPORT_DIR,
  SOURCE_MATRIX_PATH,
  SOURCE_REPORT_PATH,
  blockerTypeFromEnvironment,
  buildMarkdownReport,
  blockStatus,
  contractStatus,
  hasEnv,
  loadSourceMatrix,
  passStatus,
  writeJson,
  writeText,
} from "./tier1-live-audit-lib.mjs";

const matrix = loadSourceMatrix();
const reportJsonPath = path.join(REPORT_DIR, `TIER1_LOCAL_LIVE_AUDIT_${DATE_STAMP}.json`);
const reportMdPath = path.join(REPORT_DIR, `TIER1_LOCAL_LIVE_AUDIT_${DATE_STAMP}.md`);

const results = [];

if (matrix.live?.ollamaLocal?.run?.status === "completed") {
  results.push(
    passStatus("ollama-local", "Ollama local/self-hosted path passed a Friday-routed live run.", [SOURCE_MATRIX_PATH], {
      family: "ollama",
      runner: "local",
      backendKind: "http",
      authModes: ["none", "api-key", "bearer-token"],
      contract: contractStatus({
        providerCreate: true,
        providerDoctor: true,
        routingExplain: true,
        liveRun: true,
        failureFallback: false,
        actualExecution: true,
      }),
    }),
  );
} else {
  results.push(
    blockStatus("ollama-local", "Ollama local/self-hosted live path was not verified in the source live audit.", {
      family: "ollama",
      runner: "local",
      backendKind: "http",
      authModes: ["none", "api-key", "bearer-token"],
      blockerType: "not_yet_executed",
      contract: contractStatus({}),
    }),
  );
}

results.push(
  hasEnv("VLLM_BASE_URL")
    ? blockStatus("vllm", "VLLM endpoint is configured, but a dedicated local tier1 harness has not been executed yet.", {
        family: "vllm",
        runner: "local",
        backendKind: "http",
        authModes: ["none", "api-key", "bearer-token"],
        blockerType: "not_yet_executed",
        contract: contractStatus({}),
      })
    : blockStatus("vllm", "VLLM endpoint is not configured in this environment.", {
        family: "vllm",
        runner: "local",
        backendKind: "http",
        authModes: ["none", "api-key", "bearer-token"],
        blockerType: "missing_credentials",
        contract: contractStatus({}),
      }),
);

results.push(
  hasEnv("LITELLM_BASE_URL")
    ? blockStatus("litellm", "LiteLLM endpoint is configured, but a dedicated local tier1 harness has not been executed yet.", {
        family: "litellm",
        runner: "local",
        backendKind: "http",
        authModes: ["none", "api-key", "bearer-token"],
        blockerType: "not_yet_executed",
        contract: contractStatus({}),
      })
    : blockStatus("litellm", "LiteLLM endpoint is not configured in this environment.", {
        family: "litellm",
        runner: "local",
        backendKind: "http",
        authModes: ["none", "api-key", "bearer-token"],
        blockerType: "missing_credentials",
        contract: contractStatus({}),
      }),
);

results.push(
  hasEnv("OPENAI_COMPATIBLE_BASE_URL")
    ? blockStatus("openai-compatible", "OpenAI-compatible endpoint is configured, but a dedicated local tier1 harness has not been executed yet.", {
        family: "openai-compatible",
        runner: "local",
        backendKind: "http",
        authModes: ["none", "api-key", "bearer-token"],
        blockerType: "not_yet_executed",
        contract: contractStatus({}),
      })
    : blockStatus("openai-compatible", "OpenAI-compatible endpoint is not configured in this environment.", {
        family: "openai-compatible",
        runner: "local",
        backendKind: "http",
        authModes: ["none", "api-key", "bearer-token"],
        blockerType: "missing_credentials",
        contract: contractStatus({}),
      }),
);

const blockers = results.filter((result) => result.status === "blocked");
const summary = `Passed ${results.length - blockers.length} of ${results.length} local/self-hosted tier1 targets on April 1, 2026. Remaining targets are explicitly blocked until their endpoints are configured.`;

const payload = {
  generatedAt: new Date().toISOString(),
  scope: "tier1-local",
  sourceMatrixPath: SOURCE_MATRIX_PATH,
  sourceReportPath: SOURCE_REPORT_PATH,
  results,
  blockers,
};

writeJson(reportJsonPath, payload);
writeText(
  reportMdPath,
  buildMarkdownReport({
    title: "Tier1 Local Live Audit",
    generatedAt: payload.generatedAt,
    sourceMatrixPath: SOURCE_MATRIX_PATH,
    sourceReportPath: SOURCE_REPORT_PATH,
    summary,
    results,
    blockers,
  }),
);

console.log(JSON.stringify({ ok: true, reportJsonPath, reportMdPath, blockers: blockers.length }, null, 2));
