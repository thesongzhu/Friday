import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asNumber, asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";
import {
  ensureDir,
  findRepoRoot,
  readWorkspaceRoot,
  runCommand,
  skillEvidenceRoot,
  writeSkillEvidenceJson,
} from "../_shared/devops-skill-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const retroTemplate = readFileSync(join(__dirname, "assets/retro-template.md"), "utf-8");

const SKILL_ID = "engineering-retro";

function parseCommitLines(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...subjectParts] = line.split("\t");
      return {
        hash,
        author,
        date,
        subject: subjectParts.join("\t"),
      };
    });
}

function pickThemes(commits) {
  const themes = new Map();
  for (const commit of commits) {
    const normalized = commit.subject.toLowerCase();
    const key =
      /skill|assistant|agent/.test(normalized) ? "agent_and_skills"
        : /workflow|deploy|release/.test(normalized) ? "workflow_and_release"
          : /security|auth|token|trust/.test(normalized) ? "security_and_trust"
            : /ui|design|page|browser/.test(normalized) ? "ui_and_browser"
              : "general_delivery";
    themes.set(key, (themes.get(key) ?? 0) + 1);
  }
  return [...themes.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key]) => key.replaceAll("_", " "));
}

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const sinceDays = Math.min(60, Math.max(1, Math.round(asNumber(input.sinceDays, 14))));
  const sinceArg = `${sinceDays}.days`;
  const logResult = await runCommand("git", [
    "log",
    `--since=${sinceArg}`,
    "--pretty=format:%H%x09%an%x09%ad%x09%s",
    "--date=short",
    "-n",
    "40",
  ], { cwd: repoRoot, timeoutMs: 20_000 });
  const commits = parseCommitLines(logResult.stdout);
  const shortlog = await runCommand("git", ["shortlog", "-sne", `--since=${sinceArg}`, "HEAD"], {
    cwd: repoRoot,
    timeoutMs: 20_000,
  });
  const contributors = shortlog.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { commits: Number(match[1]), author: match[2] } : null;
    })
    .filter(Boolean);

  const evidenceRoot = skillEvidenceRoot(repoRoot, SKILL_ID);
  await ensureDir(evidenceRoot);
  let evidenceFileCount = 0;
  try {
    const entries = await fs.readdir(path.join(repoRoot, ".friday", "skills"), { recursive: true });
    evidenceFileCount = entries.filter((entry) => String(entry).endsWith(".json")).length;
  } catch {
    evidenceFileCount = 0;
  }

  const themes = pickThemes(commits);
  const wins = [];
  if (commits.length > 0) {
    wins.push(`Recorded ${commits.length} recent commit(s) across ${contributors.length || 1} contributor slot(s).`);
  }
  if (themes.length > 0) {
    wins.push(`Dominant work themes: ${themes.join(", ")}.`);
  }
  if (evidenceFileCount > 0) {
    wins.push(`Friday has ${evidenceFileCount} local skill evidence artifact(s) available for retrospective context.`);
  }

  const risks = [];
  if (contributors.length <= 1) {
    risks.push("Recent delivery appears concentrated in a single contributor, so review and resilience may be bottlenecked.");
  }
  if (commits.length < 3) {
    risks.push("The recent ship cadence is sparse, so trend confidence is limited.");
  }
  if (themes.length === 1) {
    risks.push("Recent work clustered around one theme; verify that testing and documentation kept pace with implementation.");
  }

  const followUps = [
    commits[0]?.subject
      ? `Validate the newest change end-to-end: ${compact(commits[0].subject, 120)}.`
      : "Collect a fresh benchmark or QA artifact before the next retro.",
    evidenceFileCount > 0
      ? "Cross-check the latest benchmark, canary, and security evidence before the next release decision."
      : "Start capturing local skill evidence under .friday so the next retro has concrete signals.",
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    sinceDays,
    commitCount: commits.length,
    contributors,
    themes,
    wins,
    risks,
    followUps,
    recentCommits: commits.slice(0, 10),
  };
  const reportPath = await writeSkillEvidenceJson(
    repoRoot,
    SKILL_ID,
    path.join("runs", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    payload,
  );

  const retroMarkdown = retroTemplate
    .replace(/\{\{period\}\}/g, `Last ${sinceDays} day(s)`)
    .replace("{{team}}", contributors.map((c) => c.author).join(", ") || "Unknown")
    .replace("{{timestamp}}", new Date().toISOString())
    .replace(/\{\{#each shipped\}\}[\s\S]*?\{\{\/each\}\}/m, commits.slice(0, 10).map((c) => `- **${c.hash.slice(0, 8)}** — ${c.subject}`).join("\n"))
    .replace(/\{\{#each went_well\}\}[\s\S]*?\{\{\/each\}\}/m, wins.map((w) => `- ${w}`).join("\n") || "- No wins identified.")
    .replace(/\{\{#each could_improve\}\}[\s\S]*?\{\{\/each\}\}/m, risks.map((r) => `- ${r}`).join("\n") || "- No risks identified.")
    .replace("{{metrics.commits}}", String(commits.length))
    .replace("{{metrics.prev_commits}}", "—")
    .replace("{{metrics.commits_trend}}", "—")
    .replace("{{metrics.prs_merged}}", "—")
    .replace("{{metrics.prev_prs}}", "—")
    .replace("{{metrics.prs_trend}}", "—")
    .replace("{{metrics.incidents}}", "—")
    .replace("{{metrics.prev_incidents}}", "—")
    .replace("{{metrics.incidents_trend}}", "—")
    .replace(/\{\{#each action_items\}\}[\s\S]*?\{\{\/each\}\}/m, followUps.map((f) => `- [ ] ${f}`).join("\n"));

  return {
    summary: commits.length > 0
      ? `Engineering retro: summarized ${commits.length} recent commit(s) across the last ${sinceDays} day(s).`
      : `Engineering retro: no recent commits were found in the last ${sinceDays} day(s).`,
    nextStep: risks.length > 0
      ? `Address the highest retro risk first: ${risks[0]}`
      : "Use this retro as the release or sprint wrap-up note and keep the evidence trend going.",
    retroMarkdown,
    details: {
      sinceDays,
      contributors,
      themes,
      wins,
      risks,
      followUps,
      reportPath,
      suggestedSkillId: evidenceFileCount > 0 ? "release-canary-check" : "page-benchmark-report",
    },
  };
}
