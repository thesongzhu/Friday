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

  // ─── Conflict-key canonicalization (RUN-RESOURCE-CONFLICT-001) ───
  // Two same-turn MUTATING writes that target the SAME underlying file via
  // different path spellings must be serialized into 2 groups. Without
  // canonicalization the raw strings hash to distinct keys → judged
  // non-conflicting → placed in one parallel group → lost/interleaved write.

  it("serializes two mutating writes on the same file spelled with a `.` segment", () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "write", input: { path: "/tmp/a.txt", content: "x" } },
      { id: "2", name: "write", input: { path: "/tmp/./a.txt", content: "y" } },
    ]);
    // TODAY (raw-key) returns 1 → real AssertionError "expected 1 to be 2".
    expect(groups).toHaveLength(2);
    expect(groups[0]?.tools.map((tool) => tool.id)).toEqual(["1"]);
    expect(groups[1]?.tools.map((tool) => tool.id)).toEqual(["2"]);
  });

  it("serializes two mutating writes on the same file with vs without a trailing slash", () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "write", input: { path: "/tmp/dir/", content: "x" } },
      { id: "2", name: "write", input: { path: "/tmp/dir", content: "y" } },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("serializes two mutating writes on the same file spelled with a `..` segment", () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "write", input: { path: "/tmp/x/../a.txt", content: "x" } },
      { id: "2", name: "write", input: { path: "/tmp/a.txt", content: "y" } },
    ]);
    expect(groups).toHaveLength(2);
  });

  // Darwin-only: the macOS filesystem is case-insensitive, so `/tmp/A.txt` and
  // `/tmp/a.txt` are the SAME file and two writes must be serialized. On Linux
  // (case-sensitive) they are DIFFERENT files, so this assertion is guarded.
  it.skipIf(process.platform !== "darwin")(
    "serializes two mutating writes that differ only by case on darwin",
    () => {
      const groups = classifyToolBatchDependencies([
        { id: "1", name: "write", input: { path: "/tmp/A.txt", content: "x" } },
        { id: "2", name: "write", input: { path: "/tmp/a.txt", content: "y" } },
      ]);
      expect(groups).toHaveLength(2);
    },
  );

  // Linux-only mirror: distinct-case paths are DISTINCT files on a
  // case-sensitive FS, so they must stay parallelizable (no over-serialization).
  it.skipIf(process.platform === "darwin")(
    "keeps case-distinct writes parallel on a case-sensitive filesystem",
    () => {
      const groups = classifyToolBatchDependencies([
        { id: "1", name: "write", input: { path: "/tmp/A.txt", content: "x" } },
        { id: "2", name: "write", input: { path: "/tmp/a.txt", content: "y" } },
      ]);
      expect(groups).toHaveLength(1);
    },
  );

  it("keeps genuinely distinct files parallel (no-degrade)", () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "write", input: { path: "/tmp/a.txt", content: "x" } },
      { id: "2", name: "write", input: { path: "/tmp/b.txt", content: "y" } },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tools.map((tool) => tool.id)).toEqual(["1", "2"]);
  });

  it("keeps non-mutating reads on the same canonical path in one group", () => {
    const groups = classifyToolBatchDependencies([
      { id: "1", name: "read", input: { path: "/tmp/a.txt" } },
      { id: "2", name: "read", input: { path: "/tmp/./a.txt" } },
    ]);
    expect(groups).toHaveLength(1);
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
