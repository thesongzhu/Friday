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

  function createAgentScenarioClient({
    artifactDir,
    responseText = "Friday",
    status = "completed",
    planReview,
    request,
  }: {
    artifactDir?: string;
    responseText?: string;
    status?: string;
    planReview?: unknown;
    request?: (method: string, routePath: string, options?: unknown) => Promise<unknown>;
  }) {
    return {
      request,
      async startAgentRun() {
        return { data: { runId: "agent-run-1", toolCallCount: artifactDir ? 1 : 0 } };
      },
      async getAgentRun() {
        return {
          data: {
            run: {
              status,
              responseText,
              artifactDir,
              planReview,
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

  function createStatefulMemoryRecallScenario() {
    return {
      id: "l3-memory-api-store-agent-recall-proof",
      entrySurface: "/v1/memory/store -> /v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P0",
      realWorldPrompt: "Use memory_search and answer BARB.",
      execution: {
        kind: "agent_run",
        setupRequests: [
          {
            method: "POST",
            path: "/v1/memory/store",
            body: {
              namespace: "phase-22d-proof",
              content: "codename BARB",
            },
            expectStatus: 200,
            expectOkEnvelope: true,
            jsonPathsPresent: ["data.item.id"],
          },
        ],
        cleanupRequests: [
          {
            method: "DELETE",
            path: "/v1/memory/items/{{setupResponses.0.json.data.item.id}}",
            expectStatus: 200,
            expectOkEnvelope: true,
            jsonPathsPresent: ["data.deleted"],
          },
        ],
        cleanupFailureIsFailure: true,
        expectedOutputSubstrings: ["BARB"],
        expectedToolNames: ["memory_search"],
        expectedToolResultSubstrings: ["BARB"],
        expectToolCallCountMin: 1,
        constraints: { readOnly: true },
      },
    };
  }

  function createAwaitingHumanScenario() {
    return {
      id: "l3-vague-goal-awaiting-user-state",
      entrySurface: "/v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P0",
      realWorldPrompt: "Ask clarifying questions before claiming this vague task is complete.",
      execution: {
        kind: "agent_run",
        constraints: { readOnly: true },
      },
      oracles: {
        behavior: {
          requireAwaitingHumanState: true,
          requireClarificationQuestion: true,
          disallowCompletedWithClarificationQuestion: true,
        },
      },
    };
  }

  function createMissingFileScenario() {
    return {
      id: "l4-missing-file-no-verified-success",
      entrySurface: "/v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P2",
      realWorldPrompt: "Call the read tool for docs/friday-strict-verifier-missing-proof-file.md.",
      execution: {
        kind: "agent_run",
        expectMissingWorkspaceFile: "docs/friday-strict-verifier-missing-proof-file.md",
        expectToolCallCountMin: 1,
        constraints: { readOnly: true },
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

  it("lets expected awaiting-human states reach the behavioral rubric", async () => {
    const artifact = await executeScenario({
      runId: "validation-run-awaiting-human",
      suite: "smoke",
      scenario: createAwaitingHumanScenario(),
      lane,
      client: createAgentScenarioClient({
        status: "awaiting_clarification",
        responseText: "Please answer these questions before I continue:\n1. Which users should Friday optimize for?",
        planReview: {
          gate: {
            state: "awaiting_clarification",
            clarificationQuestions: ["Which users should Friday optimize for?"],
          },
        },
      }),
      envTruth: {},
      reportRoot: tmpdir(),
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.raw.runStatus).toBe("awaiting_clarification");
  });

  it("passes missing-file strict verification only with failed read tool evidence", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-executor-"));
    const artifactDir = join(tempRoot, ".friday", "agent-runs", "agent-run-1");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "tool-calls.json"),
      JSON.stringify([
        {
          toolName: "read",
          args: { path: "docs/friday-strict-verifier-missing-proof-file.md" },
          result: { isError: true, content: "ENOENT: no such file or directory" },
        },
      ]),
      "utf8",
    );

    const artifact = await executeScenario({
      runId: "validation-run-missing-file",
      suite: "smoke",
      scenario: createMissingFileScenario(),
      lane,
      client: createAgentScenarioClient({
        artifactDir,
        responseText: "I cannot verify this file because the read tool reported it is missing.",
      }),
      envTruth: {},
      reportRoot: tempRoot,
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.raw.missingWorkspaceFileOracle).toMatchObject({
      path: "docs/friday-strict-verifier-missing-proof-file.md",
      exists: false,
    });
    expect(artifact.raw.toolEvidence).toEqual([
      expect.objectContaining({
        toolName: "read",
        isError: true,
        matchesExpectedPath: true,
      }),
    ]);
  });

  it("fails missing-file strict verification when the read tool error is absent", async () => {
    const artifact = await executeScenario({
      runId: "validation-run-missing-file-no-tool",
      suite: "smoke",
      scenario: createMissingFileScenario(),
      lane,
      client: createAgentScenarioClient({
        artifactDir: undefined,
        responseText: "I cannot verify this file.",
      }),
      envTruth: {},
      reportRoot: tmpdir(),
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("failed");
    expect(artifact.failureClass).toBe("tool_bridge");
    expect(artifact.notes).toContain(
      "expected failed read tool evidence for missing workspace file docs/friday-strict-verifier-missing-proof-file.md",
    );
  });

  it("fails stateful agent scenarios when required cleanup does not satisfy expectations", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-executor-"));
    const artifactDir = join(tempRoot, ".friday", "agent-runs", "agent-run-1");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "tool-calls.json"),
      JSON.stringify([
        {
          toolName: "memory_search",
          args: { query: "codename" },
          result: { isError: false, content: '[{"content":"codename BARB"}]' },
        },
      ]),
      "utf8",
    );

    const artifact = await executeScenario({
      runId: "validation-run-stateful-cleanup",
      suite: "smoke",
      scenario: createStatefulMemoryRecallScenario(),
      lane,
      client: createAgentScenarioClient({
        artifactDir,
        responseText: "BARB",
        request: async (method, routePath) => {
          if (method === "POST" && routePath === "/v1/memory/store") {
            return {
              status: 200,
              ok: true,
              json: { ok: true, data: { item: { id: "memory-1" } } },
              text: "",
              durationMs: 1,
            };
          }
          return {
            status: 500,
            ok: false,
            json: { ok: false, error: { code: "CLEANUP_FAILED" } },
            text: "",
            durationMs: 1,
          };
        },
      }),
      envTruth: {},
      reportRoot: tempRoot,
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("failed");
    expect(artifact.failureClass).toBe("cleanup");
    expect(artifact.notes).toContain(
      "cleanup request 1 failed expectations: expected HTTP 200 but received 500; expected ok=true envelope; missing JSON path: data.deleted",
    );
    expect(artifact.raw.cleanupResponses).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: "/v1/memory/items/memory-1",
        status: 500,
        expectationFailures: [
          "expected HTTP 200 but received 500",
          "expected ok=true envelope",
          "missing JSON path: data.deleted",
        ],
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
