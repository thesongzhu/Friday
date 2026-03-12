import { describe, expect, it } from "vitest";

import { buildFridayAgentSystemPrompt } from "#agent";

describe("buildFridayAgentSystemPrompt", () => {
  it("describes desktop capability truthfully based on registered tools", () => {
    const withDesktop = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "desktop"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });
    expect(withDesktop).toContain("Desktop control (mouse, keyboard, screen capture)");
    expect(withDesktop).not.toContain("Desktop control is available only when the desktop runtime is enabled");

    const withoutDesktop = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });
    expect(withoutDesktop).toContain(
      "Desktop control is available only when the desktop runtime is enabled in this deployment.",
    );
  });

  it("describes system orchestration capability truthfully based on registered tools", () => {
    const withSystem = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "system"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });
    expect(withSystem).toContain("Agent OS system orchestration");
    expect(withSystem).toContain(
      "Local computer orchestration: use system first for snapshots, app/project handoff, approvals, and control leases",
    );

    const withoutSystem = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });
    expect(withoutSystem).toContain("Agent OS system orchestration is not enabled in this deployment.");
  });

  it("does not claim full-filesystem file access", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "write", "edit"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("File read/write/edit within the configured workspace sandbox");
    expect(prompt).not.toContain("File read/write/edit across the entire filesystem");
  });

  it("documents supervised autonomy and destructive approval gates", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "write", "edit", "system"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("Friday uses supervised autonomy, not unrestricted autonomy.");
    expect(prompt).toContain("High-risk or destructive actions require an approval gate");
    expect(prompt).toContain("deleting files or dumps, rotating credentials or API tokens");
    expect(prompt).toContain("write a decision or plan artifact instead of performing the destructive change");
  });

  it("documents destructive reset boundary language", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "write", "edit", "system"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("reset, force delete, or immediate destructive cleanup");
    expect(prompt).toContain("destructive/high-risk");
    expect(prompt).toContain("approval or confirmation");
    expect(prompt).toContain("backups");
  });

  it("documents minimal clarification and artifact honesty rules", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "write", "edit"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("ask the smallest decisive set of follow-up questions");
    expect(prompt).toContain("Include retention or quantity details when they materially affect the task.");
    expect(prompt).toContain("Never claim a blocker, decision, or artifact was recorded unless the file you wrote actually contains that information.");
  });

  it("documents artifact content and blocker quality rules", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "write", "edit"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("carry forward the real source content or a faithful summary");
    expect(prompt).toContain("Do not write placeholders like 'Contents of X'");
    expect(prompt).toContain("clearly labeled blocker section");
  });
});
