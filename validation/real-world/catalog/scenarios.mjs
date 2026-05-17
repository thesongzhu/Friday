import { validateCatalog } from "../lib/defs.mjs";

function baseScenario(input) {
  return {
    providerLane: "none",
    riskTier: "low",
    suites: ["smoke", "daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    cleanup: [],
    tags: [],
    ...input,
  };
}

function httpScenario(input) {
  return baseScenario({
    ...input,
    preconditions: input.execution?.public ? (input.preconditions ?? []) : [...new Set([...(input.preconditions ?? []), "auth.ready"])],
    expectedEvidence: [
      "HTTP contract reachable",
      "ok=true envelope present",
      "expected data fields present",
    ],
    execution: {
      kind: "http_probe",
      method: "GET",
      expectStatus: 200,
      expectOkEnvelope: true,
      ...input.execution,
    },
  });
}

function uiScenario(input) {
  return baseScenario({
    ...input,
    preconditions: [...new Set([...(input.preconditions ?? []), "auth.ready"])],
    entrySurface: input.entrySurface,
    expectedEvidence: [
      "page becomes visibly interactive",
      "reload restores the surface",
      "request and console activity are measurable",
    ],
    latencyBudget: {
      timeToFirstVisibleSignalMs: 3_000,
      ...(input.latencyBudget ?? {}),
    },
    execution: {
      kind: "ui_probe",
      reloadCheck: true,
      idleWindowMs: 1_500,
      allowedFinalPathPrefixes: input.execution?.allowedFinalPathPrefixes ?? [input.execution?.path ?? input.entrySurface],
      ...input.execution,
    },
  });
}

function agentScenario(input) {
  return baseScenario({
    ...input,
    preconditions: [...new Set([...(input.preconditions ?? []), "auth.ready"])],
    providerLane: input.providerLane ?? "default_and_fallback",
    expectedEvidence: [
      "agent run completes",
      "output matches the requested user goal",
      "actual provider/model and cost metrics are captured",
    ],
    latencyBudget: {
      timeToFinalAnswerMs: 60_000,
      ...(input.latencyBudget ?? {}),
    },
    execution: {
      kind: "agent_run",
      timeoutMs: 180_000,
      constraints: { readOnly: true },
      taskProfile: { id: "deterministic" },
      ...input.execution,
    },
  });
}

function manualExternalScenario(input) {
  return baseScenario({
    ...input,
    preconditions: [...new Set([...(input.preconditions ?? []), "auth.ready"])],
    providerLane: "none",
    suites: ["weekly"],
    expectedEvidence: [
      "real external or distributed endpoint is available",
      "operator records inbound/outbound evidence",
      "blocked vs manual-review is explicit instead of mocked",
    ],
    execution: {
      kind: "manual_external",
      manualChecklist: input.manualChecklist ?? [],
      ...input.execution,
    },
  });
}

function discordRoundtripScenario(input) {
  return baseScenario({
    ...input,
    preconditions: [...new Set([...(input.preconditions ?? []), "external_channels.ready"])],
    providerLane: "none",
    suites: input.suites ?? ["weekly"],
    expectedEvidence: [
      "Discord bot token resolves to a bot identity",
      "sandbox guild and channel are reachable",
      "a real outbound message can be sent and read back",
      "a real reply message can be sent and read back",
    ],
    execution: {
      kind: "discord_roundtrip",
      tokenEnv: "FRIDAY_DISCORD_BOT_TOKEN",
      setupUserIdEnv: "FRIDAY_DISCORD_SETUP_USER_ID",
      guildIdEnv: "FRIDAY_DISCORD_GUILD_ID",
      channelIdEnv: "FRIDAY_DISCORD_CHANNEL_ID",
      ...input.execution,
    },
    tags: [...new Set([...(input.tags ?? []), "external-channel", "discord"])],
  });
}

export const REAL_WORLD_SCENARIOS = [
  baseScenario({
    id: "l0-runtime-health",
    layer: "L0",
    productArea: "environment truth",
    entrySurface: "/v1/health",
    routeFamily: "runtime",
    expectedEvidence: [
      "public health route reachable",
      "public version route reachable",
      "auth bootstrap can be attempted",
    ],
    execution: {
      kind: "env_truth",
      checks: [
        { path: "publicChecks.health.ok", equals: true, label: "health ok" },
        { path: "publicChecks.version.ok", equals: true, label: "version ok" },
      ],
    },
    severityOnFailure: "P0",
  }),
  baseScenario({
    id: "l0-provider-lanes-ready",
    layer: "L0",
    productArea: "environment truth",
    entrySurface: "/v1/model-routing",
    routeFamily: "provider routing",
    providerLane: "none",
    expectedEvidence: [
      "default provider lane resolved",
      "fallback lane either resolved or explicitly blocked",
      "enabled provider inventory captured",
    ],
    execution: {
      kind: "env_truth",
      checks: [
        { path: "authedChecks.providers.ok", equals: true, label: "providers route" },
        { path: "authedChecks.modelRouting.ok", equals: true, label: "model routing route" },
      ],
    },
    severityOnFailure: "P0",
  }),
  baseScenario({
    id: "l0-onboarding-truth-mismatch",
    layer: "L0",
    productArea: "environment truth",
    entrySurface: "/v1/setup/status + /v1/uix/user-profile",
    routeFamily: "onboarding truth",
    expectedEvidence: [
      "setup completion state is explicit",
      "uix user profile onboarding state is explicit",
      "setup/user-profile truth mismatch is surfaced as a real defect instead of being hidden behind UI retries",
    ],
    execution: {
      kind: "env_truth",
      failureResult: "failed",
      failureClass: "ui_misroute",
      checks: [
        { path: "setupStatus.needsSetup", equals: false, label: "setup complete" },
        { path: "derived.setupUserProfileTruthMismatch", equals: false, label: "setup/user-profile truth mismatch" },
      ],
    },
    severityOnFailure: "P1",
  }),
  baseScenario({
    id: "l0-desktop-prereq",
    layer: "L0",
    productArea: "desktop",
    entrySurface: "desktop",
    routeFamily: "desktop prerequisite",
    expectedEvidence: [
      "desktop prerequisite declared",
      "blocked state is explicit when permission or protocol is unavailable",
    ],
    execution: {
      kind: "env_truth",
      checks: [
        { path: "prerequisites.desktop.status", equals: "ready", label: "desktop ready" },
      ],
    },
    severityOnFailure: "P1",
    suites: ["weekly"],
  }),
  uiScenario({
    id: "l1-chat-ui",
    layer: "L1",
    productArea: "chat",
    entrySurface: "/chat",
    routeFamily: "surface",
    execution: { path: "/chat", readyText: "Friday" },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  uiScenario({
    id: "l1-assistant-ui",
    layer: "L1",
    productArea: "assistant",
    entrySurface: "/assistant",
    routeFamily: "surface",
    execution: { path: "/assistant", readyText: "Friday" },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  uiScenario({
    id: "l1-home-ui",
    layer: "L1",
    productArea: "home",
    entrySurface: "/home",
    routeFamily: "surface",
    execution: { path: "/home", readySelector: "[data-testid='home-surface-ready']" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-packs-ui",
    layer: "L1",
    productArea: "packs",
    entrySurface: "/packs",
    routeFamily: "surface",
    execution: { path: "/packs", readySelector: "[data-testid='packs-surface-ready']" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-cross-border-pack-setup-ui",
    layer: "L1",
    productArea: "packs",
    entrySurface: "/packs/cross-border/setup",
    routeFamily: "surface",
    execution: { path: "/packs/cross-border/setup", readySelector: "[data-testid='cross-border-setup-page']" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-guided-flow-ui",
    layer: "L1",
    productArea: "guided flow",
    entrySurface: "/flow/build-new?mode=adjust",
    routeFamily: "surface",
    execution: {
      path: "/flow/build-new?mode=adjust",
      readySelector: "[data-testid='guided-flow-page']",
      allowedFinalPathPrefixes: ["/flow/build-new"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-command-center-ui",
    layer: "L1",
    productArea: "command center",
    entrySurface: "/command-center",
    routeFamily: "surface",
    execution: { path: "/command-center", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-observability-ui",
    layer: "L1",
    productArea: "observability",
    entrySurface: "/observability",
    routeFamily: "surface",
    execution: { path: "/observability", readyText: "Friday" },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  uiScenario({
    id: "l1-settings-ui",
    layer: "L1",
    productArea: "settings",
    entrySurface: "/settings",
    routeFamily: "surface",
    execution: { path: "/settings", readyText: "Friday" },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  uiScenario({
    id: "l1-skills-ui",
    layer: "L1",
    productArea: "skills",
    entrySurface: "/skills",
    routeFamily: "surface",
    execution: { path: "/skills", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-skill-generator-ui",
    layer: "L1",
    productArea: "skills",
    entrySurface: "/skills/generator",
    routeFamily: "surface",
    execution: { path: "/skills/generator", readySelector: "[data-testid='skill-generator-goal-input']" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-workflows-ui",
    layer: "L1",
    productArea: "workflows",
    entrySurface: "/workflows",
    routeFamily: "surface",
    execution: { path: "/workflows", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-workflow-builder-ui",
    layer: "L1",
    productArea: "workflows",
    entrySurface: "/workflows/builder",
    routeFamily: "surface",
    execution: { path: "/workflows/builder", readySelector: "[data-testid='workflow-builder-node-library']" },
    suites: ["daily", "nightly", "weekly"],
  }),
  baseScenario({
    id: "l3-workflow-browser-authoring",
    layer: "L3",
    productArea: "workflows",
    entrySurface: "/workflows/builder",
    routeFamily: "browser authoring",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "workflow builder loads and becomes interactive",
      "blank draft created via UI interaction",
      "workflow canvas renders with trigger node",
    ],
    execution: {
      kind: "ui_authoring",
      path: "/workflows/builder",
      draftTitle: "RGG Browser Authoring Proof",
      readySelector: "[data-testid='workflow-builder-node-library']",
      timeoutMs: 120_000,
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
  }),
  uiScenario({
    id: "l1-memory-ui",
    layer: "L1",
    productArea: "memory",
    entrySurface: "/memory",
    routeFamily: "surface",
    execution: { path: "/memory", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-channels-ui",
    layer: "L1",
    productArea: "channels",
    entrySurface: "/channels",
    routeFamily: "surface",
    execution: { path: "/channels", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-plugins-ui",
    layer: "L1",
    productArea: "plugins",
    entrySurface: "/plugins",
    routeFamily: "surface",
    execution: { path: "/plugins", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-automations-ui",
    layer: "L1",
    productArea: "automations",
    entrySurface: "/automations",
    routeFamily: "surface",
    execution: { path: "/automations", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-automation-detail-redirect-ui",
    layer: "L1",
    productArea: "automations",
    entrySurface: "/automations/:automationId",
    routeFamily: "legacy redirect",
    execution: {
      path: "/automations/legacy-proof",
      readySelector: "[data-testid='automations-name-input']",
      allowedFinalPathPrefixes: ["/automations"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-fleet-ui",
    layer: "L1",
    productArea: "fleet",
    entrySurface: "/fleet",
    routeFamily: "surface",
    execution: { path: "/fleet", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-mcp-ui",
    layer: "L1",
    productArea: "mcp",
    entrySurface: "/mcp",
    routeFamily: "surface",
    execution: { path: "/mcp", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-usage-ui",
    layer: "L1",
    productArea: "usage",
    entrySurface: "/usage",
    routeFamily: "surface",
    execution: { path: "/usage", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  uiScenario({
    id: "l1-sessions-ui",
    layer: "L1",
    productArea: "sessions",
    entrySurface: "/sessions",
    routeFamily: "surface",
    execution: { path: "/sessions", readyText: "Friday" },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-health-contract",
    layer: "L2",
    productArea: "runtime",
    entrySurface: "/v1/health",
    routeFamily: "contract",
    execution: {
      public: true,
      path: "/v1/health",
      jsonPathsPresent: ["data.status"],
    },
  }),
  httpScenario({
    id: "l2-version-contract",
    layer: "L2",
    productArea: "runtime",
    entrySurface: "/v1/version",
    routeFamily: "contract",
    execution: {
      public: true,
      path: "/v1/version",
      jsonPathsPresent: ["data.version"],
    },
  }),
  httpScenario({
    id: "l2-setup-status-contract",
    layer: "L2",
    productArea: "setup",
    entrySurface: "/v1/setup/status",
    routeFamily: "contract",
    execution: {
      path: "/v1/setup/status",
      jsonPathsPresent: ["data.needsSetup"],
    },
  }),
  httpScenario({
    id: "l2-providers-contract",
    layer: "L2",
    productArea: "providers",
    entrySurface: "/v1/providers",
    routeFamily: "contract",
    execution: {
      path: "/v1/providers",
      jsonPathsPresent: ["data.items"],
    },
  }),
  httpScenario({
    id: "l2-uix-user-profile-contract",
    layer: "L2",
    productArea: "uix",
    entrySurface: "/v1/uix/user-profile",
    routeFamily: "contract",
    execution: {
      path: "/v1/uix/user-profile",
      jsonPathsPresent: ["data.profileType", "data.onboardedAt"],
    },
  }),
  httpScenario({
    id: "l2-home-snapshot-contract",
    layer: "L2",
    productArea: "home",
    entrySurface: "/v1/uix/home-snapshot",
    routeFamily: "contract",
    execution: {
      path: "/v1/uix/home-snapshot",
      jsonPathsPresent: ["data.snapshot.generatedAt"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-uix-diagnostics-contract",
    layer: "L2",
    productArea: "mcp",
    entrySurface: "/v1/uix/diagnostics",
    routeFamily: "contract",
    execution: {
      path: "/v1/uix/diagnostics",
      jsonPathsPresent: ["data.assistant.generatedAt", "data.assistant.mcpServerStates"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-model-routing-contract",
    layer: "L2",
    productArea: "providers",
    entrySurface: "/v1/model-routing",
    routeFamily: "contract",
    execution: {
      path: "/v1/model-routing",
      jsonPathsPresent: ["data.routing.defaultProviderId"],
    },
    severityOnFailure: "P0",
  }),
  httpScenario({
    id: "l2-workflow-approvals-contract",
    layer: "L2",
    productArea: "workflows",
    entrySurface: "/v1/workflow-approvals",
    routeFamily: "contract",
    execution: {
      path: "/v1/workflow-approvals",
      jsonPathsPresent: ["data.items"],
    },
  }),
  httpScenario({
    id: "l2-observability-overview-contract",
    layer: "L2",
    productArea: "observability",
    entrySurface: "/v1/observability/overview",
    routeFamily: "contract",
    execution: {
      path: "/v1/observability/overview",
      jsonPathsPresent: ["data"],
    },
  }),
  httpScenario({
    id: "l2-heartbeat-status-contract",
    layer: "L2",
    productArea: "observability",
    entrySurface: "/v1/heartbeat/status",
    routeFamily: "contract",
    execution: {
      path: "/v1/heartbeat/status",
      jsonPathsPresent: ["data"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-workflow-webhook-contract",
    layer: "L2",
    productArea: "workflows",
    entrySurface: "/v1/workflow-webhooks/:pathToken",
    routeFamily: "contract",
    execution: {
      method: "POST",
      path: "/v1/workflow-webhooks/nonexistent-token",
      body: { event: "rgg-probe" },
      expectStatus: 404,
      expectOkEnvelope: false,
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-channels-contract",
    layer: "L2",
    productArea: "channels",
    entrySurface: "/v1/channels",
    routeFamily: "contract",
    execution: {
      path: "/v1/channels",
      jsonPathsPresent: ["data.items"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-channel-persona-contract",
    layer: "L2",
    productArea: "channels",
    entrySurface: "/v1/channels/:kind/persona",
    routeFamily: "contract",
    execution: {
      path: "/v1/channels/discord/persona",
      jsonPathsEqual: {
        "data.kind": "discord",
      },
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-channel-persona-update-contract",
    layer: "L2",
    productArea: "channels",
    entrySurface: "/v1/channels/:kind/persona",
    routeFamily: "contract",
    execution: {
      method: "PUT",
      path: "/v1/channels/discord/persona",
      body: {
        persona: "real-world validation persona {{timestamp}}",
        systemPrompt: "",
      },
      jsonPathsEqual: {
        "data.kind": "discord",
      },
      jsonPathsPresent: ["data.persona.persona"],
      cleanupRequests: [
        {
          method: "PUT",
          path: "/v1/channels/discord/persona",
          body: {
            persona: "",
            systemPrompt: "",
          },
        },
      ],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-diagnosis-overview-contract",
    layer: "L2",
    productArea: "self-healing",
    entrySurface: "/v1/diagnosis/learning/overview",
    routeFamily: "contract",
    execution: {
      path: "/v1/diagnosis/learning/overview",
      jsonPathsPresent: ["data"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-auto-fix-metrics-contract",
    layer: "L2",
    productArea: "self-healing",
    entrySurface: "/v1/auto-fix/metrics",
    routeFamily: "contract",
    execution: {
      path: "/v1/auto-fix/metrics",
      jsonPathsPresent: ["data"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-fleet-overview-contract",
    layer: "L2",
    productArea: "fleet",
    entrySurface: "/v1/fleet/overview",
    routeFamily: "contract",
    execution: {
      path: "/v1/fleet/overview",
      jsonPathsPresent: ["data"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  // Phase 12 Module 20 — alert destinations list route honesty (no live send)
  httpScenario({
    id: "l2-observability-alert-destinations-list-contract",
    layer: "L2",
    productArea: "observability",
    entrySurface: "/v1/observability/alert-destinations",
    routeFamily: "contract",
    execution: {
      path: "/v1/observability/alert-destinations",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "alert destinations list route returns ok envelope",
      "items array shape is present without sending external alerts",
      "no Slack/SMTP traffic is initiated by listing destinations",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-12", "module-20"],
  }),
  // Phase 12 Module 20 — alert destination create with invalid Slack URL must fail closed
  httpScenario({
    id: "l2-observability-alert-destination-create-invalid-fails-closed",
    layer: "L2",
    productArea: "observability",
    entrySurface: "/v1/observability/alert-destinations",
    routeFamily: "contract",
    execution: {
      method: "POST",
      path: "/v1/observability/alert-destinations",
      body: { type: "slack", name: "rgg invalid probe", webhookUrl: "" },
      expectStatus: 400,
      expectOkEnvelope: false,
    },
    expectedEvidence: [
      "creating a Slack destination without webhook fails validation",
      "fail-closed error envelope is returned without sending external traffic",
      "no destination is persisted by the invalid request",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-12", "module-20", "fail-closed"],
  }),
  // Phase 12 Module 20 — test-dispatch against a non-existent alert must 404 fail-closed
  httpScenario({
    id: "l2-observability-alert-test-dispatch-fails-closed",
    layer: "L2",
    productArea: "observability",
    entrySurface: "/v1/observability/alerts/:alertId/test-dispatch",
    routeFamily: "contract",
    execution: {
      method: "POST",
      path: "/v1/observability/alerts/__rgg_nonexistent_alert__/test-dispatch",
      body: {},
      expectStatus: 404,
      expectOkEnvelope: false,
    },
    expectedEvidence: [
      "test-dispatch route returns 404 when the alert id does not exist",
      "no Slack/SMTP outbound traffic is attempted for a missing alert",
      "fail-closed error envelope is honest about the missing resource",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-12", "module-20", "fail-closed"],
  }),
  // Phase 12 Module 20 — audit search route honesty (no fake dispatch record contamination)
  httpScenario({
    id: "l2-observability-audit-search-contract",
    layer: "L2",
    productArea: "observability",
    entrySurface: "/v1/observability/audit",
    routeFamily: "contract",
    execution: {
      path: "/v1/observability/audit?action=observability.alert.dispatch",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "audit search route is reachable in read-only mode",
      "dispatch audit query shape returns an items array (possibly empty)",
      "no mock dispatch records are auto-injected by listing",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-12", "module-20"],
  }),
  httpScenario({
    id: "l2-automations-contract",
    layer: "L2",
    productArea: "automations",
    entrySurface: "/v1/agent/automations",
    routeFamily: "contract",
    execution: {
      path: "/v1/agent/automations",
      jsonPathsPresent: ["data.items"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-sessions-contract",
    layer: "L2",
    productArea: "sessions",
    entrySurface: "/v1/sessions",
    routeFamily: "contract",
    execution: {
      path: "/v1/sessions?limit=5",
      jsonPathsPresent: ["data.items"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  httpScenario({
    id: "l2-plugins-contract",
    layer: "L2",
    productArea: "plugins",
    entrySurface: "/v1/plugins",
    routeFamily: "contract",
    execution: {
      path: "/v1/plugins",
      jsonPathsPresent: ["data.items"],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  // Phase 11 Module 16 — packaging route honesty: default-off envelope
  httpScenario({
    id: "l2-packaging-capability-disabled-contract",
    layer: "L2",
    productArea: "packaging",
    entrySurface: "/v1/packages",
    routeFamily: "contract",
    execution: {
      public: true,
      path: "/v1/packages",
      expectStatus: 501,
      expectOkEnvelope: false,
      jsonPathsPresent: ["error.code", "error.details.capability"],
    },
    expectedEvidence: [
      "packaging route surface is honest about env-gating default-off",
      "error envelope reports CAPABILITY_DISABLED with capability=packaging",
      "surface metadata identifies /v1/packages",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
  }),
  // Phase 11 Module 17 — plugin lifecycle bounded surface, distinct from skills/commerce
  httpScenario({
    id: "l2-plugins-lifecycle-bounded-contract",
    layer: "L2",
    productArea: "plugins",
    entrySurface: "/v1/plugins",
    routeFamily: "contract",
    execution: {
      path: "/v1/plugins?source=bundled",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "plugin distribution surface stays bounded and does not blur into skills lifecycle",
      "list response uses ok envelope and items array shape",
      "source filter is recognised (bounded, not a marketplace listing)",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
  }),
  // Phase 11 Module 18 — multi-tenant security route honesty: default-off
  // surface is not exposed (route family is not registered without env gate).
  httpScenario({
    id: "l2-multi-tenant-security-default-off-not-exposed",
    layer: "L2",
    productArea: "multi-tenant security",
    entrySurface: "/v1/security/tenants",
    routeFamily: "contract",
    execution: {
      public: true,
      path: "/v1/security/tenants",
      expectStatus: 404,
      expectOkEnvelope: false,
    },
    expectedEvidence: [
      "multi-tenant security surface is not registered by default",
      "no auto-generated master key warnings appear in default-off response",
      "404 confirms env-gate honesty without exposing the family on misconfigured runtimes",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
  }),
  // Phase 11 Module 16 — packaging default-on list reachability.
  //
  // Honesty note: this scenario only proves that the packaging route
  // family answers when FRIDAY_PACKAGING_ENABLED is true (an http_probe
  // GET against the list endpoint).  It does NOT execute the full
  // publish -> install -> verify -> restart-survive -> rollback ->
  // remove roundtrip required by Phase 11 Module 16's release-complete
  // claim.  That full roundtrip remains Phase 14 debt (debt key:
  // module_16_packaging_release_proof_roundtrip) until the RGG executor
  // grows publish/install/restart/rollback step support; the executor
  // change is out of scope for Phase 11 and the FRIDAY_PACKAGING_ENABLED
  // default-on flip is an explicit stop point that is not flipped here.
  // Local real proof of the full roundtrip lives in the packaging
  // SQLite persistence integration test.
  httpScenario({
    id: "l2-packaging-default-on-list-reachable",
    layer: "L2",
    productArea: "packaging",
    entrySurface: "/v1/packages",
    routeFamily: "contract",
    preconditions: ["packaging.ready"],
    execution: {
      path: "/v1/packages?limit=1",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "packaging list route returns ok envelope when FRIDAY_PACKAGING_ENABLED is on",
      "items array shape is present (registry list reachability only)",
      "this scenario does not prove publish/install/restart/rollback (Phase 14 debt: module_16_packaging_release_proof_roundtrip)",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-11", "module-16", "behind-env-gate", "phase-14-debt-roundtrip"],
  }),
  httpScenario({
    id: "l2-packaging-default-on-trusted-keys-list",
    layer: "L2",
    productArea: "packaging",
    entrySurface: "/v1/packages/keys",
    routeFamily: "contract",
    preconditions: ["packaging.ready"],
    execution: {
      path: "/v1/packages/keys?limit=1",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "trusted-key surface returns ok envelope when packaging is enabled",
      "list result shape is bounded and not a marketplace listing",
      "persistent trusted-key store is the source of truth (SQLite v079)",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-11", "module-16", "behind-env-gate"],
  }),
  // Phase 11 Module 18 — multi-tenant default-on tenant CRUD/persistence
  // and tenant-scoped domain record access with cross-tenant denial.
  // Stays blocked_by_env until FRIDAY_REAL_WORLD_MULTI_TENANT_READY=true
  // and the operator has provisioned FRIDAY_MASTER_KEY for the hub.
  // FRIDAY_MULTI_TENANT_ENABLED default-on flip remains an explicit stop
  // point.
  httpScenario({
    id: "l2-multi-tenant-default-on-tenants-list",
    layer: "L2",
    productArea: "multi-tenant security",
    entrySurface: "/v1/security/tenants",
    routeFamily: "contract",
    preconditions: ["multi_tenant_security.ready"],
    execution: {
      path: "/v1/security/tenants?limit=1",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "tenant list route is reachable when FRIDAY_MULTI_TENANT_ENABLED is on",
      "FRIDAY_MASTER_KEY is operator-provisioned (no auto-generated key warning)",
      "tenant state is SQLite-backed (v080) and survives restart",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-11", "module-18", "behind-env-gate"],
  }),
  // Phase 11 Module 18 — multi-tenant security default-on route presence.
  //
  // Honesty note: this scenario only probes that the secret-by-id route
  // path returns 404 for a synthetic non-existent secret when the
  // multi-tenant runtime is enabled.  A generic 404 cannot, on its own,
  // prove cross-tenant denial or audit emission; a synthetic probe and a
  // real cross-tenant deny look identical from the http_probe oracle's
  // perspective.  True cross-tenant denial with audit-trail assertion is
  // proven by the multi-tenant SQLite persistence integration test and
  // by the tenant-scoped resource registry route integration test
  // locally.  The end-to-end RGG-driven assertion (two tenants + secret
  // create + cross-tenant GET + audit row inspection) remains Phase 14
  // debt (debt key: module_18_cross_tenant_denial_rgg_assertion) until
  // the RGG executor grows multi-step tenant-setup scenario support.
  // The FRIDAY_MULTI_TENANT_ENABLED default-on flip remains an explicit
  // stop point and is not flipped here.
  httpScenario({
    id: "l2-multi-tenant-default-on-secrets-route-404",
    layer: "L2",
    productArea: "multi-tenant security",
    entrySurface: "/v1/security/tenants/:tenantId/secrets/:secretId",
    routeFamily: "contract",
    preconditions: ["multi_tenant_security.ready"],
    execution: {
      path: "/v1/security/tenants/__cross_tenant_probe__/secrets/__probe__",
      expectStatus: 404,
      expectOkEnvelope: false,
    },
    expectedEvidence: [
      "secret-by-id route returns 404 for a synthetic non-existent path when FRIDAY_MULTI_TENANT_ENABLED is on",
      "route family is registered without exposing tenant existence (route presence + 404 envelope only)",
      "this scenario does not prove cross-tenant denial end-to-end (Phase 14 debt: module_18_cross_tenant_denial_rgg_assertion)",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-11", "module-18", "behind-env-gate", "phase-14-debt-cross-tenant"],
  }),
  httpScenario({
    id: "l2-memory-items-create-contract",
    layer: "L2",
    productArea: "memory",
    entrySurface: "/v1/memory/items",
    routeFamily: "contract",
    execution: {
      method: "POST",
      path: "/v1/memory/items",
      body: {
        namespace: "default",
        content: "real-world validation memory probe {{timestamp}}",
        source: "real-world-validation",
        tags: ["release-truth-audit"],
      },
      jsonPathsPresent: ["data.item.id", "data.item.content"],
      cleanupRequests: [
        {
          method: "DELETE",
          path: "/v1/memory/items/{{response.data.item.id}}",
        },
      ],
    },
    suites: ["daily", "nightly", "weekly"],
  }),
  // Phase 13.5A Module 26a/26d — task-workflows read-only boundary catalog.
  //
  // Honesty note: this scenario only probes that the read-only boundary
  // catalog route (/v1/task-workflows/boundaries) returns the built-in
  // BoundaryContract list when the task-workflow service is wired into
  // the runtime. It does NOT exercise create/revise/claim/evidence/verify/
  // closeout transitions, gate enforcement, claim-kind/evidence compatibility,
  // verifier verdict semantics, or revised-spec lineage; those are covered
  // by the local unit tests (test/unit/task-workflows/) and the route
  // unit tests (test/unit/api/routes/friday-task-workflow-routes.test.ts).
  // Phase 13.5A release-complete claim still requires a same-SHA RGG
  // artifact at PR head, which is Stage 7 evidence and not provided by
  // this catalog-only scenario on its own.
  httpScenario({
    id: "l2-task-workflows-boundaries-contract",
    layer: "L2",
    productArea: "task workflows",
    entrySurface: "/v1/task-workflows/boundaries",
    routeFamily: "contract",
    execution: {
      public: true,
      path: "/v1/task-workflows/boundaries",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "task-workflows boundary catalog route returns ok envelope when the service is wired",
      "items array shape is present (read-only catalog reachability only)",
      "this scenario does not prove gate enforcement, claim verification, or closeout receipt semantics",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-13-5", "module-26a", "module-26d", "read-only-catalog"],
  }),
  // Phase 13.5A Module 26a/26d — task-workflows read-only gate catalog.
  httpScenario({
    id: "l2-task-workflows-gates-contract",
    layer: "L2",
    productArea: "task workflows",
    entrySurface: "/v1/task-workflows/gates",
    routeFamily: "contract",
    execution: {
      public: true,
      path: "/v1/task-workflows/gates",
      jsonPathsPresent: ["data.items"],
    },
    expectedEvidence: [
      "task-workflows gate catalog route returns ok envelope when the service is wired",
      "items array shape is present (read-only catalog reachability only)",
      "this scenario does not prove required-gate-undisable enforcement; that is covered by local unit tests",
    ],
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-13-5", "module-26a", "module-26d", "read-only-catalog"],
  }),
  agentScenario({
    id: "l3-chat-direct-answer",
    layer: "L3",
    productArea: "assistant behavior",
    entrySurface: "/v1/agent/runs",
    routeFamily: "chat",
    realWorldPrompt: "Reply with one sentence: what is the default reply language in this workspace?",
    expectedEvidence: [
      "run completes without clarification",
      "answer states a concrete default reply language",
      "provider/model/cost metrics are recorded",
    ],
    oracles: {
      behavior: {
        expectedAnySubstrings: ["English", "英语", "Chinese", "中文"],
        disallowStatuses: ["awaiting_clarification", "awaiting_plan_approval"],
        disallowClarification: true,
        disallowPlanGate: true,
      },
    },
    latencyBudget: { timeToFinalAnswerMs: 20_000 },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  agentScenario({
    id: "l3-summary-misroute-guard",
    layer: "L3",
    productArea: "assistant behavior",
    entrySurface: "/v1/agent/runs",
    routeFamily: "summary",
    realWorldPrompt: "Summarize this note in 3 bullet points only: Friday should answer normal summaries directly and must not enter workflow generation or approval planning mode.",
    expectedEvidence: [
      "summary is returned directly",
      "no workflow-planning clarification appears",
      "output remains concise and task-aligned",
    ],
    oracles: {
      behavior: {
        misrouteTriggers: [
          "Before I execute this generate workflow",
          "generate workflow",
        ],
        forbiddenSubstrings: ["Before I execute this generate workflow"],
        disallowStatuses: ["awaiting_clarification", "awaiting_plan_approval"],
        minimumTextLength: 30,
        disallowClarification: true,
        disallowPlanGate: true,
      },
    },
    latencyBudget: { timeToFinalAnswerMs: 60_000 },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  agentScenario({
    id: "l3-long-summary-direct",
    layer: "L3",
    productArea: "assistant behavior",
    entrySurface: "/v1/agent/runs",
    routeFamily: "long summary",
    realWorldPrompt: [
      "Summarize this release note in exactly 5 bullet points.",
      "Friday now supports real-world validation with environment truth, UI route verification, workflow approval roundtrips, generator evidence, and fallback provider measurement.",
      "Do not ask follow-up questions.",
      "Do not enter workflow generation, approval planning, or clarification mode.",
    ].join(" "),
    expectedEvidence: [
      "longer summary is returned directly",
      "no approval or planning gate appears",
      "summary remains bounded to the requested format",
    ],
    oracles: {
      behavior: {
        forbiddenSubstrings: ["Before I execute this generate workflow"],
        minimumTextLength: 80,
        disallowStatuses: ["awaiting_clarification", "awaiting_plan_approval"],
        disallowClarification: true,
        disallowPlanGate: true,
      },
    },
    latencyBudget: { timeToFinalAnswerMs: 60_000 },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  agentScenario({
    id: "l3-json-extraction",
    layer: "L3",
    productArea: "assistant behavior",
    entrySurface: "/v1/agent/runs",
    routeFamily: "structured output",
    realWorldPrompt: 'Return JSON only for this text: "owner=Friday priority=P1 blocked=false". Schema: {"owner":string,"priority":string,"blocked":boolean}',
    expectedEvidence: [
      "agent returns parseable JSON",
      "requested keys are present",
      "boolean field is preserved",
    ],
    oracles: {
      behavior: {
        expectJson: true,
        jsonPathsEqual: {
          owner: "Friday",
          priority: "P1",
          blocked: false,
        },
        disallowStatuses: ["awaiting_clarification", "awaiting_plan_approval"],
      },
    },
    latencyBudget: { timeToFinalAnswerMs: 20_000 },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  agentScenario({
    id: "l3-multi-turn-memory",
    layer: "L3",
    productArea: "assistant behavior",
    entrySurface: "/v1/agent/runs",
    routeFamily: "multi-turn",
    realWorldPrompt: "Remember the phrase amber-cascade-17 and return it later in the same session.",
    expectedEvidence: [
      "the agent keeps state across turns in one shared session",
      "the recall turn returns the original phrase",
      "provider/model/cost metrics span both turns",
    ],
    execution: {
      timeoutMs: 120_000,
      sessionKeyPrefix: "multi-turn-memory",
      turns: [
        { prompt: "Remember this code phrase for this conversation only: amber-cascade-17. Reply with OK only." },
        { prompt: "What code phrase did I ask you to remember? Reply with the phrase only." },
      ],
    },
    oracles: {
      behavior: {
        expectedSubstrings: ["amber-cascade-17"],
        forbiddenSubstrings: ["I don't know", "not sure"],
        disallowStatuses: ["awaiting_clarification", "awaiting_plan_approval"],
        disallowClarification: true,
        disallowPlanGate: true,
      },
    },
    latencyBudget: { timeToFinalAnswerMs: 40_000 },
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  agentScenario({
    id: "l4-file-tool-roundtrip",
    layer: "L4",
    productArea: "tools",
    entrySurface: "/v1/agent/runs",
    routeFamily: "file tool",
    providerLane: "default_only",
    realWorldPrompt: "Call the `read` tool with path `README.md` from the current workspace root, then answer with the top H1 heading only. Do not use web search for this workspace file.",
    expectedEvidence: [
      "agent uses at least one tool call",
      "output reflects filesystem content rather than a guess",
      "tool result is visible in run metadata",
    ],
    execution: {
      useJudge: false,
      expectToolCallCountMin: 1,
      expectWorkspaceFileTopH1: "README.md",
      constraints: { readOnly: true },
    },
    oracles: {
      behavior: {
        minimumTextLength: 3,
        forbiddenSubstrings: [
          "outside the allowed workspace root",
          "cannot access the file",
          "cannot access",
          "unable to access",
          "unable to read",
          "无法直接访问",
          "无法读取",
          "不能读取",
          "无法访问",
        ],
      },
    },
  }),
  baseScenario({
    id: "l5-workflow-approval-roundtrip",
    layer: "L5",
    productArea: "workflow approval",
    entrySurface: "/v1/workflows",
    routeFamily: "approval loop",
    providerLane: "none",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "workflow is created and published",
      "approval request is generated and approved",
      "run completes after approval and evidence route is reachable",
    ],
    execution: {
      kind: "workflow_roundtrip",
      slugPrefix: "real-world-approval",
      workflowName: "Real World Validation Approval Workflow",
      timeoutMs: 120_000,
    },
    severityOnFailure: "P0",
    repeatProfile: { daily: 10, nightly: 30 },
  }),
  baseScenario({
    id: "l5-skill-generator-loop",
    layer: "L5",
    productArea: "skill generator",
    entrySurface: "/v1/skills/generator/sessions",
    routeFamily: "generator",
    providerLane: "none",
    preconditions: ["auth.ready"],
    realWorldPrompt: "Create a tiny skill that echoes the current date in a concise sentence.",
    expectedEvidence: [
      "generator session can start",
      "draft generation, self-test, and evidence all complete",
      "validation issues are captured as evidence instead of being hidden",
      "approved skill is saved and can run after installation",
    ],
    execution: {
      kind: "skill_generator_loop",
      approve: true,
      timeoutMs: 180_000,
    },
    severityOnFailure: "P1",
    suites: ["daily", "nightly", "weekly"],
    repeatProfile: { daily: 10, nightly: 10 },
  }),
  baseScenario({
    id: "l5-workflow-generator-loop",
    layer: "L5",
    productArea: "workflow generator",
    entrySurface: "/v1/workflows/generator/sessions",
    routeFamily: "generator",
    providerLane: "none",
    preconditions: ["auth.ready"],
    realWorldPrompt: "Create a minimal workflow that triggers manually and logs a message.",
    expectedEvidence: [
      "workflow generator session can start",
      "draft generation and evidence are reachable",
      "approval readiness is explicit",
    ],
    execution: {
      kind: "workflow_generator_loop",
      approve: false,
      timeoutMs: 180_000,
    },
    severityOnFailure: "P1",
    suites: ["daily", "nightly", "weekly"],
    repeatProfile: { daily: 10, nightly: 10 },
  }),
  baseScenario({
    id: "l5-persona-explicit-preference",
    layer: "L5",
    productArea: "persona and learning",
    entrySurface: "/v1/uix/persona",
    routeFamily: "persona",
    providerLane: "none",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "explicit preference write succeeds",
      "resolved persona changes accordingly",
      "cleanup removes temporary preferences",
    ],
    execution: {
      kind: "persona_learning",
      preferences: [
        { category: "communication", key: "persona.directness", value: "direct" },
        { category: "communication", key: "persona.verbosity", value: "concise" },
      ],
      expectPersonaChecks: [
        { path: "settings.directness", equals: "direct" },
        { path: "settings.verbosity", equals: "concise" },
      ],
    },
    severityOnFailure: "P1",
    suites: ["daily", "nightly", "weekly"],
    repeatProfile: { daily: 10, nightly: 10 },
  }),
  // Phase 14.5B Module 28b — one-click repair / recovery doctor RGG slice.
  //
  // Live-HTTP proof that the bound-principal gate refuses the synthetic
  // public principal on every /v1/auto-fix mutating route. The executor
  // sends the five POSTs without an Authorization header (skipAuth: true)
  // so the server resolves to the synthetic public principal and the
  // real route handler invokes assertBoundPrincipalForOperation. No mocks.
  //
  // Honesty note (no proof overclaim): the no-patch apply_config_patch
  // repaired-claim refusal is proven by the integration acceptance test
  // `test/e2e/api/friday-api-auto-fix-doctor.acceptance.test.ts` (which
  // drives the HTTP route + real self-healing/execution service with a
  // configManager stub that returns a numeric revision only when a real
  // patch is supplied). The channel/session-text repair preview-only
  // behavior is proven by the deterministic-dispatch unit test
  // `test/unit/sessions/friday-deterministic-dispatch.test.ts`. Live
  // external-channel transcript proof remains forwarded to Phase 14.5E
  // for configured Discord/Lark/Telegram test spaces only.
  // Phase 14.5C module_28c — workflow evidence fail-closed RGG slice.
  //
  // Same-SHA RGG vehicle for the full evidence-fail-closed contract. The
  // executor stages an isolated in-memory SQLite database (loaded with the
  // canonical Friday migration stack, including v086) and drops the
  // `workflow_run_pipeline_events` table to simulate live evidence-store
  // unreach. It then drives the real workflow runtime and the real
  // task-workflow service in-process — no mocks of the workflow runtime,
  // workflow evidence repository, task-workflow repository, or
  // task-workflow service — and asserts the four behaviors named by the
  // Stage 2 scope reconciliation matrix:
  //   * proof-required run fails closed — terminal run.status === "failed"
  //     and run.failure.code === "WORKFLOW_EVIDENCE_UNAVAILABLE";
  //   * ordinary run continues to terminal completed — no terminal failure
  //     for evidence reasons — while the run's evidenceStatus honestly
  //     resolves to degraded/unavailable so the receipt cannot claim
  //     proof;
  //   * verifyClaim refuses a `workflow_run_evidence` ref pointing at a
  //     non-available run with HTTP 409
  //     TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE;
  //   * healthy-path closeout receipt populates `evidenceDurability` and
  //     `proofClaimable`, and the new `workflow_run_evidence_durable`
  //     required gate passes.
  //
  // Honesty notes:
  //   * Live external-channel transcript proof remains forwarded to
  //     Phase 14.5E for configured Discord/Lark/Telegram test spaces.
  //   * Universal rollback class taxonomy is Phase 14.5D scope and is not
  //     introduced or claimed here.
  //   * Phase 14 release-proof debt and Phase 15 docs-truth reconciliation
  //     are out of scope.
  baseScenario({
    id: "l6-phase-14-5c-workflow-evidence-fail-closed",
    layer: "L6",
    productArea: "workflow evidence",
    entrySurface: "/v1/workflow-runs",
    routeFamily: "workflow-evidence-fail-closed",
    providerLane: "none",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "isolated in-memory SQLite database is bootstrapped with the canonical Friday migration stack including v086 (proof_required + evidenceDurability + proofClaimable)",
      "workflow_run_pipeline_events table is dropped post-migration to simulate live evidence-store unreach (no mocks of the evidence repository or runtime)",
      "healthy ordinary run before the table drop reports evidenceStatus available via runtime.evidence.getRunEvidenceStatus and runtime.evidence.getRunEvidence",
      "proof-required run after the table drop reaches terminal status=failed with failure.code=WORKFLOW_EVIDENCE_UNAVAILABLE and a failure.message naming durable evidence persistence loss; evidenceStatus is off available",
      "ordinary run after the table drop reaches terminal status=completed (not failed for evidence reasons) while evidenceStatus resolves to degraded/unavailable so no proof claim can be made",
      "task-workflow verifyClaim against a workflow_run_evidence ref from a degraded run throws TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE with HTTP 409",
      "closeout receipt on the degraded path reports status=partial and carries an evidenceDurability field",
      "healthy-path closeout receipt reports status=complete with evidenceDurability=available, proofClaimable=true, and the workflow_run_evidence_durable required gate=pass",
      "live external-channel transcript proof remains forwarded to Phase 14.5E for configured channels",
    ],
    execution: {
      kind: "workflow_evidence_fail_closed",
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P0",
    tags: ["phase-14-5c", "module-28c", "workflow-evidence-fail-closed", "proof-required"],
  }),
  baseScenario({
    id: "l6-phase-14-5b-one-click-repair-doctor",
    layer: "L6",
    productArea: "self-healing",
    entrySurface: "/v1/auto-fix/actions/*",
    routeFamily: "bound-principal gate",
    providerLane: "none",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "POST /v1/auto-fix/actions/run-ready refuses the synthetic public principal with HTTP 401 OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      "POST /v1/auto-fix/actions/:id/approve refuses the synthetic public principal with HTTP 401 OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      "POST /v1/auto-fix/actions/:id/deny refuses the synthetic public principal with HTTP 401 OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      "POST /v1/auto-fix/actions/:id/execute refuses the synthetic public principal with HTTP 401 OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      "POST /v1/auto-fix/actions/:id/rollback refuses the synthetic public principal with HTTP 401 OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      "probes hit live route handlers without an Authorization header (no mocks)",
      "no-patch apply_config_patch repaired-claim refusal is proven by the acceptance integration test (forwarded — not RGG-scope)",
      "channel/session-text repair preview-only behavior is proven by the deterministic-dispatch unit test (forwarded — not RGG-scope)",
      "live external-channel transcript proof remains forwarded to Phase 14.5E for configured channels",
    ],
    execution: {
      kind: "auto_fix_doctor_roundtrip",
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P0",
    tags: ["phase-14-5b", "module-28b", "bound-principal-gate", "self-healing"],
  }),
  httpScenario({
    id: "l5-self-healing-actions-readiness",
    layer: "L5",
    productArea: "self-healing",
    entrySurface: "/v1/auto-fix/actions",
    routeFamily: "self-healing entry",
    expectedEvidence: [
      "auto-fix action inventory is reachable in read-only mode",
      "self-healing entry state is visible without triggering execution",
      "empty inventory is explicit instead of hidden behind transport errors",
    ],
    execution: {
      path: "/v1/auto-fix/actions",
      jsonPathsPresent: ["data.items"],
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    repeatProfile: { daily: 10, nightly: 10 },
  }),
  manualExternalScenario({
    id: "l6-discord-roundtrip-manual",
    layer: "L6",
    productArea: "external channels",
    entrySurface: "discord",
    routeFamily: "distributed channel",
    preconditions: ["external_channels.ready"],
    tags: ["external-channel"],
    manualChecklist: [
      "send a real inbound Discord message",
      "capture Friday outbound reply and attachment behavior",
      "record dedupe/retry evidence in the report folder",
    ],
  }),
  discordRoundtripScenario({
    id: "l6-discord-channel-roundtrip",
    layer: "L6",
    productArea: "external channels",
    entrySurface: "discord",
    routeFamily: "distributed channel",
    severityOnFailure: "P1",
    suites: ["weekly"],
  }),
  manualExternalScenario({
    id: "l6-slack-roundtrip-manual",
    layer: "L6",
    productArea: "external channels",
    entrySurface: "slack",
    routeFamily: "distributed channel",
    preconditions: ["external_channels.ready"],
    tags: ["external-channel"],
    manualChecklist: [
      "send a real inbound Slack message",
      "capture thread reply, latency, and retry behavior",
      "verify no fake success is reported when delivery fails",
    ],
  }),
  manualExternalScenario({
    id: "l6-webchat-roundtrip-manual",
    layer: "L6",
    productArea: "external channels",
    entrySurface: "webchat",
    routeFamily: "distributed channel",
    preconditions: ["external_channels.ready"],
    tags: ["external-channel"],
    manualChecklist: [
      "exercise real inbound to outbound webchat flow",
      "capture attachment delivery evidence",
      "verify queue backlog and dedupe semantics",
    ],
  }),
  manualExternalScenario({
    id: "l6-satellite-pairing-manual",
    layer: "L6",
    productArea: "satellites",
    entrySurface: "/v1/satellites",
    routeFamily: "distributed recovery",
    preconditions: ["satellite.ready"],
    tags: ["satellite"],
    manualChecklist: [
      "pair a real satellite node",
      "force offline/resume once",
      "capture sync and command queue evidence",
    ],
  }),
  // Phase 12 Module 20 — manual external Slack alert dispatch
  manualExternalScenario({
    id: "l6-observability-slack-alert-dispatch-manual",
    layer: "L6",
    productArea: "observability",
    entrySurface: "/v1/observability/alert-destinations",
    routeFamily: "external alerts",
    preconditions: ["external_alerts.ready"],
    tags: ["external-alerts", "slack"],
    manualChecklist: [
      "create a Slack alert destination using FRIDAY_REAL_WORLD_ALERT_SLACK_WEBHOOK_URL",
      "trigger a real alert dispatch and verify the message arrives in Slack",
      "capture observability audit entry for outcome=success or outcome=failure honestly",
    ],
  }),
  // Phase 12 Module 20 — manual external SMTP alert dispatch
  manualExternalScenario({
    id: "l6-observability-smtp-alert-dispatch-manual",
    layer: "L6",
    productArea: "observability",
    entrySurface: "/v1/observability/alert-destinations",
    routeFamily: "external alerts",
    preconditions: ["external_alerts.ready"],
    tags: ["external-alerts", "smtp"],
    manualChecklist: [
      "create an SMTP alert destination using FRIDAY_REAL_WORLD_ALERT_SMTP_* env",
      "trigger a real alert dispatch and verify delivery to the configured recipient",
      "capture observability audit entry and SMTP server delivery log honestly",
    ],
  }),
  // Phase 12 Module 20 — disabling an alert destination must stop further dispatch
  manualExternalScenario({
    id: "l6-observability-alert-disable-rollback-manual",
    layer: "L6",
    productArea: "observability",
    entrySurface: "/v1/observability/alert-destinations/:destinationId",
    routeFamily: "external alerts",
    preconditions: ["external_alerts.ready"],
    tags: ["external-alerts", "rollback"],
    manualChecklist: [
      "disable a previously working Slack or SMTP destination via PATCH enabled=false",
      "trigger another alert and verify dispatch is skipped (status=skipped) without external send",
      "verify audit search returns the disabled-skip record without overclaiming success",
    ],
  }),
  // Phase 14 Module 26 — Phase 06 skill upgrade lifecycle live HTTP proof.
  //
  // Closes the Phase 06 release-proof debts: full HTTP proof of
  //   stage v1 → shadow → canary → promote →
  //   stage v2 → shadow → analyze → decide(replace) → canary → promote →
  //   rollback
  // with the rollback evidence asserting result=restored_previous (via
  // evidence.stage="rolled_back") and the skill restored to installed v1.
  //
  // The RGG executor self-stages deterministic v1/v2 candidates inside the
  // run by writing a temp skill manifest pair and POSTing them through the
  // production `/v1/skills/import` route with canonical approvals signed by
  // the runtime token secret. No operator pre-staging is required. Local
  // proof of the full lifecycle is also covered by
  // `test/e2e/api/friday-api-skill-upgrade-lifecycle-live.test.ts`.
  baseScenario({
    id: "l5-phase-06-skill-upgrade-lifecycle",
    layer: "L5",
    productArea: "skills lifecycle",
    entrySurface: "/v1/autonomy/skills/:skillId",
    routeFamily: "skill upgrade lifecycle",
    providerLane: "none",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "v1 candidate self-staged via /v1/skills/import",
      "v1 autonomy shadow→canary→promote succeeded under canonical approvals",
      "v2 candidate self-staged via /v1/skills/import",
      "upgrade analyze + decide(replace) accepted the canonical approval",
      "v2 autonomy shadow→canary→promote succeeded",
      "rollback v2 evidence reported stage=rolled_back (result=restored_previous)",
    ],
    execution: {
      kind: "skill_upgrade_lifecycle",
      runtimeVersion: "rgg-phase14",
      planDigest: "rgg-phase14-plan-digest",
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
    tags: ["phase-14", "module-26", "phase-06-debt", "skill-upgrade-lifecycle"],
  }),
  baseScenario({
    id: "l8-agent-core-soak",
    layer: "L8",
    productArea: "stability",
    entrySurface: "/v1/agent/runs",
    routeFamily: "soak",
    providerLane: "default_and_fallback",
    realWorldPrompt: "Reply with OK only.",
    expectedEvidence: [
      "repeated agent runs stay stable over time across core prompt variants",
      "completion rate and latency drift are measurable",
      "default and fallback soak lanes remain independently observable",
    ],
    execution: {
      kind: "agent_run",
      timeoutMs: 30_000,
      promptVariantsBySuite: {
        daily: [
          "Reply with one sentence: what is the default reply language in this workspace?",
          'Return JSON only for this text: "owner=Friday priority=P1 blocked=false". Schema: {"owner":string,"priority":string,"blocked":boolean}',
        ],
        nightly: [
          "Reply with one sentence: what is the default reply language in this workspace?",
          "Summarize this note in 3 bullet points only: Friday should answer normal summaries directly and must not enter workflow generation or approval planning mode.",
          'Return JSON only for this text: "owner=Friday priority=P1 blocked=false". Schema: {"owner":string,"priority":string,"blocked":boolean}',
        ],
        weekly: [
          "Reply with one sentence: what is the default reply language in this workspace?",
        ],
      },
      soak: {
        daily: { durationMs: 2 * 60 * 60 * 1000, concurrency: 1, laneKeys: ["default"] },
        nightly: { durationMs: 8 * 60 * 60 * 1000, concurrency: 1, laneKeys: ["default"] },
        weekly: { durationMs: 24 * 60 * 60 * 1000, concurrency: 1, laneKeys: ["fallback"] },
      },
      constraints: { readOnly: true },
      taskProfile: { id: "deterministic" },
    },
    oracles: {
      behavior: {
        minimumTextLength: 10,
        disallowStatuses: ["awaiting_clarification", "awaiting_plan_approval"],
      },
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
  }),
  baseScenario({
    id: "l8-workflow-approval-soak",
    layer: "L8",
    productArea: "stability",
    entrySurface: "/v1/workflows",
    routeFamily: "soak",
    providerLane: "none",
    preconditions: ["auth.ready"],
    expectedEvidence: [
      "workflow approval roundtrip remains stable over long runs",
      "approval creation, approval resolution, and evidence export remain measurable",
      "run completion drift is visible in the soak report",
    ],
    execution: {
      kind: "workflow_roundtrip",
      slugPrefix: "real-world-approval-soak",
      workflowName: "Real World Validation Approval Workflow Soak",
      timeoutMs: 120_000,
      soak: {
        daily: { durationMs: 2 * 60 * 60 * 1000, concurrency: 1 },
        nightly: { durationMs: 8 * 60 * 60 * 1000, concurrency: 1 },
        weekly: { durationMs: 24 * 60 * 60 * 1000, concurrency: 1 },
      },
    },
    suites: ["daily", "nightly", "weekly"],
    severityOnFailure: "P1",
  }),
];

const validation = validateCatalog(REAL_WORLD_SCENARIOS);
if (!validation.ok) {
  throw new Error(`Real-world scenario catalog is invalid:\n${validation.errors.join("\n")}`);
}
