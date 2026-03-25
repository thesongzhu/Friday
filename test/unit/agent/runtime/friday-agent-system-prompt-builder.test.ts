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

  it("documents starter skill discovery and usage guidance", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["read", "skill_run", "skills_list"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      starterSkills: [
        {
          skillId: "review-open-issues",
          purpose: "Inspect detected incidents and issue cards",
          triggerPhrases: ["review open issues"],
          tags: ["starter", "starter.diagnosis"],
        },
        {
          skillId: "repo-health-check",
          purpose: "Inspect repository state and suggest the next action",
          triggerPhrases: ["review repo health"],
          tags: ["starter", "starter.devops"],
        },
      ],
    });

    expect(prompt).toContain("use skills_list first");
    expect(prompt).toContain("prefer that existing skill over generating or importing a new one");
    expect(prompt).toContain("Available Diagnosis & Recovery Skills:");
    expect(prompt).toContain("review-open-issues");
    expect(prompt).toContain("Other Starter Skills:");
    expect(prompt).toContain("repo-health-check");
  });

  it("documents planning and QA starter-skill preference guidance", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["read", "skill_run", "skills_list"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("Planning, scope review, design review, browser QA, diff review, release docs, benchmark, canary, retro, QA-fix, and security review requests");
    expect(prompt).toContain("scoping, design review, implementation plan review, QAing a page, benchmarking, canary checks, retros, reviewing a diff, or syncing release docs");
  });

  it("describes messaging and MCP truthfully from runtime capabilities", () => {
    const withoutRuntimeSupport = buildFridayAgentSystemPrompt({
      toolNames: ["message", "mcp"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      runtimeCapabilities: {
        messagingEnabled: false,
        mcpEnabled: false,
      },
    });

    expect(withoutRuntimeSupport).toContain("Multi-channel messaging is not enabled in this deployment.");
    expect(withoutRuntimeSupport).toContain("MCP is not enabled in this deployment.");
    expect(withoutRuntimeSupport).toContain("Multi-channel messaging is unavailable in this deployment");

    const withRuntimeSupport = buildFridayAgentSystemPrompt({
      toolNames: ["message", "mcp"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      runtimeCapabilities: {
        messagingEnabled: true,
        messagingKinds: ["discord", "telegram"],
        mcpEnabled: true,
        mcpServerCount: 2,
      },
    });

    expect(withRuntimeSupport).toContain("Multi-channel messaging (discord, telegram)");
    expect(withRuntimeSupport).toContain("MCP: connect to external Model Context Protocol servers (2 configured)");
    expect(withRuntimeSupport).toContain("use capabilities first");
  });

  it("documents deterministic task status guidance", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["task_status", "spawn_subagent"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("use task_status first");
    expect(prompt).toContain("Default to delegation for non-trivial operational work");
    expect(prompt).toContain("use deterministic state from task_status or get_subagent instead of guessing");
    expect(prompt).toContain("generating/deploying/exporting workflows, architecture choices, large implementation plans");
    expect(prompt).toContain("treat approve/reject replies as control commands for that stored plan");
  });

  it("describes cron, subagents, marketplace, and self-learning truthfully", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["cron", "spawn_subagent", "feedback"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      runtimeCapabilities: {
        cronEnabled: false,
        subagentsEnabled: false,
        marketplaceEnabled: false,
        selfLearningEnabled: false,
      },
    });

    expect(prompt).toContain("Scheduled tasks are not enabled in this deployment.");
    expect(prompt).toContain("Sub-agents are not enabled in this deployment.");
    expect(prompt).toContain("Skill marketplace is not enabled in this deployment.");
    expect(prompt).toContain("Self-learning feedback capture is not enabled in this deployment.");
  });

  it("injects current time context and news timeliness rules", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["web_search", "web_fetch"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      currentTime: {
        nowIso: "2026-03-14T17:30:00.000Z",
        timezone: "America/Los_Angeles",
        localDate: "2026-03-14",
      },
    });

    expect(prompt).toContain("Current time context:");
    expect(prompt).toContain("nowIso: 2026-03-14T17:30:00.000Z");
    expect(prompt).toContain("timezone: America/Los_Angeles");
    expect(prompt).toContain("localDate: 2026-03-14");
    expect(prompt).toContain("absolute dates plus source URLs");
    expect(prompt).toContain("latestness is unverified");
  });
});
