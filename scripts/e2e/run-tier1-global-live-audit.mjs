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
  hasBinary,
  hasEnv,
  loadSourceMatrix,
  passStatus,
  writeJson,
  writeText,
} from "./tier1-live-audit-lib.mjs";

const matrix = loadSourceMatrix();
const reportJsonPath = path.join(REPORT_DIR, `TIER1_GLOBAL_LIVE_AUDIT_${DATE_STAMP}.json`);
const reportMdPath = path.join(REPORT_DIR, `TIER1_GLOBAL_LIVE_AUDIT_${DATE_STAMP}.md`);

const results = [];

if (matrix.live?.openaiHttp?.repeatRun1?.status === "completed") {
  results.push(
    passStatus("openai-http", "Friday-routed OpenAI HTTP live path passed.", [SOURCE_MATRIX_PATH], {
      family: "openai",
      runner: "global",
      backendKind: "http",
      authModes: ["api-key", "bearer-token"],
      contract: contractStatus({
        providerCreate: true,
        providerDoctor: true,
        routingExplain: true,
        liveRun: true,
        failureFallback: Array.isArray(matrix.live?.openaiHttp?.repeatRun1?.actualExecution?.fallbackAttempts)
          && matrix.live.openaiHttp.repeatRun1.actualExecution.fallbackAttempts.length > 0,
        actualExecution: true,
      }),
    }),
  );
} else {
  results.push(
    blockStatus("openai-http", "OpenAI HTTP live path was not verified in the source live audit.", {
      family: "openai",
      runner: "global",
      backendKind: "http",
      authModes: ["api-key", "bearer-token"],
      blockerType: blockerTypeFromEnvironment({ credentialEnv: ["OPENAI_API_KEY"] }),
      contract: contractStatus({}),
    }),
  );
}

if (matrix.live?.codexCli?.textCompletion?.text?.includes("CODEX_FRIDAY_OK")) {
  results.push(
    passStatus("codex-cli", "Codex CLI external-session backend passed a Friday-routed text completion.", [SOURCE_MATRIX_PATH], {
      family: "openai-codex",
      runner: "global",
      backendKind: "cli",
      authModes: ["external-session"],
      contract: contractStatus({
        providerCreate: true,
        providerDoctor: matrix.live?.codexCli?.doctor?.backendHealth === "healthy",
        routingExplain: true,
        liveRun: true,
        failureFallback: false,
        actualExecution: matrix.live?.codexCli?.textCompletion?.route?.backendKind === "cli",
      }),
    }),
  );
} else {
  results.push(
    blockStatus("codex-cli", "Codex CLI backend was not verified by the source live audit.", {
      family: "openai-codex",
      runner: "global",
      backendKind: "cli",
      authModes: ["external-session"],
      blockerType: blockerTypeFromEnvironment({ binary: "codex", productSupport: true }),
      contract: contractStatus({}),
    }),
  );
}

if (matrix.live?.claudeCli?.textCompletion?.text?.includes("CLAUDE_FRIDAY_OK")) {
  results.push(
    passStatus("claude-cli", "Claude CLI external-session backend passed a Friday-routed text completion.", [SOURCE_MATRIX_PATH], {
      family: "anthropic",
      runner: "global",
      backendKind: "cli",
      authModes: ["external-session"],
      contract: contractStatus({
        providerCreate: true,
        providerDoctor: matrix.live?.claudeCli?.doctor?.backendHealth === "healthy",
        routingExplain: true,
        liveRun: true,
        failureFallback: false,
        actualExecution: matrix.live?.claudeCli?.textCompletion?.route?.backendKind === "cli",
      }),
    }),
  );
} else {
  results.push(
    blockStatus("claude-cli", "Claude CLI backend was not verified by the source live audit.", {
      family: "anthropic",
      runner: "global",
      backendKind: "cli",
      authModes: ["external-session"],
      blockerType: blockerTypeFromEnvironment({ binary: "claude", productSupport: true }),
      contract: contractStatus({}),
    }),
  );
}

results.push(
  hasEnv("ANTHROPIC_API_KEY") || hasEnv("FRIDAY_E2E_LIVE_ANTHROPIC")
    ? blockStatus("anthropic-http", "Anthropic credentials are present, but this tier1 global runner has not yet executed a dedicated Anthropic HTTP/OAuth/token live harness.", {
        family: "anthropic",
        runner: "global",
        backendKind: "http",
        authModes: ["api-key", "oauth", "token"],
        blockerType: "not_yet_executed",
        contract: contractStatus({}),
      })
    : blockStatus("anthropic-http", "Anthropic live credentials are not configured in this environment.", {
        family: "anthropic",
        runner: "global",
        backendKind: "http",
        authModes: ["api-key", "oauth", "token"],
        blockerType: "missing_credentials",
        contract: contractStatus({}),
      }),
);

results.push(
  hasBinary("gemini") || hasEnv("GOOGLE_API_KEY")
    ? blockStatus("google-gemini", "Google/Gemini capability is partially present, but no dedicated tier1 global live harness has executed yet.", {
        family: "google",
        runner: "global",
        backendKind: hasBinary("gemini") ? "cli" : "http",
        authModes: hasBinary("gemini") ? ["external-session"] : ["api-key"],
        blockerType: "not_yet_executed",
        contract: contractStatus({}),
      })
    : blockStatus("google-gemini", "Neither Gemini CLI nor Google live credentials are available in this environment.", {
        family: "google",
        runner: "global",
        backendKind: "http",
        authModes: ["api-key", "external-session"],
        blockerType: blockerTypeFromEnvironment({ credentialEnv: ["GOOGLE_API_KEY"], binary: "gemini" }),
        contract: contractStatus({}),
      }),
);

for (const family of [
  ["openrouter", "OPENROUTER_API_KEY"],
  ["xai", "XAI_API_KEY"],
  ["mistral", "MISTRAL_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["together", "TOGETHER_API_KEY"],
]) {
  const [target, envName] = family;
  results.push(
    hasEnv(envName)
      ? blockStatus(target, `${envName} is present, but a dedicated tier1 global live harness for ${target} has not been executed yet.`, {
          family: target,
          runner: "global",
          backendKind: "http",
          authModes: ["api-key", "bearer-token"],
          blockerType: "not_yet_executed",
          contract: contractStatus({}),
        })
      : blockStatus(target, `${envName} is not configured in this environment.`, {
          family: target,
          runner: "global",
          backendKind: "http",
          authModes: ["api-key", "bearer-token"],
          blockerType: "missing_credentials",
          contract: contractStatus({}),
        }),
  );
}

const blockers = results.filter((result) => result.status === "blocked");
const summary = `Passed ${results.length - blockers.length} of ${results.length} global tier1 targets on April 1, 2026. Missing or unrun families are explicitly marked as blockers.`;

const payload = {
  generatedAt: new Date().toISOString(),
  scope: "tier1-global",
  sourceMatrixPath: SOURCE_MATRIX_PATH,
  sourceReportPath: SOURCE_REPORT_PATH,
  results,
  blockers,
};

writeJson(reportJsonPath, payload);
writeText(
  reportMdPath,
  buildMarkdownReport({
    title: "Tier1 Global Live Audit",
    generatedAt: payload.generatedAt,
    sourceMatrixPath: SOURCE_MATRIX_PATH,
    sourceReportPath: SOURCE_REPORT_PATH,
    summary,
    results,
    blockers,
  }),
);

console.log(JSON.stringify({ ok: true, reportJsonPath, reportMdPath, blockers: blockers.length }, null, 2));
