import { describe, expect, it } from "vitest";

import { buildToolErrorRecoveryHint } from "../../../../src/agent/runtime/friday-agent-tool-error-recovery.js";

describe("buildToolErrorRecoveryHint", () => {
  it("steers generator aliases away from skill_run and toward skill_generate", () => {
    const hint = buildToolErrorRecoveryHint([
      {
        toolName: "skill_run",
        errorContent: "Skill 'skill_generate' failed: Skill 'skill_generate' not found in registry",
        args: {
          skillId: "skill_generate",
        },
      },
    ]);

    expect(hint?.text).toContain("skill_generate");
    expect(hint?.text).toContain("action=\"start\"");
    expect(hint?.text).toContain("Do NOT tell the user the skill generator is unavailable");
  });

  it("asks to re-check the registry for ordinary missing skill ids", () => {
    const hint = buildToolErrorRecoveryHint([
      {
        toolName: "skill_run",
        errorContent: "Skill 'weekly-review' failed: Skill 'weekly-review' not found in registry",
        args: {
          skillId: "weekly-review",
        },
      },
    ]);

    expect(hint?.text).toContain("verify the installed skill ID");
    expect(hint?.text).not.toContain("action=\"start\"");
  });

  it("forces skill_run retries to include missing required inputs", () => {
    const hint = buildToolErrorRecoveryHint([
      {
        toolName: "skill_run",
        errorContent: "Skill 'blind-skill' missing required input(s): topic. Provide input like {\"topic\":\"<topic>\"}.",
        args: {
          skillId: "blind-skill",
        },
      },
    ]);

    expect(hint?.text).toContain("required input fields");
    expect(hint?.text).toContain("key=\"value\"");
    expect(hint?.text).toContain("non-empty input object");
  });

  it("forces wrong-tool autonomous bypasses back onto the autonomous tool", () => {
    const hint = buildToolErrorRecoveryHint([
      {
        toolName: "system",
        errorContent: "This task explicitly requires tool 'autonomous'. Do not use 'system' as a direct bypass. Call autonomous with action=\"execute_goal\" first, then rely on autonomous goal status/result instead of direct browser/desktop/exec/file/system tools.",
        args: {
          action: "open_url",
          url: "https://example.com",
        },
      },
    ]);

    expect(hint?.text).toContain("\"autonomous\" tool");
    expect(hint?.text).toContain("action=\"execute_goal\"");
    expect(hint?.text).toContain("Only report success after autonomous returns goal/result evidence");
  });
});
