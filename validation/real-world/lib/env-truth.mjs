import { slugify } from "./defs.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readCapabilityStatus(processEnv, key) {
  const raw = processEnv[key];
  if (raw === undefined) {
    return {
      status: "unknown",
      source: key,
      note: `Set ${key}=true or ${key}=false to declare this prerequisite explicitly.`,
    };
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "ready", "enabled"].includes(normalized)) {
    return { status: "ready", source: key };
  }
  if (["0", "false", "no", "missing", "blocked", "disabled"].includes(normalized)) {
    return { status: "missing", source: key };
  }
  return {
    status: "unknown",
    source: key,
    note: `${key}=${String(raw)} is not understood; use true/false.`,
  };
}

function readExternalChannelsStatus(processEnv) {
  const declared = readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_EXTERNAL_CHANNELS_READY");
  if (declared.status !== "ready") {
    return declared;
  }
  const requiredEnv = [
    "FRIDAY_DISCORD_BOT_TOKEN",
    "FRIDAY_DISCORD_SETUP_USER_ID",
    "FRIDAY_DISCORD_GUILD_ID",
    "FRIDAY_DISCORD_CHANNEL_ID",
  ];
  const missing = requiredEnv.filter((key) => !String(processEnv[key] ?? "").trim());
  if (missing.length > 0) {
    return {
      status: "missing",
      source: declared.source,
      missingEnv: missing,
      note: "External channels were declared ready, but Discord proof env is incomplete.",
    };
  }
  return {
    ...declared,
    requiredEnv,
  };
}

export const PHASE24_CHANNEL_ENV_REQUIREMENTS = Object.freeze({
  discord: Object.freeze([
    "FRIDAY_DISCORD_BOT_TOKEN",
    "FRIDAY_DISCORD_GUILD_ID",
    "FRIDAY_DISCORD_CHANNEL_ID",
    "FRIDAY_DISCORD_SETUP_USER_ID",
    "FRIDAY_DISCORD_BOT_USER_ID",
    "FRIDAY_DISCORD_APPROVAL_MODE",
    "FRIDAY_DISCORD_GROUP_APPROVAL",
    "FRIDAY_DISCORD_REQUIRE_MENTION",
  ]),
  telegram: Object.freeze([
    "FRIDAY_TELEGRAM_BOT_TOKEN",
    "FRIDAY_TELEGRAM_CHAT_ID",
    "FRIDAY_TELEGRAM_ALLOWED_USER_ID",
    "FRIDAY_TELEGRAM_MODE",
    "FRIDAY_TELEGRAM_APPROVAL_MODE",
    "FRIDAY_TELEGRAM_GROUP_APPROVAL",
  ]),
  lark: Object.freeze([
    "FRIDAY_LARK_APP_ID",
    "FRIDAY_LARK_APP_SECRET",
    "FRIDAY_LARK_CHAT_ID",
    "FRIDAY_LARK_GROUP_CHAT_ID",
    "FRIDAY_LARK_ALLOWED_USER_ID",
    "FRIDAY_LARK_USE_FEISHU",
    "FRIDAY_LARK_RECEIVE_MODE",
    "FRIDAY_LARK_APPROVAL_MODE",
    "FRIDAY_LARK_GROUP_APPROVAL",
  ]),
  providers: Object.freeze([
    "DEEPSEEK_API_KEY",
    "FRIDAY_DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
  ]),
});

function readPhase24ChannelsStatus(processEnv) {
  const missingByGroup = Object.fromEntries(
    Object.entries(PHASE24_CHANNEL_ENV_REQUIREMENTS).map(([group, requiredEnv]) => [
      group,
      requiredEnv.filter((key) => !String(processEnv[key] ?? "").trim()),
    ]),
  );
  const missingEnv = Object.values(missingByGroup).flat();
  const status = missingEnv.length === 0 ? "ready" : "missing";
  return {
    status,
    source: "phase-24-live-channels",
    requiredEnvByGroup: Object.fromEntries(
      Object.entries(PHASE24_CHANNEL_ENV_REQUIREMENTS).map(([group, requiredEnv]) => [group, [...requiredEnv]]),
    ),
    missingEnvByGroup: missingByGroup,
    missingEnv,
    valuesRedacted: true,
    note: status === "ready"
      ? "Phase24 channel/provider env names are present in the RGG process environment; values are intentionally redacted."
      : "Phase24 channel/provider env names are not all present in the RGG process environment; missing names are listed without values.",
  };
}

function readExternalAlertsStatus(processEnv) {
  const declared = readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY");
  if (declared.status !== "ready") {
    return declared;
  }
  const slackEnv = ["FRIDAY_REAL_WORLD_ALERT_SLACK_WEBHOOK_URL"];
  const smtpEnv = [
    "FRIDAY_REAL_WORLD_ALERT_SMTP_HOST",
    "FRIDAY_REAL_WORLD_ALERT_SMTP_PORT",
    "FRIDAY_REAL_WORLD_ALERT_SMTP_FROM",
    "FRIDAY_REAL_WORLD_ALERT_SMTP_RECIPIENT",
  ];
  const slackPresent = slackEnv.every((key) => String(processEnv[key] ?? "").trim());
  const smtpPresent = smtpEnv.every((key) => String(processEnv[key] ?? "").trim());
  if (!slackPresent && !smtpPresent) {
    return {
      status: "missing",
      source: declared.source,
      missingEnv: [...slackEnv, ...smtpEnv],
      note: "External alerts were declared ready, but neither Slack webhook nor SMTP proof env is complete.",
    };
  }
  return {
    ...declared,
    requiredEnv: [...slackEnv, ...smtpEnv],
    slackReady: slackPresent,
    smtpReady: smtpPresent,
  };
}

function resolveProviderModel(provider, preferredModel) {
  if (!provider) return undefined;
  const supportedModels = asArray(provider.config?.supportedModels).filter((value) => typeof value === "string");
  return preferredModel
    || provider.defaultModel
    || provider.config?.defaultModel
    || supportedModels[0];
}

function buildLane(provider, model, laneKey, source) {
  if (!provider || !model) return null;
  return {
    id: slugify(`${laneKey}-${provider.id}-${model}`),
    laneKey,
    source,
    providerId: provider.id,
    providerName: provider.name,
    providerKind: provider.kind,
    backendKind: provider.config?.backendKind ?? "http",
    model,
  };
}

function providerValidationStatus(provider) {
  return provider?.config?.validation?.status;
}

function isCliProvider(provider) {
  return provider?.config?.backendKind === "cli" || provider?.config?.authMode === "external-session";
}

function providerHealthSnapshot(providerHealthById, providerId) {
  return providerId ? providerHealthById.get(providerId) ?? null : null;
}

function isProviderHealthEligible(snapshot) {
  if (!snapshot) return false;
  return snapshot.routingEligible === true && snapshot.validationStatus !== "failed";
}

function isProviderValidationEligible(provider) {
  return !isCliProvider(provider) && providerValidationStatus(provider) === "ok";
}

function uniqueProviders(providers) {
  const seen = new Set();
  return providers.filter((provider) => {
    if (!provider?.id || seen.has(provider.id)) {
      return false;
    }
    seen.add(provider.id);
    return true;
  });
}

function chooseDefaultLane(providers, routing) {
  if (!routing?.defaultProviderId) return null;
  const provider = providers.find((item) => item.id === routing.defaultProviderId && item.enabled);
  if (!provider) return null;
  return buildLane(provider, resolveProviderModel(provider, routing.defaultModel), "default", "routing.default");
}

export function resolveFallbackLaneRequirement(providers, routing, defaultLane, providerHealthById = new Map()) {
  const preferredIds = asArray(routing?.fallbackProviderIds).filter((value) => typeof value === "string" && value.length > 0);
  if (preferredIds.length > 0) {
    return {
      fallbackRequired: true,
      source: "routing.fallback_configured",
    };
  }

  const hasValidatedAlternative = providers.some((provider) =>
    provider?.enabled
    && provider.id !== defaultLane?.providerId
    && (
      isProviderHealthEligible(providerHealthSnapshot(providerHealthById, provider.id))
      || isProviderValidationEligible(provider)
    ));
  if (defaultLane && !hasValidatedAlternative) {
    // Single eligible provider: a one-provider deployment truthfully has no
    // fallback, so the default proof must NOT require one — and must never
    // synthesize an absent provider (e.g. OpenAI) as a fallback. This run then
    // verifies ONLY the single-provider default lane; it does NOT prove provider
    // fallback resilience. Multi-provider / fallback-resilience proof is the
    // explicit, gated C3/C4 provider-routing lane.
    return {
      fallbackRequired: false,
      source: "single_provider_no_fallback_required",
    };
  }

  // Two or more eligible providers exist with no explicit fallback configured —
  // a fallback lane is still required so resilience is exercised.
  return {
    fallbackRequired: hasValidatedAlternative,
    source: hasValidatedAlternative ? "validated_alternative_available" : "no_validated_alternative",
  };
}

export function chooseFallbackLane(providers, routing, defaultLane, providerHealthById = new Map()) {
  const enabled = providers.filter((provider) => provider.enabled && provider.id !== defaultLane?.providerId);
  const preferredIds = asArray(routing?.fallbackProviderIds);
  const fromPreferred = uniqueProviders(preferredIds
    .map((providerId) => enabled.find((provider) => provider.id === providerId))
    .filter(Boolean));
  const preferredKinds = new Set(fromPreferred.map((provider) => provider.kind).filter((value) => typeof value === "string"));
  const eligibleByHealth = (provider) => isProviderHealthEligible(providerHealthSnapshot(providerHealthById, provider.id));
  const explicitCandidates = uniqueProviders([
    ...fromPreferred.filter((provider) => eligibleByHealth(provider) && provider.kind !== defaultLane?.providerKind),
    ...enabled.filter((provider) => eligibleByHealth(provider) && preferredKinds.has(provider.kind) && provider.kind !== defaultLane?.providerKind),
    ...enabled.filter((provider) => eligibleByHealth(provider) && provider.kind !== defaultLane?.providerKind),
    ...fromPreferred.filter((provider) => eligibleByHealth(provider)),
    ...enabled.filter((provider) => eligibleByHealth(provider) && preferredKinds.has(provider.kind)),
    ...enabled.filter((provider) => eligibleByHealth(provider)),
    ...fromPreferred.filter((provider) => isProviderValidationEligible(provider) && provider.kind !== defaultLane?.providerKind),
    ...enabled.filter((provider) => isProviderValidationEligible(provider) && preferredKinds.has(provider.kind) && provider.kind !== defaultLane?.providerKind),
    ...enabled.filter((provider) => isProviderValidationEligible(provider) && provider.kind !== defaultLane?.providerKind),
    ...fromPreferred.filter((provider) => isProviderValidationEligible(provider)),
    ...enabled.filter((provider) => isProviderValidationEligible(provider) && preferredKinds.has(provider.kind)),
    ...enabled.filter((provider) => isProviderValidationEligible(provider)),
    ...fromPreferred.filter((provider) => !isCliProvider(provider)),
    ...fromPreferred.filter((provider) => provider.config?.backendKind !== defaultLane?.backendKind),
    ...fromPreferred,
  ].filter(Boolean));
  const heuristicCandidates = uniqueProviders([
    ...enabled.filter((provider) => eligibleByHealth(provider) && provider.kind !== defaultLane?.providerKind),
    ...enabled.filter((provider) => eligibleByHealth(provider)),
    ...enabled.filter((provider) => isProviderValidationEligible(provider) && provider.kind !== defaultLane?.providerKind),
    ...enabled.filter((provider) => isProviderValidationEligible(provider)),
  ].filter(Boolean));
  const candidates = preferredIds.length > 0 ? explicitCandidates : heuristicCandidates;
  const selected = candidates[0];
  if (!selected) return null;
  return buildLane(selected, resolveProviderModel(selected), "fallback", selected.id && preferredIds.includes(selected.id) ? "routing.fallback" : "heuristic.fallback");
}

async function safeRequest(run, fallbackValue) {
  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      ...(fallbackValue ?? {}),
    };
  }
}

function summarizePublicResponse(response) {
  return {
    ok: response.ok === true,
    status: response.status ?? 0,
    durationMs: response.durationMs,
    requestId: response.json?.requestId,
    error: response.error,
  };
}

function summarizeAuthedResponse(response) {
  return {
    ok: response.ok === true && response.json?.ok === true,
    status: response.status ?? 0,
    durationMs: response.durationMs,
    requestId: response.json?.requestId,
    error: response.error,
  };
}

function deriveTruthSignals({ setupStatus, userProfile }) {
  const needsSetup = setupStatus?.needsSetup;
  const profileType = userProfile?.profileType ?? null;
  const onboardedAt = userProfile?.onboardedAt ?? null;
  return {
    setupUserProfileTruthMismatch: needsSetup === false && (!profileType || !onboardedAt),
  };
}

export function selectJudgeLane(envTruth, testedLane) {
  const providerHealthById = new Map(asArray(envTruth?.providerHealth)
    .filter((entry) => entry && typeof entry.providerId === "string")
    .map((entry) => [entry.providerId, entry]));
  const candidates = uniqueProviders([
    envTruth?.providerLanes?.default,
    envTruth?.providerLanes?.fallback,
    ...asArray(envTruth?.enabledProviderLanes),
  ].filter(Boolean));
  const alternatives = candidates.filter((candidate) => candidate.providerId !== testedLane?.providerId);
  const healthyAlternatives = alternatives.filter((candidate) => {
    const snapshot = providerHealthById.get(candidate.providerId);
    if (!snapshot) {
      return candidate.backendKind !== "cli";
    }
    return snapshot.routingEligible === true && snapshot.validationStatus !== "failed";
  });
  const nonCliAlternative = healthyAlternatives.find((candidate) => candidate.backendKind !== "cli");
  return nonCliAlternative ?? healthyAlternatives[0] ?? null;
}

export function resolveScenarioLanes(scenario, envTruth) {
  if (scenario.providerLane === "none") {
    return [{ id: "none", laneKey: "none", source: "not_applicable" }];
  }
  const lanes = [];
  if (envTruth.providerLanes.default) {
    lanes.push(envTruth.providerLanes.default);
  } else {
    lanes.push({
      id: "default-missing",
      laneKey: "default",
      source: "missing",
      blockedReason: "Default provider/model lane is not ready.",
    });
  }
  if (scenario.providerLane === "default_and_fallback") {
    if (envTruth.providerLanes.fallback) {
      lanes.push(envTruth.providerLanes.fallback);
    } else if (envTruth.providerLaneRequirements?.fallbackRequired !== false) {
      lanes.push({
        id: "fallback-missing",
        laneKey: "fallback",
        source: "missing",
        blockedReason: "Fallback provider/model lane is not ready.",
      });
    }
  }
  return lanes;
}

export function resolveScenarioBlockers(scenario, envTruth) {
  const blockers = [];
  const preconditions = new Set(asArray(scenario.preconditions));
  if (scenario.tags?.includes("desktop")) {
    preconditions.add("desktop.ready");
  }
  if (scenario.tags?.includes("external-channel")) {
    preconditions.add("external_channels.ready");
  }
  if (scenario.tags?.includes("cloud")) {
    preconditions.add("cloud.ready");
  }
  if (scenario.tags?.includes("satellite")) {
    preconditions.add("satellite.ready");
  }
  if (scenario.tags?.includes("mcp")) {
    preconditions.add("mcp.ready");
  }

  const mapping = {
    "auth.ready": {
      status: envTruth.auth.ok ? "ready" : "missing",
      source: "auth.login",
      note: envTruth.auth.ok ? undefined : envTruth.auth.error,
    },
    "desktop.ready": envTruth.prerequisites.desktop,
    "external_channels.ready": envTruth.prerequisites.externalChannels,
    "external_alerts.ready": envTruth.prerequisites.externalAlerts,
    "cloud.ready": envTruth.prerequisites.cloud,
    "satellite.ready": envTruth.prerequisites.satellite,
    "mcp.ready": envTruth.prerequisites.mcp,
    "packaging.ready": envTruth.prerequisites.packaging,
    "multi_tenant_security.ready": envTruth.prerequisites.multiTenantSecurity,
  };

  for (const key of preconditions) {
    const state = mapping[key];
    if (state && state.status !== "ready") {
      const missingEnv = Array.isArray(state.missingEnv) && state.missingEnv.length > 0
        ? ` [missing env: ${state.missingEnv.join(", ")}]`
        : "";
      blockers.push(`${key}=${state.status}${state.note ? ` (${state.note})` : ""}${missingEnv}`);
    }
  }

  if (scenario.providerLane !== "none" && !envTruth.providerLanes.default) {
    blockers.push("default provider/model lane unavailable");
  }
  return blockers;
}

export async function collectEnvironmentTruth({
  client,
  baseUrl,
  uiBaseUrl,
  processEnv = process.env,
}) {
  const health = await safeRequest(() => client.request("GET", "/v1/health"), { status: 0 });
  const version = await safeRequest(() => client.request("GET", "/v1/version"), { status: 0 });
  const auth = {
    ok: false,
    mode: client.authMode,
    source: client.authSource ?? null,
    details: client.authDetails ?? null,
    error: undefined,
    user: null,
  };

  try {
    const session = await client.initialize();
    auth.ok = true;
    auth.mode = session.authMode;
    auth.source = session.authSource ?? null;
    auth.details = session.authDetails ?? null;
    auth.user = session.user ?? client.user ?? null;
  } catch (error) {
    auth.mode = client.authMode;
    auth.source = client.authSource ?? null;
    auth.details = client.authDetails ?? null;
    auth.error = getErrorMessage(error);
  }

  const setupStatus = auth.ok
    ? await safeRequest(() => client.request("GET", "/v1/setup/status"), { status: 0 })
    : { ok: false, status: 0, error: "auth unavailable" };
  const bootstrapStatusResponse = await safeRequest(() => client.request("GET", "/v1/auth/bootstrap/status"), { status: 0 });
  const providersResponse = auth.ok
    ? await safeRequest(() => client.request("GET", "/v1/providers"), { status: 0 })
    : { ok: false, status: 0, error: "auth unavailable" };
  const providerHealthResponse = auth.ok
    ? await safeRequest(() => client.request("GET", "/v1/providers/health"), { status: 0 })
    : { ok: false, status: 0, error: "auth unavailable" };
  const routingResponse = auth.ok
    ? await safeRequest(() => client.request("GET", "/v1/model-routing"), { status: 0 })
    : { ok: false, status: 0, error: "auth unavailable" };
  const personaResponse = auth.ok
    ? await safeRequest(() => client.request("GET", "/v1/uix/persona"), { status: 0 })
    : { ok: false, status: 0, error: "auth unavailable" };
  const userProfileResponse = auth.ok
    ? await safeRequest(() => client.request("GET", "/v1/uix/user-profile"), { status: 0 })
    : { ok: false, status: 0, error: "auth unavailable" };

  const providers = asArray(providersResponse.json?.data?.items).filter(
    (provider) => provider && typeof provider === "object",
  );
  const providerHealth = asArray(providerHealthResponse.json?.data?.items).filter(
    (entry) => entry && typeof entry === "object" && typeof entry.providerId === "string",
  );
  const providerHealthById = new Map(providerHealth.map((entry) => [entry.providerId, entry]));
  const routing = routingResponse.json?.data?.routing ?? null;
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const defaultLane = chooseDefaultLane(enabledProviders, routing);
  const providerLaneRequirements = resolveFallbackLaneRequirement(enabledProviders, routing, defaultLane, providerHealthById);
  const fallbackLane = chooseFallbackLane(enabledProviders, routing, defaultLane, providerHealthById);
  const enabledProviderLanes = enabledProviders
    .map((provider) => buildLane(provider, resolveProviderModel(provider), "candidate", "providers.list"))
    .filter(Boolean);
  const resolvedSetupStatus = setupStatus.json?.data ?? null;
  const resolvedBootstrapStatus = bootstrapStatusResponse.json?.data ?? bootstrapStatusResponse.json ?? null;
  const resolvedUserProfile = userProfileResponse.json?.data ?? userProfileResponse.json ?? null;
  const derived = deriveTruthSignals({
    setupStatus: resolvedSetupStatus,
    userProfile: resolvedUserProfile,
  });

  return {
    collectedAt: new Date().toISOString(),
    baseUrl,
    uiBaseUrl,
    auth,
    publicChecks: {
      health: summarizePublicResponse(health),
      version: summarizePublicResponse(version),
      bootstrapStatus: summarizePublicResponse(bootstrapStatusResponse),
    },
    authedChecks: {
      setupStatus: summarizeAuthedResponse(setupStatus),
      providers: summarizeAuthedResponse(providersResponse),
      providerHealth: summarizeAuthedResponse(providerHealthResponse),
      modelRouting: summarizeAuthedResponse(routingResponse),
      persona: summarizeAuthedResponse(personaResponse),
      userProfile: summarizeAuthedResponse(userProfileResponse),
    },
    bootstrapStatus: resolvedBootstrapStatus,
    setupStatus: resolvedSetupStatus,
    userProfile: resolvedUserProfile,
    derived,
    routing,
    providers,
    providerHealth,
    enabledProviders,
    providerLaneRequirements,
    providerLanes: {
      default: defaultLane,
      fallback: fallbackLane,
    },
    enabledProviderLanes,
    prerequisites: {
      desktop: readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_DESKTOP_READY"),
      externalChannels: readExternalChannelsStatus(processEnv),
      phase24Channels: readPhase24ChannelsStatus(processEnv),
      externalAlerts: readExternalAlertsStatus(processEnv),
      cloud: readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_CLOUD_READY"),
      satellite: readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_SATELLITE_READY"),
      mcp: readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_MCP_READY"),
      packaging: readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_PACKAGING_READY"),
      multiTenantSecurity: readCapabilityStatus(processEnv, "FRIDAY_REAL_WORLD_MULTI_TENANT_READY"),
    },
  };
}
