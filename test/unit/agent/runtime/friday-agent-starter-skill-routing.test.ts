import { describe, expect, it } from "vitest";

import {
  buildFridayStarterSkillRoutingRetryPrompt,
  findFridayStarterSkillRoutingCandidate,
  shouldBypassFridayStarterSkillRouting,
} from "#agent";

describe("friday-agent-starter-skill-routing", () => {
  const skills = [
    {
      skillId: "workspace-diff-review",
      purpose: "Review risky workspace changes",
      triggerPhrases: ["review this diff", "review workspace changes"],
      intents: ["workspace_diff_review"],
      tags: ["starter", "starter.devops"],
    },
    {
      skillId: "browser-qa-report",
      purpose: "QA a page without editing code",
      triggerPhrases: ["qa this page"],
      intents: ["browser_qa_report"],
      tags: ["starter", "starter.qa"],
    },
  ];

  it("finds a high-confidence starter skill when a trigger phrase matches", () => {
    const candidate = findFridayStarterSkillRoutingCandidate({
      task: "Please review this diff before I land it.",
      skills,
    });

    expect(candidate?.skillId).toBe("workspace-diff-review");
  });

  it("bypasses pure informational requests", () => {
    expect(shouldBypassFridayStarterSkillRouting("What does workspace-diff-review do?")).toBe(true);
    expect(findFridayStarterSkillRoutingCandidate({
      task: "What does workspace-diff-review do?",
      skills,
    })).toBeNull();
  });

  it("builds a retry prompt that forces skills_list before a direct answer", () => {
    const prompt = buildFridayStarterSkillRoutingRetryPrompt({
      task: "QA this page",
      candidate: skills[1]!,
    });

    expect(prompt).toContain("skills_list");
    expect(prompt).toContain("browser-qa-report");
    expect(prompt).toContain("qa this page");
  });
});
