import fs from "node:fs";
import path from "node:path";
import { asString } from "../_shared/friday-runtime-skill-utils.mjs";
import {
  findRepoRoot,
  readWorkspaceRoot,
  runCommand,
  writeSkillEvidenceJson,
} from "../_shared/devops-skill-utils.mjs";

const SKILL_ID = "security-review";
const MAX_SCAN_FILE_BYTES = 512 * 1024;

function walkScanFiles(rootDir, collected = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      walkScanFiles(fullPath, collected);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_SCAN_FILE_BYTES) {
        continue;
      }
    } catch {
      continue;
    }
    collected.push(fullPath);
  }
  return collected;
}

function collectFallbackMatches(targets, pattern, limit = 200) {
  const matcher = new RegExp(pattern, "i");
  const files = targets.flatMap((entry) => walkScanFiles(entry, []));
  const matches = [];

  for (const filePath of files) {
    if (matches.length >= limit) {
      break;
    }
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      matcher.lastIndex = 0;
      if (!matcher.test(line)) {
        continue;
      }
      matches.push(`${filePath}:${String(index + 1)}:${line}`);
      if (matches.length >= limit) {
        break;
      }
    }
  }

  return matches;
}

function summarizeMatches(lines, limit = 6) {
  return lines
    .slice(0, limit)
    .map((line) => {
      const match = line.match(/^([^:]+:\d+):(.+)$/);
      if (!match) {
        return { location: line, preview: "" };
      }
      return {
        location: match[1],
        preview: match[2].trim().slice(0, 220),
      };
    });
}

async function scan(repoRoot, pattern, globs = ["src", "skills", "ui"]) {
  const targets = globs
    .map((entry) => path.join(repoRoot, entry))
    .filter((entry) => fs.existsSync(entry));
  const result = await runCommand("rg", ["-n", "-S", pattern, ...(targets.length > 0 ? targets : [repoRoot])], {
    cwd: repoRoot,
    timeoutMs: 20_000,
  });
  const rgLines = result.ok
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const fallbackLines = rgLines.length > 0
    ? []
    : collectFallbackMatches(targets.length > 0 ? targets : [repoRoot], pattern);
  const lines = rgLines.length > 0 ? rgLines : fallbackLines;
  return {
    ok: result.ok || fallbackLines.length > 0,
    command: fallbackLines.length > 0 ? `${result.command} || node-fallback` : result.command,
    count: lines.length,
    sample: summarizeMatches(lines),
  };
}

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const goal = asString(input.goal ?? input.text);

  const [
    hardcodedSecrets,
    proxyTrust,
    authAndToken,
    execSurface,
    marketplaceAndRemote,
  ] = await Promise.all([
    scan(repoRoot, "BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}"),
    scan(repoRoot, "x-forwarded-for|x-real-ip|remoteAddress|trustProxy|FRIDAY_HTTP_TRUST_PROXY"),
    scan(repoRoot, "passkey|bearer|access token|session|oauth|authorization"),
    scan(repoRoot, "spawn\\(|exec\\(|execFile\\(|shell-execute|workflow_run|skill_run"),
    scan(repoRoot, "marketplace|plugin|remote access|remote session|satellite|fleet"),
  ]);

  const findings = [];
  if (hardcodedSecrets.count > 0) {
    findings.push({
      severity: "high",
      title: "Potential hardcoded credential material detected",
      detail: `Found ${hardcodedSecrets.count} secret-like match(es); review the sampled locations immediately.`,
    });
  }
  if (proxyTrust.count > 0) {
    findings.push({
      severity: "medium",
      title: "Reverse proxy trust surfaces present",
      detail: `Found ${proxyTrust.count} proxy/IP trust touchpoint(s); verify they share the same trust model.`,
    });
  }
  if (execSurface.count > 0) {
    findings.push({
      severity: "medium",
      title: "Executable surfaces present",
      detail: `Found ${execSurface.count} shell, workflow, or skill execution touchpoint(s); confirm they remain approval-bounded.`,
    });
  }
  if (marketplaceAndRemote.count > 0) {
    findings.push({
      severity: "medium",
      title: "Remote or supply-chain attack surfaces present",
      detail: `Found ${marketplaceAndRemote.count} remote access, plugin, marketplace, or fleet touchpoint(s).`,
    });
  }

  const threatModel = [
    {
      surface: "auth_and_sessions",
      rationale: authAndToken.count > 0
        ? `Repository contains ${authAndToken.count} auth or token-related touchpoint(s).`
        : "Auth-specific touchpoints were not strongly represented in the sampled search.",
      focus: "Validate token issuance, local login gates, and session trust boundaries.",
    },
    {
      surface: "proxy_and_remote_access",
      rationale: proxyTrust.count > 0
        ? `Repository contains ${proxyTrust.count} proxy/IP trust touchpoint(s).`
        : "Proxy trust patterns were not detected in the sampled search.",
      focus: "Confirm forwarded headers are trusted only behind explicit proxy configuration.",
    },
    {
      surface: "execution_and_supply_chain",
      rationale: execSurface.count > 0 || marketplaceAndRemote.count > 0
        ? `Execution surfaces: ${execSurface.count}; marketplace/remote surfaces: ${marketplaceAndRemote.count}.`
        : "Execution and supply-chain surfaces were limited in the sampled search.",
      focus: "Keep workflow, skill, plugin, and marketplace paths approval-bounded and observable.",
    },
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    goal,
    findings,
    scans: {
      hardcodedSecrets,
      proxyTrust,
      authAndToken,
      execSurface,
      marketplaceAndRemote,
    },
    threatModel,
  };
  const reportPath = await writeSkillEvidenceJson(
    repoRoot,
    SKILL_ID,
    path.join("runs", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    payload,
  );

  return {
    summary: findings.length > 0
      ? `Security review: surfaced ${findings.length} area(s) that warrant follow-up.`
      : "Security review: no obvious high-signal issues were surfaced by the bounded static scan.",
    nextStep: findings[0]
      ? `Follow the highest-signal item first: ${findings[0].title}.`
      : "Use the threat model to pick the next focused manual audit surface before shipping.",
    details: {
      findings,
      threatModel,
      reportPath,
      scans: {
        hardcodedSecrets: hardcodedSecrets.sample,
        proxyTrust: proxyTrust.sample,
        authAndToken: authAndToken.sample,
        execSurface: execSurface.sample,
        marketplaceAndRemote: marketplaceAndRemote.sample,
      },
      suggestedSkillId: findings.some((finding) => finding.severity === "high")
        ? "workspace-diff-review"
        : "release-canary-check",
    },
  };
}
