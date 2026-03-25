import * as fs from "node:fs/promises";
import path from "node:path";
import {
  findRepoRoot,
  parseGitStatusLines,
  readWorkspaceRoot,
  runCommand,
} from "../_shared/devops-skill-utils.mjs";
import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const MANAGED_START = "<!-- friday-release-doc-sync:start -->";
const MANAGED_END = "<!-- friday-release-doc-sync:end -->";

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function buildHighlights(goal, changedPaths) {
  const bullets = [];
  if (goal) {
    bullets.push(compact(goal.replace(/\s+/g, " "), 140));
  }
  if (changedPaths.some((filePath) => /^ui\/|^src\/uix\//.test(filePath))) {
    bullets.push("Assistant and UI surfaces changed and should stay aligned with the operator-facing product story.");
  }
  if (changedPaths.some((filePath) => /^skills\//.test(filePath))) {
    bullets.push("Bundled skill behavior changed, so documentation should call out the new starter or execution flow.");
  }
  if (changedPaths.some((filePath) => /^src\/browser\//.test(filePath))) {
    bullets.push("Browser-backed flows changed and should keep their QA or evidence expectations documented.");
  }
  if (changedPaths.some((filePath) => /^src\/agent\//.test(filePath))) {
    bullets.push("Agent orchestration changed, so README and architecture notes should reflect the new routing or guardrails.");
  }
  if (changedPaths.some((filePath) => /^src\/api\/|^src\/system\//.test(filePath))) {
    bullets.push("Operator-facing API or system surfaces changed and should be reflected in release notes.");
  }
  if (bullets.length === 0 && changedPaths.length > 0) {
    bullets.push(`Updated workspace surface: ${changedPaths.slice(0, 5).join(", ")}${changedPaths.length > 5 ? ", ..." : ""}.`);
  }
  return unique(bullets).slice(0, 5);
}

function renderManagedBlock(lines) {
  return [
    MANAGED_START,
    ...lines,
    MANAGED_END,
  ].join("\n");
}

function replaceManagedBlock(text, block) {
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + MANAGED_END.length;
    return `${text.slice(0, start)}${block}${text.slice(afterEnd)}`;
  }
  return null;
}

function updateChangelog(text, highlights) {
  const block = renderManagedBlock([
    "### Changed",
    ...highlights.map((line) => `- ${line}`),
  ]);
  const replaced = replaceManagedBlock(text, block);
  if (replaced != null) {
    return replaced;
  }
  const anchor = "## [Unreleased]";
  if (!text.includes(anchor)) {
    return text;
  }
  return text.replace(anchor, `${anchor}\n\n${block}`);
}

function updateReadme(text, today, highlights) {
  const headingPattern = /^## Latest Updates(?: \([^)]+\))?/m;
  if (!headingPattern.test(text)) {
    return text;
  }
  const block = renderManagedBlock(highlights.map((line) => `- ${line}`));
  const normalizedHeading = `## Latest Updates (${today})`;
  const withHeading = text.replace(headingPattern, normalizedHeading);
  const replaced = replaceManagedBlock(withHeading, block);
  if (replaced != null) {
    return replaced;
  }
  return withHeading.replace(normalizedHeading, `${normalizedHeading}\n\n${block}`);
}

function updateArchitecture(text, today, highlights) {
  const heading = "## 8) Recent Documentation Sync";
  const block = renderManagedBlock([
    `Last synced: ${today}`,
    "",
    ...highlights.map((line) => `- ${line}`),
  ]);
  const replaced = replaceManagedBlock(text, block);
  if (replaced != null) {
    return replaced;
  }
  if (text.includes(heading)) {
    return text.replace(heading, `${heading}\n\n${block}`);
  }
  return `${text.trimEnd()}\n\n${heading}\n\n${block}\n`;
}

async function maybeWriteFile(targetPath, nextContent, apply) {
  const currentContent = await fs.readFile(targetPath, "utf8");
  if (currentContent === nextContent) {
    return { changed: false, file: targetPath };
  }
  if (apply) {
    await fs.writeFile(targetPath, nextContent, "utf8");
  }
  return { changed: true, file: targetPath };
}

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const gitStatus = await runCommand("git", ["status", "--short"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  const changedEntries = gitStatus.ok ? parseGitStatusLines(gitStatus.stdout) : [];
  const changedPaths = changedEntries.map((entry) => entry.path);
  const goal = asString(input.goal ?? input.summary ?? input.text);
  const apply = input.apply === true;
  const today = new Date().toISOString().slice(0, 10);
  const highlights = buildHighlights(goal, changedPaths);

  if (highlights.length === 0) {
    return {
      summary: "Release doc sync: no release-facing changes were detected, so docs were left untouched.",
      nextStep: "Make the source change first or provide a release summary for the docs sync skill.",
      details: {
        repoRoot,
        apply,
        changedPaths,
        highlights: [],
        updatedFiles: [],
      },
    };
  }

  const candidates = [
    path.join(repoRoot, "README.md"),
    path.join(repoRoot, "CHANGELOG.md"),
    path.join(repoRoot, "docs", "reference", "ARCHITECTURE.md"),
  ];
  const updatedFiles = [];

  for (const targetPath of candidates) {
    try {
      const currentContent = await fs.readFile(targetPath, "utf8");
      const nextContent = targetPath.endsWith(`${path.sep}README.md`) && path.basename(path.dirname(targetPath)) !== "reference"
        ? updateReadme(currentContent, today, highlights)
        : targetPath.endsWith(`${path.sep}CHANGELOG.md`)
          ? updateChangelog(currentContent, highlights)
          : updateArchitecture(currentContent, today, highlights);
      const result = await maybeWriteFile(targetPath, nextContent, apply);
      if (result.changed) {
        updatedFiles.push(result.file);
      }
    } catch {
      continue;
    }
  }

  return {
    summary: apply
      ? `Release doc sync: updated ${String(updatedFiles.length)} documentation file(s).`
      : `Release doc sync: prepared updates for ${String(updatedFiles.length)} documentation file(s).`,
    nextStep: apply
      ? "Review the generated doc diff, then run your normal release or landing checks."
      : "Review the proposed highlights and rerun with apply=true when you want Friday to write them.",
    details: {
      repoRoot,
      apply,
      changedPaths,
      highlights,
      updatedFiles,
      managedBlock: {
        start: MANAGED_START,
        end: MANAGED_END,
      },
    },
  };
}
