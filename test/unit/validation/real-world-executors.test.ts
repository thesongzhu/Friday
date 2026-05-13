import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeScenario } from "../../../validation/real-world/lib/executors.mjs";

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
});
