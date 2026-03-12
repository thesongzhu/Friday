import { describe, it, expect, beforeEach } from "vitest";

import {
  createDeadLetterQueue,
  DEFAULT_DLQ_MAX_SIZE,
} from "../../../../src/retry/engine/dead-letter-queue.js";

import type {
  DeadLetterQueueConfig,
  EnqueueParams,
} from "../../../../src/retry/engine/dead-letter-queue.js";

import type { FridayClassifiedFailure, FridayRetryDecision } from "../../../../src/retry/model/friday-retry-engine.types.js";

// ─── Helpers ───

let idCounter = 0;
let timeCounter = 0;
const testConfig: DeadLetterQueueConfig = {
  maxSize: 5,
  generateId: () => `dlq-${++idCounter}` as string,
  nowIso: () => `2026-02-24T10:00:0${timeCounter++}.000Z` as string,
};

function makeEnqueueParams(overrides?: Partial<EnqueueParams>): EnqueueParams {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    classifiedFailure: {
      classificationId: "cf-1",
      category: "transient",
      severity: "minor",
      classificationSource: "http_status",
      confidence: 90,
      retryable: true,
      classifiedAt: "2026-02-24T10:00:00.000Z",
    } as FridayClassifiedFailure,
    lastDecision: {
      shouldRetry: false,
      nextAttemptNumber: 3,
      delayMs: 0,
      reason: "retries exhausted",
      failureCategory: "transient",
      strategyType: "exponential",
      rulesOverride: false,
      budgetConstrained: false,
      escalate: true,
      idempotencyKey: "retry:run-1:node-1:3:no-retry",
      decidedAt: "2026-02-24T10:00:00.000Z",
    } as FridayRetryDecision,
    totalAttempts: 3,
    totalCost: { tokens: 5000, apiCalls: 3, computeMs: 15000 },
    reason: "Retries exhausted for transient failure",
    ...overrides,
  };
}

function resetCounters() {
  idCounter = 0;
  timeCounter = 0;
}

// ─── Tests ───

describe("DeadLetterQueue", () => {
  beforeEach(resetCounters);

  describe("DEFAULT_DLQ_MAX_SIZE", () => {
    it("has expected default value", () => {
      expect(DEFAULT_DLQ_MAX_SIZE).toBe(1000);
    });
  });

  describe("enqueue", () => {
    it("adds an entry to the queue", () => {
      const dlq = createDeadLetterQueue(testConfig);
      const entry = dlq.enqueue(makeEnqueueParams());

      expect(entry.id).toBe("dlq-1");
      expect(entry.runId).toBe("run-1");
      expect(entry.nodeId).toBe("node-1");
      expect(entry.acknowledged).toBe(false);
      expect(dlq.size()).toBe(1);
    });

    it("evicts oldest entry when at capacity", () => {
      const dlq = createDeadLetterQueue(testConfig);

      // Fill to capacity.
      for (let i = 0; i < 5; i++) {
        dlq.enqueue(makeEnqueueParams({ nodeId: `node-${i}` }));
      }
      expect(dlq.size()).toBe(5);

      // Enqueue one more — oldest should be evicted.
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-5" }));
      expect(dlq.size()).toBe(5);

      // The first entry (node-0) should be gone.
      const entries = dlq.query();
      const nodeIds = entries.map((e) => e.nodeId);
      expect(nodeIds).not.toContain("node-0");
      expect(nodeIds).toContain("node-5");
    });

    it("evicts oldest unacknowledged entry before acknowledged entries", () => {
      const dlq = createDeadLetterQueue(testConfig);

      const e0 = dlq.enqueue(makeEnqueueParams({ nodeId: "node-0" }));
      const e1 = dlq.enqueue(makeEnqueueParams({ nodeId: "node-1" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-2" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-3" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-4" }));

      dlq.acknowledge(e0.id);
      dlq.acknowledge(e1.id);

      dlq.enqueue(makeEnqueueParams({ nodeId: "node-5" }));

      const nodeIds = dlq.query().map((e) => e.nodeId);
      expect(nodeIds).toContain("node-0");
      expect(nodeIds).toContain("node-1");
      expect(nodeIds).not.toContain("node-2");
      expect(nodeIds).toContain("node-5");
    });
  });

  describe("acknowledge", () => {
    it("marks an entry as acknowledged", () => {
      const dlq = createDeadLetterQueue(testConfig);
      const entry = dlq.enqueue(makeEnqueueParams());
      const updated = dlq.acknowledge(entry.id, "Reviewed and resolved");

      expect(updated).toBeDefined();
      expect(updated!.acknowledged).toBe(true);
      expect(updated!.acknowledgeNote).toBe("Reviewed and resolved");
      expect(updated!.acknowledgedAt).toBeDefined();
    });

    it("returns undefined for non-existent entry", () => {
      const dlq = createDeadLetterQueue(testConfig);
      expect(dlq.acknowledge("non-existent")).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("removes an entry from the queue", () => {
      const dlq = createDeadLetterQueue(testConfig);
      const entry = dlq.enqueue(makeEnqueueParams());
      expect(dlq.remove(entry.id)).toBe(true);
      expect(dlq.size()).toBe(0);
    });

    it("returns false for non-existent entry", () => {
      const dlq = createDeadLetterQueue(testConfig);
      expect(dlq.remove("non-existent")).toBe(false);
    });
  });

  describe("get", () => {
    it("retrieves an entry by ID", () => {
      const dlq = createDeadLetterQueue(testConfig);
      const entry = dlq.enqueue(makeEnqueueParams());
      const retrieved = dlq.get(entry.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(entry.id);
    });

    it("returns undefined for non-existent entry", () => {
      const dlq = createDeadLetterQueue(testConfig);
      expect(dlq.get("non-existent")).toBeUndefined();
    });
  });

  describe("query", () => {
    it("returns all entries when no filter is specified", () => {
      const dlq = createDeadLetterQueue(testConfig);
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-a" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-b" }));

      const results = dlq.query();
      expect(results).toHaveLength(2);
    });

    it("filters by runId", () => {
      const dlq = createDeadLetterQueue(testConfig);
      dlq.enqueue(makeEnqueueParams({ runId: "run-1" as string }));
      dlq.enqueue(makeEnqueueParams({ runId: "run-2" as string }));

      const results = dlq.query({ runId: "run-1" as string });
      expect(results).toHaveLength(1);
      expect(results[0].runId).toBe("run-1");
    });

    it("filters by nodeId", () => {
      const dlq = createDeadLetterQueue(testConfig);
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-a" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-b" }));

      const results = dlq.query({ nodeId: "node-a" });
      expect(results).toHaveLength(1);
    });

    it("filters by failureCategory", () => {
      const dlq = createDeadLetterQueue(testConfig);
      dlq.enqueue(makeEnqueueParams());
      dlq.enqueue(
        makeEnqueueParams({
          classifiedFailure: {
            ...makeEnqueueParams().classifiedFailure,
            category: "auth",
          },
        }),
      );

      const results = dlq.query({ failureCategory: "auth" });
      expect(results).toHaveLength(1);
      expect(results[0].classifiedFailure.category).toBe("auth");
    });

    it("filters by acknowledged status", () => {
      const dlq = createDeadLetterQueue(testConfig);
      const e1 = dlq.enqueue(makeEnqueueParams({ nodeId: "node-a" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "node-b" }));
      dlq.acknowledge(e1.id);

      const unacked = dlq.query({ acknowledged: false });
      expect(unacked).toHaveLength(1);
      expect(unacked[0].nodeId).toBe("node-b");

      const acked = dlq.query({ acknowledged: true });
      expect(acked).toHaveLength(1);
      expect(acked[0].nodeId).toBe("node-a");
    });

    it("returns results in newest-first order", () => {
      const dlq = createDeadLetterQueue(testConfig);
      dlq.enqueue(makeEnqueueParams({ nodeId: "first" }));
      dlq.enqueue(makeEnqueueParams({ nodeId: "second" }));

      const results = dlq.query();
      expect(results[0].nodeId).toBe("second");
      expect(results[1].nodeId).toBe("first");
    });
  });

  describe("pendingCount", () => {
    it("counts unacknowledged entries", () => {
      const dlq = createDeadLetterQueue(testConfig);
      const e1 = dlq.enqueue(makeEnqueueParams());
      dlq.enqueue(makeEnqueueParams());

      expect(dlq.pendingCount()).toBe(2);

      dlq.acknowledge(e1.id);
      expect(dlq.pendingCount()).toBe(1);
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      const dlq = createDeadLetterQueue(testConfig);
      dlq.enqueue(makeEnqueueParams());
      dlq.enqueue(makeEnqueueParams());

      dlq.clear();
      expect(dlq.size()).toBe(0);
      expect(dlq.pendingCount()).toBe(0);
    });
  });
});
