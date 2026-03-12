#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const PHASE_DIRECTORY_NAMES = {
  phase1: "phase1-canonical-truth",
  phase2: "phase2-fleet-satellite",
  phase3: "phase3-autonomous-loop",
  phase4: "phase4-acceptance-retry-rules",
  phase5: "phase5-skills-lifecycle",
  marketplace: "marketplace-creator-ecosystem",
  final: "final-non-platform",
};

export const PHASE_TITLES = {
  phase1: "Canonical Truth Unification",
  phase2: "Fleet, Satellites, And Distributed Execution",
  phase3: "Autonomous Loop v2",
  phase4: "Acceptance, Retry, And Rules Operations",
  phase5: "Skills Lifecycle Hardening",
  marketplace: "Marketplace Creator Ecosystem",
  final: "Non-Platform Final Closeout",
};

export function getRootPath(...segments) {
  return join(ROOT, ...segments);
}

export function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function getGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

export function runCommand(step) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd ?? ROOT,
    env: { ...process.env, ...(step.env ?? {}) },
    stdio: "inherit",
    shell: false,
  });
  const finishedAt = new Date().toISOString();
  return {
    label: step.label,
    command: [step.command, ...(step.args ?? [])].join(" "),
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    startedAt,
    finishedAt,
  };
}

export function writeEvidence(phaseId, payload) {
  const directoryName = PHASE_DIRECTORY_NAMES[phaseId];
  if (!directoryName) {
    throw new Error(`Unsupported phase id: ${phaseId}`);
  }

  const evidenceDir = getRootPath("docs", "reports", "closeout", directoryName);
  ensureDirectory(evidenceDir);

  const jsonPath = join(evidenceDir, "latest.json");
  const markdownPath = join(evidenceDir, "latest.md");

  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  writeFileSync(markdownPath, renderEvidenceMarkdown(phaseId, payload), "utf-8");

  return { jsonPath, markdownPath };
}

function extractMarkdownMetadata(markdown, label) {
  const pattern = new RegExp(`^- ${label}:\\s*(.+)$`, "m");
  const match = markdown.match(pattern);
  return match ? match[1].trim() : null;
}

export function collectEvidenceFreshnessFailures(
  phaseId,
  payload,
  markdown,
  expectedGitHead,
) {
  const failures = [];
  const markdownGitHead = extractMarkdownMetadata(markdown, "Git SHA");
  const markdownStatus = extractMarkdownMetadata(markdown, "Status");

  if (payload.gitHead !== expectedGitHead) {
    failures.push(`${phaseId}: latest.json gitHead ${String(payload.gitHead)} does not match expected ${expectedGitHead}`);
  }
  if (markdownGitHead !== String(payload.gitHead)) {
    failures.push(`${phaseId}: latest.md git SHA ${String(markdownGitHead)} does not match latest.json ${String(payload.gitHead)}`);
  }
  if (markdownStatus !== String(payload.status)) {
    failures.push(`${phaseId}: latest.md status ${String(markdownStatus)} does not match latest.json ${String(payload.status)}`);
  }

  return failures;
}

export function assertEvidenceFreshness(phaseIds, expectedGitHead = getGitHead()) {
  const failures = [];

  for (const phaseId of phaseIds) {
    const directoryName = PHASE_DIRECTORY_NAMES[phaseId];
    if (!directoryName) {
      failures.push(`Unsupported closeout phase for freshness check: ${phaseId}`);
      continue;
    }

    const evidenceDir = getRootPath("docs", "reports", "closeout", directoryName);
    const jsonPath = join(evidenceDir, "latest.json");
    const markdownPath = join(evidenceDir, "latest.md");

    if (!existsSync(jsonPath)) {
      failures.push(`${phaseId}: missing ${jsonPath}`);
      continue;
    }
    if (!existsSync(markdownPath)) {
      failures.push(`${phaseId}: missing ${markdownPath}`);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch (error) {
      failures.push(`${phaseId}: could not parse latest.json (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    const markdown = readFileSync(markdownPath, "utf-8");
    failures.push(
      ...collectEvidenceFreshnessFailures(
        phaseId,
        payload,
        markdown,
        expectedGitHead,
      ),
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

function renderEvidenceMarkdown(phaseId, payload) {
  const lines = [
    `# ${PHASE_TITLES[phaseId]}`,
    "",
    `- Status: ${payload.status}`,
    `- Git SHA: ${payload.gitHead}`,
    `- Generated At: ${payload.generatedAt}`,
  ];

  if (payload.notes?.length) {
    lines.push("- Notes:");
    for (const note of payload.notes) {
      lines.push(`  - ${note}`);
    }
  }

  lines.push("", "## Commands", "");

  for (const step of payload.steps ?? []) {
    lines.push(`- ${step.label}: ${step.status}`);
    lines.push(`  - Command: \`${step.command}\``);
    lines.push(`  - Exit Code: ${step.exitCode}`);
    lines.push(`  - Started At: ${step.startedAt}`);
    lines.push(`  - Finished At: ${step.finishedAt}`);
  }

  if (payload.metrics) {
    lines.push("", "## Metrics", "");
    for (const [key, value] of Object.entries(payload.metrics)) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function createPhaseSteps(steps) {
  return steps.map((step) => {
    if (step.type === "npm") {
      return {
        label: step.label,
        command: getNpmCommand(),
        args: ["run", step.script],
      };
    }
    return step;
  });
}

export function exitWithFailure(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

export function validatePhaseArg(value) {
  if (!Object.prototype.hasOwnProperty.call(PHASE_DIRECTORY_NAMES, value)) {
    exitWithFailure(`Unsupported phase argument: ${value}`);
  }
  return value;
}
