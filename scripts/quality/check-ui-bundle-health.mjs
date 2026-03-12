#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getRootPath } from "./closeout-lib.mjs";

const assetsDir = getRootPath("dist", "ui", "assets");
const advisoryBytes = 500 * 1024;
const hardFailBytes = 700 * 1024;

const assetEntries = readdirSync(assetsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => {
    const absolutePath = join(assetsDir, entry.name);
    return {
      file: entry.name,
      bytes: statSync(absolutePath).size,
    };
  })
  .sort((left, right) => right.bytes - left.bytes);

if (assetEntries.length === 0) {
  console.error("❌ No built UI JavaScript assets found. Run `npm run build:ui` first.");
  process.exit(1);
}

const largest = assetEntries[0];
const totalBytes = assetEntries.reduce((sum, entry) => sum + entry.bytes, 0);

console.log("UI bundle health");
console.log(`- Largest JS asset: ${largest.file} (${formatKiB(largest.bytes)})`);
console.log(`- Total JS bytes: ${formatKiB(totalBytes)}`);

if (largest.bytes > advisoryBytes) {
  console.warn(`⚠️ Largest UI chunk exceeds advisory threshold (${formatKiB(advisoryBytes)})`);
}

if (largest.bytes > hardFailBytes) {
  console.error(`❌ Largest UI chunk exceeds hard-fail threshold (${formatKiB(hardFailBytes)})`);
  process.exit(1);
}

console.log("✅ UI bundle health is within the enforced threshold");

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}
