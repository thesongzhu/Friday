import { describe, expect, it } from "vitest";

import {
  classifyToolBatchDependencies,
  executeToolBatch,
} from "#agent";

describe("friday-agent-tool-batch-executor", () => {
  it("groups independent read tools together and separates conflicting writes", () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "read", input: { path: "/tmp/a.txt" } },
      { id: "2", name: "read", input: { path: "/tmp/b.txt" } },
      { id: "3", name: "write", input: { path: "/tmp/a.txt", content: "x" } },
      { id: "4", name: "read", input: { path: "/tmp/c.txt" } },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.tools.map((tool) => tool.id)).toEqual(["1", "2"]);
    expect(groups[1]?.tools.map((tool) => tool.id)).toEqual(["3", "4"]);
  });

  it("preserves original order in returned results", async () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "read", input: { path: "/tmp/a.txt" } },
      { id: "2", name: "read", input: { path: "/tmp/b.txt" } },
      { id: "3", name: "write", input: { path: "/tmp/a.txt", content: "x" } },
    ]);

    const results = await executeToolBatch(groups, async (toolUse) => ({
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result: {
        content: `ok:${toolUse.id}`,
      },
      durationMs: 1,
      startedAt: "2026-03-31T00:00:00.000Z",
    }));

    expect(results.map((result) => result.toolCallId)).toEqual(["1", "2", "3"]);
  });

  it("redacts canonical approval signatures from batch result args", async () => {
    const groups = [{
      tools: [
        {
          id: "1",
          name: "system",
          input: {
            action: "launch_app",
            canonicalApproval: {
              decision: "approved",
              approvalId: "approval-1",
              actionDigest: "digest-1",
              issuer: "friday_canonical_gate",
              signature: "signed-secret-ticket",
            },
          },
        },
        { id: "2", name: "read", input: { path: "/tmp/a.txt" } },
      ],
    }];

    const results = await executeToolBatch(groups, async (toolUse) => {
      if (toolUse.id === "1") {
        throw new Error("executor failed");
      }
      return {
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        args: toolUse.input,
        result: { content: "ok" },
        durationMs: 1,
        startedAt: "2026-03-31T00:00:00.000Z",
      };
    });

    expect(results[0]?.args).toMatchObject({
      canonicalApproval: {
        redacted: true,
        decision: "approved",
        approvalId: "approval-1",
        actionDigest: "digest-1",
        issuer: "friday_canonical_gate",
      },
    });
    expect(JSON.stringify(results)).not.toContain("signed-secret-ticket");
    expect(JSON.stringify(results)).not.toContain("signature");
  });

  it("redacts canonical approval signatures from single-tool batch result args", async () => {
    const results = await executeToolBatch(
      [{
        tools: [{
          id: "1",
          name: "system",
          input: {
            action: "launch_app",
            canonicalApproval: {
              decision: "approved",
              approvalId: "approval-1",
              actionDigest: "digest-1",
              issuer: "friday_canonical_gate",
              signature: "single-tool-secret-ticket",
            },
          },
        }],
      }],
      async (toolUse) => ({
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        args: toolUse.input,
        result: { content: "ok" },
        durationMs: 1,
        startedAt: "2026-03-31T00:00:00.000Z",
      }),
    );

    expect(results[0]?.args).toMatchObject({
      canonicalApproval: {
        redacted: true,
        approvalId: "approval-1",
        actionDigest: "digest-1",
      },
    });
    expect(JSON.stringify(results)).not.toContain("single-tool-secret-ticket");
    expect(JSON.stringify(results)).not.toContain("signature");
  });
});
