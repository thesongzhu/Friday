import path from "node:path";
import {
  detectPortListeners,
  detectProcessesByName,
  fetchHealthCheck,
  findRepoRoot,
  readWorkspaceRoot,
  triageLogs,
} from "../_shared/devops-skill-utils.mjs";

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const port = Number.isFinite(Number(input.port)) ? Number(input.port) : null;
  const processName = typeof input.processName === "string" ? input.processName.trim() : "";
  const healthUrl = typeof input.healthUrl === "string" ? input.healthUrl.trim() : "";
  const logPath = typeof input.logPath === "string" ? input.logPath.trim() : "";

  const [listeners, processes, health, logs] = await Promise.all([
    port != null ? detectPortListeners(port) : Promise.resolve([]),
    processName ? detectProcessesByName(processName) : Promise.resolve([]),
    healthUrl ? fetchHealthCheck(healthUrl, 10_000) : Promise.resolve(null),
    triageLogs(repoRoot, { explicitPath: logPath || undefined, maxFiles: 3 }),
  ]);

  let status = "unknown";
  if (health?.ok) {
    status = "healthy";
  } else if (listeners.length > 0 || processes.length > 0) {
    status = "degraded";
  } else if (port != null || processName || healthUrl) {
    status = "unavailable";
  }

  const nextActions = [];
  if (status === "healthy") {
    nextActions.push("Service responds successfully to the health check. Focus on higher-level correctness rather than availability.");
  } else if (status === "degraded") {
    nextActions.push("The service appears partially alive. Check the top log issue and compare it with the failing path.");
  } else if (status === "unavailable") {
    nextActions.push("No healthy listener or process was confirmed. Verify startup configuration and inspect recent logs.");
  } else {
    nextActions.push("Provide at least one of processName, port, healthUrl, or logPath for a stronger diagnosis.");
  }
  if (logs.topIssues[0]) {
    nextActions.push(`Most frequent recent log issue: ${logs.topIssues[0].sample}`);
  }

  const summaryParts = [];
  if (processName) summaryParts.push(`${processes.length} matching process record(s)`);
  if (port != null) summaryParts.push(`${listeners.length} listener record(s) on port ${String(port)}`);
  if (healthUrl) summaryParts.push(`health ${health?.status ?? 0}`);
  const summaryLead = summaryParts.length > 0 ? summaryParts.join(" · ") : "No explicit process, port, or health URL provided";

  return {
    status,
    summary: `${path.basename(repoRoot)} service diagnosis: ${status}. ${summaryLead}.`,
    details: {
      repoRoot,
      processName: processName || null,
      processes,
      port,
      listeners,
      healthUrl: healthUrl || null,
      health,
      logFiles: logs.files,
      topIssues: logs.topIssues,
    },
    nextActions,
  };
}
