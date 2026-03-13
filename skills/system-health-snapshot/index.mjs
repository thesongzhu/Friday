import {
  asRecord,
  asString,
  compact,
  requireSystemContext,
} from "../_shared/friday-runtime-skill-utils.mjs";

export async function execute(_input = {}, ctx = {}) {
  const system = requireSystemContext(ctx);
  const snapshot = await system.getSnapshot();
  const health = asRecord(snapshot.health);
  const companion = asRecord(snapshot.companion);
  const browser = asRecord(snapshot.browser);
  const approvals = asRecord(snapshot.approvalsSummary);
  const remoteDevices = asRecord(snapshot.remoteDevicesSummary);
  const remoteSessions = asRecord(snapshot.remoteSessionsSummary);

  const healthStatus = asString(health.status, "unknown");
  const companionStatus = asString(companion.status, "unknown");
  const browserMode = asString(browser.activeMode || browser.configuredMode, "unavailable");
  const targetBrowser = asString(browser.targetBrowser, "none");
  const approvalCount = Number(approvals.total ?? 0) || 0;

  let nextStep = "Run review-open-issues if Friday already detected incidents or approvals that need attention.";
  if (healthStatus === "healthy" && approvalCount === 0) {
    nextStep = "The runtime looks stable. Move to repo-health-check or release-readiness-check for the workspace itself.";
  } else if (approvalCount > 0) {
    nextStep = "Run autofix-readiness-review to see which planned fixes need approval and which are still safe to inspect.";
  } else if (healthStatus !== "healthy") {
    nextStep = "Run review-open-issues to correlate the degraded runtime state with diagnosis incidents and suggested fixes.";
  }

  const summary = compact(
    `System snapshot: health is ${healthStatus}, companion is ${companionStatus}, browser mode is ${browserMode}${targetBrowser !== "none" ? ` targeting ${targetBrowser}` : ""}. ${approvalCount} approval item(s) are currently open.`,
    220,
  );

  return {
    summary,
    nextStep,
    details: {
      capturedAt: asString(snapshot.capturedAt),
      workspaceRoot: asString(snapshot.workspaceRoot),
      platform: asString(snapshot.platform, "unknown"),
      healthStatus,
      healthReasons: Array.isArray(health.reasons) ? health.reasons : [],
      companionStatus,
      browserMode,
      targetBrowser,
      browserTarget: asString(browser.browserTarget),
      fallbackReason: asString(browser.fallbackReason),
      approvalsSummary: approvals,
      remoteDevicesSummary: remoteDevices,
      remoteSessionsSummary: remoteSessions,
      activeTask: asString(snapshot.activeTask),
    },
  };
}
