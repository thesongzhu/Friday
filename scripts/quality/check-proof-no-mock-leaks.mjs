#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PROOF_INPUTS, scanTextForMockLeaks } from "./release-truth-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const inputs = process.argv.slice(2);
const requestedInputs = inputs.length > 0 ? inputs : DEFAULT_PROOF_INPUTS;

function walk(targetPath) {
  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    return [targetPath];
  }
  if (!stats.isDirectory()) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const absolutePath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

const resolvedFiles = requestedInputs
  .map((value) => path.resolve(REPO_ROOT, value))
  .flatMap((targetPath) => walk(targetPath));

const findings = [];
for (const filePath of resolvedFiles) {
  const text = fs.readFileSync(filePath, "utf8");
  findings.push(
    ...scanTextForMockLeaks(path.relative(REPO_ROOT, filePath), text).map((entry) => ({
      ...entry,
      filePath: path.relative(REPO_ROOT, filePath),
    })),
  );
}

if (findings.length > 0) {
  console.error("Mock contamination markers found in proof inputs:");
  for (const finding of findings) {
    console.error(`- ${finding.filePath}: ${finding.marker}`);
  }
  process.exit(1);
}

console.log(`No mock contamination markers found across ${resolvedFiles.length} proof input file(s).`);
