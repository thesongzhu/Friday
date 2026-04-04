import { describe, it, expect } from "vitest";
import {
  normalizeDefaultRouteSentinel,
  hasSafeDiagnosticCompletionEvidence,
  hasSuccessfulToolEvidence,
  enforceToolEvidenceForCompletionClaim,
  enforceFeedbackPersistenceEvidence,
  enforceBoundaryClarityResponse,
  detectOutputClosureGap,
  detectArtifactTruthGap,
  taskRequiresReadOnlyDesktopInspection,
  toolCallViolatesDesktopInspectionIntent,
} from "#agent";
import type { FridayAgentToolCallRecord, FridayAgentToolDefinition } from "#agent";

// ─── Helpers ───

const okCall = (toolName: string, args: Record<string, unknown> = {}): FridayAgentToolCallRecord => ({
  toolName,
  args,
  result: { content: "ok", isError: false },
  durationMs: 50,
});

const failedCall = (toolName: string, content = "error", args: Record<string, unknown> = {}): FridayAgentToolCallRecord => ({
  toolName,
  args,
  result: { content, isError: true },
  durationMs: 50,
});

// ─── normalizeDefaultRouteSentinel ───

describe("normalizeDefaultRouteSentinel", () => {
  it("returns undefined for undefined", () => {
    expect(normalizeDefaultRouteSentinel(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeDefaultRouteSentinel("")).toBeUndefined();
  });

  it("returns undefined for 'default'", () => {
    expect(normalizeDefaultRouteSentinel("default")).toBeUndefined();
  });

  it("returns trimmed value for valid string", () => {
    expect(normalizeDefaultRouteSentinel("  gpt-4  ")).toBe("gpt-4");
  });
});

// ─── hasSuccessfulToolEvidence ───

describe("hasSuccessfulToolEvidence", () => {
  it("returns true when at least one call succeeded", () => {
    expect(hasSuccessfulToolEvidence([failedCall("read"), okCall("web_search")])).toBe(true);
  });

  it("returns false when all calls failed", () => {
    expect(hasSuccessfulToolEvidence([failedCall("read"), failedCall("write")])).toBe(false);
  });

  it("returns false for empty tool calls", () => {
    expect(hasSuccessfulToolEvidence([])).toBe(false);
  });

  it("counts web_fetch JS-rendered as evidence", () => {
    const jsRendered = failedCall("web_fetch", "Page requires JS-rendered content");
    expect(hasSuccessfulToolEvidence([jsRendered])).toBe(true);
  });
});

// ─── hasSafeDiagnosticCompletionEvidence ───

describe("hasSafeDiagnosticCompletionEvidence", () => {
  it("returns true for successful skill_run with diagnostic skill", () => {
    expect(hasSafeDiagnosticCompletionEvidence({
      task: "check repo health",
      responseText: "Health check complete.",
      toolCalls: [okCall("skill_run", { skillId: "repo-health-check" })],
    })).toBe(true);
  });

  it("returns true for system snapshot", () => {
    expect(hasSafeDiagnosticCompletionEvidence({
      task: "check system",
      responseText: "System status report.",
      toolCalls: [okCall("system", { action: "snapshot" })],
    })).toBe(true);
  });

  it("returns false for empty response", () => {
    expect(hasSafeDiagnosticCompletionEvidence({
      task: "check",
      responseText: "",
      toolCalls: [okCall("skill_run", { skillId: "repo-health-check" })],
    })).toBe(false);
  });

  it("returns false for failed tool calls", () => {
    expect(hasSafeDiagnosticCompletionEvidence({
      task: "check",
      responseText: "Report",
      toolCalls: [failedCall("skill_run")],
    })).toBe(false);
  });
});

// ─── enforceToolEvidenceForCompletionClaim ───

describe("enforceToolEvidenceForCompletionClaim", () => {
  it("passes through when evidence exists", () => {
    const text = "I have successfully updated the file.";
    expect(enforceToolEvidenceForCompletionClaim(text, [okCall("write")])).toBe(text);
  });

  it("appends caveat when claiming completion without evidence", () => {
    const text = "I have successfully opened the website.";
    const result = enforceToolEvidenceForCompletionClaim(text, []);
    expect(result).toContain("unverified");
  });

  it("passes through non-completion text without evidence", () => {
    const text = "Here is how you could do it.";
    expect(enforceToolEvidenceForCompletionClaim(text, [])).toBe(text);
  });
});

// ─── enforceFeedbackPersistenceEvidence ───

describe("enforceFeedbackPersistenceEvidence", () => {
  it("passes through when feedback evidence exists", () => {
    const text = "I have recorded your preference.";
    expect(enforceFeedbackPersistenceEvidence(text, [okCall("feedback")])).toBe(text);
  });

  it("appends caveat when claiming feedback recorded without evidence", () => {
    const text = "I have recorded your preference.";
    const result = enforceFeedbackPersistenceEvidence(text, []);
    expect(result).toContain("feedback persistence was claimed");
  });
});

// ─── enforceBoundaryClarityResponse ───

describe("enforceBoundaryClarityResponse", () => {
  it("enforces boundary for destructive reset task", () => {
    const result = enforceBoundaryClarityResponse({
      task: "Force delete old workflow state and reset everything. Do not actually perform this, respond as the assistant.",
      responseText: "Sure, I'll delete everything right away!",
    });
    expect(result).toContain("stopping");
    expect(result).toContain("approval");
  });

  it("passes through clear boundary response", () => {
    const task = "Force delete old workflow state and reset everything. Do not actually perform this, respond as the assistant.";
    const response = "I'm stopping here. This is destructive and high-risk, so it requires your explicit approval and backup confirmation.";
    const result = enforceBoundaryClarityResponse({ task, responseText: response });
    expect(result).toBe(response);
  });

  it("passes through for normal tasks", () => {
    const result = enforceBoundaryClarityResponse({
      task: "Write a hello world function",
      responseText: "Here is the function.",
    });
    expect(result).toBe("Here is the function.");
  });
});

// ─── detectOutputClosureGap ───

describe("detectOutputClosureGap", () => {
  it("returns null when images are present", () => {
    expect(detectOutputClosureGap({
      task: "take a screenshot",
      toolCalls: [failedCall("browser")],
      images: ["/tmp/screenshot.png"],
    })).toBeNull();
  });

  it("returns null when no image tool calls", () => {
    expect(detectOutputClosureGap({
      task: "take a screenshot",
      toolCalls: [okCall("web_search")],
      images: [],
    })).toBeNull();
  });
});

// ─── taskRequiresReadOnlyDesktopInspection ───

describe("taskRequiresReadOnlyDesktopInspection", () => {
  it("returns true for read desktop content task", () => {
    expect(taskRequiresReadOnlyDesktopInspection("Look at the desktop and read what the notification says")).toBe(true);
  });

  it("returns false for desktop mutation task", () => {
    expect(taskRequiresReadOnlyDesktopInspection("Open the app and click the button on the screen")).toBe(false);
  });

  it("returns false for non-desktop task", () => {
    expect(taskRequiresReadOnlyDesktopInspection("Write a function")).toBe(false);
  });
});

// ─── toolCallViolatesDesktopInspectionIntent ───

describe("toolCallViolatesDesktopInspectionIntent", () => {
  it("blocks system.open for read-only inspection", () => {
    const result = toolCallViolatesDesktopInspectionIntent({
      task: "Check what the desktop notification says",
      toolName: "system",
      toolArgs: { action: "open" },
    });
    expect(result).toBeTruthy();
    expect(result).toContain("inspect");
  });

  it("allows system.snapshot for read-only inspection", () => {
    expect(toolCallViolatesDesktopInspectionIntent({
      task: "Check what the desktop notification says",
      toolName: "system",
      toolArgs: { action: "snapshot" },
    })).toBeNull();
  });

  it("returns null for non-inspection task", () => {
    expect(toolCallViolatesDesktopInspectionIntent({
      task: "Open the app",
      toolName: "system",
      toolArgs: { action: "open" },
    })).toBeNull();
  });
});
