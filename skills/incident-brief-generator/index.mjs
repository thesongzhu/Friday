import { readFileSync } from "node:fs";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPortListeners,
  detectProcessesByName,
  fetchHealthCheck,
  findRepoRoot,
  readWorkspaceRoot,
  triageLogs,
} from "../_shared/devops-skill-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const incidentBriefTemplate = readFileSync(join(__dirname, "assets/incident-brief-template.md"), "utf-8");

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const symptoms = typeof input.symptoms === "string" ? input.symptoms.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const processName = typeof input.processName === "string" ? input.processName.trim() : "";
  const port = Number.isFinite(Number(input.port)) ? Number(input.port) : null;
  const healthUrl = typeof input.healthUrl === "string" ? input.healthUrl.trim() : "";
  const logPath = typeof input.logPath === "string" ? input.logPath.trim() : "";

  const [listeners, processes, health, logs] = await Promise.all([
    port != null ? detectPortListeners(port) : Promise.resolve([]),
    processName ? detectProcessesByName(processName) : Promise.resolve([]),
    healthUrl ? fetchHealthCheck(healthUrl, 10_000) : Promise.resolve(null),
    triageLogs(repoRoot, { explicitPath: logPath || undefined, maxFiles: 3 }),
  ]);

  const evidenceLines = [];
  if (symptoms) evidenceLines.push(`- Reported symptoms: ${symptoms}`);
  if (notes) evidenceLines.push(`- Operator notes: ${notes}`);
  if (processName) evidenceLines.push(`- Matching processes: ${processes.length}`);
  if (port != null) evidenceLines.push(`- Port ${String(port)} listeners: ${listeners.length}`);
  if (healthUrl) evidenceLines.push(`- Health check: ${health?.status ?? 0} ${health?.statusText ?? ""}`.trim());
  if (logs.topIssues[0]) evidenceLines.push(`- Loudest log issue: ${logs.topIssues[0].sample} (${logs.topIssues[0].count} hits)`);

  const likelyCauses = [];
  if (healthUrl && health && !health.ok) likelyCauses.push("The health endpoint is not reporting success.");
  if (port != null && listeners.length === 0) likelyCauses.push("Nothing is listening on the expected local port.");
  if (processName && processes.length === 0) likelyCauses.push("The expected process name was not found.");
  if (logs.topIssues[0]) likelyCauses.push(`The most common recent log failure points to: ${logs.topIssues[0].sample}`);
  if (likelyCauses.length === 0) likelyCauses.push("No single dominant failure signal was detected from the provided evidence.");

  const nextActions = [];
  if (logs.topIssues[0]) nextActions.push("Validate the top log fingerprint against the current user-facing failure.");
  if (healthUrl && health && !health.ok) nextActions.push("Re-run the failing health path manually and compare its response with the service logs.");
  if (port != null && listeners.length === 0) nextActions.push("Confirm the startup path, env config, and whether the service bound to the intended port.");
  if (nextActions.length === 0) nextActions.push("Capture a wider incident timeline and add more evidence if the issue persists.");

  const briefMarkdown = incidentBriefTemplate
    .replace("{{title}}", path.basename(repoRoot))
    .replace("{{severity}}", likelyCauses.length > 1 ? "high" : "medium")
    .replace("{{status}}", "investigating")
    .replace("{{timestamp}}", new Date().toISOString())
    .replace("{{situation_summary}}", symptoms || "An incident summary was requested, but no explicit symptom statement was provided.")
    .replace("| Users affected | {{users_affected}} |", `| Users affected | ${healthUrl && health && !health.ok ? "Potentially all users hitting " + healthUrl : "Unknown"} |`)
    .replace("| Services degraded | {{services_degraded}} |", `| Services degraded | ${port != null && listeners.length === 0 ? "Service on port " + String(port) : "Under investigation"} |`)
    .replace("| Revenue impact | {{revenue_impact}} |", "| Revenue impact | To be determined |")
    .replace(/\{\{#each evidence\}\}[\s\S]*?\{\{\/each\}\}/m, evidenceLines.length > 0 ? evidenceLines.join("\n") : "- No structured evidence was provided.")
    .replace(/\{\{#each causes\}\}[\s\S]*?\{\{\/each\}\}/m, likelyCauses.map((cause, i) => `${i + 1}. ${cause}`).join("\n"))
    .replace(/\{\{#each actions\}\}[\s\S]*?\{\{\/each\}\}/m, nextActions.map((step) => `- [ ] ${step}`).join("\n"));

  return {
    summary: `Incident brief prepared for ${path.basename(repoRoot)} with ${evidenceLines.length} evidence line(s).`,
    briefMarkdown,
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
  };
}
