import { describe, it, expect, beforeEach } from "vitest";
import {
  createHelpSystem,
} from "../../../../src/uix/engine/help-system.js";
import type {
  HelpSystem,
  HelpArticle,
  TooltipDefinition,
  GuidedTour,
  TourStep,
} from "../../../../src/uix/engine/help-system.js";

// ─── Fixtures ───

function makeArticle(overrides: Partial<HelpArticle> = {}): HelpArticle {
  return {
    id: "article-1",
    title: "Getting Started",
    summary: "Learn how to get started with Friday.",
    type: "article",
    contextKeys: ["dashboard", "onboarding"],
    tags: ["beginner", "setup"],
    priority: 10,
    ...overrides,
  };
}

function makeTooltip(overrides: Partial<TooltipDefinition> = {}): TooltipDefinition {
  return {
    id: "tip-1",
    contextKey: "settings.notifications",
    content: "Configure how you receive notifications.",
    placement: "bottom",
    ...overrides,
  };
}

function makeTourStep(overrides: Partial<TourStep> = {}): TourStep {
  return {
    id: "step-1",
    target: "#dashboard-widget",
    title: "Dashboard Overview",
    content: "This is your main dashboard.",
    placement: "bottom",
    sortOrder: 0,
    ...overrides,
  };
}

function makeTour(overrides: Partial<GuidedTour> = {}): GuidedTour {
  return {
    id: "tour-1",
    name: "Welcome Tour",
    steps: [
      makeTourStep({ id: "ts-1", sortOrder: 0 }),
      makeTourStep({ id: "ts-2", title: "Settings", sortOrder: 1 }),
      makeTourStep({ id: "ts-3", title: "Done", sortOrder: 2 }),
    ],
    enabled: true,
    tags: ["onboarding"],
    ...overrides,
  };
}

// ─── Tests ───

describe("HelpSystem", () => {
  let help: HelpSystem;

  beforeEach(() => {
    help = createHelpSystem();
  });

  describe("articles", () => {
    it("registers and retrieves an article", () => {
      const article = makeArticle();
      help.registerArticle(article);
      expect(help.getArticle("article-1")).toEqual(article);
    });

    it("returns undefined for unknown article", () => {
      expect(help.getArticle("unknown")).toBeUndefined();
    });

    it("unregisters an article", () => {
      help.registerArticle(makeArticle());
      expect(help.unregisterArticle("article-1")).toBe(true);
      expect(help.getArticle("article-1")).toBeUndefined();
    });

    it("returns false when unregistering unknown article", () => {
      expect(help.unregisterArticle("unknown")).toBe(false);
    });

    it("finds articles by exact context key", () => {
      help.registerArticle(makeArticle({ id: "a1", contextKeys: ["dashboard"] }));
      help.registerArticle(makeArticle({ id: "a2", contextKeys: ["settings"] }));

      const results = help.getArticlesByContext("dashboard");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
    });

    it("finds articles by context key prefix", () => {
      help.registerArticle(makeArticle({ id: "a1", contextKeys: ["settings"] }));

      const results = help.getArticlesByContext("settings.notifications");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
    });

    it("returns articles sorted by priority", () => {
      help.registerArticle(makeArticle({ id: "a2", contextKeys: ["dash"], priority: 20 }));
      help.registerArticle(makeArticle({ id: "a1", contextKeys: ["dash"], priority: 5 }));

      const results = help.getArticlesByContext("dash");
      expect(results.map((a) => a.id)).toEqual(["a1", "a2"]);
    });
  });

  describe("article search", () => {
    it("finds articles by title match", () => {
      help.registerArticle(makeArticle({ id: "gs", title: "Getting Started" }));
      help.registerArticle(makeArticle({ id: "adv", title: "Advanced Configuration" }));

      const results = help.searchArticles("getting started");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].article.id).toBe("gs");
    });

    it("finds articles by summary match", () => {
      help.registerArticle(makeArticle({ id: "a1", summary: "Learn about workflows and automation" }));

      const results = help.searchArticles("workflows");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("finds articles by tag match", () => {
      help.registerArticle(makeArticle({ id: "a1", tags: ["integration", "slack"] }));

      const results = help.searchArticles("slack");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("respects maxResults", () => {
      for (let i = 0; i < 5; i++) {
        help.registerArticle(makeArticle({ id: `a-${i}`, title: `Guide ${i}` }));
      }
      const results = help.searchArticles("Guide", 2);
      expect(results).toHaveLength(2);
    });

    it("returns empty for no match", () => {
      help.registerArticle(makeArticle());
      const results = help.searchArticles("zzzzz_no_match_xyz");
      expect(results).toHaveLength(0);
    });
  });

  describe("tooltips", () => {
    it("registers and retrieves a tooltip by context key", () => {
      const tip = makeTooltip();
      help.registerTooltip(tip);
      expect(help.getTooltip("settings.notifications")).toEqual(tip);
    });

    it("returns undefined for unknown context key", () => {
      expect(help.getTooltip("unknown")).toBeUndefined();
    });

    it("lists all tooltips", () => {
      help.registerTooltip(makeTooltip({ id: "t1", contextKey: "a" }));
      help.registerTooltip(makeTooltip({ id: "t2", contextKey: "b" }));
      expect(help.getAllTooltips()).toHaveLength(2);
    });

    it("unregisters a tooltip and removes context index", () => {
      help.registerTooltip(makeTooltip());
      expect(help.unregisterTooltip("tip-1")).toBe(true);
      expect(help.getTooltip("settings.notifications")).toBeUndefined();
    });

    it("returns false when unregistering unknown tooltip", () => {
      expect(help.unregisterTooltip("unknown")).toBe(false);
    });

    it("keeps latest tooltip mapping when an older tooltip with same context is removed", () => {
      help.registerTooltip(makeTooltip({ id: "tip-1", contextKey: "shared.context", content: "first" }));
      help.registerTooltip(makeTooltip({ id: "tip-2", contextKey: "shared.context", content: "second" }));

      expect(help.unregisterTooltip("tip-1")).toBe(true);
      expect(help.getTooltip("shared.context")?.id).toBe("tip-2");

      expect(help.unregisterTooltip("tip-2")).toBe(true);
      expect(help.getTooltip("shared.context")).toBeUndefined();
    });
  });

  describe("guided tours", () => {
    it("registers and retrieves a tour", () => {
      const tour = makeTour();
      help.registerTour(tour);
      expect(help.getTour("tour-1")).toEqual(tour);
    });

    it("returns undefined for unknown tour", () => {
      expect(help.getTour("unknown")).toBeUndefined();
    });

    it("lists all tours", () => {
      help.registerTour(makeTour({ id: "t1" }));
      help.registerTour(makeTour({ id: "t2" }));
      expect(help.getAllTours()).toHaveLength(2);
    });

    it("unregisters a tour", () => {
      help.registerTour(makeTour());
      expect(help.unregisterTour("tour-1")).toBe(true);
      expect(help.getTour("tour-1")).toBeUndefined();
    });

    it("finds tours by context prefix", () => {
      help.registerTour(makeTour({ id: "t1", contextPrefix: "settings" }));
      help.registerTour(makeTour({ id: "t2", contextPrefix: "dashboard" }));

      const tours = help.getToursForContext("settings.notifications");
      expect(tours).toHaveLength(1);
      expect(tours[0].id).toBe("t1");
    });

    it("excludes disabled tours from context search", () => {
      help.registerTour(makeTour({ id: "t1", contextPrefix: "settings", enabled: false }));
      expect(help.getToursForContext("settings")).toHaveLength(0);
    });
  });

  describe("tour sessions", () => {
    it("starts a tour session", () => {
      help.registerTour(makeTour());
      const session = help.startTour("tour-1", "user-1");
      expect(session).toBeDefined();
      expect(session!.tourId).toBe("tour-1");
      expect(session!.principalId).toBe("user-1");
      expect(session!.status).toBe("in_progress");
      expect(session!.currentStepIndex).toBe(0);
    });

    it("returns undefined for disabled tour", () => {
      help.registerTour(makeTour({ enabled: false }));
      expect(help.startTour("tour-1", "user-1")).toBeUndefined();
    });

    it("returns undefined for unknown tour", () => {
      expect(help.startTour("unknown", "user-1")).toBeUndefined();
    });

    it("returns undefined for tour with no steps", () => {
      help.registerTour(makeTour({ steps: [] }));
      expect(help.startTour("tour-1", "user-1")).toBeUndefined();
    });

    it("returns existing in-progress session", () => {
      help.registerTour(makeTour());
      const s1 = help.startTour("tour-1", "user-1");
      const s2 = help.startTour("tour-1", "user-1");
      expect(s1!.startedAt).toBe(s2!.startedAt);
    });

    it("advances through tour steps", () => {
      help.registerTour(makeTour());
      help.startTour("tour-1", "user-1");

      const s1 = help.advanceTour("tour-1", "user-1");
      expect(s1!.currentStepIndex).toBe(1);

      const s2 = help.advanceTour("tour-1", "user-1");
      expect(s2!.currentStepIndex).toBe(2);

      // Advance past last step → completed
      const s3 = help.advanceTour("tour-1", "user-1");
      expect(s3!.status).toBe("completed");
      expect(s3!.finishedAt).toBeDefined();
    });

    it("returns undefined when advancing non-existent session", () => {
      expect(help.advanceTour("tour-1", "user-1")).toBeUndefined();
    });

    it("returns undefined when advancing completed session", () => {
      help.registerTour(makeTour({ steps: [makeTourStep()] }));
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1"); // completes
      expect(help.advanceTour("tour-1", "user-1")).toBeUndefined();
    });

    it("skips a tour", () => {
      help.registerTour(makeTour());
      help.startTour("tour-1", "user-1");

      const session = help.skipTour("tour-1", "user-1");
      expect(session!.status).toBe("skipped");
      expect(session!.finishedAt).toBeDefined();
    });

    it("returns undefined when skipping non-existent session", () => {
      expect(help.skipTour("tour-1", "user-1")).toBeUndefined();
    });

    it("rewinds to a previously visited step", () => {
      help.registerTour(makeTour({
        steps: [
          makeTourStep({ id: "s1", sortOrder: 0 }),
          makeTourStep({ id: "s2", sortOrder: 1 }),
          makeTourStep({ id: "s3", sortOrder: 2 }),
          makeTourStep({ id: "s4", sortOrder: 3 }),
        ],
      }));
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1"); // step 2
      help.advanceTour("tour-1", "user-1"); // step 3

      const rewound = help.rewindTour("tour-1", "user-1", 1);
      expect(rewound).toBeDefined();
      expect(rewound!.currentStepIndex).toBe(1);
    });

    it("rejects rewind to a step that has not been reached", () => {
      help.registerTour(makeTour({
        steps: [
          makeTourStep({ id: "s1", sortOrder: 0 }),
          makeTourStep({ id: "s2", sortOrder: 1 }),
          makeTourStep({ id: "s3", sortOrder: 2 }),
          makeTourStep({ id: "s4", sortOrder: 3 }),
        ],
      }));
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1"); // step 2
      help.advanceTour("tour-1", "user-1"); // step 3

      expect(help.rewindTour("tour-1", "user-1", 3)).toBeUndefined();
    });

    it("rejects rewind on completed sessions", () => {
      help.registerTour(makeTour({ steps: [makeTourStep({ id: "s1" })] }));
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1"); // completes

      expect(help.rewindTour("tour-1", "user-1", 0)).toBeUndefined();
    });

    it("rejects rewind with NaN index", () => {
      help.registerTour(makeTour());
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1");

      expect(help.rewindTour("tour-1", "user-1", NaN)).toBeUndefined();
    });

    it("rejects rewind with Infinity index", () => {
      help.registerTour(makeTour());
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1");

      expect(help.rewindTour("tour-1", "user-1", Infinity)).toBeUndefined();
    });

    it("rejects rewind with fractional index", () => {
      help.registerTour(makeTour());
      help.startTour("tour-1", "user-1");
      help.advanceTour("tour-1", "user-1");

      expect(help.rewindTour("tour-1", "user-1", 0.5)).toBeUndefined();
    });

    it("retrieves a tour session", () => {
      help.registerTour(makeTour());
      help.startTour("tour-1", "user-1");

      const session = help.getTourSession("tour-1", "user-1");
      expect(session).toBeDefined();
      expect(session!.tourId).toBe("tour-1");
    });

    it("returns undefined for non-existent tour session", () => {
      expect(help.getTourSession("tour-1", "user-1")).toBeUndefined();
    });

    it("lists completed tours for a user", () => {
      help.registerTour(makeTour({ id: "t1", steps: [makeTourStep()] }));
      help.registerTour(makeTour({ id: "t2", steps: [makeTourStep()] }));

      help.startTour("t1", "user-1");
      help.advanceTour("t1", "user-1"); // completes
      help.startTour("t2", "user-1");
      help.skipTour("t2", "user-1"); // skipped, not completed

      const completed = help.getCompletedTours("user-1");
      expect(completed).toEqual(["t1"]);
    });
  });
});
