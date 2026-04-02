#!/usr/bin/env node

import path from "node:path";

import {
  DATE_STAMP,
  REPORT_DIR,
  SOURCE_MATRIX_PATH,
  SOURCE_REPORT_PATH,
  blockerTypesFromEnvironment,
  buildMarkdownReport,
  blockStatus,
  contractStatus,
  hasEnv,
  loadSourceMatrix,
  writeJson,
  writeText,
} from "./tier1-live-audit-lib.mjs";

loadSourceMatrix();

const reportJsonPath = path.join(REPORT_DIR, `TIER1_CHINA_LIVE_AUDIT_${DATE_STAMP}.json`);
const reportMdPath = path.join(REPORT_DIR, `TIER1_CHINA_LIVE_AUDIT_${DATE_STAMP}.md`);

const families = [
  ["qwen", "QWEN_API_KEY"],
  ["moonshot-kimi", "MOONSHOT_API_KEY"],
  ["glm", "ZHIPU_API_KEY"],
  ["volcengine-byteplus", "VOLCENGINE_API_KEY"],
];

const results = families.map(([target, envName]) =>
  hasEnv(envName)
    ? blockStatus(target, `${envName} is present, but this machine is not running the dedicated China egress live harness yet.`, {
        family: target,
        runner: "china",
        backendKind: "http",
        authModes: ["api-key", "bearer-token", "token"],
        blockerTypes: ["missing_runner"],
        requiredEnv: [envName],
        requiredRunner: "china-egress-runner",
        contract: contractStatus({}),
      })
    : blockStatus(target, `${envName} is not configured in this environment.`, {
        family: target,
        runner: "china",
        backendKind: "http",
        authModes: ["api-key", "bearer-token", "token"],
        blockerTypes: blockerTypesFromEnvironment({ credentialEnv: [envName], runner: false }),
        requiredEnv: [envName],
        requiredRunner: "china-egress-runner",
        contract: contractStatus({}),
      }),
);

const blockers = results;
const summary = "No China-tier provider family could be fully live-verified on this machine on April 1, 2026. This runner currently records explicit blockers until a China egress environment is available.";

const payload = {
  generatedAt: new Date().toISOString(),
  scope: "tier1-china",
  sourceMatrixPath: SOURCE_MATRIX_PATH,
  sourceReportPath: SOURCE_REPORT_PATH,
  results,
  blockers,
};

writeJson(reportJsonPath, payload);
writeText(
  reportMdPath,
  buildMarkdownReport({
    title: "Tier1 China Live Audit",
    generatedAt: payload.generatedAt,
    sourceMatrixPath: SOURCE_MATRIX_PATH,
    sourceReportPath: SOURCE_REPORT_PATH,
    summary,
    results,
    blockers,
  }),
);

console.log(JSON.stringify({ ok: true, reportJsonPath, reportMdPath, blockers: blockers.length }, null, 2));
