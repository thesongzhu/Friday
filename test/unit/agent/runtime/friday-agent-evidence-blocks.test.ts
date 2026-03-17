import { describe, expect, it } from "vitest";

import { buildFridayEvidenceBlocks } from "#agent";
import type {
  FridayAgentCapabilitiesSnapshot,
  FridayAgentTaskStatusSnapshot,
} from "#agent";
import type { FridaySessionConversationFocusState } from "#sessions";

describe("friday-agent-evidence-blocks", () => {
  const focusState: FridaySessionConversationFocusState = {
    currentTopicSummary: "Investigate why the GitHub browser task failed.",
    currentTopicFingerprint: "topic-1",
    currentTopicStartSequence: 1,
    lastAnsweredQuestion: "What happened to the GitHub task?",
    lastAssistantAskedQuestion: false,
    lastRunId: "run-1",
    activeRunId: "run-2",
    activeSubagentIds: ["sub-1"],
    pendingPlanRunId: "plan-1",
    updatedAt: "2026-03-17T10:00:00.000Z",
  };

  const capabilitiesSnapshot: FridayAgentCapabilitiesSnapshot = {
    readOnly: true,
    messaging: {
      enabled: true,
      kinds: ["discord"],
    },
    mcp: {
      enabled: false,
      serverCount: 0,
    },
    provider: {
      available: true,
      configuredCount: 2,
      mutationBlockedByReadOnly: true,
    },
    browser: {
      activeMode: "headless",
      targetBrowser: "Google Chrome",
    },
    system: {
      enabled: true,
    },
    desktop: {
      connected: false,
    },
    companion: {
      connected: true,
    },
  };

  const taskStatusSnapshot: FridayAgentTaskStatusSnapshot = {
    readOnly: true,
    sessionKey: "webchat:default:test",
    trackedRunId: "run-2",
    task: "Open GitHub and inspect the current page.",
    runStatus: "awaiting_plan_approval",
    phase: "planning",
    elapsedMs: 45_000,
    latestTool: "browser",
    activeSubagents: [
      {
        id: "sub-1",
        childRunId: "child-run-1",
        childSessionKey: "subagent:child-1",
        status: "running",
        task: "Open GitHub in the browser.",
        createdAt: "2026-03-17T10:00:00.000Z",
      },
    ],
    blockers: ["Awaiting plan approval for run plan-1."],
    pendingPlanRunId: "plan-1",
  };

  it("builds deterministic capability evidence for deployment fact questions", () => {
    const blocks = buildFridayEvidenceBlocks({
      task: "discord enabled? mcp enabled? and is provider mutation blocked by readOnly?",
      turnKind: "new_topic",
      capabilitiesSnapshot,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.source).toBe("capabilities_block");
    expect(blocks[0]?.summary).toContain("messaging enabled (discord)");
    expect(blocks[0]?.summary).toContain("MCP disabled");
    expect(blocks[0]?.summary).toContain("provider mutations blocked by readOnly");
    expect(blocks[0]?.summary).toContain("desktop disconnected");
  });

  it("builds status, planning, run-activity, and delegated-task evidence for status questions", () => {
    const blocks = buildFridayEvidenceBlocks({
      task: "What are you doing right now and what is the latest task result?",
      turnKind: "status_check",
      focusState,
      taskStatusSnapshot,
      capabilitiesSnapshot,
    });

    expect(blocks.some((block) => block.source === "task_status_block")).toBe(true);
    expect(blocks.some((block) => block.source === "run_event_block")).toBe(true);
    expect(blocks.some((block) => block.source === "delegated_task_block")).toBe(true);
    expect(blocks.some((block) => block.source === "plan_block")).toBe(true);
    expect(blocks.find((block) => block.source === "task_status_block")?.summary)
      .toContain("status awaiting_plan_approval");
    expect(blocks.find((block) => block.source === "run_event_block")?.summary)
      .toContain("latest tool browser");
    expect(blocks.find((block) => block.source === "delegated_task_block")?.summary)
      .toContain("subagent sub-1");
    expect(blocks.find((block) => block.source === "plan_block")?.summary)
      .toContain("pending plan run plan-1");
  });

  it("uses pending plan context instead of saying there is no tracked run", () => {
    const blocks = buildFridayEvidenceBlocks({
      task: "那个任务结果呢？",
      turnKind: "status_check",
      focusState: {
        ...focusState,
        activeRunId: undefined,
        lastRunId: undefined,
        pendingPlanRunId: "plan-2",
      },
      taskStatusSnapshot: {
        readOnly: false,
        sessionKey: "webchat:default:test",
        runStatus: "awaiting_clarification",
        blockers: ["Awaiting clarification for run plan-2."],
        pendingPlanRunId: "plan-2",
        activeSubagents: [],
      },
    });

    const taskStatus = blocks.find((block) => block.source === "task_status_block");
    expect(taskStatus?.summary).toContain("pending plan plan-2");
    expect(taskStatus?.summary).toContain("status awaiting_clarification");
    expect(taskStatus?.summary).not.toContain("no tracked run");

    const planning = blocks.find((block) => block.source === "plan_block");
    expect(planning?.summary).toContain("pending plan run plan-2");
    expect(planning?.summary).toContain("planning state awaiting_clarification");
  });
});
