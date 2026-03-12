import { describe, expect, it } from "vitest";
import type { FridayWorkflowOverview } from "@friday-operator-client";
import {
  buildWorkflowGuidedSteps,
  buildWorkflowHref,
  summarizeWorkflowAttention,
} from "../../../ui/src/lib/workflows/view-models";

function createOverview(
  overrides: Partial<FridayWorkflowOverview> = {},
): FridayWorkflowOverview {
  return {
    workflow: {
      id: "wf-1",
      slug: "weekly-report",
      name: "Weekly Report",
      state: "active",
    },
    drafts: [],
    recentRuns: [],
    latestRunNodeTimeline: [],
    latestEvidenceExports: [],
    versionHistory: [],
    ...overrides,
  };
}

describe("workflow view models", () => {
  it("builds deep links with workflow and focus context", () => {
    expect(buildWorkflowHref("wf-1", "recovery")).toBe("/workflows?workflowId=wf-1&focus=recovery");
  });

  it("prioritizes failed runs as the top workflow attention state", () => {
    const overview = createOverview({
      latestRun: {
        runId: "run-1",
        workflowVersionId: "ver-1",
        status: "failed",
        startedAt: "2026-03-08T10:00:00.000Z",
      },
      latestRunNodeTimeline: [
        {
          nodeId: "ship",
          attempt: 1,
          status: "failed",
          message: "Release note generation failed.",
          finishedAt: "2026-03-08T10:05:00.000Z",
        },
      ],
      latestDraft: {
        draftId: "draft-1",
        revision: 3,
        title: "Repair release flow",
        status: "active",
        createdAt: "2026-03-08T10:00:00.000Z",
        updatedAt: "2026-03-08T10:05:00.000Z",
      },
    });

    expect(summarizeWorkflowAttention(overview)).toMatchObject({
      focus: "recovery",
      tone: "danger",
      primaryLabel: "Open recovery path",
      secondaryLabel: "Deploy repaired draft",
    });
  });

  it("treats draft-ready workflows as deploy-first when there is no failed run", () => {
    const overview = createOverview({
      latestDraft: {
        draftId: "draft-1",
        revision: 3,
        title: "Weekly report draft",
        status: "active",
        createdAt: "2026-03-08T10:00:00.000Z",
        updatedAt: "2026-03-08T10:05:00.000Z",
      },
    });

    expect(summarizeWorkflowAttention(overview)).toMatchObject({
      focus: "deploy",
      primaryLabel: "Deploy now",
      secondaryLabel: "Export bundle",
    });
  });

  it("builds a recovery-first guided ladder before advanced graph details", () => {
    const overview = createOverview({
      latestRun: {
        runId: "run-1",
        workflowVersionId: "ver-1",
        status: "failed",
        startedAt: "2026-03-08T10:00:00.000Z",
      },
      latestRunNodeTimeline: [
        {
          nodeId: "ship",
          attempt: 1,
          status: "failed",
          message: "Release note generation failed.",
          finishedAt: "2026-03-08T10:05:00.000Z",
        },
      ],
      latestDraft: {
        draftId: "draft-1",
        revision: 3,
        title: "Repair release flow",
        status: "active",
        createdAt: "2026-03-08T10:00:00.000Z",
        updatedAt: "2026-03-08T10:05:00.000Z",
      },
      publishedVersion: {
        id: "ver-1",
        workflowId: "wf-1",
        versionNumber: 2,
        graph: {},
        createdAt: "2026-03-07T10:00:00.000Z",
        isPublished: true,
      },
    });

    const steps = buildWorkflowGuidedSteps({ overview });
    expect(steps.map((step) => step.id)).toEqual([
      "failed-run",
      "deploy-draft",
      "inspect-live",
    ]);
  });
});
