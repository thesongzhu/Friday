#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  DATE_STAMP,
  REPORT_DIR,
  ensureDir,
  formatBlockedTargetActionItems,
  writeJson,
  writeText,
} from "./tier1-live-audit-lib.mjs";

const scopes = ["GLOBAL", "CHINA", "LOCAL"];

function readReport(scope) {
  const filePath = path.join(REPORT_DIR, `TIER1_${scope}_LIVE_AUDIT_${DATE_STAMP}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing tier1 report: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const reports = scopes.map((scope) => readReport(scope));
const results = reports.flatMap((report) => report.results ?? []);
const blockers = results.filter((result) => result.status === "blocked");

const matrixPath = path.join(REPORT_DIR, `TIER1_LIVE_MATRIX_${DATE_STAMP}.json`);
const blockerPath = path.join(REPORT_DIR, `TIER1_BLOCKER_MATRIX_${DATE_STAMP}.json`);
const verifiedSummaryPath = path.join(REPORT_DIR, `VERIFIED_VS_UNVERIFIED_${DATE_STAMP}.md`);
const checklistPath = path.join(REPORT_DIR, `TIER1_ENVIRONMENT_CHECKLIST_${DATE_STAMP}.md`);

ensureDir(REPORT_DIR);
writeJson(matrixPath, {
  generatedAt: new Date().toISOString(),
  scopes: reports.map((report) => report.scope),
  totals: {
    results: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    blocked: blockers.length,
  },
  results,
});

writeJson(blockerPath, {
  generatedAt: new Date().toISOString(),
  totals: {
    blocked: blockers.length,
  },
  blockers,
});

const verified = results.filter((result) => result.status === "passed");
const knownCoverageGaps = [
  {
    layer: "Realtime / Channels / UIX / Observability",
    currentValidation: "closure local plus targeted live audit and existing suite coverage",
    gap: "not every operator surface and transport has been fully live-dogfooded with the same rigor as provider tier1 routes",
  },
  {
    layer: "Skills / Plugins",
    currentValidation: "closure local and existing suite coverage",
    gap: "not every plugin path is yet covered by a dedicated live matrix family harness",
  },
];

writeText(
  verifiedSummaryPath,
  [
    "# Verified vs Unverified Friday Scope",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Passed tier1 targets: ${verified.length}`,
    `- Blocked tier1 targets: ${blockers.length}`,
    "",
    "## Verified live targets",
    "",
    ...verified.map((result) => `- ${result.target}: ${result.family} / ${result.runner} / ${result.backendKind}`),
    "",
    "## Blocked live targets",
    "",
    ...blockers.map((result) => `- ${result.target}: ${result.reason}`),
    "",
    "## Product layers not yet fully live-dogfooded",
    "",
    ...knownCoverageGaps.map((gap) => `- ${gap.layer}: ${gap.currentValidation}; gap: ${gap.gap}`),
    "",
  ].join("\n"),
);

writeText(
  checklistPath,
  [
    "# Tier1 Environment Checklist",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    "",
    ...blockers.flatMap((result) => {
      const items = formatBlockedTargetActionItems(result);
      return [
        `## ${result.target}`,
        "",
        `- Reason: ${result.reason}`,
        `- blockerTypes: ${Array.isArray(result.blockerTypes) && result.blockerTypes.length > 0 ? result.blockerTypes.join(", ") : result.blockerType ?? "unknown"}`,
        ...(items.length > 0 ? items.map((item) => `- Action: ${item}`) : ["- Action: inspect blocker manually"]),
        "",
      ];
    }),
  ].join("\n"),
);

console.log(JSON.stringify({
  ok: true,
  matrixPath,
  blockerPath,
  verifiedSummaryPath,
  checklistPath,
  passed: results.filter((result) => result.status === "passed").length,
  blocked: blockers.length,
}, null, 2));
