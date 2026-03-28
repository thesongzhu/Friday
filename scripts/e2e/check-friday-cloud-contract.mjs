#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { resolveCloudContractReport } from "./friday-closure-lib.mjs";

function resolveArtifactPath() {
  const explicit = process.env.FRIDAY_CLOUD_CONTRACT_REPORT_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(process.cwd(), "artifacts", "cloud-contract", "report.json");
}

const report = {
  generatedAt: new Date().toISOString(),
  ...resolveCloudContractReport(process.env),
};

const reportPath = resolveArtifactPath();
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

if (!report.ready) {
  process.exit(78);
}
