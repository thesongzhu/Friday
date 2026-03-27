import path from "node:path";

export const FRIDAY_CLOSURE_STATUSES = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  BLOCKER: "BLOCKER",
});

export const FRIDAY_READINESS_VERDICTS = Object.freeze({
  GO: "GO",
  NO_GO: "NO-GO",
  NOT_RUN: "NOT_RUN",
});

export function createClosureRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function resolveClosureRoot(cwd, runId) {
  return path.join(cwd, ".friday", "closure", runId);
}

export function parseEnabledChannelKinds(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return new Set();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }

  const channels = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.instances)
      ? parsed.instances
    : Array.isArray(parsed?.channels)
      ? parsed.channels
      : [];

  const kinds = new Set();
  for (const channel of channels) {
    if (!channel || typeof channel !== "object") continue;
    if (channel.enabled === false) continue;
    if (typeof channel.kind === "string" && channel.kind.trim().length > 0) {
      kinds.add(channel.kind.trim());
    }
  }
  return kinds;
}

export function collectCloudBlockers(env = process.env) {
  const blockers = [];
  const baseUrl = env.FRIDAY_E2E_CLOUD_BASE_URL?.trim();
  const authMode = env.FRIDAY_E2E_CLOUD_AUTH_MODE?.trim();

  if (!baseUrl) {
    blockers.push("FRIDAY_E2E_CLOUD_BASE_URL is not set");
  }

  if (!authMode) {
    blockers.push("FRIDAY_E2E_CLOUD_AUTH_MODE is not set");
    return blockers;
  }

  if (authMode === "access-token") {
    if (!env.FRIDAY_E2E_CLOUD_ACCESS_TOKEN?.trim()) {
      blockers.push("FRIDAY_E2E_CLOUD_ACCESS_TOKEN is not set for access-token mode");
    }
    return blockers;
  }

  if (authMode === "email-password") {
    if (!env.FRIDAY_E2E_CLOUD_EMAIL?.trim()) {
      blockers.push("FRIDAY_E2E_CLOUD_EMAIL is not set for email-password mode");
    }
    if (!env.FRIDAY_E2E_CLOUD_PASSWORD?.trim()) {
      blockers.push("FRIDAY_E2E_CLOUD_PASSWORD is not set for email-password mode");
    }
    return blockers;
  }

  if (authMode === "local-passphrase") {
    if (!env.FRIDAY_E2E_CLOUD_LOCAL_PASSPHRASE?.trim()) {
      blockers.push("FRIDAY_E2E_CLOUD_LOCAL_PASSPHRASE is not set for local-passphrase mode");
    }
    return blockers;
  }

  blockers.push(`Unsupported FRIDAY_E2E_CLOUD_AUTH_MODE "${authMode}"`);
  return blockers;
}

export function resolveCloudContractReport(env = process.env) {
  const blockers = collectCloudBlockers(env);
  const baseUrl = env.FRIDAY_E2E_CLOUD_BASE_URL?.trim() ?? "";
  const authMode = env.FRIDAY_E2E_CLOUD_AUTH_MODE?.trim() ?? "";
  const target = (env.FRIDAY_E2E_TARGET ?? "local").trim().toLowerCase();

  if (target !== "cloud") {
    blockers.push(`FRIDAY_E2E_TARGET must be "cloud" for cloud contract checks (received "${target}")`);
  }

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        blockers.push(`FRIDAY_E2E_CLOUD_BASE_URL must use http or https (received "${parsed.protocol}")`);
      }
    } catch {
      blockers.push("FRIDAY_E2E_CLOUD_BASE_URL must be a valid absolute URL");
    }
  }

  return {
    ready: blockers.length === 0,
    target,
    baseUrl: baseUrl || null,
    authMode: authMode || null,
    liveProvider: env.FRIDAY_E2E_LIVE_OPENAI === "1"
      ? "openai"
      : env.FRIDAY_E2E_LIVE_OLLAMA === "1"
        ? "ollama"
        : null,
    blockers,
  };
}

export function collectChannelBlockers(env = process.env) {
  const configuredKinds = parseEnabledChannelKinds(env.FRIDAY_CHANNELS_JSON);
  const requiredKinds = [
    "discord",
    "slack",
    "telegram",
    "whatsapp",
    "signal",
    "line",
    "irc",
    "qq",
    "lark",
    "webchat",
  ];

  return requiredKinds
    .filter((kind) => !configuredKinds.has(kind))
    .map((kind) => `Channel "${kind}" is not configured in FRIDAY_CHANNELS_JSON`);
}

export function buildClosureScratchEnv(baseEnv = process.env, paths) {
  return {
    ...baseEnv,
    FRIDAY_STATE_DIR: paths.state,
    FRIDAY_CHANNELS_JSON: baseEnv.FRIDAY_CHANNELS_JSON ?? '{"enabled":true,"instances":[]}',
    FRIDAY_BROWSER_HEADLESS: "true",
    FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN: baseEnv.FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN ?? "true",
  };
}

function entryHasHiddenClosureFailure(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const closureFailures = entry.details?.closureFailures;
  return Array.isArray(closureFailures)
    && closureFailures.some((item) => typeof item === "string" && item.trim().length > 0);
}

export function summarizeLedger(entries) {
  return entries.reduce(
    (summary, entry) => {
      if (entry.status === FRIDAY_CLOSURE_STATUSES.PASS && entryHasHiddenClosureFailure(entry)) {
        summary.fail += 1;
        return summary;
      }
      if (entry.status === FRIDAY_CLOSURE_STATUSES.PASS) summary.pass += 1;
      if (entry.status === FRIDAY_CLOSURE_STATUSES.FAIL) summary.fail += 1;
      if (entry.status === FRIDAY_CLOSURE_STATUSES.BLOCKER) summary.blocker += 1;
      return summary;
    },
    { pass: 0, fail: 0, blocker: 0 },
  );
}

function readinessVerdictFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return FRIDAY_READINESS_VERDICTS.NOT_RUN;
  }

  const summary = summarizeLedger(entries);
  return summary.fail === 0 && summary.blocker === 0
    ? FRIDAY_READINESS_VERDICTS.GO
    : FRIDAY_READINESS_VERDICTS.NO_GO;
}

export function resolveClosureVerdict(entries) {
  const summary = summarizeLedger(entries);
  return {
    summary,
    verdict:
      summary.fail === 0 && summary.blocker === 0
        ? "GO"
        : "NO-GO",
  };
}

export function resolveReadinessReport(entries, mode = "local") {
  const localEntries = entries.filter(
    (entry) => String(entry?.id ?? entry?.stage ?? "").startsWith("local."),
  );
  const cloudEntries = entries.filter(
    (entry) => String(entry?.id ?? entry?.stage ?? "").startsWith("cloud."),
  );
  const repoBackstopEntry = entries.find((entry) => entry?.id === "local.backstop.release-verify");
  const overall = resolveClosureVerdict(entries).verdict;

  return {
    mode,
    repoReady: repoBackstopEntry
      ? readinessVerdictFromEntries([repoBackstopEntry])
      : FRIDAY_READINESS_VERDICTS.NOT_RUN,
    productReadyLocal: readinessVerdictFromEntries(localEntries),
    cloudReady: readinessVerdictFromEntries(cloudEntries),
    overall,
  };
}
