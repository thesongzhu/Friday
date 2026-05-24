import { describe, expect, it } from "vitest";

import { buildFridayAgentSystemPrompt } from "#agent";

describe("buildFridayAgentSystemPrompt", () => {
  it("builds a compact minimal prompt without tool strategy or workspace sections", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["web_search", "browser", "desktop"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      promptProfile: "minimal",
      workspaceContext: "SHOULD_NOT_APPEAR",
      starterSkills: [
        {
          skillId: "heavy-skill",
          purpose: "A verbose skill that should not be listed",
          triggerPhrases: ["heavy"],
        },
      ],
      currentTime: {
        nowIso: "2026-02-19T10:00:00.000Z",
        timezone: "America/Los_Angeles",
        localDate: "2026-02-19",
      },
    });

    expect(prompt).toContain("lightweight simple-chat route");
    expect(prompt).toContain("Current date: 2026-02-19 (America/Los_Angeles).");
    expect(prompt).not.toContain("Tool selection strategy");
    expect(prompt).not.toContain("Behavior rules");
    expect(prompt).not.toContain("SHOULD_NOT_APPEAR");
    expect(prompt).not.toContain("heavy-skill");
    expect(prompt.length).toBeLessThan(1200);
  });

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

  it("does not list MCP as an available tool when runtime capabilities mark MCP disabled", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec", "read", "mcp"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      runtimeCapabilities: {
        mcpEnabled: false,
        mcpServerCount: 0,
      },
    });

    expect(prompt).not.toContain("Tools: exec, read, mcp");
    expect(prompt).toContain("Tools: exec, read");
    expect(prompt).toContain("MCP is not enabled in this deployment.");
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

  it("routes local workspace file reads to the read tool before web lookup", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["read", "web_search", "web_fetch"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("Local workspace files, repository paths, or filesystem reads");
    expect(prompt).toContain("use read first for file contents");
    expect(prompt).toContain("do not use web_search or web_fetch for workspace files");
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
    expect(prompt).toContain("start with a hard stop");
    expect(prompt).toContain("exact targets plus backup handling");
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
    expect(prompt).toContain("low-risk retries/reversible fixes may auto-run");
    expect(prompt).toContain("verification and rollback gates remain mandatory");
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

  it("injects the User Constitution into the full agent prompt", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["read", "exec", "memory_search"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("[User Constitution / Skeptical Mode]");
    expect(prompt).toContain("Ask the smallest useful clarifying question");
    expect(prompt).toContain("Challenge requests that appear risky");
    expect(prompt).toContain("must not write memory, weaken approval gates");
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

  it("only exposes hard starter-skill routing requirements when the rollout flag is enabled", () => {
    const disabledPrompt = buildFridayAgentSystemPrompt({
      toolNames: ["read", "skill_run", "skills_list"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      starterSkills: [
        {
          skillId: "workspace-diff-review",
          purpose: "Review risky changes",
          triggerPhrases: ["review this diff"],
          tags: ["starter", "starter.devops"],
        },
      ],
    });
    const enabledPrompt = buildFridayAgentSystemPrompt({
      toolNames: ["read", "skill_run", "skills_list"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      starterSkills: [
        {
          skillId: "workspace-diff-review",
          purpose: "Review risky changes",
          triggerPhrases: ["review this diff"],
          tags: ["starter", "starter.devops"],
        },
      ],
      enforceStarterSkillRouting: true,
    });

    expect(disabledPrompt).not.toContain("MUST call skills_list before replying directly");
    expect(enabledPrompt).toContain("MUST call skills_list before replying directly");
    expect(enabledPrompt).toContain("do not skip skills_list");
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

  it("tells the agent to discover deferred tools before claiming missing capability", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["web_search", "tool_search", "request_tool_pack"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      deferredToolHints: [
        {
          name: "provider",
          description: "Inspect configured model provider setup and routing.",
        },
      ],
    });

    expect(prompt).toContain("Additional tools available on demand");
    expect(prompt).toContain("provider: Inspect configured model provider setup and routing.");
    expect(prompt).toContain("use tool_search first");
    expect(prompt).toContain("Only say the capability is unavailable after the discovery result proves no match or the lifecycle gate denies it");
  });

  it("keeps conversation-only memory separate from durable memory writes", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["memory_search", "memory_store", "feedback"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("for this conversation only / this chat / the current thread");
    expect(prompt).toContain("transient session context, not durable memory persistence");
    expect(prompt).toContain("Do not call feedback or memory_store for that instruction");
    expect(prompt).toContain("A read-only run still may use the current conversation history");
  });

  it("B3 truth-labeling: memory_search recall instruction documents scope limits and forbids fabricated memory", () => {
    // Prior version of the prompt promised broad auto-recall ("proactively
    // search memory ... if relevant memories exist, incorporate them") which
    // overstated what memory_search actually does — the tool is scoped to the
    // current agent/session namespace and may return zero results even when a
    // match conceptually exists. This assertion locks the truthful framing
    // into the prompt so future edits cannot silently regress to the broad
    // promise.
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["memory_search", "memory_store", "feedback"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    // Positive: the call is still instructed
    expect(prompt).toContain("call memory_search to look up relevant items");
    // Positive: truthful scope qualifier
    expect(prompt).toContain("scoped to your current agent / session namespace");
    // Positive: explicit no-global-recall disclaimer
    expect(prompt).toContain("does NOT provide global cross-session recall");
    // Positive: fail-honest instruction
    expect(prompt).toContain("say so plainly rather than fabricating memory");
    // Negative: the prior overclaim phrasing must not be present
    expect(prompt).not.toContain("proactively search memory with memory_search. If relevant memories exist, incorporate them into your response.");
  });

  it("documents the configured execution communication style", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["capabilities", "setup_assistant", "web_search", "skill_generate"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("Execution communication style:");
    expect(prompt).toContain("Default to Chinese when the language is ambiguous");
    expect(prompt).toContain("patient private execution assistant");
    expect(prompt).toContain("Use first person for normal work updates");
    expect(prompt).toContain("Use \"Friday\" when explaining product capability boundaries");
    expect(prompt).toContain("Progress updates use smart frequency");
    expect(prompt).toContain("state the immediate check and why it matters");
    expect(prompt).toContain("Chinese replies should feel human, concise, and tidy");
    expect(prompt).toContain("avoid markdown-heavy formatting, emoji, decorative symbols");
  });

  it("locks failure, missing-capability, and completion replies to closed-loop wording", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["capabilities", "setup", "setup_assistant", "provider"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("give evidence first, then the conclusion");
    expect(prompt).toContain("include the failed step, the evidence or error, and the concrete next step");
    expect(prompt).toContain("describe the controlled capability-acquisition loop");
    expect(prompt).toContain("search for options, generate or install tools/skills, sandbox-test them, register verified capabilities");
    expect(prompt).toContain("third-party accounts, API keys, OAuth, payment, CAPTCHA");
    expect(prompt).toContain("what changed, what was verified, and what risk or out-of-scope item remains");
  });

  it("guards against stock ChatGPT-style task wording", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["exec"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });

    expect(prompt).toContain("Avoid stock acknowledgements");
    expect(prompt).toContain("当然可以");
    expect(prompt).toContain("没问题");
    expect(prompt).toContain("Avoid ChatGPT-template summaries");
    expect(prompt).toContain("customer-service tone");
    expect(prompt).toContain("marketing tone");
    expect(prompt).toContain("excessive apologies");
    expect(prompt).toContain("false certainty");
    expect(prompt).toContain("habitual closing offers");
  });

  it("describes cron, subagents, skill catalog, and self-learning truthfully", () => {
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: ["cron", "spawn_subagent", "feedback"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      runtimeCapabilities: {
        cronEnabled: false,
        subagentsEnabled: false,
        selfLearningEnabled: false,
      },
    });

    expect(prompt).toContain("Scheduled tasks are not enabled in this deployment.");
    expect(prompt).toContain("Sub-agents are not enabled in this deployment.");
    expect(prompt).toContain("Skill catalog: execute bundled, generated, and local skills");
    expect(prompt).toContain("Self-learning feedback capture is not enabled in this deployment.");
  });

  it("only advertises subagent fork mode when the rollout flag is enabled", () => {
    const disabledPrompt = buildFridayAgentSystemPrompt({
      toolNames: ["spawn_subagent"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
    });
    const enabledPrompt = buildFridayAgentSystemPrompt({
      toolNames: ["spawn_subagent"],
      modelIdentity: "test-model (provider: test)",
      version: "0.0.0-test",
      subagentForkModeEnabled: true,
    });

    expect(disabledPrompt).not.toContain('mode="fork"');
    expect(enabledPrompt).toContain('mode="fork"');
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
