import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTO_FIX_DOCTOR_BOUND_PRINCIPAL_ERROR_CODE,
  AUTO_FIX_DOCTOR_PROBE_ACTION_ID,
  AUTO_FIX_DOCTOR_ROUTES,
  executeScenario,
} from "../../../validation/real-world/lib/executors.mjs";

describe("real-world executors", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  function createAgentScenarioClient({ artifactDir }: { artifactDir?: string }) {
    return {
      async startAgentRun() {
        return { data: { runId: "agent-run-1", toolCallCount: artifactDir ? 1 : 0 } };
      },
      async getAgentRun() {
        return {
          data: {
            run: {
              status: "completed",
              responseText: "Friday",
              artifactDir,
              actualExecution: {
                actualProviderId: "test-provider",
                actualModel: "test-model",
                turns: [],
              },
            },
          },
        };
      },
    };
  }

  function createFileRoundtripScenario() {
    return {
      id: "l4-file-tool-roundtrip",
      entrySurface: "/v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P1",
      realWorldPrompt: "Call the read tool with path README.md, then answer with the top H1 heading only.",
      execution: {
        kind: "agent_run",
        expectWorkspaceFileTopH1: "README.md",
        expectToolCallCountMin: 1,
        constraints: { readOnly: true },
      },
    };
  }

  const lane = {
    laneKey: "default",
    providerId: "test-provider",
    model: "test-model",
  };

  it("fails file roundtrip when response has the heading but no matching read tool evidence", async () => {
    const artifact = await executeScenario({
      runId: "validation-run-1",
      suite: "smoke",
      scenario: createFileRoundtripScenario(),
      lane,
      client: createAgentScenarioClient({ artifactDir: undefined }),
      envTruth: {},
      reportRoot: tmpdir(),
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("failed");
    expect(artifact.failureClass).toBe("tool_bridge");
    expect(artifact.notes).toContain(
      'expected successful read tool evidence for README.md containing workspace top heading "Friday"',
    );
  });

  it("passes file roundtrip only when matching read tool evidence contains the expected heading", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-executor-"));
    const artifactDir = join(tempRoot, ".friday", "agent-runs", "agent-run-1");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "tool-calls.json"),
      JSON.stringify([
        {
          toolName: "read",
          args: { path: "README.md" },
          result: { isError: false, content: "# Friday\n\nLocal fixture.\n" },
        },
      ]),
      "utf8",
    );

    const artifact = await executeScenario({
      runId: "validation-run-1",
      suite: "smoke",
      scenario: createFileRoundtripScenario(),
      lane,
      client: createAgentScenarioClient({ artifactDir }),
      envTruth: {},
      reportRoot: tempRoot,
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.raw.toolEvidence).toEqual([
      expect.objectContaining({
        toolName: "read",
        isError: false,
        relativePath: "README.md",
        matchesExpectedPath: true,
        matchesExpectedHeading: true,
      }),
    ]);
  });

  describe("Phase 14.5B module_28b: auto_fix_doctor_roundtrip", () => {
    function createDoctorScenario() {
      return {
        id: "l6-phase-14-5b-one-click-repair-doctor",
        layer: "L6",
        productArea: "self-healing",
        entrySurface: "/v1/auto-fix/actions/*",
        routeFamily: "bound-principal gate",
        providerLane: "none",
        riskTier: "low",
        expectedEvidence: [
          "POST /v1/auto-fix/actions/run-ready refuses the synthetic public principal",
        ],
        execution: { kind: "auto_fix_doctor_roundtrip" },
      };
    }

    function createDoctorRouteResponder(overrides: Record<string, { status: number; errorCode?: string | null; skipAuthSeen?: boolean }> = {}) {
      const seenSkipAuth: Record<string, boolean> = {};
      const client = {
        accessToken: "real-access-token",
        request: async (method: string, routePath: string, options: { skipAuth?: boolean } = {}) => {
          seenSkipAuth[routePath] = options.skipAuth === true;
          const override = overrides[routePath];
          const status = override?.status ?? 401;
          const errorCode = override?.errorCode === undefined
            ? AUTO_FIX_DOCTOR_BOUND_PRINCIPAL_ERROR_CODE
            : override.errorCode;
          const json = errorCode === null
            ? { ok: false }
            : { ok: false, error: { code: errorCode } };
          return {
            method,
            routePath,
            status,
            ok: status >= 200 && status < 300,
            text: JSON.stringify(json),
            json,
            durationMs: 1,
          };
        },
        seenSkipAuth,
      };
      return client;
    }

    it("passes when every mutating route refuses with 401 and OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED", async () => {
      const client = createDoctorRouteResponder();
      const artifact = await executeScenario({
        runId: "validation-run-doctor-pass",
        suite: "smoke",
        scenario: createDoctorScenario(),
        lane: { laneKey: "default", providerId: "n/a", model: "n/a" },
        client,
        envTruth: {},
        reportRoot: tmpdir(),
        uiBaseUrl: "http://127.0.0.1:3141",
      });

      expect(artifact.result).toBe("passed");
      expect(artifact.metrics?.routesProbed).toBe(AUTO_FIX_DOCTOR_ROUTES.length);
      expect(artifact.metrics?.routesRefused).toBe(AUTO_FIX_DOCTOR_ROUTES.length);
      for (const route of AUTO_FIX_DOCTOR_ROUTES) {
        expect(client.seenSkipAuth[route.path]).toBe(true);
      }
    });

    it("fails when any mutating route returns a non-401 status", async () => {
      const breakingRoute = `/v1/auto-fix/actions/${AUTO_FIX_DOCTOR_PROBE_ACTION_ID}/execute`;
      const client = createDoctorRouteResponder({
        [breakingRoute]: { status: 200 },
      });
      const artifact = await executeScenario({
        runId: "validation-run-doctor-bad-status",
        suite: "smoke",
        scenario: createDoctorScenario(),
        lane: { laneKey: "default", providerId: "n/a", model: "n/a" },
        client,
        envTruth: {},
        reportRoot: tmpdir(),
        uiBaseUrl: "http://127.0.0.1:3141",
      });

      expect(artifact.result).toBe("failed");
      expect(artifact.failureClass).toBe("http_contract");
      expect(artifact.notes?.some((note: string) => note.includes("autofix.actions.execute"))).toBe(true);
      expect(artifact.metrics?.routesRefused).toBe(AUTO_FIX_DOCTOR_ROUTES.length - 1);
    });

    it("fails when a 401 carries a different error code (proof of code-level invariant)", async () => {
      const breakingRoute = `/v1/auto-fix/actions/${AUTO_FIX_DOCTOR_PROBE_ACTION_ID}/rollback`;
      const client = createDoctorRouteResponder({
        [breakingRoute]: { status: 401, errorCode: "UNAUTHORIZED" },
      });
      const artifact = await executeScenario({
        runId: "validation-run-doctor-bad-code",
        suite: "smoke",
        scenario: createDoctorScenario(),
        lane: { laneKey: "default", providerId: "n/a", model: "n/a" },
        client,
        envTruth: {},
        reportRoot: tmpdir(),
        uiBaseUrl: "http://127.0.0.1:3141",
      });

      expect(artifact.result).toBe("failed");
      expect(artifact.failureClass).toBe("http_contract");
      expect(artifact.notes?.some((note: string) => note.includes("autofix.actions.rollback"))).toBe(true);
    });
  });
});
