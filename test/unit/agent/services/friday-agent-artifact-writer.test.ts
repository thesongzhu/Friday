import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFridayAgentArtifactWriter } from "#agent";

describe("FridayAgentArtifactWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-artifact-writer-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeParams() {
    return {
      runId: "run-001",
      task: "Build a hello world script",
      status: "completed",
      response: "Here is the hello world script.",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "write",
          args: { path: "/tmp/hello.ts", content: "console.log('hello')" },
          result: { content: "Written" },
          durationMs: 100,
          startedAt: "2026-02-20T10:00:00.000Z",
        },
      ],
      testResults: [
        { strategy: "syntax" as const, passed: true, errors: [], durationMs: 50 },
      ],
      artifacts: [{ type: "file", path: "/tmp/hello.ts" }],
      durationMs: 5000,
      usageInput: 100,
      usageOutput: 50,
      costUsd: 0.01,
      completedAt: "2026-02-20T10:00:05.000Z",
    };
  }

  it("creates expected directory layout", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const result = writer.writeRunArtifacts(makeParams());

    const runDir = result.artifactDir;
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "tool-calls.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "test-results.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "response.md"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "artifacts.json"))).toBe(true);
  });

  it("run.json contains expected metadata", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const result = writer.writeRunArtifacts(makeParams());

    const runMeta = JSON.parse(fs.readFileSync(path.join(result.artifactDir, "run.json"), "utf-8"));
    expect(runMeta.runId).toBe("run-001");
    expect(runMeta.task).toBe("Build a hello world script");
    expect(runMeta.status).toBe("completed");
    expect(runMeta.durationMs).toBe(5000);
    expect(runMeta.costUsd).toBe(0.01);
    expect(runMeta.contextSelection).toBeNull();
  });

  it("writes contextSelection debug metadata when provided", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const result = writer.writeRunArtifacts({
      ...makeParams(),
      conversationContext: {
        turnKind: "follow_up",
        previousTopicSummary: "Desktop companion is not connected.",
        currentTopicSummary: "Desktop companion is not connected.",
        replyToMessageId: "discord-msg-2",
        selectedBlocks: [
          {
            id: "reply:msg-2",
            source: "reply_anchor",
            summary: "assistant: Desktop companion is not connected.",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-2"],
          },
        ],
        selectionReasons: ["reply anchor → msg-2"],
      },
    });

    const runMeta = JSON.parse(fs.readFileSync(path.join(result.artifactDir, "run.json"), "utf-8"));
    expect(runMeta.contextSelection).toEqual({
      turnKind: "follow_up",
      selectedBlocks: [
        {
          id: "reply:msg-2",
          source: "reply_anchor",
          summary: "assistant: Desktop companion is not connected.",
          score: 100,
          reason: "Explicit reply target matched a prior session message.",
          messageIds: ["msg-2"],
        },
      ],
      selectionReasons: ["reply anchor → msg-2"],
      replyToMessageId: "discord-msg-2",
    });
  });

  it("response.md contains response text", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const result = writer.writeRunArtifacts(makeParams());

    const response = fs.readFileSync(path.join(result.artifactDir, "response.md"), "utf-8");
    expect(response).toContain("Here is the hello world script.");
  });

  it("is idempotent — calling twice overwrites cleanly", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const params = makeParams();

    const result1 = writer.writeRunArtifacts(params);
    const result2 = writer.writeRunArtifacts(params);

    expect(result1.artifactDir).toBe(result2.artifactDir);
    // File should still exist and be valid
    const runMeta = JSON.parse(fs.readFileSync(path.join(result2.artifactDir, "run.json"), "utf-8"));
    expect(runMeta.runId).toBe("run-001");
  });

  it("returns enriched artifacts list", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const result = writer.writeRunArtifacts(makeParams());

    expect(result.artifacts.length).toBeGreaterThan(1);
    const runRecordArtifact = result.artifacts.find((a) => a.type === "run_record");
    expect(runRecordArtifact).toBeDefined();
    expect(runRecordArtifact?.path).toContain("run.json");
  });

  it("does not perform any git operations", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    writer.writeRunArtifacts(makeParams());

    // Verify no .git directory created
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(false);
  });

  it("artifact dir path follows expected pattern", () => {
    const writer = createFridayAgentArtifactWriter(tmpDir);
    const result = writer.writeRunArtifacts(makeParams());

    expect(result.artifactDir).toBe(path.join(tmpDir, ".friday", "agent-runs", "run-001"));
  });
});
