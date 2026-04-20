import { describe, expect, it } from "vitest";

import {
  inferFridaySubagentProfile,
  resolveFridaySubagentProfile,
  taskLikelyNeedsWriteAccessForSubagent,
} from "#agent";

describe("Friday subagent profile helpers", () => {
  it("resolves plan profile with its default task profile", () => {
    const profile = resolveFridaySubagentProfile("plan");

    expect(profile).toMatchObject({
      id: "plan",
      taskProfile: "planning",
      readOnly: true,
      maxTurns: 4,
    });
  });

  it("infers review and debug profiles from task text", () => {
    expect(inferFridaySubagentProfile("review this diff for regressions")).toBe("review");
    expect(inferFridaySubagentProfile("debug this failing log pipeline")).toBe("debug");
  });

  it("treats explicit mutating tool instructions as execute work even when audit keywords appear", () => {
    const task = [
      "Persist and recall the marker below.",
      "Use memory_store exactly once with namespace: 'agent'.",
      "Tags: ['issue-00150', 'audit'].",
    ].join(" ");

    expect(inferFridaySubagentProfile(task)).toBe("execute");
    expect(taskLikelyNeedsWriteAccessForSubagent(task)).toBe(true);
  });

  it("keeps reconnaissance tasks read-only by default", () => {
    expect(taskLikelyNeedsWriteAccessForSubagent("Search for nodejs testing frameworks")).toBe(false);
    expect(taskLikelyNeedsWriteAccessForSubagent("Review the workflow diff and summarize risks")).toBe(false);
  });

  it("detects delegated tasks that need mutating tools", () => {
    expect(taskLikelyNeedsWriteAccessForSubagent("Write a file")).toBe(true);
    expect(taskLikelyNeedsWriteAccessForSubagent("Continue and fix the failing workflow generator tests")).toBe(true);
    expect(taskLikelyNeedsWriteAccessForSubagent("Open example.com and take a screenshot")).toBe(true);
    expect(taskLikelyNeedsWriteAccessForSubagent("Run the build command and deploy the app")).toBe(true);
  });

  it("allows automatic delegation to preserve the inferred profile while disabling readOnly", () => {
    const inferred = inferFridaySubagentProfile("Open example.com and take a screenshot");
    const resolved = resolveFridaySubagentProfile({
      id: inferred,
      readOnly: false,
      taskProfile: "deterministic",
    });

    expect(inferred).toBe("explore");
    expect(resolved.readOnly).toBe(false);
    expect(resolved.taskProfile).toBe("deterministic");
  });
});
