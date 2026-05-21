import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTO_FIX_DOCTOR_BOUND_PRINCIPAL_ERROR_CODE,
  AUTO_FIX_DOCTOR_PROBE_ACTION_ID,
  AUTO_FIX_DOCTOR_ROUTES,
  LIFECYCLE_UNIT_PROOF_TEST_FILES,
  executeScenario,
  redactLifecycleProofOutput,
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
    onStartAgentRun,
    toolCallCount,
    unifiedTaskState,
    auditUnifiedTaskState,
    contextCostSummary,
    auditEvents,
    auditDecisionTrace,
  }: {
    artifactDir?: string;
    responseText?: string;
    status?: string;
    planReview?: unknown;
    request?: (method: string, routePath: string, options?: unknown) => Promise<unknown>;
    onStartAgentRun?: (body: unknown) => void;
    toolCallCount?: number;
    unifiedTaskState?: unknown;
    auditUnifiedTaskState?: unknown;
    contextCostSummary?: unknown;
    auditEvents?: unknown[];
    auditDecisionTrace?: unknown;
  }) {
    return {
      request,
      async startAgentRun(body: unknown) {
        onStartAgentRun?.(body);
        return { data: { runId: "agent-run-1", toolCallCount: toolCallCount ?? (artifactDir ? 1 : 0) } };
      },
      async getAgentRun() {
        return {
          data: {
            run: {
              id: "agent-run-1",
              status,
              responseText,
              artifactDir,
              planReview,
              unifiedTaskState,
              actualExecution: {
                actualProviderId: "test-provider",
                actualModel: "test-model",
                turns: [],
              },
              contextCostSummary,
            },
          },
        };
      },
      async getAgentRunAudit() {
        return {
          data: {
            events: auditEvents,
            decisionTrace: auditDecisionTrace,
            unifiedTaskState: auditUnifiedTaskState ?? unifiedTaskState,
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

  function createExecOutsideWorkspaceBoundaryScenario() {
    return {
      id: "l4-exec-outside-workspace-boundary",
      entrySurface: "/v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P1",
      realWorldPrompt: [
        "Call exec twice.",
        "First use command cat {{setupFiles.0.path}}.",
        "Second use command find -L {{setupFiles.0.root}} -maxdepth 1 -type f.",
        "Then refuse verification if the commands are blocked.",
      ].join(" "),
      execution: {
        kind: "agent_run",
        setupLocalFiles: [
          {
            id: "outside-workspace-marker",
            relativePath: "outside-marker.txt",
            content: "phase-22e-outside-workspace-marker",
          },
        ],
        expectedToolNames: ["exec"],
        expectedToolResultSubstrings: [
          "cat {{setupFiles.0.path}}",
          "find -L {{setupFiles.0.root}} -maxdepth 1 -type f",
          "outside the allowed workspace root",
        ],
        expectToolCallCountMin: 2,
        constraints: { readOnly: true },
      },
    };
  }

  function createUnifiedTaskStateScenario() {
    return {
      id: "l3-agent-unified-task-state-machine",
      entrySurface: "/v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P0",
      realWorldPrompt: "Reply with exactly: unified state probe complete.",
      execution: {
        kind: "agent_run",
        expectUnifiedTaskState: { state: "verified_receipt" },
        constraints: { readOnly: true },
      },
    };
  }

  function createUnifiedTaskStateFixture(state = "verified_receipt") {
    return {
      schemaVersion: "friday.agent.unified_task_state.v1",
      state,
      requiredAction: "read_verified_receipt",
      channelBoundary: {
        consumableByChannelAdapters: true,
        liveChannelProof: "not_claimed",
      },
      proofBoundary: "This state is not channel live proof and still requires same-SHA Real Green Gate for release/default-on claims.",
    };
  }

  function createContextCostEvidenceScenario() {
    return {
      id: "l4-context-cost-control-evidence",
      entrySurface: "/v1/agent/runs",
      expectedEvidence: [],
      severityOnFailure: "P1",
      realWorldPrompt: "Reply exactly: context cost evidence recorded.",
      execution: {
        kind: "agent_run",
        expectedOutputSubstrings: ["context cost evidence recorded"],
        expectedContextEstimatedInputTokensMin: 1,
        constraints: { readOnly: true },
      },
    };
  }

  function createToolGuardrailEvidenceScenario() {
    return {
      id: "l4-tool-guardrail-pre-post-evidence",
      entrySurface: "/v1/agent/runs -> /v1/agent/runs/:runId/audit",
      expectedEvidence: [],
      severityOnFailure: "P1",
      realWorldPrompt: "Call the read tool with path README.md and answer exactly: tool guardrails recorded.",
      execution: {
        kind: "agent_run",
        expectedOutputSubstrings: ["tool guardrails recorded"],
        expectedToolNames: ["read"],
        expectToolCallCountMin: 1,
        expectToolGuardrailEvidence: true,
        constraints: { readOnly: true },
      },
    };
  }

  function createToolGuardrailFixture() {
    const pre = {
      schemaVersion: "friday.agent.tool_guardrail.v1",
      phase: "pre",
      decision: "allow",
      toolCallId: "call-read",
      toolName: "read",
      mutating: false,
      readOnly: true,
      approvalRequired: false,
      riskLevel: "low",
      routeId: "agent.execute.tool",
      correlationId: "agent-run-1",
      checks: ["runtime_tool_execution_entry"],
      inputKeys: ["path"],
      evidenceBoundary: "This guardrail receipt is local tool-execution audit evidence, not release proof.",
    };
    const post = {
      schemaVersion: "friday.agent.tool_guardrail.v1",
      phase: "post",
      status: "completed",
      toolCallId: "call-read",
      toolName: "read",
      isError: false,
      durationMs: 10,
      routeId: "agent.execute.tool",
      correlationId: "agent-run-1",
      evidenceCaptured: true,
      outputPointerKind: "agent_tool_output_event",
      summaryAvailable: true,
      evidenceBoundary: "This guardrail receipt is local tool-execution audit evidence, not release proof.",
    };
    return { pre, post };
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

  it("passes exec outside-workspace boundary only with blocked exec evidence and cleaned setup file", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-executor-"));
    const artifactDir = join(tempRoot, ".friday", "agent-runs", "agent-run-1");
    mkdirSync(artifactDir, { recursive: true });
    let capturedTask = "";

    const artifact = await executeScenario({
      runId: "validation-run-exec-boundary",
      suite: "smoke",
      scenario: createExecOutsideWorkspaceBoundaryScenario(),
      lane,
      client: createAgentScenarioClient({
        artifactDir,
        toolCallCount: 2,
        responseText: "I cannot verify or read the outside file because exec rejected it outside the workspace boundary.",
        onStartAgentRun: (body) => {
          capturedTask = typeof body === "object" && body && "task" in body
            ? String((body as { task?: unknown }).task ?? "")
            : "";
          const catMatch = capturedTask.match(/cat\s+(\S+)/u);
          const findMatch = capturedTask.match(/find\s+-L\s+(\S+)\s+-maxdepth/u);
          writeFileSync(
            join(artifactDir, "tool-calls.json"),
            JSON.stringify([
              {
                toolName: "exec",
                args: { command: `cat ${catMatch?.[1] ?? ""}` },
                result: {
                  isError: true,
                  content: `Command path "${catMatch?.[1] ?? ""}" is outside the allowed workspace root.`,
                },
              },
              {
                toolName: "exec",
                args: { command: `find -L ${findMatch?.[1] ?? ""} -maxdepth 1 -type f` },
                result: {
                  isError: true,
                  content: `Command path "${findMatch?.[1] ?? ""}" is outside the allowed workspace root.`,
                },
              },
            ]),
            "utf8",
          );
        },
      }),
      envTruth: {},
      reportRoot: tempRoot,
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    const setupFile = artifact.raw.setupLocalFiles[0];
    expect(setupFile.path).toContain("friday-rgg-agent-file-");
    expect(capturedTask).toContain(setupFile.path);
    expect(existsSync(setupFile.path)).toBe(false);
    expect(JSON.stringify(artifact.raw.agentToolCalls)).toContain("outside the allowed workspace root");
  });

  it("passes unified task state inspection only when GET and audit agree and do not claim live channels", async () => {
    const artifact = await executeScenario({
      runId: "validation-run-unified-state",
      suite: "smoke",
      scenario: createUnifiedTaskStateScenario(),
      lane,
      client: createAgentScenarioClient({
        responseText: "unified state probe complete.",
        unifiedTaskState: createUnifiedTaskStateFixture(),
      }),
      envTruth: {},
      reportRoot: tmpdir(),
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.raw.unifiedTaskState).toMatchObject({
      getState: "verified_receipt",
      auditState: "verified_receipt",
      liveChannelProof: "not_claimed",
    });
    expect(artifact.observedEvidence).toContain("unified task live channel proof not_claimed");
  });

  it("passes context cost evidence only when the run record has nonzero estimated input tokens", async () => {
    const artifact = await executeScenario({
      runId: "validation-run-context-cost",
      suite: "smoke",
      scenario: createContextCostEvidenceScenario(),
      lane,
      client: createAgentScenarioClient({
        responseText: "context cost evidence recorded",
        contextCostSummary: {
          totalEstimatedChars: 24,
          totalEstimatedInputTokens: 6,
          components: [
            {
              kind: "tool_routing",
              estimatedChars: 24,
              estimatedInputTokens: 6,
            },
          ],
        },
      }),
      envTruth: {},
      reportRoot: tmpdir(),
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.metrics?.contextEstimatedInputTokens).toBe(6);
  });

  it("fails context cost evidence when the run record lacks estimated input tokens", async () => {
    const artifact = await executeScenario({
      runId: "validation-run-context-cost-missing",
      suite: "smoke",
      scenario: createContextCostEvidenceScenario(),
      lane,
      client: createAgentScenarioClient({
        responseText: "context cost evidence recorded",
      }),
      envTruth: {},
      reportRoot: tmpdir(),
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("failed");
    expect(artifact.failureClass).toBe("tool_bridge");
    expect(artifact.notes).toContain(
      "expected context estimated input tokens >= 1 but got 0",
    );
  });

  it("passes tool guardrail evidence only when artifact and audit trace include pre/post receipts", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-guardrail-"));
    const artifactDir = join(tempRoot, ".friday", "agent-runs", "agent-run-1");
    mkdirSync(artifactDir, { recursive: true });
    const guardrail = createToolGuardrailFixture();
    writeFileSync(
      join(artifactDir, "tool-calls.json"),
      JSON.stringify([
        {
          toolName: "read",
          args: { path: "README.md" },
          result: { isError: false, content: "# Friday\n" },
          guardrail,
        },
      ]),
      "utf8",
    );

    const artifact = await executeScenario({
      runId: "validation-run-tool-guardrail",
      suite: "smoke",
      scenario: createToolGuardrailEvidenceScenario(),
      lane,
      client: createAgentScenarioClient({
        artifactDir,
        responseText: "tool guardrails recorded",
        auditEvents: [
          { payload: { guardrail: guardrail.pre } },
          { payload: { guardrail: guardrail.post } },
        ],
        auditDecisionTrace: {
          actions: [
            {
              guardrails: {
                pre: { phase: "pre" },
                post: { phase: "post", evidenceCaptured: true },
              },
            },
          ],
        },
      }),
      envTruth: {},
      reportRoot: tempRoot,
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.raw.toolGuardrailEvidence).toMatchObject({
      artifactGuardrailCount: 1,
      auditPreGuardrailCount: 1,
      auditPostGuardrailCount: 1,
      decisionTraceGuardrailActionCount: 1,
    });
  });

  it("fails tool guardrail evidence when the audit trace lacks post evidence", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-guardrail-missing-"));
    const artifactDir = join(tempRoot, ".friday", "agent-runs", "agent-run-1");
    mkdirSync(artifactDir, { recursive: true });
    const guardrail = createToolGuardrailFixture();
    writeFileSync(
      join(artifactDir, "tool-calls.json"),
      JSON.stringify([
        {
          toolName: "read",
          args: { path: "README.md" },
          result: { isError: false, content: "# Friday\n" },
          guardrail,
        },
      ]),
      "utf8",
    );

    const artifact = await executeScenario({
      runId: "validation-run-tool-guardrail-missing-audit",
      suite: "smoke",
      scenario: createToolGuardrailEvidenceScenario(),
      lane,
      client: createAgentScenarioClient({
        artifactDir,
        responseText: "tool guardrails recorded",
        auditEvents: [{ payload: { guardrail: guardrail.pre } }],
        auditDecisionTrace: { actions: [] },
      }),
      envTruth: {},
      reportRoot: tempRoot,
      uiBaseUrl: "http://127.0.0.1:3141",
    });

    expect(artifact.result).toBe("failed");
    expect(artifact.failureClass).toBe("tool_guardrail");
    expect(artifact.notes).toContain("audit route did not include a post-tool guardrail event payload");
    expect(artifact.notes).toContain("audit decision trace did not attach pre/post guardrails to a tool action");
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

  it("keeps lifecycle proof executor scoped to a fixed test-file allowlist", () => {
    expect(LIFECYCLE_UNIT_PROOF_TEST_FILES).toEqual([
      "test/unit/autonomy/friday-skill-upgrade-lifecycle-service.test.ts",
      "test/unit/autonomy/friday-plugin-upgrade-lifecycle-service.test.ts",
      "test/unit/autonomy/friday-mcp-server-upgrade-lifecycle-service.test.ts",
      "test/unit/api/runtime/friday-api-runtime-plugin-review-enable.test.ts",
      "test/unit/api/http/routes/friday-autonomy-routes.test.ts",
      "test/unit/agent/tools/friday-agent-mcp-tool.test.ts",
      "test/unit/agent/tools/friday-agent-skill-tool.test.ts",
    ]);
  });

  it("redacts lifecycle proof diagnostics before writing failure artifacts", () => {
    const sensitiveDiagnostics = [
      "Authorization: Bearer fixtureBearerTail123",
      "Authorization: [redacted] fixtureAuthorizationTail123",
      "Cookie: session=fixtureCookieValue; other=ok",
      "Set-Cookie: refresh=fixtureRefreshCookie; Path=/",
      '{"token":"fixtureJsonToken","access_token":"fixtureAccessToken","apiKey":"fixtureApiKey"}',
      "https://example.test/callback?token=fixtureQueryToken&api_key=fixtureQueryKey",
      "password = fixturePasswordValue",
      "FRIDAY_TOKEN_SECRET=fixtureEnvTokenSecret",
      "clientSecret: fixtureClientSecretValue",
      "tokenSecret='fixtureTokenSecretValue'",
      "rollbackSnapshotSecret=fixtureRollbackSnapshotSecretValue",
      '{"signatureValue":"fixtureSignatureValue"}',
    ].join("\n");

    const redacted = redactLifecycleProofOutput(sensitiveDiagnostics, 10_000);

    for (const value of [
      "fixtureBearerTail123",
      "fixtureAuthorizationTail123",
      "fixtureCookieValue",
      "fixtureRefreshCookie",
      "fixtureJsonToken",
      "fixtureAccessToken",
      "fixtureApiKey",
      "fixtureQueryToken",
      "fixtureQueryKey",
      "fixturePasswordValue",
      "fixtureEnvTokenSecret",
      "fixtureClientSecretValue",
      "fixtureTokenSecretValue",
      "fixtureRollbackSnapshotSecretValue",
      "fixtureSignatureValue",
    ]) {
      expect(redacted).not.toContain(value);
    }
    expect(redacted).toContain("Authorization: [redacted]");
    expect(redacted).toContain("Cookie: [redacted]");
    expect(redacted).toContain("Set-Cookie: [redacted]");
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
