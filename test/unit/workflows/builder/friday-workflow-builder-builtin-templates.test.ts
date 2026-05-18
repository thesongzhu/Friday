import { describe, it, expect } from "vitest";
import { getFridayBuiltinWorkflowTemplates } from "#workflows";
import { listFridayCrossBorderWorkflowCatalog } from "../../../../src/packs/cross-border/friday-cross-border-workflow-catalog";

describe("getFridayBuiltinWorkflowTemplates - shipping guards", () => {
  // CLAW-023: Built-in templates must not reference unavailable runnable skills.
  describe("CLAW-023 skill_call ref hygiene", () => {
    it("no built-in template references the non-existent 'example-skill' placeholder", () => {
      const templates = getFridayBuiltinWorkflowTemplates();
      for (const template of templates) {
        for (const step of template.spec.steps) {
          if (step.type === "skill_call") {
            expect(step.ref, `template ${template.templateId} step ${step.id}`).not.toBe(
              "example-skill",
            );
          }
        }
      }
    });

    it("every skill_call step in a built-in template with a ref points at a real cross-border catalog skill id", () => {
      const knownSkillIds = new Set<string>();
      for (const entry of listFridayCrossBorderWorkflowCatalog()) {
        knownSkillIds.add(entry.primarySkillId);
        if (entry.followupSkillId) {
          knownSkillIds.add(entry.followupSkillId);
        }
      }

      const templates = getFridayBuiltinWorkflowTemplates();
      for (const template of templates) {
        for (const step of template.spec.steps) {
          if (step.type === "skill_call" && step.ref) {
            expect(
              knownSkillIds.has(step.ref),
              `template ${template.templateId} step ${step.id} references skill '${step.ref}' which is not in the cross-border catalog`,
            ).toBe(true);
          }
        }
      }
    });

    it("simple-action starter template uses a non-skill step type so it does not ship a fake skill ref", () => {
      const templates = getFridayBuiltinWorkflowTemplates();
      const simple = templates.find((t) => t.templateId === "builtin-simple-action");
      expect(simple).toBeDefined();
      const skillCalls = simple!.spec.steps.filter((step) => step.type === "skill_call");
      expect(skillCalls).toEqual([]);
    });
  });

  // CLAW-024: Visual edge keys must match spec edge condition; success-only spec edges
  // must not render as ":any".
  describe("CLAW-024 visual edge key suffix matches spec edge 'when'", () => {
    it("for every built-in template, every visual edge whose endpoints match a spec edge uses the spec edge's 'when' value as the suffix", () => {
      const templates = getFridayBuiltinWorkflowTemplates();
      for (const template of templates) {
        const specEdgeByFromTo = new Map<string, string | undefined>();
        for (const edge of template.spec.edges) {
          specEdgeByFromTo.set(`${edge.from}:${edge.to}`, edge.when);
        }

        for (const visualEdge of template.visual.edges) {
          // Trigger edges have no spec counterpart; skip them.
          if (visualEdge.edgeKey.startsWith("__trigger__:")) {
            continue;
          }
          const parts = visualEdge.edgeKey.split(":");
          expect(parts.length, `edgeKey '${visualEdge.edgeKey}' is not in from:to:when shape`).toBeGreaterThanOrEqual(3);
          const suffix = parts[parts.length - 1]!;
          const fromTo = parts.slice(0, -1).join(":");
          const specWhen = specEdgeByFromTo.get(fromTo);
          if (specWhen !== undefined) {
            expect(
              suffix,
              `template ${template.templateId} visual edge '${visualEdge.edgeKey}' suffix must match spec edge 'when' value '${specWhen}'`,
            ).toBe(specWhen);
          }
        }
      }
    });

    it("weekly-hot-product-review chain template visual edge uses ':success' to match the spec success edge", () => {
      const templates = getFridayBuiltinWorkflowTemplates();
      const template = templates.find(
        (t) => t.templateId === "builtin-cross-border-weekly-hot-product-review",
      );
      expect(template).toBeDefined();
      const specEdge = template!.spec.edges[0]!;
      expect(specEdge.when).toBe("success");
      const visualEdge = template!.visual.edges.find((e) =>
        e.edgeKey.startsWith(`${specEdge.from}:${specEdge.to}:`),
      );
      expect(visualEdge).toBeDefined();
      expect(visualEdge!.edgeKey).toBe(`${specEdge.from}:${specEdge.to}:success`);
    });

    it("weekly-operating-profile-tune chain template visual edge uses ':success' to match the spec success edge", () => {
      const templates = getFridayBuiltinWorkflowTemplates();
      const template = templates.find(
        (t) => t.templateId === "builtin-cross-border-weekly-operating-profile-tune",
      );
      expect(template).toBeDefined();
      const specEdge = template!.spec.edges[0]!;
      expect(specEdge.when).toBe("success");
      const visualEdge = template!.visual.edges.find((e) =>
        e.edgeKey.startsWith(`${specEdge.from}:${specEdge.to}:`),
      );
      expect(visualEdge).toBeDefined();
      expect(visualEdge!.edgeKey).toBe(`${specEdge.from}:${specEdge.to}:success`);
    });

    it("no built-in template ships a visual edge whose suffix is ':any' while its spec edge declares a success/failure/true/false condition", () => {
      const templates = getFridayBuiltinWorkflowTemplates();
      for (const template of templates) {
        const specEdgeByFromTo = new Map<string, string | undefined>();
        for (const edge of template.spec.edges) {
          specEdgeByFromTo.set(`${edge.from}:${edge.to}`, edge.when);
        }
        for (const visualEdge of template.visual.edges) {
          if (visualEdge.edgeKey.startsWith("__trigger__:")) continue;
          const parts = visualEdge.edgeKey.split(":");
          const suffix = parts[parts.length - 1]!;
          const fromTo = parts.slice(0, -1).join(":");
          const specWhen = specEdgeByFromTo.get(fromTo);
          if (specWhen && suffix === "any") {
            throw new Error(
              `template ${template.templateId} ships visual edge '${visualEdge.edgeKey}' as ':any' but spec edge declares '${specWhen}'`,
            );
          }
        }
      }
    });
  });
});
