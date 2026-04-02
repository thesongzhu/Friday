#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { DATE_STAMP, REPORT_DIR, ensureDir, writeJson } from "./tier1-live-audit-lib.mjs";

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

console.log(JSON.stringify({
  ok: true,
  matrixPath,
  blockerPath,
  passed: results.filter((result) => result.status === "passed").length,
  blocked: blockers.length,
}, null, 2));
