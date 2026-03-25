import * as fs from "node:fs/promises";
import path from "node:path";
import {
  asString,
  compact,
  requireBrowserContext,
} from "../_shared/friday-runtime-skill-utils.mjs";
import {
  fileExists,
  findRepoRoot,
  readJsonFile,
  readWorkspaceRoot,
  writeSkillEvidenceJson,
} from "../_shared/devops-skill-utils.mjs";

const SKILL_ID = "browser-qa-fix";
const URL_PATTERN = /https?:\/\/[^\s)]+/i;

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function pickUrl(input) {
  if (typeof input.url === "string" && input.url.trim().length > 0) {
    return input.url.trim();
  }
  const goal = asString(input.goal ?? input.text);
  const match = goal.match(URL_PATTERN);
  return match?.[0] ?? "";
}

function deriveDesiredTitle(input, inspection) {
  if (typeof input.desiredTitle === "string" && input.desiredTitle.trim().length > 0) {
    return input.desiredTitle.trim();
  }
  const goal = asString(input.goal ?? input.text);
  const quoted = goal.match(/title\s+(?:to|as)\s+["']([^"']+)["']/i);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const current = typeof inspection?.title === "string" ? inspection.title.trim() : "";
  if (current && !/^(vite app|react app|untitled|new page)$/i.test(current)) {
    return current;
  }
  const hostname = typeof inspection?.finalUrl === "string"
    ? inspection.finalUrl.replace(/^https?:\/\//i, "").split("/")[0]
    : "";
  return hostname ? `Friday | ${hostname}` : "Friday";
}

async function resolveTargetFile(repoRoot, input) {
  if (typeof input.targetFile === "string" && input.targetFile.trim().length > 0) {
    return path.resolve(repoRoot, input.targetFile.trim());
  }
  const candidates = unique([
    "index.html",
    "ui/index.html",
    "public/index.html",
    "app/index.html",
  ]);
  for (const candidate of candidates) {
    const absolutePath = path.join(repoRoot, candidate);
    if (await fileExists(absolutePath)) {
      return absolutePath;
    }
  }
  return null;
}

function planTitlePatch(html, desiredTitle) {
  const headMatch = html.match(/<head[^>]*>/i);
  if (!headMatch?.[0]) {
    return {
      applicable: false,
      reason: "No <head> block was found, so Friday cannot apply the bounded title fix safely.",
    };
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const currentTitle = titleMatch?.[1]?.trim() ?? "";
  if (currentTitle === desiredTitle) {
    return {
      applicable: false,
      reason: "The target file already contains the desired <title> value.",
    };
  }

  if (titleMatch) {
    return {
      applicable: true,
      patchType: "replace_title",
      currentTitle,
      nextContent: html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${desiredTitle}</title>`),
    };
  }

  const nextContent = html.replace(headMatch[0], `${headMatch[0]}\n  <title>${desiredTitle}</title>`);
  return {
    applicable: true,
    patchType: "insert_title",
    currentTitle,
    nextContent,
  };
}

export async function execute(input = {}, ctx = {}) {
  const browser = requireBrowserContext(ctx);
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const apply = input.apply === true;
  const evidencePath = typeof input.evidencePath === "string" && input.evidencePath.trim().length > 0
    ? path.resolve(repoRoot, input.evidencePath.trim())
    : null;
  const evidence = evidencePath ? await readJsonFile(evidencePath) : null;
  const url = pickUrl(input) || asString(evidence?.url);
  let inspection = null;
  let sessionId = "";

  try {
    if (url) {
      inspection = await browser.inspectPage({
        url,
        waitUntil: "load",
        screenshotName: "browser-qa-fix",
      });
      sessionId = inspection.sessionId;
    }

    if (!inspection && !evidence) {
      return {
        summary: "Browser QA fix: missing browser evidence or page target, so Friday did not change any files.",
        nextStep: "Provide a URL, an evidencePath, or run browser-qa-report first so Friday can stay inside the bounded QA-fix policy.",
        details: {
          apply,
          repoRoot,
          requiresApproval: true,
          blockedReason: "No browser evidence or page target was provided for the requested fix.",
          suggestedSkillId: "browser-qa-report",
        },
      };
    }

    const targetFile = await resolveTargetFile(repoRoot, input);
    if (!targetFile) {
      return {
        summary: "Browser QA fix: no bounded target file was found for a safe fix.",
        nextStep: "Provide targetFile explicitly or add a single HTML entrypoint before asking Friday to auto-fix browser QA issues.",
        details: {
          apply,
          repoRoot,
          requiresApproval: true,
          blockedReason: "No target HTML file was found for a bounded metadata fix.",
          suggestedSkillId: "browser-qa-report",
        },
      };
    }

    const html = await fs.readFile(targetFile, "utf8");
    const desiredTitle = deriveDesiredTitle(input, inspection);
    const patch = planTitlePatch(html, desiredTitle);
    const findings = [];
    if (inspection?.consoleErrors?.length) {
      findings.push({
        severity: "high",
        title: "Console errors were present during QA",
        detail: inspection.consoleErrors.slice(0, 3).map((entry) => entry.text).join(" | "),
      });
    }
    if (inspection?.pageErrors?.length) {
      findings.push({
        severity: "high",
        title: "Unhandled page errors were present during QA",
        detail: inspection.pageErrors.slice(0, 3).join(" | "),
      });
    }
    if (inspection?.requestFailures?.length) {
      findings.push({
        severity: "high",
        title: "Request failures were present during QA",
        detail: inspection.requestFailures
          .slice(0, 3)
          .map((entry) => `${entry.method} ${entry.url}`)
          .join(" | "),
      });
    }

    if (!patch.applicable) {
      return {
        summary: `Browser QA fix: ${patch.reason}`,
        nextStep: findings.length > 0
          ? "Review the blocking browser evidence first; the current request exceeds the bounded safe-fix policy."
          : "Adjust the target or provide a different bounded HTML metadata fix request.",
        details: {
          apply,
          repoRoot,
          targetFile,
          desiredTitle,
          inspection: inspection
            ? {
              url: inspection.finalUrl,
              title: inspection.title,
              screenshotPath: inspection.screenshotPath,
              consoleErrors: inspection.consoleErrors,
            }
            : null,
          findings,
          requiresApproval: findings.length > 0,
          blockedReason: patch.reason,
          suggestedSkillId: findings.length > 0 ? "workspace-diff-review" : "browser-qa-report",
        },
      };
    }

    if (findings.length > 0) {
      return {
        summary: "Browser QA fix: broader QA errors were detected, so Friday stopped before applying a bounded fix.",
        nextStep: `Review the highest-risk browser issue first: ${findings[0].title}.`,
        details: {
          apply,
          repoRoot,
          targetFile,
          desiredTitle,
          inspection: inspection
            ? {
              url: inspection.finalUrl,
              title: inspection.title,
              screenshotPath: inspection.screenshotPath,
              consoleErrors: inspection.consoleErrors,
              pageErrors: inspection.pageErrors,
              requestFailures: inspection.requestFailures,
            }
            : null,
          findings,
          requiresApproval: true,
          blockedReason: "Detected browser errors exceed the bounded safe-fix policy.",
          suggestedSkillId: "workspace-diff-review",
        },
      };
    }

    const runPayload = {
      generatedAt: new Date().toISOString(),
      apply,
      targetFile,
      desiredTitle,
      patchType: patch.patchType,
      currentTitle: patch.currentTitle,
      finalUrl: inspection?.finalUrl ?? null,
      screenshotPath: inspection?.screenshotPath ?? null,
    };
    const reportPath = await writeSkillEvidenceJson(
      repoRoot,
      SKILL_ID,
      path.join("runs", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
      runPayload,
    );

    if (apply) {
      await fs.writeFile(targetFile, patch.nextContent, "utf8");
    }

    return {
      summary: apply
        ? `Browser QA fix: updated ${path.relative(repoRoot, targetFile)} with a bounded title fix.`
        : `Browser QA fix: prepared a bounded title fix for ${path.relative(repoRoot, targetFile)}.`,
      nextStep: apply
        ? "Review the HTML diff and rerun browser QA or canary checks against the same page."
        : "Rerun with apply=true once you want Friday to write the bounded fix.",
      details: {
        apply,
        repoRoot,
        targetFile,
        desiredTitle,
        patchType: patch.patchType,
        currentTitle: patch.currentTitle,
        preview: compact(patch.nextContent, 220),
        inspection: inspection
          ? {
            url: inspection.finalUrl,
            title: inspection.title,
            screenshotPath: inspection.screenshotPath,
            consoleErrors: inspection.consoleErrors,
            requestFailures: inspection.requestFailures,
          }
          : null,
        findings,
        reportPath,
        suggestedSkillId: "browser-qa-report",
      },
    };
  } finally {
    if (sessionId) {
      await browser.closeSession(sessionId).catch(() => undefined);
    }
  }
}
