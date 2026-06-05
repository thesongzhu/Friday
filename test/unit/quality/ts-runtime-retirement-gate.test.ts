import { describe, expect, it } from "vitest";

import {
  collectTsRuntimeRetirementFailures,
  findClassificationForRoute,
} from "../../../scripts/quality/check-ts-runtime-retirement.mjs";

const baseManifest = {
  schemaVersion: 1,
  discovery: {
    includeMethods: ["GET", "POST"],
  },
  classificationValues: [
    "ui_shell",
    "test_oracle",
    "release_tooling",
    "compat_shim",
    "rust_delegated",
    "operator_external_adapter",
    "fail_closed",
    "ts_runtime_blocker",
  ],
  forbiddenCompletionSources: [
    "provider_ack",
    "timeline_read",
    "process_exit",
    "skill_run",
    "channel_receipt",
  ],
  defaultCompletionSemantics: {
    provider_ack: false,
    timeline_read: false,
    process_exit: false,
    skill_run: false,
    channel_receipt: false,
  },
  requiredLeakControls: [
    "raw_transcripts",
    "secrets",
    "private_paths",
    "provider_ids",
    "channel_ids",
    "raw_commands",
    "private_reasoning",
  ],
  routeFamilies: [],
  surfaces: [],
};

describe("TS runtime retirement gate", () => {
  it("fails an unclassified user-triggerable route", () => {
    const result = collectTsRuntimeRetirementFailures(baseManifest, [
      {
        method: "POST",
        path: "/v1/agent/runs",
        operationId: "agent.runs.start",
        sourceFile: "src/api/http/routes/friday-agent-routes.ts",
      },
    ]);

    expect(result.failures).toContain(
      "POST /v1/agent/runs (agent.runs.start, src/api/http/routes/friday-agent-routes.ts) is unclassified",
    );
  });

  it("requires blocker ownership, reason, and next action", () => {
    const manifest = {
      ...baseManifest,
      routeFamilies: [
        {
          id: "agent_runtime",
          match: { sourceFile: "src/api/http/routes/friday-agent-routes.ts" },
          classification: "ts_runtime_blocker",
          user_triggerable: true,
          owner: "ts-runtime-retirement",
          blocker: "TS owns agent runtime.",
        },
      ],
    };

    const result = collectTsRuntimeRetirementFailures(manifest, [
      {
        method: "POST",
        path: "/v1/agent/runs",
        operationId: "agent.runs.start",
        sourceFile: "src/api/http/routes/friday-agent-routes.ts",
      },
    ]);

    expect(result.failures).toContain(
      "POST /v1/agent/runs (agent.runs.start, src/api/http/routes/friday-agent-routes.ts) via agent_runtime is a ts_runtime_blocker without next_action",
    );
  });

  it("requires operator external adapters to declare private-data leak controls", () => {
    const manifest = {
      ...baseManifest,
      routeFamilies: [
        {
          id: "channel_adapter",
          match: { sourceFile: "src/api/http/routes/friday-channel-webhook-routes.ts" },
          classification: "operator_external_adapter",
          user_triggerable: true,
          leak_controls: {
            raw_private_data_allowed: false,
            forbidden: ["raw_transcripts"],
          },
        },
      ],
    };

    const result = collectTsRuntimeRetirementFailures(manifest, [
      {
        method: "POST",
        path: "/v1/channel-webhooks/telegram",
        operationId: "channels.webhooks.telegram",
        sourceFile: "src/api/http/routes/friday-channel-webhook-routes.ts",
      },
    ]);

    expect(result.failures).toContain(
      "POST /v1/channel-webhooks/telegram (channels.webhooks.telegram, src/api/http/routes/friday-channel-webhook-routes.ts) via channel_adapter leak controls are missing secrets",
    );
  });

  it("lets exact blocker surfaces override broader compatibility families", () => {
    const manifest = {
      ...baseManifest,
      routeFamilies: [
        {
          id: "agent_compat",
          match: { sourceFile: "src/api/http/routes/friday-agent-routes.ts" },
          classification: "compat_shim",
          user_triggerable: true,
          migration_intent: "temporary",
        },
      ],
      surfaces: [
        {
          id: "agent_runs_start",
          route: {
            method: "POST",
            path: "/v1/agent/runs",
            operationId: "agent.runs.start",
          },
          classification: "ts_runtime_blocker",
          user_triggerable: true,
          owner: "ts-runtime-retirement",
          blocker: "TS starts runs.",
          next_action: "Delegate or fail-close.",
        },
      ],
    };

    const classification = findClassificationForRoute(
      {
        method: "POST",
        path: "/v1/agent/runs",
        operationId: "agent.runs.start",
        sourceFile: "src/api/http/routes/friday-agent-routes.ts",
      },
      manifest.surfaces,
      manifest.routeFamilies,
    );

    expect(classification?.id).toBe("agent_runs_start");
  });
});
