import path from "node:path";
import {
  findRepoRoot,
  readWorkspaceRoot,
  triageLogs,
} from "../_shared/devops-skill-utils.mjs";

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const triage = await triageLogs(repoRoot, {
    explicitPath: typeof input.logPath === "string" ? input.logPath : undefined,
    maxFiles: 6,
  });

  if (triage.files.length === 0) {
    return {
      summary: `No log files were discovered under ${path.basename(repoRoot)}. Provide a logPath or create a logs/ directory inside the workspace.`,
      scannedFiles: [],
      topIssues: [],
      recommendedNextSteps: [
        "Provide logPath pointing to a file or log directory.",
        "If this is a running local service, pair this with local-service-diagnose.",
      ],
    };
  }

  const topIssue = triage.topIssues[0];
  return {
    summary: topIssue
      ? `Scanned ${triage.files.length} log file(s). The loudest issue is "${topIssue.sample}" and it appeared ${topIssue.count} time(s).`
      : `Scanned ${triage.files.length} log file(s), but no obvious error or warning patterns were detected in the recent tail.`,
    scannedFiles: triage.files,
    topIssues: triage.topIssues,
    recommendedNextSteps: topIssue
      ? [
          "Confirm whether the top fingerprint matches the current incident window.",
          "Use incident-brief-generator to turn these findings into a handoff summary.",
        ]
      : [
          "Increase the log window or provide a more specific logPath.",
          "Cross-check with a health endpoint or local service diagnostics.",
        ],
  };
}
