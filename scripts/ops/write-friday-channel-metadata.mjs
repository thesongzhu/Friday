#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const outputPath = process.env.FRIDAY_CHANNEL_METADATA_PATH?.trim();
const channel = process.env.FRIDAY_CHANNEL_KIND?.trim();
const availability = process.env.FRIDAY_CHANNEL_AVAILABILITY?.trim();

if (!outputPath || !channel || !availability) {
  process.stderr.write("[friday-channel-metadata] output path, channel kind, and availability are required.\n");
  process.exit(1);
}

let details = {};
const rawDetails = process.env.FRIDAY_CHANNEL_DETAILS_JSON?.trim();
if (rawDetails) {
  details = JSON.parse(rawDetails);
}

const payload = {
  generatedAt: new Date().toISOString(),
  channel,
  availability,
  ...details,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
