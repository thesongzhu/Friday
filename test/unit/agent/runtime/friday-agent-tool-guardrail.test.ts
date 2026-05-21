import { describe, expect, it } from "vitest";

import {
  buildFridayAgentToolPostGuardrailEvidence,
  buildFridayAgentToolPreGuardrailEvidence,
  FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION,
} from "#agent";

describe("friday-agent-tool-guardrail", () => {
  it("builds a sanitized pre-tool guardrail receipt without raw input values", () => {
    const guardrail = buildFridayAgentToolPreGuardrailEvidence({
      toolCallId: "call-1",
      toolName: "exec",
      toolInput: {
        command: "rm database.dump",
        path: "private-backup.dump",
        canonicalApproval: { secret: "do-not-leak" },
      },
      mutating: true,
      readOnly: false,
      approvalRequiredReason: "Deleting backup/dump/snapshot-like artifacts is destructive for private-backup.dump.",
      decision: "requires_approval",
      routeId: "agent.execute.tool.approval_required",
      correlationId: "run-1",
    });

    expect(guardrail.schemaVersion).toBe(FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION);
    expect(guardrail.phase).toBe("pre");
    expect(guardrail.decision).toBe("requires_approval");
    expect(guardrail.riskLevel).toBe("critical");
    expect(guardrail.inputKeys).toEqual(["command", "path"]);
    expect(JSON.stringify(guardrail)).not.toContain("do-not-leak");
    expect(JSON.stringify(guardrail)).not.toContain("private-backup.dump");
    expect(JSON.stringify(guardrail)).not.toContain("database.dump");
    expect(guardrail.evidenceBoundary).toContain("not release proof");
  });

  it("builds a post-tool guardrail receipt with evidence capture metadata", () => {
    const guardrail = buildFridayAgentToolPostGuardrailEvidence({
      toolCallId: "call-1",
      toolName: "read",
      durationMs: 12,
      isError: false,
      routeId: "agent.execute.tool",
      correlationId: "run-1",
      summary: "read README",
    });

    expect(guardrail).toMatchObject({
      schemaVersion: FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION,
      phase: "post",
      status: "completed",
      evidenceCaptured: true,
      outputPointerKind: "agent_tool_output_event",
      summaryAvailable: true,
    });
  });
});
