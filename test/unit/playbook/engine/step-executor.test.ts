import { describe, it, expect, beforeEach } from "vitest";
import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import {
  createStepExecutor,
  resolveParameters,
} from "../../../../src/playbook/engine/step-executor.js";
import type {
  StepExecutor,
  ParameterContext,
} from "../../../../src/playbook/engine/step-executor.js";
import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type {
  FridayPlaybook,
  FridayPlaybookVersion,
  FridayPlaybookSelector,
  FridayPlaybookEngineConfig,
  JsonValue,
} from "../../../../src/playbook/model/friday-playbook.types.js";
import {
  FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS,
  FRIDAY_DEFAULT_PROMOTION_RULES,
  FRIDAY_PLAYBOOK_TIE_BREAK_ORDER,
} from "../../../../src/playbook/model/friday-playbook.types.js";

// ─── Helpers ───

const NOW = "2026-02-24T10:00:00.000Z";
let idCounter = 0;

function makeConfig(): FridayPlaybookEngineConfig {
  idCounter = 0;
  return {
    scoring: {
      weights: { ...FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS },
      decayRate: 0.02,
      autoArchiveDays: 90,
      minSampleSize: 5,
    },
    selection: {
      matchThreshold: 0.6,
      similarityWeight: 0.6,
      scoreWeight: 0.4,
      minTagOverlap: 0.5,
      maxCandidates: 50,
      tieBreakOrder: [...FRIDAY_PLAYBOOK_TIE_BREAK_ORDER],
    },
    promotion: {
      rules: [...FRIDAY_DEFAULT_PROMOTION_RULES],
      evaluationIntervalHours: 6,
      rollbackConsecutiveWindows: 3,
      rollbackSuccessRateThreshold: 0.5,
    },
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

// ─── Tests ───

describe("Step Executor", () => {
  let store: PlaybookStore;
  let config: FridayPlaybookEngineConfig;
  let executor: StepExecutor;

  beforeEach(() => {
    store = createPlaybookStore();
    config = makeConfig();
    executor = createStepExecutor({ store, config });
  });

  describe("resolveParameters", () => {
    const context: ParameterContext = {
      input: { source: "my-db", destination: "s3://bucket", count: 42 },
      runtime: { env: "production", region: "us-west-2" },
      stepOutputs: {
        "0": { extractedRows: 1000, format: "parquet" },
      },
    };

    it("resolves input placeholders", () => {
      expect(resolveParameters("{{input.source}}", context)).toBe("my-db");
    });

    it("resolves runtime placeholders", () => {
      expect(resolveParameters("{{runtime.env}}", context)).toBe("production");
    });

    it("resolves step output placeholders", () => {
      expect(resolveParameters("{{steps.0.extractedRows}}", context)).toBe(1000);
    });

    it("preserves typed values for full-match placeholders", () => {
      expect(resolveParameters("{{input.count}}", context)).toBe(42);
    });

    it("interpolates multiple placeholders in a string", () => {
      const result = resolveParameters(
        "Source: {{input.source}}, Env: {{runtime.env}}",
        context,
      );
      expect(result).toBe("Source: my-db, Env: production");
    });

    it("returns original string when placeholder is unresolvable", () => {
      expect(resolveParameters("{{input.nonexistent}}", context)).toBe(
        "{{input.nonexistent}}",
      );
    });

    it("resolves nested objects recursively", () => {
      const value = {
        source: "{{input.source}}",
        config: { env: "{{runtime.env}}" },
      };
      const resolved = resolveParameters(value, context);
      expect(resolved).toEqual({
        source: "my-db",
        config: { env: "production" },
      });
    });

    it("resolves arrays recursively", () => {
      const value = ["{{input.source}}", "{{runtime.env}}"];
      const resolved = resolveParameters(value, context);
      expect(resolved).toEqual(["my-db", "production"]);
    });

    it("passes through non-string primitives unchanged", () => {
      expect(resolveParameters(42, context)).toBe(42);
      expect(resolveParameters(true, context)).toBe(true);
      expect(resolveParameters(null, context)).toBeNull();
    });
  });

  describe("generatePlan", () => {
    const playbook: FridayPlaybook = {
      id: "pb-1",
      name: "etl-pipeline",
      workflowType: "data-pipeline",
      tags: ["etl"],
      status: "active",
      activeVersionNumber: 1,
      sourceCandidateId: "cand-1",
      compositeScore: 0.85,
      totalUses: 10,
      totalSuccesses: 9,
      etag: "etag-1",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const version: FridayPlaybookVersion = {
      id: "ver-1",
      playbookId: "pb-1",
      versionNumber: 1,
      fingerprint: "abc123",
      pattern: {
        nodeSequence: [
          { nodeType: "extract", adapterType: "sql" },
          { nodeType: "transform" },
          { nodeType: "load", adapterType: "s3" },
        ],
        toolsUsed: ["sql-query", "s3-upload"],
        parameterKeys: ["source", "destination"],
      },
      candidateId: "cand-1",
      createdAt: NOW,
    };

    const selector: FridayPlaybookSelector = {
      workflowType: "data-pipeline",
      workflowId: "wf-1",
      runId: "run-1",
      nodeSequence: [{ nodeType: "extract" }],
      tags: ["etl"],
    };

    beforeEach(() => {
      store.savePlaybook(playbook);
      store.saveVersion(version);
    });

    it("generates an execution plan from a playbook version", () => {
      const plan = executor.generatePlan("pb-1", 1, selector);

      expect(plan).not.toBeNull();
      expect(plan!.playbookId).toBe("pb-1");
      expect(plan!.versionNumber).toBe(1);
      expect(plan!.steps).toHaveLength(3);
      expect(plan!.steps[0].nodeType).toBe("extract");
      expect(plan!.steps[0].adapterType).toBe("sql");
      expect(plan!.steps[1].nodeType).toBe("transform");
      expect(plan!.steps[2].nodeType).toBe("load");
    });

    it("populates parameter templates in steps", () => {
      const plan = executor.generatePlan("pb-1", 1, selector);
      expect(plan!.steps[0].parameters).toHaveProperty("source", "{{input.source}}");
      expect(plan!.steps[0].parameters).toHaveProperty("destination", "{{input.destination}}");
    });

    it("includes tool preferences from the pattern", () => {
      const plan = executor.generatePlan("pb-1", 1, selector);
      expect(plan!.steps[0].toolPreferences).toEqual(["sql-query", "s3-upload"]);
    });

    it("returns null for non-existent playbook", () => {
      expect(executor.generatePlan("nonexistent", 1, selector)).toBeNull();
    });

    it("returns null for non-existent version", () => {
      expect(executor.generatePlan("pb-1", 99, selector)).toBeNull();
    });

    it("includes metadata in the plan", () => {
      const plan = executor.generatePlan("pb-1", 1, selector);
      expect(plan!.metadata).toMatchObject({
        workflowType: "data-pipeline",
        runId: "run-1",
        workflowId: "wf-1",
      });
    });
  });

  describe("resolveStep", () => {
    it("resolves parameter templates in a step", () => {
      const step = {
        index: 0,
        nodeType: "extract",
        parameters: { source: "{{input.source}}", limit: "{{runtime.limit}}" },
        toolPreferences: ["sql-query"],
      };

      const context: ParameterContext = {
        input: { source: "my-db" },
        runtime: { limit: 100 },
        stepOutputs: {},
      };

      const resolved = executor.resolveStep(step, context);
      expect(resolved.parameters.source).toBe("my-db");
      expect(resolved.parameters.limit).toBe(100);
    });
  });
});
