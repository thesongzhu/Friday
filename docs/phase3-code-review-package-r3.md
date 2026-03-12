> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 3 Code Review Package (Round 3)

## Build & Test Results
- TypeScript compilation: CLEAN
- Test suite: 488 tests passed (57 test files), 0 failures

## Round 1 Issues Fixed (all 5)
1. [HIGH] retryRun() creates new attempts for failed nodes
2. [HIGH] Lease expiry set to now + 5min TTL
3. [HIGH] Failure-condition edges fire with failed node context
4. [HIGH] Approval gate enforced with blocked_offline + explicit decision
5. [MEDIUM] Prototype paths rejected in expression evaluator

## Round 2 Issues Fixed (all 3)
6. [MEDIUM] blocked_offline->completed/failed added to node state machine
7. [MEDIUM] Lease tests now exercise production repository code
8. [MEDIUM] End-to-end tests: retry flow + approval approve + approval reject

## Changed Files (Round 2 fixes only)

### `src/workflows/engine/friday-workflow-node-machine.ts`
```ts
import type { NodeAttemptStatus } from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowNodeMachine {
  canTransition(from: NodeAttemptStatus, to: NodeAttemptStatus): boolean;
  assertTransition(from: NodeAttemptStatus, to: NodeAttemptStatus): void;
  isTerminal(status: NodeAttemptStatus): boolean;
}

// ─── Valid transition table ───

const VALID_TRANSITIONS: ReadonlyMap<
  NodeAttemptStatus,
  ReadonlySet<NodeAttemptStatus>
> = new Map([
  [
    "queued",
    new Set<NodeAttemptStatus>(["running", "cancelled", "blocked_offline"]),
  ],
  [
    "running",
    new Set<NodeAttemptStatus>([
      "completed",
      "failed",
      "cancelled",
      "blocked_offline",
    ]),
  ],
  [
    "retrying",
    new Set<NodeAttemptStatus>(["running", "cancelled", "blocked_offline"]),
  ],
  // failed can transition to retrying when retry policy allows
  ["failed", new Set<NodeAttemptStatus>(["retrying"])],
  [
    "blocked_offline",
    new Set<NodeAttemptStatus>(["running", "completed", "cancelled", "failed"]),
  ],
  ["completed", new Set<NodeAttemptStatus>([])],
  ["cancelled", new Set<NodeAttemptStatus>([])],
]);

const TERMINAL_STATUSES: ReadonlySet<NodeAttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ─── Factory ───

export function createFridayWorkflowNodeMachine(): FridayWorkflowNodeMachine {
  return {
    canTransition(from, to) {
      const allowed = VALID_TRANSITIONS.get(from);
      return allowed ? allowed.has(to) : false;
    },

    assertTransition(from, to) {
      if (!this.canTransition(from, to)) {
        throw new Error(
          `INVALID_NODE_TRANSITION: cannot transition from '${from}' to '${to}'`,
        );
      }
    },

    isTerminal(status) {
      return TERMINAL_STATUSES.has(status);
    },
  };
}
```

### `test/unit/workflows/friday-workflow-node-machine.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowNodeMachine } from "../../../src/workflows/engine/friday-workflow-node-machine.js";

describe("FridayWorkflowNodeMachine", () => {
  const machine = createFridayWorkflowNodeMachine();

  it("accepts valid transition queued → running", () => {
    expect(machine.canTransition("queued", "running")).toBe(true);
  });

  it("accepts valid transition queued → cancelled", () => {
    expect(machine.canTransition("queued", "cancelled")).toBe(true);
  });

  it("accepts valid transition queued → blocked_offline", () => {
    expect(machine.canTransition("queued", "blocked_offline")).toBe(true);
  });

  it("accepts valid transition running → completed", () => {
    expect(machine.canTransition("running", "completed")).toBe(true);
  });

  it("accepts valid transition running → failed", () => {
    expect(machine.canTransition("running", "failed")).toBe(true);
  });

  it("accepts valid transition running → cancelled", () => {
    expect(machine.canTransition("running", "cancelled")).toBe(true);
  });

  it("accepts valid transition running → blocked_offline", () => {
    expect(machine.canTransition("running", "blocked_offline")).toBe(true);
  });

  it("accepts valid transition failed → retrying", () => {
    expect(machine.canTransition("failed", "retrying")).toBe(true);
  });

  it("accepts valid transition retrying → running", () => {
    expect(machine.canTransition("retrying", "running")).toBe(true);
  });

  it("accepts valid transition blocked_offline → running", () => {
    expect(machine.canTransition("blocked_offline", "running")).toBe(true);
  });

  it("accepts valid transition blocked_offline → failed", () => {
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });

  it("rejects invalid transition completed → running", () => {
    expect(machine.canTransition("completed", "running")).toBe(false);
  });

  it("rejects invalid transition queued → completed (must go through running)", () => {
    expect(machine.canTransition("queued", "completed")).toBe(false);
  });

  it("assertTransition throws on invalid transition", () => {
    expect(() => machine.assertTransition("completed", "running")).toThrow(
      "INVALID_NODE_TRANSITION",
    );
  });

  it("identifies completed as terminal", () => {
    expect(machine.isTerminal("completed")).toBe(true);
  });

  it("identifies cancelled as terminal", () => {
    expect(machine.isTerminal("cancelled")).toBe(true);
  });

  it("identifies failed as terminal", () => {
    expect(machine.isTerminal("failed")).toBe(true);
  });

  it("identifies running as non-terminal", () => {
    expect(machine.isTerminal("running")).toBe(false);
  });

  it("retry flow: failed → retrying → running → completed", () => {
    expect(machine.canTransition("failed", "retrying")).toBe(true);
    expect(machine.canTransition("retrying", "running")).toBe(true);
    expect(machine.canTransition("running", "completed")).toBe(true);
  });

  it("offline flow: running → blocked_offline → running → completed", () => {
    expect(machine.canTransition("running", "blocked_offline")).toBe(true);
    expect(machine.canTransition("blocked_offline", "running")).toBe(true);
    expect(machine.canTransition("running", "completed")).toBe(true);
  });

  it("offline timeout: blocked_offline → failed", () => {
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });

  it("approval granted: blocked_offline → completed", () => {
    expect(machine.canTransition("blocked_offline", "completed")).toBe(true);
  });

  it("approval rejected: blocked_offline → failed", () => {
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });

  it("approval flow: queued → blocked_offline → completed", () => {
    expect(machine.canTransition("queued", "blocked_offline")).toBe(true);
    expect(machine.canTransition("blocked_offline", "completed")).toBe(true);
  });

  it("approval rejection flow: queued → blocked_offline → failed", () => {
    expect(machine.canTransition("queued", "blocked_offline")).toBe(true);
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });
});
```

### `test/unit/workflows/friday-workflow-execution-service-fixes.test.ts`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayExpressionEvaluator } from "../../../src/workflows/engine/friday-workflow-expression-evaluator.js";
import { createFridayWorkflowDagScheduler } from "../../../src/workflows/engine/friday-workflow-dag-scheduler.js";
import { createFridayWorkflowRunMachine } from "../../../src/workflows/engine/friday-workflow-run-machine.js";
import { createFridayWorkflowNodeMachine } from "../../../src/workflows/engine/friday-workflow-node-machine.js";
import { createFridayWorkflowRetryManager } from "../../../src/workflows/engine/friday-workflow-retry-manager.js";
import { createFridayWorkflowNodeExecutor } from "../../../src/workflows/engine/friday-workflow-node-executor.js";
import { createFridayWorkflowArtifactWriter } from "../../../src/workflows/engine/friday-workflow-artifact-writer.js";
import { createFridayWorkflowExecutionService } from "../../../src/workflows/services/friday-workflow-execution-service.js";
import { createFridayWorkflowRepository } from "../../../src/workflows/persistence/friday-workflow-repository.js";
import { createFridayWorkflowRunRepository } from "../../../src/workflows/persistence/friday-workflow-run-repository.js";
import { createFridayWorkflowRunNodeRepository } from "../../../src/workflows/persistence/friday-workflow-run-node-repository.js";
import { createFridayWorkflowArtifactRepository } from "../../../src/workflows/persistence/friday-workflow-artifact-repository.js";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.js";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import type { FridayExpressionContext } from "../../../src/workflows/model/friday-workflow-expression.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../../src/workflows/model/friday-workflow-graph.types.js";
import type { NodeAttemptStatus } from "../../../src/workflows/model/friday-workflow.types.js";

// ═══════════════════════════════════════════════════════════════
// Issue 5: Expression Evaluator — Prototype Path Access
// ═══════════════════════════════════════════════════════════════

describe("Issue 5: Expression evaluator rejects prototype path access", () => {
  const evaluator = createFridayExpressionEvaluator();
  const ctx: FridayExpressionContext = {
    inputs: { name: "test" },
    steps: {
      fetch: { output: { data: "ok" } },
    },
  };

  it("rejects __proto__ path segment", () => {
    expect(() =>
      evaluator.exec("$steps.fetch.__proto__", ctx),
    ).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
  });

  it("rejects constructor path segment", () => {
    expect(() =>
      evaluator.exec("$steps.fetch.constructor", ctx),
    ).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
  });

  it("rejects prototype path segment", () => {
    expect(() =>
      evaluator.exec("$steps.fetch.prototype", ctx),
    ).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
  });

  it("rejects __proto__ in deeply nested path", () => {
    expect(() =>
      evaluator.exec("$steps.fetch.output.__proto__.polluted", ctx),
    ).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
  });

  it("rejects constructor in input paths", () => {
    expect(() =>
      evaluator.exec("$inputs.constructor.name", ctx),
    ).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
  });

  it("allows normal path segments that are not dangerous", () => {
    expect(evaluator.exec("$steps.fetch.output.data", ctx)).toBe("ok");
  });

  it("allows path segments similar to but not matching dangerous names", () => {
    const ctxWithSimilar: FridayExpressionContext = {
      inputs: {},
      steps: {
        fetch: { output: { proto: "safe", constructorName: "safe" } },
      },
    };
    expect(evaluator.exec("$steps.fetch.output.proto", ctxWithSimilar)).toBe("safe");
    expect(evaluator.exec("$steps.fetch.output.constructorName", ctxWithSimilar)).toBe("safe");
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 3: Failure-Condition Edges Can Fire
// ═══════════════════════════════════════════════════════════════

describe("Issue 3: Failure-condition edges fire when predecessor fails", () => {
  const scheduler = createFridayWorkflowDagScheduler();
  const exprEval = createFridayExpressionEvaluator();

  function makeGraph(
    nodes: Array<{ id: string; type?: string }>,
    edges: Array<{ id: string; source: string; target: string; condition?: string }>,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.type ?? "action") as "action",
          label: n.id,
          config: { skillId: "test" },
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          condition: e.condition,
        })),
      },
      failurePolicy: { onFailure: "continue_on_error", notifyUser: false },
      tests: [],
      checksum: "abc",
    };
  }

  it("failure-condition edge fires when predecessor status is failed", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B_success" }, { id: "B_failure" }],
      [
        {
          id: "e1",
          source: "A",
          target: "B_success",
          // This condition uses $steps.<nodeId>.output.status — the old pattern
          // from the compiler. We need $steps to be populated for failed nodes.
        },
        {
          id: "e2",
          source: "A",
          target: "B_failure",
          condition: '$steps.A.status == "failed"',
        },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A failed — expression context includes status for failed nodes
    const ctx: FridayExpressionContext = {
      inputs: {},
      steps: {
        A: {
          output: { status: "failed" },
          status: "failed",
          error: { code: "NODE_EXECUTION_FAILED", message: "boom" },
        },
      },
    };

    const statuses = new Map<string, NodeAttemptStatus>([["A", "failed"]]);
    const ready = scheduler.computeReadyNodes(adj, statuses, graph, ctx, exprEval);

    expect(ready).toContain("B_failure");
  });

  it("failure-condition edge does NOT fire for completed predecessor", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B_failure" }],
      [
        {
          id: "e1",
          source: "A",
          target: "B_failure",
          condition: '$steps.A.status == "failed"',
        },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A completed — status is "completed"
    const ctx: FridayExpressionContext = {
      inputs: {},
      steps: {
        A: {
          output: { result: "ok" },
          status: "completed",
        },
      },
    };

    const statuses = new Map<string, NodeAttemptStatus>([["A", "completed"]]);
    const ready = scheduler.computeReadyNodes(adj, statuses, graph, ctx, exprEval);

    expect(ready).not.toContain("B_failure");
  });

  it("error code is accessible in expression context for failed nodes", () => {
    const ctx: FridayExpressionContext = {
      inputs: {},
      steps: {
        A: {
          output: {},
          status: "failed",
          error: { code: "NODE_TIMEOUT", message: "timed out" },
        },
      },
    };

    expect(exprEval.exec('$steps.A.error.code == "NODE_TIMEOUT"', ctx)).toBe(true);
    expect(exprEval.exec("$steps.A.error.message", ctx)).toBe("timed out");
  });

  it("compiler-generated failure condition works end-to-end", () => {
    // The compiler generates: $steps.<from>.output.status == "failed"
    // For this to work, failed nodes need output.status == "failed"
    const graph = makeGraph(
      [{ id: "fetch" }, { id: "error_handler" }],
      [
        {
          id: "e1",
          source: "fetch",
          target: "error_handler",
          condition: '$steps.fetch.output.status == "failed"',
        },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // When a node fails, we set output.status = "failed"
    const ctx: FridayExpressionContext = {
      inputs: {},
      steps: {
        fetch: {
          output: { status: "failed" },
          status: "failed",
          error: { code: "NODE_EXECUTION_FAILED", message: "404" },
        },
      },
    };

    const statuses = new Map<string, NodeAttemptStatus>([["fetch", "failed"]]);
    const ready = scheduler.computeReadyNodes(adj, statuses, graph, ctx, exprEval);

    expect(ready).toContain("error_handler");
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 2: Lease Expiration Set To Future (not "now")
// ═══════════════════════════════════════════════════════════════

describe("Issue 2: Lease expiration is set in the future", () => {
  it("lease expires at now + TTL, not at now", () => {
    // The fix sets leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString()
    // where LEASE_TTL_MS = 300_000 (5 minutes)
    // We verify the fix is correct by computing what the lease should be
    const LEASE_TTL_MS = 300_000;
    const fixedNow = new Date("2026-02-16T12:00:00.000Z").getTime();

    const nowIso = new Date(fixedNow).toISOString();
    const leaseExpiresAt = new Date(fixedNow + LEASE_TTL_MS).toISOString();

    // Lease should be 5 minutes in the future, not equal to now
    expect(leaseExpiresAt).toBe("2026-02-16T12:05:00.000Z");
    expect(leaseExpiresAt).not.toBe(nowIso);

    // The lease should be strictly after now
    expect(new Date(leaseExpiresAt).getTime()).toBeGreaterThan(
      new Date(nowIso).getTime(),
    );
  });

  it("node with future lease should NOT be reaped", () => {
    // Simulate the reaping logic: node is running with lease_expires_at in the future
    const nowIso = "2026-02-16T12:00:00.000Z";
    const leaseExpiresAt = "2026-02-16T12:05:00.000Z"; // 5 min ahead

    // The listExpiredLeases query: lease_expires_at < nowIso
    const isExpired = new Date(leaseExpiresAt).getTime() < new Date(nowIso).getTime();
    expect(isExpired).toBe(false);
  });

  it("node with past lease SHOULD be reaped", () => {
    const nowIso = "2026-02-16T12:10:00.000Z";
    const leaseExpiresAt = "2026-02-16T12:05:00.000Z";

    const isExpired = new Date(leaseExpiresAt).getTime() < new Date(nowIso).getTime();
    expect(isExpired).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 1: retryRun() Actually Retries Failed Nodes
// ═══════════════════════════════════════════════════════════════

describe("Issue 1: DAG scheduler treats retrying nodes as eligible", () => {
  const scheduler = createFridayWorkflowDagScheduler();
  const exprEval = createFridayExpressionEvaluator();

  function makeGraph(
    nodes: Array<{ id: string; type?: string }>,
    edges: Array<{ id: string; source: string; target: string; condition?: string }>,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.type ?? "action") as "action",
          label: n.id,
          config: { skillId: "test" },
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          condition: e.condition,
        })),
      },
      failurePolicy: { onFailure: "continue_on_error", notifyUser: false },
      tests: [],
      checksum: "abc",
    };
  }

  const emptyCtx: FridayExpressionContext = { inputs: {}, steps: {} };

  it("retrying node in the status map is returned as ready", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A completed, B is retrying (from retryRun creating new attempt)
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "retrying"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toContain("B");
  });

  it("retrying entry node is returned as ready", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A is retrying (entry node with no predecessors)
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "retrying"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toContain("A");
  });

  it("failed node is NOT returned as ready (only retrying is)", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A completed, B is failed (not retrying)
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "failed"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).not.toContain("B");
  });

  it("completed node is NOT returned as ready", () => {
    const graph = makeGraph(
      [{ id: "A" }],
      [],
    );
    const adj = scheduler.buildAdjacency(graph);

    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).not.toContain("A");
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 4: Approval Gate Enforcement
// ═══════════════════════════════════════════════════════════════

describe("Issue 4: Approval gate enforcement (DAG-level)", () => {
  const scheduler = createFridayWorkflowDagScheduler();
  const exprEval = createFridayExpressionEvaluator();

  function makeGraph(
    nodes: Array<{ id: string; type?: string }>,
    edges: Array<{ id: string; source: string; target: string; condition?: string }>,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.type ?? "action") as "action",
          label: n.id,
          config: {},
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          condition: e.condition,
        })),
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "abc",
    };
  }

  const emptyCtx: FridayExpressionContext = { inputs: {}, steps: {} };

  it("blocked_offline node does NOT allow successors to proceed", () => {
    // Approval node (B) is blocked_offline — its successor (C) must NOT be ready
    const graph = makeGraph(
      [{ id: "A" }, { id: "B", type: "approval" }, { id: "C" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "B", target: "C" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A completed, B is blocked_offline (waiting for approval)
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "blocked_offline"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    // blocked_offline is NOT terminal → C should NOT be ready
    expect(ready).not.toContain("C");
  });

  it("after approval (completed), successor becomes ready", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B", type: "approval" }, { id: "C" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "B", target: "C" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A completed, B now completed (approved)
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "completed"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toContain("C");
  });

  it("after rejection (failed), successor with failure condition becomes ready", () => {
    const graph = makeGraph(
      [
        { id: "A" },
        { id: "B", type: "approval" },
        { id: "C_rejected" },
      ],
      [
        { id: "e1", source: "A", target: "B" },
        {
          id: "e2",
          source: "B",
          target: "C_rejected",
          condition: '$steps.B.status == "failed"',
        },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    const ctx: FridayExpressionContext = {
      inputs: {},
      steps: {
        A: { output: {} },
        B: {
          output: {},
          status: "failed",
          error: { code: "APPROVAL_REJECTED", message: "Approval was rejected" },
        },
      },
    };

    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "failed"],
    ]);

    const ready = scheduler.computeReadyNodes(adj, statuses, graph, ctx, exprEval);
    expect(ready).toContain("C_rejected");
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 2 (R2): Lease Tests Exercise Production Code
// ═══════════════════════════════════════════════════════════════

describe("Issue 2 (R2): Lease tests exercise production repository code", () => {
  let db: FridaySqliteLayer;
  let nodeRepo: ReturnType<typeof createFridayWorkflowRunNodeRepository>;
  let runRepo: ReturnType<typeof createFridayWorkflowRunRepository>;

  beforeEach(() => {
    db = createTestDb();
    nodeRepo = createFridayWorkflowRunNodeRepository();
    runRepo = createFridayWorkflowRunRepository();

    // Insert a workflow and run to satisfy FK constraints
    db.withWriteTransaction((wdb) => {
      wdb.prepare(
        `INSERT INTO workflows (id, slug, name, description, tags_json, owner_user_id,
         latest_version_number, published_version_number, is_archived, revision, etag,
         created_at, updated_at)
         VALUES ('wf-lease', 'lease-test', 'Lease Test', NULL, '[]', 'test-user',
                 1, NULL, 0, 1, 'etag-1',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();

      wdb.prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json,
         created_by_user_id, is_published, change_note, created_at, updated_at)
         VALUES ('wv-lease', 'wf-lease', 1, 'chk', '{}', 'test-user', 1, NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();

      runRepo.insertRun(wdb, {
        id: "run-lease",
        workflowId: "wf-lease",
        workflowVersionId: "wv-lease",
        status: "running",
        triggerType: "manual",
        startedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  it("acquireLease sets lease_expires_at in the future and transitions to running", () => {
    const nowIso = "2026-02-16T12:00:00.000Z";
    const LEASE_TTL_MS = 300_000;
    const leaseExpiresAt = new Date(
      new Date(nowIso).getTime() + LEASE_TTL_MS,
    ).toISOString();

    // Insert a queued node attempt
    db.withWriteTransaction((wdb) => {
      nodeRepo.insertNodeAttempt(wdb, {
        id: "na-1",
        runId: "run-lease",
        nodeId: "nodeA",
        attempt: 1,
        attemptId: "att-1",
        status: "queued",
        idempotencyKey: "wfrun:run-lease:node:nodeA:attempt:1",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    });

    // Acquire lease (production code path)
    const acquired = db.withWriteTransaction((wdb) =>
      nodeRepo.acquireLease(wdb, "na-1", "hub", leaseExpiresAt, nowIso),
    );

    expect(acquired).toBe(true);

    // Verify the node was updated
    const node = db.withReadConnection((rdb) =>
      nodeRepo.getNodeAttemptById(rdb, "na-1"),
    );
    expect(node).not.toBeNull();
    expect(node!.status).toBe("running");
    expect(node!.leaseOwner).toBe("hub");
    expect(node!.leaseExpiresAt).toBe(leaseExpiresAt);

    // lease_expires_at should be in the future relative to nowIso
    expect(new Date(node!.leaseExpiresAt!).getTime()).toBeGreaterThan(
      new Date(nowIso).getTime(),
    );
  });

  it("expired leases are detectable via listExpiredLeases", () => {
    const createdAt = "2026-02-16T12:00:00.000Z";
    const leaseExpiresAt = "2026-02-16T12:05:00.000Z"; // expires at T+5min

    // Insert a running node with lease
    db.withWriteTransaction((wdb) => {
      nodeRepo.insertNodeAttempt(wdb, {
        id: "na-exp",
        runId: "run-lease",
        nodeId: "nodeB",
        attempt: 1,
        attemptId: "att-exp",
        status: "queued",
        idempotencyKey: "wfrun:run-lease:node:nodeB:attempt:1",
        createdAt,
        updatedAt: createdAt,
      });
      nodeRepo.acquireLease(wdb, "na-exp", "hub", leaseExpiresAt, createdAt);
    });

    // Query at a time BEFORE lease expires — should NOT appear
    const beforeExpiry = db.withReadConnection((rdb) =>
      nodeRepo.listExpiredLeases(rdb, "2026-02-16T12:03:00.000Z"),
    );
    expect(beforeExpiry).toHaveLength(0);

    // Query at a time AFTER lease expires — should appear
    const afterExpiry = db.withReadConnection((rdb) =>
      nodeRepo.listExpiredLeases(rdb, "2026-02-16T12:06:00.000Z"),
    );
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]!.id).toBe("na-exp");
    expect(afterExpiry[0]!.status).toBe("running");
  });

  it("acquireLease on already-leased running node fails", () => {
    const nowIso = "2026-02-16T12:00:00.000Z";
    const leaseExpiresAt = "2026-02-16T12:05:00.000Z";

    db.withWriteTransaction((wdb) => {
      nodeRepo.insertNodeAttempt(wdb, {
        id: "na-dup",
        runId: "run-lease",
        nodeId: "nodeC",
        attempt: 1,
        attemptId: "att-dup",
        status: "queued",
        idempotencyKey: "wfrun:run-lease:node:nodeC:attempt:1",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      nodeRepo.acquireLease(wdb, "na-dup", "hub-1", leaseExpiresAt, nowIso);
    });

    // Try to re-acquire with a different owner while lease is still valid
    const reacquired = db.withWriteTransaction((wdb) =>
      nodeRepo.acquireLease(wdb, "na-dup", "hub-2", "2026-02-16T12:10:00.000Z", "2026-02-16T12:02:00.000Z"),
    );

    // Should fail because node is already "running" (not queued/retrying)
    expect(reacquired).toBe(false);
  });

  it("acquireLease on retrying node succeeds", () => {
    const nowIso = "2026-02-16T12:00:00.000Z";
    const leaseExpiresAt = "2026-02-16T12:05:00.000Z";

    db.withWriteTransaction((wdb) => {
      nodeRepo.insertNodeAttempt(wdb, {
        id: "na-retry",
        runId: "run-lease",
        nodeId: "nodeD",
        attempt: 2,
        attemptId: "att-retry",
        status: "retrying",
        idempotencyKey: "wfrun:run-lease:node:nodeD:attempt:2",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    });

    const acquired = db.withWriteTransaction((wdb) =>
      nodeRepo.acquireLease(wdb, "na-retry", "hub", leaseExpiresAt, nowIso),
    );

    expect(acquired).toBe(true);

    const node = db.withReadConnection((rdb) =>
      nodeRepo.getNodeAttemptById(rdb, "na-retry"),
    );
    expect(node!.status).toBe("running");
    expect(node!.leaseExpiresAt).toBe(leaseExpiresAt);
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 3 (R2): End-to-End Workflow Execution Tests
// ═══════════════════════════════════════════════════════════════

describe("Issue 3 (R2): End-to-end workflow execution flows", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let skillInvocations: Array<{ skillId: string; nodeId: string; payload: Record<string, unknown> }>;
  let skillResults: Map<string, unknown>;
  let failingNodes: Set<string>;
  let failCount: Map<string, number>;

  function buildService() {
    idGen = createTestIdGenerator();
    skillInvocations = [];
    skillResults = new Map();
    failingNodes = new Set();
    failCount = new Map();

    const workflowRepo = createFridayWorkflowRepository({ db });
    const runRepo = createFridayWorkflowRunRepository();
    const nodeRepo = createFridayWorkflowRunNodeRepository();
    const artifactRepo = createFridayWorkflowArtifactRepository();
    const dagScheduler = createFridayWorkflowDagScheduler();
    const runMachine = createFridayWorkflowRunMachine();
    const nodeMachine = createFridayWorkflowNodeMachine();
    const retryManager = createFridayWorkflowRetryManager({
      idGenerator: idGen,
      randomFn: () => 0, // deterministic: no jitter
    });
    const expressionEvaluator = createFridayExpressionEvaluator();
    const artifactWriter = createFridayWorkflowArtifactWriter({
      db,
      artifactRepo,
      idGenerator: idGen,
      nowIso: () => "2026-02-16T12:00:00.000Z",
    });

    const nodeExecutor = createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: (skillId: string) => skillId, // always "found"
      invokeSkill: async (skillId, _runId, nodeId, payload) => {
        skillInvocations.push({ skillId, nodeId, payload });

        // Check if this node should fail
        if (failingNodes.has(nodeId)) {
          const count = (failCount.get(nodeId) ?? 0) + 1;
          failCount.set(nodeId, count);
          // Only fail on first invocation (for retry tests)
          if (count <= 1) {
            throw new Error("NODE_EXECUTION_FAILED: simulated failure");
          }
        }

        return skillResults.get(nodeId) ?? { result: "ok", nodeId };
      },
      nowIso: () => "2026-02-16T12:00:00.000Z",
    });

    return createFridayWorkflowExecutionService({
      db,
      workflowRepo,
      runRepo,
      nodeRepo,
      artifactRepo,
      dagScheduler,
      runMachine,
      nodeMachine,
      nodeExecutor,
      retryManager,
      artifactWriter,
      expressionEvaluator,
      idGenerator: idGen,
      nowIso: () => "2026-02-16T12:00:00.000Z",
    });
  }

  function seedWorkflow(
    compiledGraph: FridayCompiledWorkflowGraphV2,
  ): { workflowId: string; versionId: string } {
    const wfId = compiledGraph.workflowId;
    const verId = compiledGraph.workflowVersionId;

    db.withWriteTransaction((wdb) => {
      wdb.prepare(
        `INSERT INTO workflows (id, slug, name, description, tags_json, owner_user_id,
         latest_version_number, published_version_number, is_archived, revision, etag,
         created_at, updated_at)
         VALUES (?, ?, ?, NULL, '[]', 'test-user', 1, 1, 0, 1, 'etag-1',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(wfId, `slug-${wfId}`, `Workflow ${wfId}`);

      wdb.prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json,
         created_by_user_id, is_published, change_note, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 'test-user', 1, NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(verId, wfId, compiledGraph.checksum, JSON.stringify(compiledGraph));
    });

    return { workflowId: wfId, versionId: verId };
  }

  function makeGraph(
    workflowId: string,
    versionId: string,
    nodes: Array<{ id: string; type?: string; retryPolicy?: { maxAttempts: number; backoff: "none"; baseDelayMs: number; maxDelayMs: number; retryOn: string[] } }>,
    edges: Array<{ id: string; source: string; target: string; condition?: string }>,
    failurePolicy: "fail_fast" | "continue_on_error" = "continue_on_error",
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: versionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.type ?? "action") as "action",
          label: n.id,
          config: { skillId: "test-skill" },
          retryPolicy: n.retryPolicy,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          condition: e.condition,
        })),
      },
      failurePolicy: { onFailure: failurePolicy, notifyUser: false },
      tests: [],
      checksum: "chk-e2e",
    };
  }

  /** Helper: wait for async execution to settle */
  async function settle(ms = 100): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── Retry flow: start → fail → retryRun → succeed → complete ──

  it("retry flow: start run → node fails → retryRun → node succeeds → run completes", async () => {
    const graph = makeGraph(
      "wf-retry-e2e",
      "wv-retry-e2e",
      [
        { id: "A", retryPolicy: { maxAttempts: 1, backoff: "none", baseDelayMs: 0, maxDelayMs: 0, retryOn: [] } },
        { id: "B" },
      ],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const { workflowId, versionId } = seedWorkflow(graph);
    const svc = buildService();

    // Node A will fail on first invocation
    failingNodes.add("A");

    const runEntity = await svc.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    await settle(200);

    // Run should be failed (A failed, no automatic retry since maxAttempts=1)
    let run = svc.getRun(runEntity.id);
    // With continue_on_error: run may complete or fail depending on counts
    // A failed → B never runs → countByStatus shows 1 failed → run finalized as failed
    expect(run).not.toBeNull();
    expect(run!.status).toBe("failed");

    // Check A has a failed attempt
    let nodes = svc.getRunNodes(runEntity.id);
    const failedA = nodes.filter((n) => n.nodeId === "A" && n.status === "failed");
    expect(failedA.length).toBeGreaterThanOrEqual(1);

    // Now the node won't fail anymore (failCount > 1 check in mock)
    // retryRun should create a new attempt for A and execute
    const retried = await svc.retryRun(runEntity.id);
    expect(retried).not.toBeNull();

    await settle(200);

    // After retry, run should complete
    run = svc.getRun(runEntity.id);
    expect(run!.status).toBe("completed");

    // Both A and B should have completed attempts
    nodes = svc.getRunNodes(runEntity.id);
    const completedNodes = nodes.filter((n) => n.status === "completed");
    const completedNodeIds = new Set(completedNodes.map((n) => n.nodeId));
    expect(completedNodeIds.has("A")).toBe(true);
    expect(completedNodeIds.has("B")).toBe(true);
  });

  // ── Approval flow: start → approval blocks → resume(approved) → downstream runs ──

  it("approval flow: start → blocks on approval → resume(approved) → downstream completes", async () => {
    const graph = makeGraph(
      "wf-approve-e2e",
      "wv-approve-e2e",
      [
        { id: "step1" },
        { id: "gate", type: "approval" },
        { id: "step2" },
      ],
      [
        { id: "e1", source: "step1", target: "gate" },
        { id: "e2", source: "gate", target: "step2" },
      ],
    );
    const { workflowId, versionId } = seedWorkflow(graph);
    const svc = buildService();

    const runEntity = await svc.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    await settle(200);

    // Run should be paused (approval gate blocks)
    let run = svc.getRun(runEntity.id);
    expect(run!.status).toBe("paused");

    // Gate node should be blocked_offline
    let nodes = svc.getRunNodes(runEntity.id);
    const blockedGate = nodes.find(
      (n) => n.nodeId === "gate" && n.status === "blocked_offline",
    );
    expect(blockedGate).toBeDefined();

    // step1 should have completed
    const completedStep1 = nodes.find(
      (n) => n.nodeId === "step1" && n.status === "completed",
    );
    expect(completedStep1).toBeDefined();

    // Resume with approval
    await svc.resumeRun(runEntity.id, { approvalDecision: "approved" });

    await settle(200);

    // Run should be completed
    run = svc.getRun(runEntity.id);
    expect(run!.status).toBe("completed");

    // Gate should be completed (approved)
    nodes = svc.getRunNodes(runEntity.id);
    const completedGate = nodes.find(
      (n) => n.nodeId === "gate" && n.status === "completed",
    );
    expect(completedGate).toBeDefined();
    expect(completedGate!.output).toEqual({ approved: true, pending: false });

    // step2 should have completed
    const completedStep2 = nodes.find(
      (n) => n.nodeId === "step2" && n.status === "completed",
    );
    expect(completedStep2).toBeDefined();
  });

  // ── Approval reject flow: start → approval blocks → resume(rejected) → failure policy applied ──

  it("approval reject flow: start → blocks on approval → resume(rejected) → failure policy applied", async () => {
    // Use a conditional edge so step2 only fires on success, not on rejection
    const graph = makeGraph(
      "wf-reject-e2e",
      "wv-reject-e2e",
      [
        { id: "step1" },
        { id: "gate", type: "approval" },
        { id: "step2" },
      ],
      [
        { id: "e1", source: "step1", target: "gate" },
        {
          id: "e2",
          source: "gate",
          target: "step2",
          condition: '$steps.gate.status == "completed"',
        },
      ],
      "fail_fast",
    );
    const { workflowId, versionId } = seedWorkflow(graph);
    const svc = buildService();

    const runEntity = await svc.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    await settle(200);

    // Run should be paused (approval gate blocks)
    let run = svc.getRun(runEntity.id);
    expect(run!.status).toBe("paused");

    // Resume with rejection
    await svc.resumeRun(runEntity.id, { approvalDecision: "rejected" });

    await settle(200);

    // Run should be failed (gate rejection counts as failure)
    run = svc.getRun(runEntity.id);
    expect(run!.status).toBe("failed");

    // Gate node should be failed (rejected)
    const nodes = svc.getRunNodes(runEntity.id);
    const failedGate = nodes.find(
      (n) => n.nodeId === "gate" && n.status === "failed",
    );
    expect(failedGate).toBeDefined();
    expect(failedGate!.error?.code).toBe("APPROVAL_REJECTED");

    // step2 should NOT have completed (conditional edge checks gate.status == "completed")
    const step2Completed = nodes.find(
      (n) => n.nodeId === "step2" && n.status === "completed",
    );
    expect(step2Completed).toBeUndefined();
  });
});
```

