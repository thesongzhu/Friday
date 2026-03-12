#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptionalEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizeNotes(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry));
    }
  } catch {
    // Fall through to newline parsing.
  }
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main() {
  const repoRoot = path.resolve(readOptionalEnv("FRIDAY_ARTIFACT_REPO_ROOT") ?? process.cwd());
  const artifactPath = path.resolve(readRequiredEnv("FRIDAY_ARTIFACT_PATH"));
  const metadataPath = path.resolve(
    readOptionalEnv("FRIDAY_ARTIFACT_METADATA_PATH")
      ?? `${artifactPath}.artifact.json`,
  );
  const platform = readRequiredEnv("FRIDAY_ARTIFACT_PLATFORM");
  const kind = readRequiredEnv("FRIDAY_ARTIFACT_KIND");
  const arch = readOptionalEnv("FRIDAY_ARTIFACT_ARCH") ?? "unknown";
  const availability = readOptionalEnv("FRIDAY_ARTIFACT_AVAILABILITY") ?? "available";
  const installSummary = readOptionalEnv("FRIDAY_ARTIFACT_INSTALL_SUMMARY");
  const signingStatus = readOptionalEnv("FRIDAY_ARTIFACT_SIGNING_STATUS");
  const notarizationStatus = readOptionalEnv("FRIDAY_ARTIFACT_NOTARIZATION_STATUS");
  const runtimeKind = readOptionalEnv("FRIDAY_ARTIFACT_RUNTIME_KIND");
  const downloadBaseUrl = readOptionalEnv("FRIDAY_ARTIFACT_DOWNLOAD_BASE_URL");
  const displayName = readOptionalEnv("FRIDAY_ARTIFACT_DISPLAY_NAME");
  const notes = normalizeNotes(readOptionalEnv("FRIDAY_ARTIFACT_NOTES"));

  const fileBuffer = await fs.readFile(artifactPath);
  const stat = await fs.stat(artifactPath);
  const fileName = path.basename(artifactPath);
  const relativePath = path.relative(repoRoot, artifactPath).replaceAll(path.sep, "/");

  const payload = {
    artifactId: readOptionalEnv("FRIDAY_ARTIFACT_ID") ?? `${platform}-${kind}-${arch}`,
    platform,
    kind,
    arch,
    displayName: displayName ?? fileName,
    fileName,
    relativePath,
    availability,
    sizeBytes: stat.size,
    sha256: crypto.createHash("sha256").update(fileBuffer).digest("hex"),
    installSummary,
    signingStatus,
    notarizationStatus,
    runtimeKind,
    downloadUrl: downloadBaseUrl ? `${downloadBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(fileName)}` : null,
    notes,
  };

  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${metadataPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`[friday-artifact-metadata] ${error.message}\n`);
  process.exit(1);
});
