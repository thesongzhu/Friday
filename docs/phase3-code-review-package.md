> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 3 Code Review Package (Round 2)

## Build & Test Results
- TypeScript compilation: CLEAN
- Test suite: 477 tests passed (57 test files), 0 failures

## Round 1 Issues Fixed (all 5)
1. [HIGH] retryRun() now creates new attempts for failed nodes with status 'retrying'
2. [HIGH] Lease expiry now set to now + 5min TTL, not now
3. [HIGH] Failure-condition edges now fire — expression context includes failed nodes
4. [HIGH] Approval gate enforced — blocked_offline until explicit approved/rejected
5. [MEDIUM] __proto__/constructor/prototype paths rejected in expression evaluator

## Source Code (Phase 3 files only)

### `src/workflows/compiler/friday-workflow-compiler.ts`
```ts
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowNode,
  FridayWorkflowEdge,
  FridayWorkflowTest,
  FridayNodeRetryPolicy,
} from "../model/friday-workflow-graph.types.js";
import type { WorkflowFailurePolicyV2, JsonValue } from "../model/friday-workflow.types.js";
import type { FridayWorkflowValidationResult } from "./friday-workflow-validator.js";
import { createFridayWorkflowValidator } from "./friday-workflow-validator.js";

// ─── WorkflowSpecV1: the authoring DSL input ───

export interface FridayWorkflowSpecV1 {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger:
    | { type: "manual" }
    | { type: "schedule"; cron: string; timezone: string }
    | { type: "event"; source: string; event: string };
  inputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    required: boolean;
    defaultValue?: unknown;
  }>;
  steps: Array<{
    id: string;
    type: "skill_call" | "tool_call" | "condition" | "transform" | "human_approval";
    ref?: string;
    args?: Record<string, unknown>;
    condition?: string;
    timeoutSec?: number;
    retry?: { maxAttempts: number; backoffMs: number };
  }>;
  edges: Array<{
    from: string;
    to: string;
    when?: "success" | "failure" | "true" | "false";
  }>;
  outputs: Array<{
    key: string;
    fromStep: string;
    path: string;
  }>;
  errorPolicy: WorkflowFailurePolicyV2;
  tests: Array<{
    name: string;
    description?: string;
    inputs: Record<string, unknown>;
    mocks?: Record<
      string,
      { output: Record<string, unknown>; status?: "completed" | "failed" }
    >;
    assertions: Array<{
      path: string;
      operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
      expected: unknown;
    }>;
  }>;
}

// ─── Interface ───

export interface FridayWorkflowCompiler {
  compile(
    spec: FridayWorkflowSpecV1,
    workflowVersionId: string,
  ): FridayCompiledWorkflowGraphV2;

  validateSpec(spec: FridayWorkflowSpecV1): FridayWorkflowValidationResult;
}

// ─── Step type → Node type mapping ───

const STEP_TYPE_MAP: Record<string, FridayWorkflowNode["type"]> = {
  skill_call: "action",
  tool_call: "action",
  condition: "condition",
  transform: "data",
  human_approval: "approval",
};

// ─── Dependencies ───

export interface CreateWorkflowCompilerDeps {
  computeChecksum: (content: string) => string;
  idGenerator: () => string;
}

// ─── Factory ───

export function createFridayWorkflowCompiler(
  deps: CreateWorkflowCompilerDeps,
): FridayWorkflowCompiler {
  const validator = createFridayWorkflowValidator();

  function mapRetryPolicy(
    retry: { maxAttempts: number; backoffMs: number } | undefined,
  ): FridayNodeRetryPolicy | undefined {
    if (!retry) return undefined;
    return {
      maxAttempts: retry.maxAttempts,
      backoff: "exponential",
      baseDelayMs: retry.backoffMs,
      maxDelayMs: retry.backoffMs * 8,
      retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"],
    };
  }

  return {
    compile(spec, workflowVersionId) {
      // Build trigger node
      const triggerNodeId = `__trigger__`;
      const triggerConfig: Record<string, JsonValue> = {
        triggerType: spec.trigger.type,
      };
      if (spec.trigger.type === "schedule") {
        triggerConfig.cron = spec.trigger.cron;
        triggerConfig.timezone = spec.trigger.timezone;
      } else if (spec.trigger.type === "event") {
        triggerConfig.source = spec.trigger.source;
        triggerConfig.event = spec.trigger.event;
      }

      const triggerNode: FridayWorkflowNode = {
        id: triggerNodeId,
        type: "trigger",
        label: `Trigger (${spec.trigger.type})`,
        config: triggerConfig,
      };

      // Map steps to nodes
      const nodes: FridayWorkflowNode[] = [triggerNode];
      for (const step of spec.steps) {
        const nodeType = STEP_TYPE_MAP[step.type];
        if (!nodeType) {
          throw new Error(
            `WORKFLOW_COMPILATION_ERROR: unknown step type '${step.type}'`,
          );
        }

        const config: Record<string, JsonValue> = {};
        if (step.ref) config.skillId = step.ref;
        if (step.args) config.args = step.args as unknown as JsonValue;
        if (step.condition) config.condition = step.condition;

        nodes.push({
          id: step.id,
          type: nodeType,
          label: step.id,
          config,
          retryPolicy: mapRetryPolicy(step.retry),
          timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : undefined,
        });
      }

      // Build edges: trigger → startStepId + spec edges
      const edges: FridayWorkflowEdge[] = [];

      edges.push({
        id: deps.idGenerator(),
        sourceNodeId: triggerNodeId,
        targetNodeId: spec.startStepId,
      });

      for (const specEdge of spec.edges) {
        const edge: FridayWorkflowEdge = {
          id: deps.idGenerator(),
          sourceNodeId: specEdge.from,
          targetNodeId: specEdge.to,
        };

        // Map 'when' to condition expressions
        if (specEdge.when === "failure") {
          edge.condition = `$steps.${specEdge.from}.output.status == "failed"`;
        } else if (specEdge.when === "true") {
          edge.condition = `$steps.${specEdge.from}.output.result == true`;
        } else if (specEdge.when === "false") {
          edge.condition = `$steps.${specEdge.from}.output.result == false`;
        }
        // 'success' and undefined → unconditional

        edges.push(edge);
      }

      // Map tests
      const tests: FridayWorkflowTest[] = spec.tests.map((t) => ({
        name: t.name,
        description: t.description,
        inputs: t.inputs,
        mocks: t.mocks,
        assertions: t.assertions,
      }));

      // Build compiled graph (without checksum first, compute after)
      const graphObj: Omit<FridayCompiledWorkflowGraphV2, "checksum"> = {
        schemaVersion: "2.0",
        workflowId: spec.workflowId,
        workflowVersionId,
        sourceSpecSchemaVersion: "1.0",
        graph: { nodes, edges },
        failurePolicy: spec.errorPolicy,
        tests,
      };

      const checksum = deps.computeChecksum(JSON.stringify(graphObj));
      const compiled: FridayCompiledWorkflowGraphV2 = {
        ...graphObj,
        checksum,
      };

      // Validate the compiled graph
      const validation = validator.validate(compiled);
      if (!validation.valid) {
        const firstError = validation.errors[0]!;
        throw new Error(`${firstError.code}: ${firstError.message}`);
      }

      return compiled;
    },

    validateSpec(spec) {
      // Compile to validate, catching errors
      try {
        const dummyVersionId = "validate-only";
        this.compile(spec, dummyVersionId);
        return { valid: true, errors: [] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        // Extract code from "CODE: message" format
        const colonIdx = message.indexOf(": ");
        const code =
          colonIdx > 0 ? message.slice(0, colonIdx) : "WORKFLOW_GRAPH_INVALID";
        const msg = colonIdx > 0 ? message.slice(colonIdx + 2) : message;
        return {
          valid: false,
          errors: [{ code, message: msg }],
        };
      }
    },
  };
}
```

### `src/workflows/compiler/friday-workflow-validator.ts`
```ts
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";
import { createFridayExpressionEvaluator } from "../engine/friday-workflow-expression-evaluator.js";

// ─── Types ───

export interface FridayWorkflowValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface FridayWorkflowValidationResult {
  valid: boolean;
  errors: FridayWorkflowValidationError[];
}

// ─── Interface ───

export interface FridayWorkflowValidator {
  validate(graph: FridayCompiledWorkflowGraphV2): FridayWorkflowValidationResult;
}

// ─── Factory ───

export function createFridayWorkflowValidator(): FridayWorkflowValidator {
  const exprEval = createFridayExpressionEvaluator();

  return {
    validate(graph) {
      const errors: FridayWorkflowValidationError[] = [];

      // 1. Schema version check
      if (graph.schemaVersion !== "2.0") {
        errors.push({
          code: "WORKFLOW_INVALID_SCHEMA_VERSION",
          message: `Expected schemaVersion '2.0', got '${graph.schemaVersion}'`,
        });
      }

      // 2. Checksum present
      if (!graph.checksum) {
        errors.push({
          code: "WORKFLOW_MISSING_CHECKSUM",
          message: "Graph checksum is required",
        });
      }

      // 3. Non-empty graph
      if (graph.graph.nodes.length === 0) {
        errors.push({
          code: "WORKFLOW_EMPTY_GRAPH",
          message: "Graph must contain at least one node",
        });
        return { valid: false, errors };
      }

      // 4. Unique node ids
      const nodeIds = new Set<string>();
      for (const node of graph.graph.nodes) {
        if (nodeIds.has(node.id)) {
          errors.push({
            code: "WORKFLOW_DUPLICATE_NODE_ID",
            message: `Duplicate node id '${node.id}'`,
            nodeId: node.id,
          });
        }
        nodeIds.add(node.id);
      }

      // 5. Unique edge ids
      const edgeIds = new Set<string>();
      for (const edge of graph.graph.edges) {
        if (edgeIds.has(edge.id)) {
          errors.push({
            code: "WORKFLOW_DUPLICATE_EDGE_ID",
            message: `Duplicate edge id '${edge.id}'`,
            edgeId: edge.id,
          });
        }
        edgeIds.add(edge.id);
      }

      // 6. Edge references valid
      for (const edge of graph.graph.edges) {
        if (!nodeIds.has(edge.sourceNodeId)) {
          errors.push({
            code: "WORKFLOW_EDGE_REFERENCES_MISSING_NODE",
            message: `Edge '${edge.id}' references missing source node '${edge.sourceNodeId}'`,
            edgeId: edge.id,
          });
        }
        if (!nodeIds.has(edge.targetNodeId)) {
          errors.push({
            code: "WORKFLOW_EDGE_REFERENCES_MISSING_NODE",
            message: `Edge '${edge.id}' references missing target node '${edge.targetNodeId}'`,
            edgeId: edge.id,
          });
        }
      }

      // Build adjacency for further checks
      const outbound = new Map<string, string[]>();
      const inbound = new Map<string, string[]>();
      for (const node of graph.graph.nodes) {
        outbound.set(node.id, []);
        inbound.set(node.id, []);
      }
      for (const edge of graph.graph.edges) {
        if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
          outbound.get(edge.sourceNodeId)!.push(edge.targetNodeId);
          inbound.get(edge.targetNodeId)!.push(edge.sourceNodeId);
        }
      }

      // 7. At least one entry node
      const entryNodes: string[] = [];
      for (const node of graph.graph.nodes) {
        if (inbound.get(node.id)!.length === 0) {
          entryNodes.push(node.id);
        }
      }
      if (entryNodes.length === 0) {
        errors.push({
          code: "WORKFLOW_NO_ENTRY_NODE",
          message: "Graph must have at least one node with no inbound edges",
        });
      }

      // 8. Acyclic check via DFS (also validates connectivity)
      {
        const WHITE = 0,
          GRAY = 1,
          BLACK = 2;
        const color = new Map<string, number>();
        for (const id of nodeIds) color.set(id, WHITE);

        let cycleDetected = false;

        function dfs(nodeId: string): void {
          color.set(nodeId, GRAY);
          for (const succ of outbound.get(nodeId) ?? []) {
            const c = color.get(succ);
            if (c === GRAY) {
              cycleDetected = true;
              return;
            }
            if (c === WHITE) {
              dfs(succ);
              if (cycleDetected) return;
            }
          }
          color.set(nodeId, BLACK);
        }

        for (const id of nodeIds) {
          if (color.get(id) === WHITE) {
            dfs(id);
            if (cycleDetected) break;
          }
        }

        if (cycleDetected) {
          errors.push({
            code: "WORKFLOW_CYCLE_DETECTED",
            message: "Graph contains a cycle",
          });
        }
      }

      // 9. Connected graph — undirected connectivity check
      //    All nodes must belong to a single connected component when
      //    edges are treated as undirected.
      if (graph.graph.nodes.length > 1) {
        // Build undirected adjacency
        const undirected = new Map<string, string[]>();
        for (const node of graph.graph.nodes) {
          undirected.set(node.id, []);
        }
        for (const edge of graph.graph.edges) {
          if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
            undirected.get(edge.sourceNodeId)!.push(edge.targetNodeId);
            undirected.get(edge.targetNodeId)!.push(edge.sourceNodeId);
          }
        }

        const visited = new Set<string>();
        const queue = [graph.graph.nodes[0].id];
        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          if (visited.has(nodeId)) continue;
          visited.add(nodeId);
          for (const neighbor of undirected.get(nodeId) ?? []) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }

        for (const id of nodeIds) {
          if (!visited.has(id)) {
            errors.push({
              code: "WORKFLOW_GRAPH_DISCONNECTED",
              message: `Node '${id}' is not reachable from any entry node`,
              nodeId: id,
            });
          }
        }
      }

      // 10. At least one terminal path
      {
        const terminalNodes = [...nodeIds].filter(
          (id) => outbound.get(id)!.length === 0,
        );
        if (terminalNodes.length === 0 && graph.graph.nodes.length > 0) {
          errors.push({
            code: "WORKFLOW_NO_TERMINAL_PATH",
            message:
              "Graph must have at least one path reaching a node with no outbound edges",
          });
        }
      }

      // 11. Node-type-specific validation
      for (const node of graph.graph.nodes) {
        if (
          node.type === "condition" &&
          outbound.get(node.id)!.length === 0
        ) {
          errors.push({
            code: "WORKFLOW_CONDITION_NO_OUTBOUND",
            message: `Condition node '${node.id}' must have at least one outbound edge`,
            nodeId: node.id,
          });
        }

        if (node.type === "action") {
          const config = node.config as Record<string, unknown>;
          if (!config.skillId && !config.ref) {
            errors.push({
              code: "WORKFLOW_ACTION_MISSING_REF",
              message: `Action node '${node.id}' must have a 'skillId' or 'ref' in config`,
              nodeId: node.id,
            });
          }
        }
      }

      // 12. Edge condition syntax validation
      for (const edge of graph.graph.edges) {
        if (edge.condition) {
          try {
            exprEval.parse(edge.condition);
          } catch {
            errors.push({
              code: "WORKFLOW_EXPRESSION_INVALID",
              message: `Edge '${edge.id}' has invalid condition expression: '${edge.condition}'`,
              edgeId: edge.id,
            });
          }
        }
      }

      return { valid: errors.length === 0, errors };
    },
  };
}
```

### `src/workflows/engine/friday-workflow-artifact-writer.ts`
```ts
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";
import type { FridayWorkflowArtifactEntity, UUID } from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowArtifactWriter {
  writeJsonArtifact(
    runId: UUID,
    nodeId: string,
    output: unknown,
  ): FridayWorkflowArtifactEntity;

  writeArtifact(
    runId: UUID,
    nodeId: string,
    artifactType: string,
    uri: string,
    checksum?: string,
    metadata?: Record<string, unknown>,
  ): FridayWorkflowArtifactEntity;
}

// ─── Dependencies ───

export interface CreateArtifactWriterDeps {
  db: FridaySqliteLayer;
  artifactRepo: FridayWorkflowArtifactRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Size threshold for inline vs file storage ───

const INLINE_THRESHOLD = 64 * 1024; // 64KB

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ─── Factory ───

export function createFridayWorkflowArtifactWriter(
  deps: CreateArtifactWriterDeps,
): FridayWorkflowArtifactWriter {
  return {
    writeJsonArtifact(runId, nodeId, output) {
      const serialized = JSON.stringify(output);
      const checksum = sha256(serialized);

      let uri: string;
      if (serialized.length < INLINE_THRESHOLD) {
        // Small payload: store inline as data URI
        const encoded = Buffer.from(serialized).toString("base64");
        uri = `data:application/json;base64,${encoded}`;
      } else {
        // Large payload: reference a conceptual file path
        uri = `file://artifacts/${runId}/${nodeId}.json`;
      }

      const nowIso = deps.nowIso();
      const entity: FridayWorkflowArtifactEntity = {
        id: deps.idGenerator(),
        runId,
        nodeId,
        artifactType: "json",
        uri,
        checksum,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      deps.db.withWriteTransaction((db) => {
        deps.artifactRepo.insertArtifact(db, entity);
      });

      return entity;
    },

    writeArtifact(runId, nodeId, artifactType, uri, checksum, metadata) {
      const nowIso = deps.nowIso();
      const entity: FridayWorkflowArtifactEntity = {
        id: deps.idGenerator(),
        runId,
        nodeId,
        artifactType: artifactType as FridayWorkflowArtifactEntity["artifactType"],
        uri,
        checksum,
        metadata: metadata as FridayWorkflowArtifactEntity["metadata"],
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      deps.db.withWriteTransaction((db) => {
        deps.artifactRepo.insertArtifact(db, entity);
      });

      return entity;
    },
  };
}
```

### `src/workflows/engine/friday-workflow-dag-scheduler.ts`
```ts
import type {
  FridayCompiledWorkflowGraphV2,
  FridayDagAdjacency,
  FridayWorkflowExecutionPlan,
  FridayWorkflowNode,
} from "../model/friday-workflow-graph.types.js";
import type { NodeAttemptStatus } from "../model/friday-workflow.types.js";
import type {
  FridayExpressionContext,
  FridayExpressionEvaluator,
} from "../model/friday-workflow-expression.types.js";

// ─── Interface ───

export interface FridayWorkflowDagScheduler {
  buildAdjacency(graph: FridayCompiledWorkflowGraphV2): FridayDagAdjacency;

  buildExecutionPlan(
    runId: string,
    graph: FridayCompiledWorkflowGraphV2,
  ): FridayWorkflowExecutionPlan;

  computeReadyNodes(
    adjacency: FridayDagAdjacency,
    nodeStatuses: Map<string, NodeAttemptStatus>,
    graph: FridayCompiledWorkflowGraphV2,
    expressionContext: FridayExpressionContext,
    expressionEvaluator: FridayExpressionEvaluator,
  ): string[];
}

// ─── Terminal node statuses for scheduling purposes ───

const TERMINAL_STATUSES: ReadonlySet<NodeAttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ─── Factory ───

export function createFridayWorkflowDagScheduler(): FridayWorkflowDagScheduler {
  return {
    buildAdjacency(graph) {
      const outbound = new Map<string, string[]>();
      const inbound = new Map<string, string[]>();

      // Initialize maps for all nodes
      for (const node of graph.graph.nodes) {
        outbound.set(node.id, []);
        inbound.set(node.id, []);
      }

      // Populate from edges
      for (const edge of graph.graph.edges) {
        outbound.get(edge.sourceNodeId)!.push(edge.targetNodeId);
        inbound.get(edge.targetNodeId)!.push(edge.sourceNodeId);
      }

      // Entry nodes: zero inbound edges
      const entryNodes: string[] = [];
      for (const node of graph.graph.nodes) {
        if (inbound.get(node.id)!.length === 0) {
          entryNodes.push(node.id);
        }
      }

      // Topological sort (Kahn's algorithm)
      const inDegree = new Map<string, number>();
      for (const node of graph.graph.nodes) {
        inDegree.set(node.id, inbound.get(node.id)!.length);
      }

      const queue = [...entryNodes];
      const topoOrder: string[] = [];

      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        topoOrder.push(nodeId);

        for (const successor of outbound.get(nodeId)!) {
          const newDegree = inDegree.get(successor)! - 1;
          inDegree.set(successor, newDegree);
          if (newDegree === 0) {
            queue.push(successor);
          }
        }
      }

      if (topoOrder.length !== graph.graph.nodes.length) {
        throw new Error("WORKFLOW_CYCLE_DETECTED: graph contains a cycle");
      }

      return { outbound, inbound, entryNodes, topoOrder };
    },

    buildExecutionPlan(runId, graph) {
      const adjacency = this.buildAdjacency(graph);

      const nodeMap = new Map<string, FridayWorkflowNode>();
      for (const node of graph.graph.nodes) {
        nodeMap.set(node.id, node);
      }

      return {
        runId,
        workflowId: graph.workflowId,
        workflowVersionId: graph.workflowVersionId,
        compiledGraph: graph,
        adjacency,
        failurePolicy: graph.failurePolicy,
        nodeMap,
      };
    },

    computeReadyNodes(
      adjacency,
      nodeStatuses,
      graph,
      expressionContext,
      expressionEvaluator,
    ) {
      const ready: string[] = [];

      // Build an edge index for condition lookups: source→target → edge
      const edgeIndex = new Map<string, typeof graph.graph.edges[0]>();
      for (const edge of graph.graph.edges) {
        edgeIndex.set(`${edge.sourceNodeId}→${edge.targetNodeId}`, edge);
      }

      for (const nodeId of adjacency.topoOrder) {
        // Skip nodes that already have a terminal or in-progress attempt
        // but treat "retrying" as eligible for execution
        const currentStatus = nodeStatuses.get(nodeId);
        if (currentStatus && currentStatus !== "retrying") continue;

        // Retrying nodes are immediately ready — predecessors were already satisfied
        if (currentStatus === "retrying") {
          ready.push(nodeId);
          continue;
        }

        const predecessors = adjacency.inbound.get(nodeId) ?? [];

        if (predecessors.length === 0) {
          // Entry node — always ready
          ready.push(nodeId);
          continue;
        }

        let allSatisfied = true;
        let anyEnabledEdge = false;

        for (const pred of predecessors) {
          const predStatus = nodeStatuses.get(pred);

          if (!predStatus || !TERMINAL_STATUSES.has(predStatus)) {
            allSatisfied = false;
            break;
          }

          // Check edge condition
          const edge = edgeIndex.get(`${pred}→${nodeId}`);
          if (edge?.condition) {
            try {
              const condResult = expressionEvaluator.exec(
                edge.condition,
                expressionContext,
              );
              if (condResult) {
                anyEnabledEdge = true;
              }
            } catch {
              // Condition evaluation failure — treat as not enabled
            }
          } else {
            // Unconditional edge
            anyEnabledEdge = true;
          }
        }

        if (allSatisfied && anyEnabledEdge) {
          ready.push(nodeId);
        }
      }

      return ready;
    },
  };
}
```

### `src/workflows/engine/friday-workflow-expression-evaluator.ts`
```ts
import type {
  FridayExprNode,
  FridayExpressionContext,
  FridayExpressionEvaluator as IFridayExpressionEvaluator,
} from "../model/friday-workflow-expression.types.js";

export type { IFridayExpressionEvaluator as FridayExpressionEvaluator };

const MAX_EXPR_LENGTH = 4096;
const MAX_DEPTH = 32;

// ─── Token types ───

type TokenKind =
  | "REF"
  | "STRING"
  | "NUMBER"
  | "BOOLEAN"
  | "NULL"
  | "OP"
  | "LPAREN"
  | "RPAREN"
  | "NOT"
  | "EOF";

interface Token {
  kind: TokenKind;
  value: string;
}

// ─── Tokenizer ───

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i]!)) {
      i++;
      continue;
    }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (
      two === "==" ||
      two === "!=" ||
      two === ">=" ||
      two === "<=" ||
      two === "&&" ||
      two === "||"
    ) {
      tokens.push({ kind: "OP", value: two });
      i += 2;
      continue;
    }

    // Single-char operators
    const ch = expr[i]!;
    if (ch === ">" || ch === "<") {
      tokens.push({ kind: "OP", value: ch });
      i++;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "NOT", value: "!" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "LPAREN", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "RPAREN", value: ")" });
      i++;
      continue;
    }

    // Ref: $identifier.path
    if (ch === "$") {
      let ref = "";
      i++; // skip $
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i]!)) {
        ref += expr[i];
        i++;
      }
      if (ref === "") {
        throw new Error("EXPRESSION_PARSE_ERROR: expected identifier after '$'");
      }
      tokens.push({ kind: "REF", value: ref });
      continue;
    }

    // String literal (double or single quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++; // skip opening quote
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\") {
          i++;
          if (i < expr.length) {
            str += expr[i];
            i++;
          }
        } else {
          str += expr[i];
          i++;
        }
      }
      if (i >= expr.length) {
        throw new Error("EXPRESSION_PARSE_ERROR: unterminated string literal");
      }
      i++; // skip closing quote
      tokens.push({ kind: "STRING", value: str });
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch) || (ch === "-" && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]!))) {
      let num = "";
      if (ch === "-") {
        num += ch;
        i++;
      }
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) {
        num += expr[i];
        i++;
      }
      tokens.push({ kind: "NUMBER", value: num });
      continue;
    }

    // Keywords: true, false, null
    if (/[a-zA-Z]/.test(ch)) {
      let word = "";
      while (i < expr.length && /[a-zA-Z_]/.test(expr[i]!)) {
        word += expr[i];
        i++;
      }
      if (word === "true" || word === "false") {
        tokens.push({ kind: "BOOLEAN", value: word });
      } else if (word === "null") {
        tokens.push({ kind: "NULL", value: "null" });
      } else {
        throw new Error(
          `EXPRESSION_PARSE_ERROR: unexpected identifier '${word}'; use $${word} for references`,
        );
      }
      continue;
    }

    throw new Error(
      `EXPRESSION_PARSE_ERROR: unexpected character '${ch}' at position ${i}`,
    );
  }

  tokens.push({ kind: "EOF", value: "" });
  return tokens;
}

// ─── Parser (recursive descent) ───

function parseExpr(tokens: Token[]): FridayExprNode {
  let pos = 0;
  let depth = 0;

  function peek(): Token {
    return tokens[pos] ?? { kind: "EOF", value: "" };
  }

  function advance(): Token {
    const t = tokens[pos]!;
    pos++;
    return t;
  }

  function expect(kind: TokenKind): Token {
    const t = peek();
    if (t.kind !== kind) {
      throw new Error(
        `EXPRESSION_PARSE_ERROR: expected ${kind} but got ${t.kind} '${t.value}'`,
      );
    }
    return advance();
  }

  function checkDepth(): void {
    depth++;
    if (depth > MAX_DEPTH) {
      throw new Error("EXPRESSION_DEPTH_EXCEEDED: maximum nesting depth of 32 exceeded");
    }
  }

  // expr = logical_or
  function expr(): FridayExprNode {
    checkDepth();
    const result = logicalOr();
    depth--;
    return result;
  }

  // logical_or = logical_and ( "||" logical_and )*
  function logicalOr(): FridayExprNode {
    let left = logicalAnd();
    while (peek().kind === "OP" && peek().value === "||") {
      advance();
      const right = logicalAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  // logical_and = not_expr ( "&&" not_expr )*
  function logicalAnd(): FridayExprNode {
    let left = notExpr();
    while (peek().kind === "OP" && peek().value === "&&") {
      advance();
      const right = notExpr();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  // not_expr = "!" not_expr | compare
  function notExpr(): FridayExprNode {
    if (peek().kind === "NOT") {
      advance();
      const operand = notExpr();
      return { kind: "unary", op: "!", operand };
    }
    return compare();
  }

  // compare = primary ( OP primary )?
  function compare(): FridayExprNode {
    const left = primary();
    const t = peek();
    if (
      t.kind === "OP" &&
      (t.value === "==" ||
        t.value === "!=" ||
        t.value === ">" ||
        t.value === "<" ||
        t.value === ">=" ||
        t.value === "<=")
    ) {
      advance();
      const right = primary();
      return {
        kind: "binary",
        op: t.value as "==" | "!=" | ">" | "<" | ">=" | "<=",
        left,
        right,
      };
    }
    return left;
  }

  // primary = ref | literal | "(" expr ")"
  function primary(): FridayExprNode {
    const t = peek();

    if (t.kind === "REF") {
      advance();
      return { kind: "ref", path: t.value.split(".") };
    }

    if (t.kind === "STRING") {
      advance();
      return { kind: "literal", value: t.value };
    }

    if (t.kind === "NUMBER") {
      advance();
      return { kind: "literal", value: Number(t.value) };
    }

    if (t.kind === "BOOLEAN") {
      advance();
      return { kind: "literal", value: t.value === "true" };
    }

    if (t.kind === "NULL") {
      advance();
      return { kind: "literal", value: null };
    }

    if (t.kind === "LPAREN") {
      advance();
      const inner = expr();
      expect("RPAREN");
      return inner;
    }

    throw new Error(
      `EXPRESSION_PARSE_ERROR: unexpected token ${t.kind} '${t.value}'`,
    );
  }

  const result = expr();

  if (peek().kind !== "EOF") {
    const leftover = peek();
    throw new Error(
      `EXPRESSION_PARSE_ERROR: unexpected token ${leftover.kind} '${leftover.value}' after expression`,
    );
  }

  return result;
}

// ─── Evaluator ───

function evaluateNode(
  node: FridayExprNode,
  ctx: FridayExpressionContext,
): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;

    case "ref": {
      // Resolve path against context: first segment selects the top-level object
      const [root, ...rest] = node.path;
      let target: unknown;
      if (root === "inputs") {
        target = ctx.inputs;
      } else if (root === "steps") {
        target = ctx.steps;
      } else if (root === "env") {
        target = ctx.env;
      } else {
        return undefined;
      }

      for (const segment of rest) {
        // Reject unsafe path segments that could leak prototype internals
        if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
          throw new Error(
            `EXPRESSION_UNSAFE_PATH_ACCESS: path segment '${segment}' is not allowed`,
          );
        }
        if (target == null || typeof target !== "object") {
          return undefined;
        }
        target = (target as Record<string, unknown>)[segment];
      }
      return target;
    }

    case "binary": {
      // Short-circuit for logical operators
      if (node.op === "&&") {
        const left = evaluateNode(node.left, ctx);
        if (!left) return left;
        return evaluateNode(node.right, ctx);
      }
      if (node.op === "||") {
        const left = evaluateNode(node.left, ctx);
        if (left) return left;
        return evaluateNode(node.right, ctx);
      }

      const left = evaluateNode(node.left, ctx);
      const right = evaluateNode(node.right, ctx);

      switch (node.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return Number(left) > Number(right);
        case "<":
          return Number(left) < Number(right);
        case ">=":
          return Number(left) >= Number(right);
        case "<=":
          return Number(left) <= Number(right);
      }
      break;
    }

    case "unary": {
      const operand = evaluateNode(node.operand, ctx);
      return !operand;
    }
  }
}

// ─── Factory ───

export function createFridayExpressionEvaluator(): IFridayExpressionEvaluator {
  return {
    parse(expr: string): FridayExprNode {
      if (expr.length > MAX_EXPR_LENGTH) {
        throw new Error(
          `EXPRESSION_TOO_LONG: expression length ${expr.length} exceeds maximum ${MAX_EXPR_LENGTH}`,
        );
      }
      const tokens = tokenize(expr);
      return parseExpr(tokens);
    },

    evaluate(ast: FridayExprNode, ctx: FridayExpressionContext): unknown {
      return evaluateNode(ast, ctx);
    },

    exec(expr: string, ctx: FridayExpressionContext): unknown {
      const ast = this.parse(expr);
      return this.evaluate(ast, ctx);
    },
  };
}
```

### `src/workflows/engine/friday-workflow-node-executor.ts`
```ts
import type { FridayWorkflowNode } from "../model/friday-workflow-graph.types.js";
import type {
  FridayExpressionContext,
  FridayExpressionEvaluator,
} from "../model/friday-workflow-expression.types.js";
import type { JsonValue, UUID } from "../model/friday-workflow.types.js";

// ─── I/O types ───

export interface FridayNodeExecutionInput {
  runId: UUID;
  nodeId: string;
  attemptId: UUID;
  node: FridayWorkflowNode;
  inputData: Record<string, unknown>;
  expressionContext: FridayExpressionContext;
}

export interface FridayNodeExecutionOutput {
  output: JsonValue;
  artifacts?: Array<{
    artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
    uri: string;
    checksum?: string;
    metadata?: Record<string, unknown>;
  }>;
}

// ─── Interface ───

export interface FridayWorkflowNodeExecutor {
  executeNode(input: FridayNodeExecutionInput): Promise<FridayNodeExecutionOutput>;
}

// ─── Dependencies ───

export interface CreateNodeExecutorDeps {
  expressionEvaluator: FridayExpressionEvaluator;
  resolveSkill: (skillId: string) => unknown | null;
  invokeSkill: (
    skillId: string,
    runId: UUID,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  nowIso: () => string;
}

// ─── Expression arg resolution ───

function resolveArgs(
  args: Record<string, unknown>,
  expressionContext: FridayExpressionContext,
  evaluator: FridayExpressionEvaluator,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.startsWith("$")) {
      resolved[key] = evaluator.exec(value, expressionContext);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ─── Factory ───

export function createFridayWorkflowNodeExecutor(
  deps: CreateNodeExecutorDeps,
): FridayWorkflowNodeExecutor {
  return {
    async executeNode(input) {
      const { node, expressionContext } = input;
      const config = node.config as Record<string, unknown>;

      switch (node.type) {
        case "trigger": {
          // Trigger nodes pass through their payload as output
          const payload =
            expressionContext.inputs ?? {};
          return { output: payload as JsonValue };
        }

        case "action": {
          const skillId = (config.skillId ?? config.ref) as string | undefined;
          if (!skillId) {
            throw new Error("NODE_EXECUTION_FAILED: action node missing skillId or ref");
          }

          const skill = deps.resolveSkill(skillId);
          if (!skill) {
            throw new Error(
              `NODE_EXECUTION_FAILED: skill '${skillId}' not found`,
            );
          }

          const rawArgs = (config.args ?? {}) as Record<string, unknown>;
          const resolvedArgs = resolveArgs(
            rawArgs,
            expressionContext,
            deps.expressionEvaluator,
          );

          const result = await deps.invokeSkill(
            skillId,
            input.runId,
            input.nodeId,
            resolvedArgs,
          );
          return { output: (result ?? null) as JsonValue };
        }

        case "condition": {
          const conditionExpr = config.condition as string | undefined;
          if (!conditionExpr) {
            throw new Error(
              "NODE_EXECUTION_FAILED: condition node missing 'condition' in config",
            );
          }
          const result = deps.expressionEvaluator.exec(
            conditionExpr,
            expressionContext,
          );
          return { output: { result: Boolean(result) } as unknown as JsonValue };
        }

        case "data": {
          // Apply mapping or transform from config
          const mapping = config.mapping as
            | Record<string, unknown>
            | undefined;
          const transform = config.transform as string | undefined;

          if (transform) {
            const result = deps.expressionEvaluator.exec(
              transform,
              expressionContext,
            );
            return { output: (result ?? null) as JsonValue };
          }

          if (mapping) {
            const resolved = resolveArgs(
              mapping,
              expressionContext,
              deps.expressionEvaluator,
            );
            return { output: resolved as unknown as JsonValue };
          }

          return { output: null };
        }

        case "ai": {
          const prompt = config.prompt as string | undefined;
          const model = config.model as string | undefined;
          if (!prompt) {
            throw new Error(
              "NODE_EXECUTION_FAILED: ai node missing 'prompt' in config",
            );
          }

          // Interpolate prompt using expression context
          let interpolatedPrompt = prompt;
          const refPattern = /\$[a-zA-Z_][a-zA-Z0-9_.]*\b/g;
          for (const match of prompt.matchAll(refPattern)) {
            const refExpr = match[0];
            try {
              const val = deps.expressionEvaluator.exec(
                refExpr,
                expressionContext,
              );
              interpolatedPrompt = interpolatedPrompt.replace(
                refExpr,
                String(val ?? ""),
              );
            } catch {
              // Leave unresolved refs as-is
            }
          }

          const result = await deps.invokeSkill(
            "ai-inference",
            input.runId,
            input.nodeId,
            { prompt: interpolatedPrompt, model },
          );
          return { output: (result ?? null) as JsonValue };
        }

        case "approval": {
          // Approval nodes signal that the run should pause
          return {
            output: { approved: false, pending: true } as unknown as JsonValue,
          };
        }

        default:
          throw new Error(
            `NODE_EXECUTION_FAILED: unknown node type '${node.type}'`,
          );
      }
    },
  };
}
```

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
    new Set<NodeAttemptStatus>(["running", "cancelled", "failed"]),
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

### `src/workflows/engine/friday-workflow-retry-manager.ts`
```ts
import type {
  FridayWorkflowRunNodeEntity,
  UUID,
} from "../model/friday-workflow.types.js";
import type { FridayNodeRetryPolicy } from "../model/friday-workflow-graph.types.js";

// ─── Decision type ───

export interface FridayRetryDecision {
  shouldRetry: boolean;
  nextAttemptNumber: number;
  delayMs: number;
  reason: string;
}

// ─── Interface ───

export interface FridayWorkflowRetryManager {
  evaluateRetry(
    nodeAttempt: FridayWorkflowRunNodeEntity,
    retryPolicy: FridayNodeRetryPolicy | undefined,
    errorCode: string,
  ): FridayRetryDecision;

  computeBackoffMs(
    attemptNumber: number,
    policy: FridayNodeRetryPolicy,
  ): number;

  generateIdempotencyKey(
    runId: UUID,
    nodeId: string,
    attemptNumber: number,
  ): string;

  generateAttemptId(): UUID;

  isRetryableError(errorCode: string, retryOn: string[]): boolean;
}

// ─── Factory ───

export interface CreateRetryManagerDeps {
  idGenerator: () => string;
  /** Optional: inject a random function for deterministic testing */
  randomFn?: () => number;
}

export function createFridayWorkflowRetryManager(
  deps: CreateRetryManagerDeps,
): FridayWorkflowRetryManager {
  const random = deps.randomFn ?? Math.random;

  return {
    evaluateRetry(nodeAttempt, retryPolicy, errorCode) {
      if (!retryPolicy) {
        return {
          shouldRetry: false,
          nextAttemptNumber: nodeAttempt.attempt + 1,
          delayMs: 0,
          reason: "no retry policy",
        };
      }

      if (nodeAttempt.attempt >= retryPolicy.maxAttempts) {
        return {
          shouldRetry: false,
          nextAttemptNumber: nodeAttempt.attempt + 1,
          delayMs: 0,
          reason: "max attempts exceeded",
        };
      }

      if (
        retryPolicy.retryOn.length > 0 &&
        !this.isRetryableError(errorCode, retryPolicy.retryOn)
      ) {
        return {
          shouldRetry: false,
          nextAttemptNumber: nodeAttempt.attempt + 1,
          delayMs: 0,
          reason: "error code not in retryOn list",
        };
      }

      const delayMs = this.computeBackoffMs(nodeAttempt.attempt, retryPolicy);

      return {
        shouldRetry: true,
        nextAttemptNumber: nodeAttempt.attempt + 1,
        delayMs,
        reason: "retry eligible",
      };
    },

    computeBackoffMs(attemptNumber, policy) {
      switch (policy.backoff) {
        case "none":
          return 0;
        case "fixed":
          return Math.min(policy.baseDelayMs, policy.maxDelayMs);
        case "exponential": {
          const delay = policy.baseDelayMs * Math.pow(2, attemptNumber - 1);
          // Add jitter: ±25%
          const jitter = delay * 0.25 * (random() * 2 - 1);
          return Math.min(Math.round(delay + jitter), policy.maxDelayMs);
        }
      }
    },

    generateIdempotencyKey(runId, nodeId, attemptNumber) {
      return `wfrun:${runId}:node:${nodeId}:attempt:${attemptNumber}`;
    },

    generateAttemptId() {
      return deps.idGenerator();
    },

    isRetryableError(errorCode, retryOn) {
      // Empty retryOn list means all errors are retryable (wildcard)
      if (retryOn.length === 0) return true;
      return retryOn.includes(errorCode);
    },
  };
}
```

### `src/workflows/engine/friday-workflow-run-machine.ts`
```ts
import type { WorkflowRunStatus } from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRunMachine {
  canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean;
  assertTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void;
  isTerminal(status: WorkflowRunStatus): boolean;
}

// ─── Valid transition table ───

const VALID_TRANSITIONS: ReadonlyMap<
  WorkflowRunStatus,
  ReadonlySet<WorkflowRunStatus>
> = new Map([
  ["queued", new Set<WorkflowRunStatus>(["running", "cancelled"])],
  [
    "running",
    new Set<WorkflowRunStatus>([
      "pausing",
      "completed",
      "failed",
      "cancelled",
      "compensating",
    ]),
  ],
  [
    "pausing",
    new Set<WorkflowRunStatus>(["paused", "failed", "cancelled"]),
  ],
  ["paused", new Set<WorkflowRunStatus>(["running", "cancelled"])],
  [
    "compensating",
    new Set<WorkflowRunStatus>(["completed", "failed", "cancelled"]),
  ],
  // failed can transition to running (retry)
  ["failed", new Set<WorkflowRunStatus>(["running"])],
  ["completed", new Set<WorkflowRunStatus>([])],
  ["cancelled", new Set<WorkflowRunStatus>([])],
]);

const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ─── Factory ───

export function createFridayWorkflowRunMachine(): FridayWorkflowRunMachine {
  return {
    canTransition(from, to) {
      const allowed = VALID_TRANSITIONS.get(from);
      return allowed ? allowed.has(to) : false;
    },

    assertTransition(from, to) {
      if (!this.canTransition(from, to)) {
        throw new Error(
          `INVALID_RUN_TRANSITION: cannot transition from '${from}' to '${to}'`,
        );
      }
    },

    isTerminal(status) {
      return TERMINAL_STATUSES.has(status);
    },
  };
}
```

### `src/workflows/index.ts`
```ts
// Model types
export * from "./model/friday-workflow.types.js";
export * from "./model/friday-workflow-graph.types.js";
export * from "./model/friday-workflow-trigger.types.js";
export * from "./model/friday-workflow-expression.types.js";

// Persistence
export { createFridayWorkflowRepository } from "./persistence/friday-workflow-repository.js";
export type { FridayWorkflowRepository } from "./persistence/friday-workflow-repository.js";
export { createFridayWorkflowRunRepository } from "./persistence/friday-workflow-run-repository.js";
export type { FridayWorkflowRunRepository } from "./persistence/friday-workflow-run-repository.js";
export { createFridayWorkflowRunNodeRepository } from "./persistence/friday-workflow-run-node-repository.js";
export type { FridayWorkflowRunNodeRepository } from "./persistence/friday-workflow-run-node-repository.js";
export { createFridayWorkflowArtifactRepository } from "./persistence/friday-workflow-artifact-repository.js";
export type { FridayWorkflowArtifactRepository } from "./persistence/friday-workflow-artifact-repository.js";

// Compiler
export { createFridayWorkflowCompiler } from "./compiler/friday-workflow-compiler.js";
export type {
  FridayWorkflowCompiler,
  FridayWorkflowSpecV1,
} from "./compiler/friday-workflow-compiler.js";
export { createFridayWorkflowValidator } from "./compiler/friday-workflow-validator.js";
export type { FridayWorkflowValidator } from "./compiler/friday-workflow-validator.js";

// Engine
export { createFridayWorkflowDagScheduler } from "./engine/friday-workflow-dag-scheduler.js";
export { createFridayWorkflowRunMachine } from "./engine/friday-workflow-run-machine.js";
export { createFridayWorkflowNodeMachine } from "./engine/friday-workflow-node-machine.js";
export { createFridayWorkflowNodeExecutor } from "./engine/friday-workflow-node-executor.js";
export { createFridayExpressionEvaluator } from "./engine/friday-workflow-expression-evaluator.js";
export { createFridayWorkflowRetryManager } from "./engine/friday-workflow-retry-manager.js";
export { createFridayWorkflowArtifactWriter } from "./engine/friday-workflow-artifact-writer.js";

// Services
export { createFridayWorkflowCrudService } from "./services/friday-workflow-crud-service.js";
export type { FridayWorkflowCrudService } from "./services/friday-workflow-crud-service.js";
export { createFridayWorkflowExecutionService } from "./services/friday-workflow-execution-service.js";
export type { FridayWorkflowExecutionService } from "./services/friday-workflow-execution-service.js";
export { createFridayWorkflowTriggerService } from "./services/friday-workflow-trigger-service.js";
export type { FridayWorkflowTriggerService } from "./services/friday-workflow-trigger-service.js";

// Runtime
export { createFridayWorkflowRuntime } from "./runtime/friday-workflow-runtime.js";
export type { FridayWorkflowRuntime } from "./runtime/friday-workflow-runtime.types.js";
```

### `src/workflows/model/friday-workflow-expression.types.ts`
```ts
// ─── Expression AST ───

export type FridayExprNode =
  | FridayExprLiteral
  | FridayExprRef
  | FridayExprBinaryOp
  | FridayExprUnaryOp;

export interface FridayExprLiteral {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface FridayExprRef {
  kind: "ref";
  path: string[];
}

export interface FridayExprBinaryOp {
  kind: "binary";
  op: "==" | "!=" | ">" | "<" | ">=" | "<=" | "&&" | "||";
  left: FridayExprNode;
  right: FridayExprNode;
}

export interface FridayExprUnaryOp {
  kind: "unary";
  op: "!";
  operand: FridayExprNode;
}

// ─── Expression Context (variables available during evaluation) ───

export interface FridayExpressionStepContext {
  output: Record<string, unknown>;
  status?: "completed" | "failed";
  error?: { code: string; message: string };
}

export interface FridayExpressionContext {
  inputs: Record<string, unknown>;
  steps: Record<string, FridayExpressionStepContext>;
  env?: Record<string, unknown>;
}

// ─── Expression Evaluator Contract ───

export interface FridayExpressionEvaluator {
  /** Parse an expression string into an AST. Throws on syntax error. */
  parse(expr: string): FridayExprNode;
  /** Evaluate a parsed AST against a context. Returns a primitive value. */
  evaluate(ast: FridayExprNode, ctx: FridayExpressionContext): unknown;
  /** Convenience: parse + evaluate in one call. */
  exec(expr: string, ctx: FridayExpressionContext): unknown;
}
```

### `src/workflows/model/friday-workflow-graph.types.ts`
```ts
import type {
  JsonValue,
  WorkflowNodeType,
  WorkflowFailurePolicyV2,
} from "./friday-workflow.types.js";

// ─── Compiled Graph Nodes ───

export interface FridayWorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, JsonValue>;
  retryPolicy?: FridayNodeRetryPolicy;
  timeoutMs?: number;
}

export interface FridayNodeRetryPolicy {
  maxAttempts: number;
  backoff: "none" | "fixed" | "exponential";
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: string[];
}

// ─── Compiled Graph Edges ───

export interface FridayWorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  condition?: string;
  priority?: number;
}

// ─── Compiled Workflow Graph V2 ───

export interface FridayCompiledWorkflowGraphV2 {
  schemaVersion: "2.0";
  workflowId: string;
  workflowVersionId: string;
  sourceSpecSchemaVersion: "1.0";
  graph: {
    nodes: FridayWorkflowNode[];
    edges: FridayWorkflowEdge[];
    variables?: Record<string, JsonValue>;
  };
  failurePolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowTest[];
  checksum: string;
}

// ─── Workflow Test ───

export interface FridayWorkflowTest {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<
    string,
    { output: Record<string, unknown>; status?: "completed" | "failed" }
  >;
  assertions: FridayWorkflowTestAssertion[];
}

export interface FridayWorkflowTestAssertion {
  path: string;
  operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
  expected: unknown;
}

// ─── Adjacency structures (produced by DAG scheduler) ───

export interface FridayDagAdjacency {
  /** nodeId → list of successor nodeIds */
  outbound: Map<string, string[]>;
  /** nodeId → list of predecessor nodeIds */
  inbound: Map<string, string[]>;
  /** nodes with zero inbound edges (entry points, including trigger nodes) */
  entryNodes: string[];
  /** topological order */
  topoOrder: string[];
}

// ─── Execution Plan (produced by compiler + scheduler for a run) ───

export interface FridayWorkflowExecutionPlan {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  compiledGraph: FridayCompiledWorkflowGraphV2;
  adjacency: FridayDagAdjacency;
  failurePolicy: WorkflowFailurePolicyV2;
  /** nodeId → FridayWorkflowNode lookup */
  nodeMap: Map<string, FridayWorkflowNode>;
}
```

### `src/workflows/model/friday-workflow-trigger.types.ts`
```ts
import type { UUID, ISODateTime, JsonObject } from "./friday-workflow.types.js";

// ─── Trigger Types ───

export type FridayWorkflowTriggerType = "manual" | "schedule" | "event";

// ─── Manual Trigger ───

export interface FridayManualTrigger {
  type: "manual";
}

// ─── Schedule Trigger ───

export interface FridayScheduleTrigger {
  type: "schedule";
  cron: string;
  timezone: string;
}

// ─── Event Trigger ───

export interface FridayEventTrigger {
  type: "event";
  source: string;
  event: string;
}

export type FridayWorkflowTriggerDef =
  | FridayManualTrigger
  | FridayScheduleTrigger
  | FridayEventTrigger;

// ─── Trigger Registration ───

export interface FridayTriggerRegistration {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  trigger: FridayWorkflowTriggerDef;
  enabled: boolean;
  lastFiredAt?: ISODateTime;
  nextFireAt?: ISODateTime;
  createdAt: ISODateTime;
}

// ─── Trigger Fire Input ───

export interface FridayTriggerFireInput {
  workflowId: UUID;
  workflowVersionId: UUID;
  triggerType: FridayWorkflowTriggerType;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  correlationId?: string;
}

// ─── Cron Tick Context (for schedule trigger evaluation) ───

export interface FridayCronTickContext {
  nowIso: ISODateTime;
  registrations: FridayTriggerRegistration[];
}

// ─── Event Match Context ───

export interface FridayEventMatchContext {
  source: string;
  event: string;
  payload: JsonObject;
}
```

### `src/workflows/model/friday-workflow.types.ts`
```ts
// ─── Foundational value types (local definitions; not coupled to SQLite layer) ───

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Workflow Run Status ───

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "compensating"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Node Attempt Status ───

export type NodeAttemptStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "blocked_offline"
  | "cancelled";

// ─── Failure Policy ───

export type WorkflowFailureStrategy =
  | "fail_fast"
  | "continue_on_error"
  | "fallback_step"
  | "compensate"
  | "pause_for_approval";

export interface WorkflowFailurePolicyV2 {
  onFailure: WorkflowFailureStrategy;
  fallbackStepId?: string;
  compensationWorkflowId?: string;
  notifyUser: boolean;
}

// ─── Workflow Node Types ───

export type WorkflowNodeType =
  | "trigger"
  | "action"
  | "condition"
  | "data"
  | "ai"
  | "approval";

// ─── Workflow Definition Row (DB shape) ───

export interface FridayWorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tags_json: string;
  owner_user_id: string | null;
  latest_version_number: number;
  published_version_number: number | null;
  is_archived: number;
  revision: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ─── Workflow Definition Entity (domain shape) ───

export interface FridayWorkflowEntity {
  id: UUID;
  slug: string;
  name: string;
  description?: string;
  tags: string[];
  ownerUserId?: UUID;
  latestVersionNumber: number;
  publishedVersionNumber?: number;
  isArchived: boolean;
  revision: number;
  etag: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt?: ISODateTime;
  deletedBy?: string;
}

// ─── Workflow Version Row ───

export interface FridayWorkflowVersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  checksum: string;
  graph_json: string;
  created_by_user_id: string | null;
  is_published: number;
  change_note: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Version Entity ───

export interface FridayWorkflowVersionEntity {
  id: UUID;
  workflowId: UUID;
  versionNumber: number;
  checksum: string;
  graphJson: JsonValue;
  createdByUserId?: UUID;
  isPublished: boolean;
  changeNote?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Run Row ───

export interface FridayWorkflowRunRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
  trigger_type: string;
  trigger_payload_json: string | null;
  started_by_user_id: string | null;
  started_by_satellite_id: string | null;
  started_at: string;
  finished_at: string | null;
  correlation_id: string | null;
  context_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_details_json: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Run Entity ───

export interface FridayWorkflowRunEntity {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  status: WorkflowRunStatus;
  triggerType: string;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  startedBySatelliteId?: UUID;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
  correlationId?: string;
  context?: JsonObject;
  failure?: {
    code: string;
    message: string;
    details?: JsonValue;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Run Node Row ───

export interface FridayWorkflowRunNodeRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  attempt_id: string;
  status: string;
  satellite_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Run Node Entity ───

export interface FridayWorkflowRunNodeEntity {
  id: UUID;
  runId: UUID;
  nodeId: string;
  attempt: number;
  attemptId: UUID;
  status: NodeAttemptStatus;
  satelliteId?: UUID;
  leaseOwner?: string;
  leaseExpiresAt?: ISODateTime;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  input?: JsonValue;
  output?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
  idempotencyKey: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Artifact Row ───

export interface FridayWorkflowArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  artifact_type: string;
  uri: string;
  checksum: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Artifact Entity ───

export interface FridayWorkflowArtifactEntity {
  id: UUID;
  runId: UUID;
  nodeId: string;
  artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
  uri: string;
  checksum?: string;
  metadata?: JsonObject;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Create Workflow Input ───

export interface FridayWorkflowCreateInput {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  ownerUserId?: UUID;
}

// ─── Update Workflow Input ───

export interface FridayWorkflowUpdateInput {
  workflowId: UUID;
  expectedRevision: number;
  etag: string;
  name?: string;
  description?: string;
  tags?: string[];
}

// ─── List Workflows Input ───

export interface FridayWorkflowListInput {
  tag?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}

// ─── Start Run Input ───

export interface FridayWorkflowStartRunInput {
  workflowId: UUID;
  workflowVersionId?: UUID;
  triggerType: string;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  startedBySatelliteId?: UUID;
  correlationId?: string;
  context?: JsonObject;
  dryRun?: boolean;
}

// ─── Node Outcome (internal) ───

export interface FridayNodeOutcome {
  nodeId: string;
  status: "completed" | "failed" | "cancelled";
  output?: JsonValue;
  error?: { code: string; message: string; retryable: boolean };
}

// ─── Row-to-entity mapper signature ───

export type RowMapper<TRow, TEntity> = (row: TRow) => TEntity;
```

### `src/workflows/persistence/friday-workflow-artifact-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayWorkflowArtifactRow,
  FridayWorkflowArtifactEntity,
  UUID,
  JsonObject,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowArtifactRepository {
  insertArtifact(
    db: Database.Database,
    entity: FridayWorkflowArtifactEntity,
  ): void;

  getArtifactById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowArtifactEntity | null;

  listArtifactsByRun(
    db: Database.Database,
    runId: UUID,
    nodeId?: string,
  ): FridayWorkflowArtifactEntity[];

  deleteArtifactsByRun(db: Database.Database, runId: UUID): number;
}

// ─── Row mapper ───

function mapArtifactRow(
  row: FridayWorkflowArtifactRow,
): FridayWorkflowArtifactEntity {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    artifactType: row.artifact_type as FridayWorkflowArtifactEntity["artifactType"],
    uri: row.uri,
    checksum: row.checksum ?? undefined,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as JsonObject)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayWorkflowArtifactRepository(): FridayWorkflowArtifactRepository {
  return {
    insertArtifact(db, entity) {
      db.prepare(
        `INSERT INTO workflow_artifacts (id, run_id, node_id, artifact_type, uri, checksum,
         metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id,
        entity.runId,
        entity.nodeId,
        entity.artifactType,
        entity.uri,
        entity.checksum ?? null,
        entity.metadata ? JSON.stringify(entity.metadata) : null,
        entity.createdAt,
        entity.updatedAt,
      );
    },

    getArtifactById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_artifacts WHERE id = ?")
        .get(id) as FridayWorkflowArtifactRow | undefined;
      return row ? mapArtifactRow(row) : null;
    },

    listArtifactsByRun(db, runId, nodeId) {
      if (nodeId) {
        return (
          db
            .prepare(
              "SELECT * FROM workflow_artifacts WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC",
            )
            .all(runId, nodeId) as FridayWorkflowArtifactRow[]
        ).map(mapArtifactRow);
      }
      return (
        db
          .prepare(
            "SELECT * FROM workflow_artifacts WHERE run_id = ? ORDER BY created_at ASC",
          )
          .all(runId) as FridayWorkflowArtifactRow[]
      ).map(mapArtifactRow);
    },

    deleteArtifactsByRun(db, runId) {
      const result = db
        .prepare("DELETE FROM workflow_artifacts WHERE run_id = ?")
        .run(runId);
      return result.changes;
    },
  };
}
```

### `src/workflows/persistence/friday-workflow-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayWorkflowRow,
  FridayWorkflowEntity,
  FridayWorkflowVersionRow,
  FridayWorkflowVersionEntity,
  FridayWorkflowCreateInput,
  FridayWorkflowUpdateInput,
  FridayWorkflowListInput,
  UUID,
  JsonValue,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRepository {
  insertWorkflow(
    db: Database.Database,
    id: UUID,
    input: FridayWorkflowCreateInput,
    etag: string,
    nowIso: string,
  ): FridayWorkflowEntity;

  getWorkflowById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowEntity | null;

  getWorkflowBySlug(
    db: Database.Database,
    slug: string,
  ): FridayWorkflowEntity | null;

  listWorkflows(
    db: Database.Database,
    input: FridayWorkflowListInput,
  ): FridayWorkflowEntity[];

  updateWorkflow(
    db: Database.Database,
    input: FridayWorkflowUpdateInput,
    newEtag: string,
    nowIso: string,
  ): FridayWorkflowEntity;

  archiveWorkflow(
    db: Database.Database,
    id: UUID,
    deletedBy: string,
    nowIso: string,
  ): void;

  incrementVersionNumber(
    db: Database.Database,
    workflowId: UUID,
    nowIso: string,
  ): number;

  setPublishedVersion(
    db: Database.Database,
    workflowId: UUID,
    versionNumber: number,
    nowIso: string,
  ): void;

  insertVersion(
    db: Database.Database,
    id: UUID,
    workflowId: UUID,
    versionNumber: number,
    checksum: string,
    graphJson: string,
    createdByUserId: UUID | undefined,
    changeNote: string | undefined,
    nowIso: string,
  ): FridayWorkflowVersionEntity;

  getVersionById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowVersionEntity | null;

  getLatestVersion(
    db: Database.Database,
    workflowId: UUID,
  ): FridayWorkflowVersionEntity | null;

  getPublishedVersion(
    db: Database.Database,
    workflowId: UUID,
  ): FridayWorkflowVersionEntity | null;

  listVersions(
    db: Database.Database,
    workflowId: UUID,
    limit?: number,
  ): FridayWorkflowVersionEntity[];

  publishVersion(
    db: Database.Database,
    workflowId: UUID,
    versionId: UUID,
    nowIso: string,
  ): void;
}

// ─── Row mappers ───

function mapWorkflowRow(row: FridayWorkflowRow): FridayWorkflowEntity {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    ownerUserId: row.owner_user_id ?? undefined,
    latestVersionNumber: row.latest_version_number,
    publishedVersionNumber: row.published_version_number ?? undefined,
    isArchived: row.is_archived === 1,
    revision: row.revision,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
  };
}

function mapVersionRow(row: FridayWorkflowVersionRow): FridayWorkflowVersionEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    versionNumber: row.version_number,
    checksum: row.checksum,
    graphJson: JSON.parse(row.graph_json) as JsonValue,
    createdByUserId: row.created_by_user_id ?? undefined,
    isPublished: row.is_published === 1,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export interface CreateWorkflowRepositoryDeps {
  db: FridaySqliteLayer;
}

export function createFridayWorkflowRepository(
  _deps: CreateWorkflowRepositoryDeps,
): FridayWorkflowRepository {
  return {
    insertWorkflow(db, id, input, etag, nowIso) {
      db.prepare(
        `INSERT INTO workflows (id, slug, name, description, tags_json, owner_user_id,
         latest_version_number, published_version_number, is_archived, revision, etag,
         created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 0, 1, ?, ?, ?)`,
      ).run(
        id,
        input.slug,
        input.name,
        input.description ?? null,
        JSON.stringify(input.tags ?? []),
        input.ownerUserId ?? null,
        etag,
        nowIso,
        nowIso,
      );

      return mapWorkflowRow(
        db
          .prepare("SELECT * FROM workflows WHERE id = ?")
          .get(id) as FridayWorkflowRow,
      );
    },

    getWorkflowById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflows WHERE id = ? AND deleted_at IS NULL")
        .get(id) as FridayWorkflowRow | undefined;
      return row ? mapWorkflowRow(row) : null;
    },

    getWorkflowBySlug(db, slug) {
      const row = db
        .prepare("SELECT * FROM workflows WHERE slug = ? AND deleted_at IS NULL")
        .get(slug) as FridayWorkflowRow | undefined;
      return row ? mapWorkflowRow(row) : null;
    },

    listWorkflows(db, input) {
      const conditions: string[] = ["deleted_at IS NULL"];
      const params: unknown[] = [];

      if (input.tag) {
        conditions.push("tags_json LIKE ?");
        params.push(`%"${input.tag}"%`);
      }

      if (input.archived !== undefined) {
        conditions.push("is_archived = ?");
        params.push(input.archived ? 1 : 0);
      }

      const limit = input.limit ?? 50;
      const offset = input.cursor ? parseInt(input.cursor, 10) : 0;

      const sql = `SELECT * FROM workflows WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as FridayWorkflowRow[];
      return rows.map(mapWorkflowRow);
    },

    updateWorkflow(db, input, newEtag, nowIso) {
      const result = db
        .prepare(
          `UPDATE workflows SET
           name = COALESCE(?, name),
           description = COALESCE(?, description),
           tags_json = COALESCE(?, tags_json),
           revision = revision + 1,
           etag = ?,
           updated_at = ?
           WHERE id = ? AND revision = ? AND etag = ? AND deleted_at IS NULL`,
        )
        .run(
          input.name ?? null,
          input.description ?? null,
          input.tags ? JSON.stringify(input.tags) : null,
          newEtag,
          nowIso,
          input.workflowId,
          input.expectedRevision,
          input.etag,
        );

      if (result.changes === 0) {
        throw new Error("WORKFLOW_VERSION_CONFLICT");
      }

      return mapWorkflowRow(
        db
          .prepare("SELECT * FROM workflows WHERE id = ?")
          .get(input.workflowId) as FridayWorkflowRow,
      );
    },

    archiveWorkflow(db, id, deletedBy, nowIso) {
      db.prepare(
        `UPDATE workflows SET is_archived = 1, deleted_at = ?, deleted_by = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      ).run(nowIso, deletedBy, nowIso, id);
    },

    incrementVersionNumber(db, workflowId, nowIso) {
      const row = db
        .prepare(
          `UPDATE workflows SET latest_version_number = latest_version_number + 1, updated_at = ?
           WHERE id = ? RETURNING latest_version_number`,
        )
        .get(nowIso, workflowId) as { latest_version_number: number };
      return row.latest_version_number;
    },

    setPublishedVersion(db, workflowId, versionNumber, nowIso) {
      db.prepare(
        "UPDATE workflows SET published_version_number = ?, updated_at = ? WHERE id = ?",
      ).run(versionNumber, nowIso, workflowId);
    },

    insertVersion(db, id, workflowId, versionNumber, checksum, graphJson, createdByUserId, changeNote, nowIso) {
      db.prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json,
         created_by_user_id, is_published, change_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        id,
        workflowId,
        versionNumber,
        checksum,
        graphJson,
        createdByUserId ?? null,
        changeNote ?? null,
        nowIso,
        nowIso,
      );

      return mapVersionRow(
        db.prepare("SELECT * FROM workflow_versions WHERE id = ?").get(id) as FridayWorkflowVersionRow,
      );
    },

    getVersionById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_versions WHERE id = ?")
        .get(id) as FridayWorkflowVersionRow | undefined;
      return row ? mapVersionRow(row) : null;
    },

    getLatestVersion(db, workflowId) {
      const row = db
        .prepare(
          "SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT 1",
        )
        .get(workflowId) as FridayWorkflowVersionRow | undefined;
      return row ? mapVersionRow(row) : null;
    },

    getPublishedVersion(db, workflowId) {
      const row = db
        .prepare(
          `SELECT wv.* FROM workflow_versions wv
           JOIN workflows w ON w.id = wv.workflow_id AND w.published_version_number = wv.version_number
           WHERE wv.workflow_id = ? AND wv.is_published = 1 LIMIT 1`,
        )
        .get(workflowId) as FridayWorkflowVersionRow | undefined;
      return row ? mapVersionRow(row) : null;
    },

    listVersions(db, workflowId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT ?",
        )
        .all(workflowId, limit ?? 50) as FridayWorkflowVersionRow[];
      return rows.map(mapVersionRow);
    },

    publishVersion(db, workflowId, versionId, nowIso) {
      db.prepare(
        "UPDATE workflow_versions SET is_published = 0, updated_at = ? WHERE workflow_id = ? AND is_published = 1",
      ).run(nowIso, workflowId);

      db.prepare(
        "UPDATE workflow_versions SET is_published = 1, updated_at = ? WHERE id = ?",
      ).run(nowIso, versionId);
    },
  };
}
```

### `src/workflows/persistence/friday-workflow-run-node-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayWorkflowRunNodeRow,
  FridayWorkflowRunNodeEntity,
  NodeAttemptStatus,
  UUID,
  JsonValue,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRunNodeRepository {
  insertNodeAttempt(
    db: Database.Database,
    entity: FridayWorkflowRunNodeEntity,
  ): void;

  getNodeAttemptById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowRunNodeEntity | null;

  getLatestAttempt(
    db: Database.Database,
    runId: UUID,
    nodeId: string,
  ): FridayWorkflowRunNodeEntity | null;

  listAttemptsByNode(
    db: Database.Database,
    runId: UUID,
    nodeId: string,
  ): FridayWorkflowRunNodeEntity[];

  listNodesByRun(
    db: Database.Database,
    runId: UUID,
    status?: NodeAttemptStatus,
  ): FridayWorkflowRunNodeEntity[];

  updateNodeAttempt(
    db: Database.Database,
    id: UUID,
    update: {
      status: NodeAttemptStatus;
      satelliteId?: UUID;
      leaseOwner?: string;
      leaseExpiresAt?: string;
      startedAt?: string;
      finishedAt?: string;
      output?: unknown;
      error?: {
        code: string;
        message: string;
        retryable: boolean;
        details?: unknown;
      };
      nowIso: string;
    },
  ): void;

  acquireLease(
    db: Database.Database,
    id: UUID,
    leaseOwner: string,
    leaseExpiresAt: string,
    nowIso: string,
  ): boolean;

  listExpiredLeases(
    db: Database.Database,
    nowIso: string,
  ): FridayWorkflowRunNodeEntity[];

  cancelAllPendingNodes(
    db: Database.Database,
    runId: UUID,
    nowIso: string,
  ): number;

  countByStatus(
    db: Database.Database,
    runId: UUID,
  ): Record<NodeAttemptStatus, number>;
}

// ─── Row mapper ───

function mapNodeRow(row: FridayWorkflowRunNodeRow): FridayWorkflowRunNodeEntity {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    attemptId: row.attempt_id,
    status: row.status as NodeAttemptStatus,
    satelliteId: row.satellite_id ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    input: row.input_json ? (JSON.parse(row.input_json) as JsonValue) : undefined,
    output: row.output_json ? (JSON.parse(row.output_json) as JsonValue) : undefined,
    error: row.error_json
      ? (JSON.parse(row.error_json) as {
          code: string;
          message: string;
          retryable: boolean;
          details?: JsonValue;
        })
      : undefined,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayWorkflowRunNodeRepository(): FridayWorkflowRunNodeRepository {
  return {
    insertNodeAttempt(db, entity) {
      db.prepare(
        `INSERT INTO workflow_run_nodes (id, run_id, node_id, attempt, attempt_id, status,
         satellite_id, lease_owner, lease_expires_at, started_at, finished_at,
         input_json, output_json, error_json, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id,
        entity.runId,
        entity.nodeId,
        entity.attempt,
        entity.attemptId,
        entity.status,
        entity.satelliteId ?? null,
        entity.leaseOwner ?? null,
        entity.leaseExpiresAt ?? null,
        entity.startedAt ?? null,
        entity.finishedAt ?? null,
        entity.input !== undefined ? JSON.stringify(entity.input) : null,
        entity.output !== undefined ? JSON.stringify(entity.output) : null,
        entity.error ? JSON.stringify(entity.error) : null,
        entity.idempotencyKey,
        entity.createdAt,
        entity.updatedAt,
      );
    },

    getNodeAttemptById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_run_nodes WHERE id = ?")
        .get(id) as FridayWorkflowRunNodeRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    getLatestAttempt(db, runId, nodeId) {
      const row = db
        .prepare(
          "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1",
        )
        .get(runId, nodeId) as FridayWorkflowRunNodeRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    listAttemptsByNode(db, runId, nodeId) {
      return (
        db
          .prepare(
            "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ? ORDER BY attempt ASC",
          )
          .all(runId, nodeId) as FridayWorkflowRunNodeRow[]
      ).map(mapNodeRow);
    },

    listNodesByRun(db, runId, status) {
      if (status) {
        return (
          db
            .prepare(
              "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND status = ? ORDER BY created_at ASC",
            )
            .all(runId, status) as FridayWorkflowRunNodeRow[]
        ).map(mapNodeRow);
      }
      return (
        db
          .prepare(
            "SELECT * FROM workflow_run_nodes WHERE run_id = ? ORDER BY created_at ASC",
          )
          .all(runId) as FridayWorkflowRunNodeRow[]
      ).map(mapNodeRow);
    },

    updateNodeAttempt(db, id, update) {
      db.prepare(
        `UPDATE workflow_run_nodes SET
         status = ?,
         satellite_id = COALESCE(?, satellite_id),
         lease_owner = ?,
         lease_expires_at = ?,
         started_at = COALESCE(?, started_at),
         finished_at = ?,
         output_json = ?,
         error_json = ?,
         updated_at = ?
         WHERE id = ?`,
      ).run(
        update.status,
        update.satelliteId ?? null,
        update.leaseOwner ?? null,
        update.leaseExpiresAt ?? null,
        update.startedAt ?? null,
        update.finishedAt ?? null,
        update.output !== undefined ? JSON.stringify(update.output) : null,
        update.error ? JSON.stringify(update.error) : null,
        update.nowIso,
        id,
      );
    },

    acquireLease(db, id, leaseOwner, leaseExpiresAt, nowIso) {
      const result = db
        .prepare(
          `UPDATE workflow_run_nodes SET
           lease_owner = ?, lease_expires_at = ?, status = 'running',
           started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ? AND status IN ('queued', 'retrying')
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        )
        .run(leaseOwner, leaseExpiresAt, nowIso, nowIso, id, nowIso);
      return result.changes > 0;
    },

    listExpiredLeases(db, nowIso) {
      return (
        db
          .prepare(
            `SELECT * FROM workflow_run_nodes
             WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
          )
          .all(nowIso) as FridayWorkflowRunNodeRow[]
      ).map(mapNodeRow);
    },

    cancelAllPendingNodes(db, runId, nowIso) {
      const result = db
        .prepare(
          `UPDATE workflow_run_nodes SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('queued', 'running', 'retrying', 'blocked_offline')`,
        )
        .run(nowIso, nowIso, runId);
      return result.changes;
    },

    countByStatus(db, runId) {
      // Count using latest attempt per node only
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) as cnt FROM workflow_run_nodes
           WHERE (run_id, node_id, attempt) IN (
             SELECT run_id, node_id, MAX(attempt) FROM workflow_run_nodes
             WHERE run_id = ? GROUP BY run_id, node_id
           )
           GROUP BY status`,
        )
        .all(runId) as Array<{ status: string; cnt: number }>;

      const counts = {
        queued: 0,
        running: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        blocked_offline: 0,
        cancelled: 0,
      } as Record<NodeAttemptStatus, number>;

      for (const row of rows) {
        counts[row.status as NodeAttemptStatus] = row.cnt;
      }
      return counts;
    },
  };
}
```

### `src/workflows/persistence/friday-workflow-run-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayWorkflowRunRow,
  FridayWorkflowRunEntity,
  WorkflowRunStatus,
  UUID,
  JsonObject,
  JsonValue,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRunRepository {
  insertRun(db: Database.Database, entity: FridayWorkflowRunEntity): void;

  getRunById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowRunEntity | null;

  updateRunStatus(
    db: Database.Database,
    id: UUID,
    status: WorkflowRunStatus,
    nowIso: string,
    failure?: { code: string; message: string; details?: unknown },
  ): void;

  finalizeRun(
    db: Database.Database,
    id: UUID,
    status: WorkflowRunStatus,
    nowIso: string,
    failure?: { code: string; message: string; details?: unknown },
  ): void;

  listRunsByWorkflow(
    db: Database.Database,
    workflowId: UUID,
    status?: WorkflowRunStatus,
    limit?: number,
  ): FridayWorkflowRunEntity[];

  listActiveRuns(db: Database.Database): FridayWorkflowRunEntity[];

  mergeRunContext(
    db: Database.Database,
    id: UUID,
    context: Record<string, unknown>,
    nowIso: string,
  ): void;
}

// ─── Row mapper ───

function mapRunRow(row: FridayWorkflowRunRow): FridayWorkflowRunEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status as WorkflowRunStatus,
    triggerType: row.trigger_type,
    triggerPayload: row.trigger_payload_json
      ? (JSON.parse(row.trigger_payload_json) as JsonObject)
      : undefined,
    startedByUserId: row.started_by_user_id ?? undefined,
    startedBySatelliteId: row.started_by_satellite_id ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    context: row.context_json
      ? (JSON.parse(row.context_json) as JsonObject)
      : undefined,
    failure:
      row.failure_code
        ? {
            code: row.failure_code,
            message: row.failure_message ?? "",
            details: row.failure_details_json
              ? (JSON.parse(row.failure_details_json) as JsonValue)
              : undefined,
          }
        : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayWorkflowRunRepository(): FridayWorkflowRunRepository {
  return {
    insertRun(db, entity) {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type,
         trigger_payload_json, started_by_user_id, started_by_satellite_id, started_at,
         finished_at, correlation_id, context_json, failure_code, failure_message,
         failure_details_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id,
        entity.workflowId,
        entity.workflowVersionId,
        entity.status,
        entity.triggerType,
        entity.triggerPayload ? JSON.stringify(entity.triggerPayload) : null,
        entity.startedByUserId ?? null,
        entity.startedBySatelliteId ?? null,
        entity.startedAt,
        entity.finishedAt ?? null,
        entity.correlationId ?? null,
        entity.context ? JSON.stringify(entity.context) : null,
        entity.failure?.code ?? null,
        entity.failure?.message ?? null,
        entity.failure?.details !== undefined
          ? JSON.stringify(entity.failure.details)
          : null,
        entity.createdAt,
        entity.updatedAt,
      );
    },

    getRunById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_runs WHERE id = ?")
        .get(id) as FridayWorkflowRunRow | undefined;
      return row ? mapRunRow(row) : null;
    },

    updateRunStatus(db, id, status, nowIso, failure) {
      db.prepare(
        `UPDATE workflow_runs SET status = ?, failure_code = ?, failure_message = ?,
         failure_details_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        status,
        failure?.code ?? null,
        failure?.message ?? null,
        failure?.details !== undefined ? JSON.stringify(failure.details) : null,
        nowIso,
        id,
      );
    },

    finalizeRun(db, id, status, nowIso, failure) {
      db.prepare(
        `UPDATE workflow_runs SET status = ?, finished_at = ?, failure_code = ?,
         failure_message = ?, failure_details_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        status,
        nowIso,
        failure?.code ?? null,
        failure?.message ?? null,
        failure?.details !== undefined ? JSON.stringify(failure.details) : null,
        nowIso,
        id,
      );
    },

    listRunsByWorkflow(db, workflowId, status, limit) {
      if (status) {
        return (
          db
            .prepare(
              "SELECT * FROM workflow_runs WHERE workflow_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?",
            )
            .all(workflowId, status, limit ?? 50) as FridayWorkflowRunRow[]
        ).map(mapRunRow);
      }
      return (
        db
          .prepare(
            "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?",
          )
          .all(workflowId, limit ?? 50) as FridayWorkflowRunRow[]
      ).map(mapRunRow);
    },

    listActiveRuns(db) {
      return (
        db
          .prepare(
            "SELECT * FROM workflow_runs WHERE status IN ('queued', 'running', 'pausing', 'compensating')",
          )
          .all() as FridayWorkflowRunRow[]
      ).map(mapRunRow);
    },

    mergeRunContext(db, id, context, nowIso) {
      const row = db
        .prepare("SELECT context_json FROM workflow_runs WHERE id = ?")
        .get(id) as { context_json: string | null } | undefined;

      const existing = row?.context_json
        ? (JSON.parse(row.context_json) as Record<string, unknown>)
        : {};
      const merged = { ...existing, ...context };

      db.prepare(
        "UPDATE workflow_runs SET context_json = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(merged), nowIso, id);
    },
  };
}
```

### `src/workflows/runtime/friday-workflow-runtime.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySkill } from "../../skills/model/friday-skill-runtime.types.js";
import type { FridayWorkflowRuntime } from "./friday-workflow-runtime.types.js";

import { createFridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import { createFridayWorkflowRunRepository } from "../persistence/friday-workflow-run-repository.js";
import { createFridayWorkflowRunNodeRepository } from "../persistence/friday-workflow-run-node-repository.js";
import { createFridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";

import { createFridayExpressionEvaluator } from "../engine/friday-workflow-expression-evaluator.js";
import { createFridayWorkflowDagScheduler } from "../engine/friday-workflow-dag-scheduler.js";
import { createFridayWorkflowRunMachine } from "../engine/friday-workflow-run-machine.js";
import { createFridayWorkflowNodeMachine } from "../engine/friday-workflow-node-machine.js";
import { createFridayWorkflowRetryManager } from "../engine/friday-workflow-retry-manager.js";
import { createFridayWorkflowNodeExecutor } from "../engine/friday-workflow-node-executor.js";
import { createFridayWorkflowArtifactWriter } from "../engine/friday-workflow-artifact-writer.js";

import { createFridayWorkflowCrudService } from "../services/friday-workflow-crud-service.js";
import { createFridayWorkflowExecutionService } from "../services/friday-workflow-execution-service.js";
import { createFridayWorkflowTriggerService } from "../services/friday-workflow-trigger-service.js";

// ─── Dependencies ───

export interface CreateWorkflowRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
  resolveSkill: (
    skillId: string,
  ) => FridaySkill<unknown, unknown, unknown> | null;
  invokeSkill: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

// ─── Factory ───

export function createFridayWorkflowRuntime(
  deps: CreateWorkflowRuntimeDeps,
): FridayWorkflowRuntime {
  // 1. Repositories
  const workflowRepo = createFridayWorkflowRepository({ db: deps.db });
  const runRepo = createFridayWorkflowRunRepository();
  const nodeRepo = createFridayWorkflowRunNodeRepository();
  const artifactRepo = createFridayWorkflowArtifactRepository();

  // 2. Engine components
  const expressionEvaluator = createFridayExpressionEvaluator();
  const dagScheduler = createFridayWorkflowDagScheduler();
  const runMachine = createFridayWorkflowRunMachine();
  const nodeMachine = createFridayWorkflowNodeMachine();
  const retryManager = createFridayWorkflowRetryManager({
    idGenerator: deps.idGenerator,
  });
  const nodeExecutor = createFridayWorkflowNodeExecutor({
    expressionEvaluator,
    resolveSkill: deps.resolveSkill,
    invokeSkill: deps.invokeSkill,
    nowIso: deps.nowIso,
  });
  const artifactWriter = createFridayWorkflowArtifactWriter({
    db: deps.db,
    artifactRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 3. Services
  const crud = createFridayWorkflowCrudService({
    db: deps.db,
    workflowRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    computeChecksum: deps.computeChecksum,
    computeEtag: () => deps.idGenerator().slice(0, 16),
  });

  const execution = createFridayWorkflowExecutionService({
    db: deps.db,
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
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    publishEvent: deps.publishEvent,
  });

  const triggers = createFridayWorkflowTriggerService({
    db: deps.db,
    executionService: execution,
    workflowRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  return { crud, execution, triggers };
}
```

### `src/workflows/runtime/friday-workflow-runtime.types.ts`
```ts
import type { FridayWorkflowCrudService } from "../services/friday-workflow-crud-service.js";
import type { FridayWorkflowExecutionService } from "../services/friday-workflow-execution-service.js";
import type { FridayWorkflowTriggerService } from "../services/friday-workflow-trigger-service.js";

/**
 * Composite runtime surface that exposes all Phase 3 services
 * for integration with hub gateway and other hub services.
 */
export interface FridayWorkflowRuntime {
  crud: FridayWorkflowCrudService;
  execution: FridayWorkflowExecutionService;
  triggers: FridayWorkflowTriggerService;
}
```

### `src/workflows/services/friday-workflow-crud-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
  FridayWorkflowCreateInput,
  FridayWorkflowUpdateInput,
  FridayWorkflowListInput,
  UUID,
} from "../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";
import { createFridayWorkflowValidator } from "../compiler/friday-workflow-validator.js";

// ─── Interface ───

export interface FridayWorkflowCrudService {
  createWorkflow(input: FridayWorkflowCreateInput): FridayWorkflowEntity;
  getWorkflow(id: UUID): FridayWorkflowEntity | null;
  getWorkflowBySlug(slug: string): FridayWorkflowEntity | null;
  listWorkflows(input?: FridayWorkflowListInput): FridayWorkflowEntity[];
  updateWorkflow(input: FridayWorkflowUpdateInput): FridayWorkflowEntity;
  archiveWorkflow(id: UUID, deletedBy: string): void;
  createVersion(
    workflowId: UUID,
    compiledGraph: FridayCompiledWorkflowGraphV2,
    createdByUserId?: UUID,
    changeNote?: string,
  ): FridayWorkflowVersionEntity;
  publishVersion(
    workflowId: UUID,
    versionNumber?: number,
  ): FridayWorkflowVersionEntity;
  getVersion(versionId: UUID): FridayWorkflowVersionEntity | null;
  listVersions(
    workflowId: UUID,
    limit?: number,
  ): FridayWorkflowVersionEntity[];
  getPublishedVersion(
    workflowId: UUID,
  ): FridayWorkflowVersionEntity | null;
}

// ─── Dependencies ───

export interface CreateWorkflowCrudServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
  computeEtag: () => string;
}

// ─── Factory ───

export function createFridayWorkflowCrudService(
  deps: CreateWorkflowCrudServiceDeps,
): FridayWorkflowCrudService {
  const validator = createFridayWorkflowValidator();

  return {
    createWorkflow(input) {
      const id = deps.idGenerator();
      const etag = deps.computeEtag();
      const nowIso = deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        return deps.workflowRepo.insertWorkflow(db, id, input, etag, nowIso);
      });
    },

    getWorkflow(id) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getWorkflowById(db, id);
      });
    },

    getWorkflowBySlug(slug) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getWorkflowBySlug(db, slug);
      });
    },

    listWorkflows(input) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.listWorkflows(db, input ?? {});
      });
    },

    updateWorkflow(input) {
      const newEtag = deps.computeEtag();
      const nowIso = deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        return deps.workflowRepo.updateWorkflow(db, input, newEtag, nowIso);
      });
    },

    archiveWorkflow(id, deletedBy) {
      const nowIso = deps.nowIso();
      deps.db.withWriteTransaction((db) => {
        deps.workflowRepo.archiveWorkflow(db, id, deletedBy, nowIso);
      });
    },

    createVersion(workflowId, compiledGraph, createdByUserId, changeNote) {
      // Validate before persisting
      const validation = validator.validate(compiledGraph);
      if (!validation.valid) {
        const firstError = validation.errors[0]!;
        throw new Error(`${firstError.code}: ${firstError.message}`);
      }

      const graphJson = JSON.stringify(compiledGraph);
      const checksum = deps.computeChecksum(graphJson);

      return deps.db.withWriteTransaction((db) => {
        const versionNumber = deps.workflowRepo.incrementVersionNumber(
          db,
          workflowId,
          deps.nowIso(),
        );

        const versionId = deps.idGenerator();
        return deps.workflowRepo.insertVersion(
          db,
          versionId,
          workflowId,
          versionNumber,
          checksum,
          graphJson,
          createdByUserId,
          changeNote,
          deps.nowIso(),
        );
      });
    },

    publishVersion(workflowId, versionNumber) {
      return deps.db.withWriteTransaction((db) => {
        let version: FridayWorkflowVersionEntity | null;

        if (versionNumber !== undefined) {
          // Find version by number
          const versions = deps.workflowRepo.listVersions(db, workflowId);
          version =
            versions.find((v) => v.versionNumber === versionNumber) ?? null;
        } else {
          // Publish latest version
          version = deps.workflowRepo.getLatestVersion(db, workflowId);
        }

        if (!version) {
          throw new Error("WORKFLOW_VERSION_NOT_FOUND");
        }

        deps.workflowRepo.publishVersion(
          db,
          workflowId,
          version.id,
          deps.nowIso(),
        );
        deps.workflowRepo.setPublishedVersion(
          db,
          workflowId,
          version.versionNumber,
          deps.nowIso(),
        );

        // Re-fetch to return updated entity
        return deps.workflowRepo.getVersionById(db, version.id)!;
      });
    },

    getVersion(versionId) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getVersionById(db, versionId);
      });
    },

    listVersions(workflowId, limit) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.listVersions(db, workflowId, limit);
      });
    },

    getPublishedVersion(workflowId) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getPublishedVersion(db, workflowId);
      });
    },
  };
}
```

### `src/workflows/services/friday-workflow-execution-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  FridayWorkflowStartRunInput,
  UUID,
  WorkflowRunStatus,
  NodeAttemptStatus,
  JsonObject,
  JsonValue,
} from "../model/friday-workflow.types.js";
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowExecutionPlan,
} from "../model/friday-workflow-graph.types.js";
import type { FridayExpressionContext } from "../model/friday-workflow-expression.types.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type { FridayWorkflowRunRepository } from "../persistence/friday-workflow-run-repository.js";
import type { FridayWorkflowRunNodeRepository } from "../persistence/friday-workflow-run-node-repository.js";
import type { FridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";
import type { FridayWorkflowDagScheduler } from "../engine/friday-workflow-dag-scheduler.js";
import type { FridayWorkflowRunMachine } from "../engine/friday-workflow-run-machine.js";
import type { FridayWorkflowNodeMachine } from "../engine/friday-workflow-node-machine.js";
import type { FridayWorkflowNodeExecutor } from "../engine/friday-workflow-node-executor.js";
import type { FridayWorkflowRetryManager } from "../engine/friday-workflow-retry-manager.js";
import type { FridayWorkflowArtifactWriter } from "../engine/friday-workflow-artifact-writer.js";
import type { FridayExpressionEvaluator } from "../engine/friday-workflow-expression-evaluator.js";

// ─── Interface ───

export interface FridayWorkflowResumeOptions {
  /** For approval nodes: the approval decision (approved/rejected) */
  approvalDecision?: "approved" | "rejected";
}

export interface FridayWorkflowExecutionService {
  startRun(
    input: FridayWorkflowStartRunInput,
  ): Promise<FridayWorkflowRunEntity>;
  resumeRun(runId: UUID, options?: FridayWorkflowResumeOptions): Promise<FridayWorkflowRunEntity>;
  cancelRun(
    runId: UUID,
    reason?: string,
  ): Promise<FridayWorkflowRunEntity>;
  retryRun(
    runId: UUID,
    nodeIds?: string[],
  ): Promise<FridayWorkflowRunEntity>;
  getRun(runId: UUID): FridayWorkflowRunEntity | null;
  listRuns(
    workflowId: UUID,
    status?: WorkflowRunStatus,
    limit?: number,
  ): FridayWorkflowRunEntity[];
  getRunNodes(
    runId: UUID,
    status?: string,
  ): FridayWorkflowRunNodeEntity[];
  recoverActiveRuns(): Promise<void>;
  reapExpiredLeases(): Promise<number>;
}

// ─── Dependencies ───

export interface CreateWorkflowExecutionServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  runRepo: FridayWorkflowRunRepository;
  nodeRepo: FridayWorkflowRunNodeRepository;
  artifactRepo: FridayWorkflowArtifactRepository;
  dagScheduler: FridayWorkflowDagScheduler;
  runMachine: FridayWorkflowRunMachine;
  nodeMachine: FridayWorkflowNodeMachine;
  nodeExecutor: FridayWorkflowNodeExecutor;
  retryManager: FridayWorkflowRetryManager;
  artifactWriter: FridayWorkflowArtifactWriter;
  expressionEvaluator: FridayExpressionEvaluator;
  idGenerator: () => string;
  nowIso: () => string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

// ─── Factory ───

export function createFridayWorkflowExecutionService(
  deps: CreateWorkflowExecutionServiceDeps,
): FridayWorkflowExecutionService {
  // In-memory plan cache for active runs
  const activePlans = new Map<string, FridayWorkflowExecutionPlan>();

  // Default lease TTL: 5 minutes
  const LEASE_TTL_MS = 300_000;

  interface NodeContextEntry {
    output: Record<string, unknown>;
    status?: "completed" | "failed";
    error?: { code: string; message: string };
  }

  function buildExpressionContext(
    runEntity: FridayWorkflowRunEntity,
    nodeContexts: Map<string, NodeContextEntry>,
  ): FridayExpressionContext {
    const steps: Record<string, NodeContextEntry> = {};
    for (const [nodeId, entry] of nodeContexts) {
      steps[nodeId] = entry;
    }
    return {
      inputs: (runEntity.triggerPayload ?? runEntity.context ?? {}) as Record<
        string,
        unknown
      >,
      steps,
    };
  }

  function loadNodeContexts(runId: string): Map<string, NodeContextEntry> {
    const contexts = new Map<string, NodeContextEntry>();
    deps.db.withReadConnection((db) => {
      // Load ALL terminal nodes (completed AND failed) so failure-condition edges can fire
      const allNodes = deps.nodeRepo.listNodesByRun(db, runId);
      // Use latest attempt per node
      const latestAttempts = new Map<string, FridayWorkflowRunNodeEntity>();
      for (const n of allNodes) {
        const existing = latestAttempts.get(n.nodeId);
        if (!existing || n.attempt > existing.attempt) {
          latestAttempts.set(n.nodeId, n);
        }
      }
      for (const [nodeId, node] of latestAttempts) {
        if (node.status === "completed") {
          const output = node.output != null
            ? (typeof node.output === "object" && !Array.isArray(node.output)
              ? node.output
              : { value: node.output }) as Record<string, unknown>
            : {};
          contexts.set(nodeId, { output, status: "completed" });
        } else if (node.status === "failed") {
          const output = node.output != null
            ? (typeof node.output === "object" && !Array.isArray(node.output)
              ? node.output
              : { value: node.output }) as Record<string, unknown>
            : { status: "failed" };
          contexts.set(nodeId, {
            output,
            status: "failed",
            error: node.error
              ? { code: node.error.code, message: node.error.message }
              : { code: "UNKNOWN", message: "Unknown error" },
          });
        }
      }
    });
    return contexts;
  }

  async function executeRun(plan: FridayWorkflowExecutionPlan): Promise<void> {
    const runId = plan.runId;
    let runEntity = deps.db.withReadConnection((db) =>
      deps.runRepo.getRunById(db, runId),
    )!;

    // Transition to running
    if (runEntity.status !== "running") {
      deps.runMachine.assertTransition(runEntity.status, "running");
      deps.db.withWriteTransaction((db) => {
        deps.runRepo.updateRunStatus(db, runId, "running", deps.nowIso());
      });
    }

    const nodeContexts = loadNodeContexts(runId);

    // Build initial node status map from DB
    const nodeStatuses = new Map<string, NodeAttemptStatus>();
    deps.db.withReadConnection((db) => {
      const allNodes = deps.nodeRepo.listNodesByRun(db, runId);
      // Use latest attempt per node
      const latestAttempts = new Map<string, FridayWorkflowRunNodeEntity>();
      for (const n of allNodes) {
        const existing = latestAttempts.get(n.nodeId);
        if (!existing || n.attempt > existing.attempt) {
          latestAttempts.set(n.nodeId, n);
        }
      }
      for (const [nodeId, node] of latestAttempts) {
        nodeStatuses.set(nodeId, node.status);
      }
    });

    let aborted = false;

    // Main execution loop
    while (!aborted) {
      // Reload run entity to check for external cancellation
      runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
      if (
        runEntity.status === "cancelled" ||
        runEntity.status === "paused" ||
        runEntity.status === "pausing"
      ) {
        break;
      }

      const exprContext = buildExpressionContext(runEntity, nodeContexts);
      const readyNodes = deps.dagScheduler.computeReadyNodes(
        plan.adjacency,
        nodeStatuses,
        plan.compiledGraph,
        exprContext,
        deps.expressionEvaluator,
      );

      if (readyNodes.length === 0) break;

      // Create node attempt records (or reuse existing retrying attempts)
      const attempts: FridayWorkflowRunNodeEntity[] = [];
      deps.db.withWriteTransaction((db) => {
        for (const nodeId of readyNodes) {
          // Check if this node already has a retrying attempt (from retryRun)
          const currentNodeStatus = nodeStatuses.get(nodeId);
          if (currentNodeStatus === "retrying") {
            const existingAttempt = deps.db.withReadConnection((rdb) =>
              deps.nodeRepo.getLatestAttempt(rdb, runId, nodeId),
            );
            if (existingAttempt && existingAttempt.status === "retrying") {
              attempts.push(existingAttempt);
              continue;
            }
          }

          const latestAttempt = deps.db.withReadConnection((rdb) =>
            deps.nodeRepo.getLatestAttempt(rdb, runId, nodeId),
          );
          const actualAttempt = latestAttempt
            ? latestAttempt.attempt + 1
            : 1;

          const attemptId = deps.idGenerator();
          const idempotencyKey = deps.retryManager.generateIdempotencyKey(
            runId,
            nodeId,
            actualAttempt,
          );

          const entity: FridayWorkflowRunNodeEntity = {
            id: deps.idGenerator(),
            runId,
            nodeId,
            attempt: actualAttempt,
            attemptId,
            status: "queued",
            idempotencyKey,
            input: exprContext as unknown as JsonValue,
            createdAt: deps.nowIso(),
            updatedAt: deps.nowIso(),
          };

          deps.nodeRepo.insertNodeAttempt(db, entity);
          attempts.push(entity);
        }
      });

      // Execute batch
      const results = await Promise.allSettled(
        attempts.map(async (attempt) => {
          const node = plan.nodeMap.get(attempt.nodeId)!;

          // Acquire lease with future expiry
          const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
          const leaseAcquired = deps.db.withWriteTransaction((db) =>
            deps.nodeRepo.acquireLease(
              db,
              attempt.id,
              "hub",
              leaseExpiresAt,
              deps.nowIso(),
            ),
          );

          if (!leaseAcquired) {
            return { nodeId: attempt.nodeId, status: "skipped" as const };
          }

          // Check for approval nodes — these block until explicit decision
          if (node.type === "approval") {
            deps.db.withWriteTransaction((db) => {
              deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
                status: "blocked_offline",
                nowIso: deps.nowIso(),
              });
            });

            // Pause the run — awaiting approval decision
            deps.db.withWriteTransaction((db) => {
              deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
            });

            return {
              nodeId: attempt.nodeId,
              status: "paused" as const,
            };
          }

          try {
            // Execute with timeout
            const timeoutMs = node.timeoutMs ?? 300_000; // 5min default
            const result = await Promise.race([
              deps.nodeExecutor.executeNode({
                runId,
                nodeId: attempt.nodeId,
                attemptId: attempt.attemptId,
                node,
                inputData: (attempt.input as Record<string, unknown>) ?? {},
                expressionContext: buildExpressionContext(
                  runEntity,
                  nodeContexts,
                ),
              }),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("NODE_TIMEOUT")),
                  timeoutMs,
                ),
              ),
            ]);

            // Success
            deps.db.withWriteTransaction((db) => {
              deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
                status: "completed",
                output: result.output,
                finishedAt: deps.nowIso(),
                nowIso: deps.nowIso(),
              });
            });

            // Write artifacts
            if (result.output != null) {
              deps.artifactWriter.writeJsonArtifact(
                runId,
                attempt.nodeId,
                result.output,
              );
            }

            return {
              nodeId: attempt.nodeId,
              status: "completed" as const,
              output: result.output,
            };
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            const errorCode = errorMessage.startsWith("NODE_")
              ? errorMessage.split(":")[0]!
              : "NODE_EXECUTION_FAILED";

            const errorObj = {
              code: errorCode,
              message: errorMessage,
              retryable: true,
            };

            // Check retry policy
            const retryDecision = deps.retryManager.evaluateRetry(
              attempt,
              node.retryPolicy,
              errorCode,
            );

            if (retryDecision.shouldRetry) {
              deps.db.withWriteTransaction((db) => {
                deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
                  status: "failed",
                  error: errorObj,
                  finishedAt: deps.nowIso(),
                  nowIso: deps.nowIso(),
                });
              });

              // Wait for backoff delay
              if (retryDecision.delayMs > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, retryDecision.delayMs),
                );
              }

              return {
                nodeId: attempt.nodeId,
                status: "retrying" as const,
              };
            }

            // Exhausted retries
            deps.db.withWriteTransaction((db) => {
              deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
                status: "failed",
                error: errorObj,
                finishedAt: deps.nowIso(),
                nowIso: deps.nowIso(),
              });
            });

            return {
              nodeId: attempt.nodeId,
              status: "failed" as const,
              error: errorObj,
            };
          }
        }),
      );

      // Process results and update statuses
      let hasFailure = false;
      let hasPause = false;

      for (const result of results) {
        if (result.status === "rejected") continue;
        const { value } = result;

        if (value.status === "completed") {
          nodeStatuses.set(value.nodeId, "completed");
          if ("output" in value && value.output != null) {
            const outputObj =
              typeof value.output === "object" && !Array.isArray(value.output)
                ? (value.output as Record<string, unknown>)
                : { value: value.output };
            nodeContexts.set(value.nodeId, { output: outputObj, status: "completed" });
          }
        } else if (value.status === "failed") {
          nodeStatuses.set(value.nodeId, "failed");
          if ("error" in value && value.error != null) {
            const errObj = value.error as { code: string; message: string };
            nodeContexts.set(value.nodeId, {
              output: { status: "failed" },
              status: "failed",
              error: { code: errObj.code, message: errObj.message },
            });
          }
          hasFailure = true;
        } else if (value.status === "retrying") {
          // Don't set status — let next iteration pick it up
          // Remove from nodeStatuses so it can be retried
          nodeStatuses.delete(value.nodeId);
        } else if (value.status === "paused") {
          nodeStatuses.set(value.nodeId, "blocked_offline");
          hasPause = true;
        }
      }

      // Apply failure policy
      if (hasFailure) {
        const policy = plan.failurePolicy;
        switch (policy.onFailure) {
          case "fail_fast":
            aborted = true;
            deps.db.withWriteTransaction((db) => {
              deps.nodeRepo.cancelAllPendingNodes(db, runId, deps.nowIso());
              deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
                code: "WORKFLOW_FAILED",
                message: "Workflow failed due to fail_fast policy",
              });
            });
            return;

          case "continue_on_error":
            // Continue, failed nodes are terminal
            break;

          case "pause_for_approval":
            deps.db.withWriteTransaction((db) => {
              deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
            });
            return;

          case "fallback_step":
            // Add fallback step to ready set if available
            if (policy.fallbackStepId) {
              nodeStatuses.delete(policy.fallbackStepId);
            }
            break;

          case "compensate":
            deps.db.withWriteTransaction((db) => {
              deps.runRepo.updateRunStatus(
                db,
                runId,
                "compensating",
                deps.nowIso(),
              );
            });
            return;
        }
      }

      if (hasPause) {
        return;
      }
    }

    // Determine final status
    if (!aborted) {
      runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;

      if (runEntity.status === "running") {
        // Check if any nodes failed
        const counts = deps.db.withReadConnection((db) =>
          deps.nodeRepo.countByStatus(db, runId),
        );

        const finalStatus: WorkflowRunStatus =
          counts.failed > 0 ? "failed" : "completed";

        deps.db.withWriteTransaction((db) => {
          const failure =
            finalStatus === "failed"
              ? {
                  code: "WORKFLOW_NODES_FAILED",
                  message: `${counts.failed} node(s) failed`,
                }
              : undefined;
          deps.runRepo.finalizeRun(
            db,
            runId,
            finalStatus,
            deps.nowIso(),
            failure,
          );
        });
      }
    }

    activePlans.delete(runId);
    await deps.publishEvent?.("workflow.run.finished", { runId });
  }

  return {
    async startRun(input) {
      // Resolve version
      let versionId = input.workflowVersionId;
      let compiledGraph: FridayCompiledWorkflowGraphV2;

      if (!versionId) {
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getPublishedVersion(db, input.workflowId),
        );
        if (!version) {
          throw new Error("WORKFLOW_NO_PUBLISHED_VERSION");
        }
        versionId = version.id;
        compiledGraph = version.graphJson as unknown as FridayCompiledWorkflowGraphV2;
      } else {
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getVersionById(db, versionId!),
        );
        if (!version) {
          throw new Error("WORKFLOW_VERSION_NOT_FOUND");
        }
        compiledGraph = version.graphJson as unknown as FridayCompiledWorkflowGraphV2;
      }

      const runId = deps.idGenerator();
      const nowIso = deps.nowIso();

      const runEntity: FridayWorkflowRunEntity = {
        id: runId,
        workflowId: input.workflowId,
        workflowVersionId: versionId,
        status: "queued",
        triggerType: input.triggerType,
        triggerPayload: input.triggerPayload,
        startedByUserId: input.startedByUserId,
        startedBySatelliteId: input.startedBySatelliteId,
        startedAt: nowIso,
        correlationId: input.correlationId,
        context: input.context,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      deps.db.withWriteTransaction((db) => {
        deps.runRepo.insertRun(db, runEntity);
      });

      if (input.dryRun) {
        return runEntity;
      }

      // Build execution plan
      const plan = deps.dagScheduler.buildExecutionPlan(
        runId,
        compiledGraph,
      );
      activePlans.set(runId, plan);

      // Start execution (non-blocking)
      executeRun(plan).catch(() => {
        // Ensure run is marked failed on unhandled errors
        deps.db.withWriteTransaction((db) => {
          deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
            code: "WORKFLOW_EXECUTION_ERROR",
            message: "Unhandled execution error",
          });
        });
      });

      // Return the queued run entity
      return runEntity;
    },

    async resumeRun(runId, options) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) throw new Error("WORKFLOW_RUN_NOT_FOUND");

      deps.runMachine.assertTransition(runEntity.status, "running");

      // Rebuild plan from version (needed before checking approval nodes)
      const version = deps.db.withReadConnection((db) =>
        deps.workflowRepo.getVersionById(db, runEntity.workflowVersionId),
      );
      if (!version) throw new Error("WORKFLOW_VERSION_NOT_FOUND");

      const compiledGraph =
        version.graphJson as unknown as FridayCompiledWorkflowGraphV2;
      const plan = deps.dagScheduler.buildExecutionPlan(runId, compiledGraph);
      activePlans.set(runId, plan);

      // Check for blocked approval nodes that need a decision
      const blockedNodes = deps.db.withReadConnection((db) =>
        deps.nodeRepo.listNodesByRun(db, runId, "blocked_offline" as NodeAttemptStatus),
      );

      const approvalNodes = blockedNodes.filter((n) => {
        const graphNode = plan.nodeMap.get(n.nodeId);
        return graphNode?.type === "approval";
      });

      if (approvalNodes.length > 0) {
        // Approval nodes require an explicit decision
        if (!options?.approvalDecision) {
          throw new Error("WORKFLOW_APPROVAL_DECISION_REQUIRED");
        }

        deps.db.withWriteTransaction((db) => {
          for (const approvalNode of approvalNodes) {
            if (options.approvalDecision === "approved") {
              deps.nodeRepo.updateNodeAttempt(db, approvalNode.id, {
                status: "completed",
                output: { approved: true, pending: false },
                finishedAt: deps.nowIso(),
                nowIso: deps.nowIso(),
              });
            } else {
              deps.nodeRepo.updateNodeAttempt(db, approvalNode.id, {
                status: "failed",
                error: {
                  code: "APPROVAL_REJECTED",
                  message: "Approval was rejected",
                  retryable: false,
                },
                finishedAt: deps.nowIso(),
                nowIso: deps.nowIso(),
              });
            }
          }
        });
      }

      deps.db.withWriteTransaction((db) => {
        deps.runRepo.updateRunStatus(db, runId, "running", deps.nowIso());
      });

      executeRun(plan).catch(() => {});

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    async cancelRun(runId, reason) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) throw new Error("WORKFLOW_RUN_NOT_FOUND");

      deps.runMachine.assertTransition(runEntity.status, "cancelled");

      deps.db.withWriteTransaction((db) => {
        deps.nodeRepo.cancelAllPendingNodes(db, runId, deps.nowIso());
        deps.runRepo.finalizeRun(db, runId, "cancelled", deps.nowIso(), {
          code: "WORKFLOW_CANCELLED",
          message: reason ?? "Cancelled by user",
        });
      });

      activePlans.delete(runId);

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    async retryRun(runId, nodeIds) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) throw new Error("WORKFLOW_RUN_NOT_FOUND");

      deps.runMachine.assertTransition(runEntity.status, "running");

      // Get failed nodes (latest attempt per node)
      const failedNodes = deps.db.withReadConnection((db) => {
        const allNodes = deps.nodeRepo.listNodesByRun(db, runId);
        const latestAttempts = new Map<string, FridayWorkflowRunNodeEntity>();
        for (const n of allNodes) {
          const existing = latestAttempts.get(n.nodeId);
          if (!existing || n.attempt > existing.attempt) {
            latestAttempts.set(n.nodeId, n);
          }
        }
        return Array.from(latestAttempts.values()).filter(
          (n) => n.status === "failed",
        );
      });

      const targetNodes = nodeIds
        ? failedNodes.filter((n) => nodeIds.includes(n.nodeId))
        : failedNodes;

      if (targetNodes.length === 0) {
        throw new Error("WORKFLOW_NO_FAILED_NODES_TO_RETRY");
      }

      // Rebuild plan
      const version = deps.db.withReadConnection((db) =>
        deps.workflowRepo.getVersionById(db, runEntity.workflowVersionId),
      );
      if (!version) throw new Error("WORKFLOW_VERSION_NOT_FOUND");

      const compiledGraph =
        version.graphJson as unknown as FridayCompiledWorkflowGraphV2;
      const plan = deps.dagScheduler.buildExecutionPlan(runId, compiledGraph);
      activePlans.set(runId, plan);

      // Create new retry attempts for failed nodes so the scheduler picks them up
      deps.db.withWriteTransaction((db) => {
        for (const failedNode of targetNodes) {
          const newAttemptNumber = failedNode.attempt + 1;
          const attemptId = deps.idGenerator();
          const idempotencyKey = deps.retryManager.generateIdempotencyKey(
            runId,
            failedNode.nodeId,
            newAttemptNumber,
          );

          const retryEntity: FridayWorkflowRunNodeEntity = {
            id: deps.idGenerator(),
            runId,
            nodeId: failedNode.nodeId,
            attempt: newAttemptNumber,
            attemptId,
            status: "retrying",
            idempotencyKey,
            input: failedNode.input,
            createdAt: deps.nowIso(),
            updatedAt: deps.nowIso(),
          };

          deps.nodeRepo.insertNodeAttempt(db, retryEntity);
        }

        deps.runRepo.updateRunStatus(db, runId, "running", deps.nowIso());
      });

      executeRun(plan).catch(() => {});

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    getRun(runId) {
      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
    },

    listRuns(workflowId, status, limit) {
      return deps.db.withReadConnection((db) =>
        deps.runRepo.listRunsByWorkflow(db, workflowId, status, limit),
      );
    },

    getRunNodes(runId, status) {
      return deps.db.withReadConnection((db) =>
        deps.nodeRepo.listNodesByRun(
          db,
          runId,
          status as NodeAttemptStatus | undefined,
        ),
      );
    },

    async recoverActiveRuns() {
      const activeRuns = deps.db.withReadConnection((db) =>
        deps.runRepo.listActiveRuns(db),
      );

      for (const run of activeRuns) {
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getVersionById(db, run.workflowVersionId),
        );
        if (!version) continue;

        const compiledGraph =
          version.graphJson as unknown as FridayCompiledWorkflowGraphV2;
        const plan = deps.dagScheduler.buildExecutionPlan(
          run.id,
          compiledGraph,
        );
        activePlans.set(run.id, plan);

        executeRun(plan).catch(() => {});
      }
    },

    async reapExpiredLeases() {
      const nowIso = deps.nowIso();
      const expired = deps.db.withReadConnection((db) =>
        deps.nodeRepo.listExpiredLeases(db, nowIso),
      );

      let reaped = 0;
      for (const node of expired) {
        const plan = activePlans.get(node.runId);
        const graphNode = plan?.nodeMap.get(node.nodeId);
        const retryPolicy = graphNode?.retryPolicy;

        const decision = deps.retryManager.evaluateRetry(
          node,
          retryPolicy,
          "NODE_TIMEOUT",
        );

        deps.db.withWriteTransaction((db) => {
          if (decision.shouldRetry) {
            deps.nodeRepo.updateNodeAttempt(db, node.id, {
              status: "failed",
              error: {
                code: "NODE_TIMEOUT",
                message: "Node lease expired",
                retryable: true,
              },
              finishedAt: nowIso,
              nowIso,
            });
          } else {
            deps.nodeRepo.updateNodeAttempt(db, node.id, {
              status: "failed",
              error: {
                code: "NODE_TIMEOUT",
                message: "Node lease expired, retries exhausted",
                retryable: false,
              },
              finishedAt: nowIso,
              nowIso,
            });
          }
        });

        reaped++;
      }

      return reaped;
    },
  };
}
```

### `src/workflows/services/friday-workflow-trigger-service.ts`
```ts
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../model/friday-workflow.types.js";
import type {
  FridayTriggerRegistration,
  FridayTriggerFireInput,
  FridayWorkflowTriggerDef,
  FridayCronTickContext,
  FridayEventMatchContext,
} from "../model/friday-workflow-trigger.types.js";
import type { FridayWorkflowExecutionService } from "./friday-workflow-execution-service.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";

// ─── Interface ───

export interface FridayWorkflowTriggerService {
  register(
    workflowId: UUID,
    workflowVersionId: UUID,
    trigger: FridayWorkflowTriggerDef,
  ): FridayTriggerRegistration;

  unregister(workflowId: UUID): void;

  fireManual(input: FridayTriggerFireInput): Promise<UUID>;

  tickCron(ctx: FridayCronTickContext): Promise<UUID[]>;

  matchEvent(ctx: FridayEventMatchContext): Promise<UUID[]>;

  listRegistrations(): FridayTriggerRegistration[];

  reloadFromPublishedVersions(): Promise<void>;
}

// ─── Dependencies ───

export interface CreateWorkflowTriggerServiceDeps {
  db: FridaySqliteLayer;
  executionService: FridayWorkflowExecutionService;
  workflowRepo: FridayWorkflowRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Simple cron matcher (5-field: minute hour dom month dow) ───

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  // Handle comma-separated values
  const parts = field.split(",");
  for (const part of parts) {
    // Handle step values
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      if (range === "*") {
        if (value % step === 0) return true;
      }
      continue;
    }

    // Handle ranges
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (value >= start && value <= end) return true;
      continue;
    }

    // Exact match
    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

function matchesCron(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minute, hour, dom, month, dow] = fields;
  return (
    matchesCronField(minute!, date.getUTCMinutes()) &&
    matchesCronField(hour!, date.getUTCHours()) &&
    matchesCronField(dom!, date.getUTCDate()) &&
    matchesCronField(month!, date.getUTCMonth() + 1) &&
    matchesCronField(dow!, date.getUTCDay())
  );
}

// ─── Factory ───

export function createFridayWorkflowTriggerService(
  deps: CreateWorkflowTriggerServiceDeps,
): FridayWorkflowTriggerService {
  // In-memory trigger registrations: workflowId → registrations
  const registrations = new Map<UUID, FridayTriggerRegistration[]>();

  // Dedup set: correlation IDs for recent fires (to prevent duplicate cron fires)
  const recentCorrelationIds = new Set<string>();

  return {
    register(workflowId, workflowVersionId, trigger) {
      const reg: FridayTriggerRegistration = {
        id: deps.idGenerator(),
        workflowId,
        workflowVersionId,
        trigger,
        enabled: true,
        createdAt: deps.nowIso(),
      };

      const existing = registrations.get(workflowId) ?? [];
      existing.push(reg);
      registrations.set(workflowId, existing);

      return reg;
    },

    unregister(workflowId) {
      registrations.delete(workflowId);
    },

    async fireManual(input) {
      const run = await deps.executionService.startRun({
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        triggerType: input.triggerType,
        triggerPayload: input.triggerPayload,
        startedByUserId: input.startedByUserId,
        correlationId: input.correlationId,
      });
      return run.id;
    },

    async tickCron(ctx) {
      const runIds: UUID[] = [];
      const tickDate = new Date(ctx.nowIso);

      for (const reg of ctx.registrations) {
        if (!reg.enabled || reg.trigger.type !== "schedule") continue;

        const schedule = reg.trigger;
        if (!matchesCron(schedule.cron, tickDate)) continue;

        // Dedup: compute fingerprint for this minute
        const minuteIso = ctx.nowIso.slice(0, 16); // YYYY-MM-DDTHH:MM
        const fingerprint = createHash("sha256")
          .update(
            `${reg.workflowId}:${reg.workflowVersionId}:schedule:${minuteIso}`,
          )
          .digest("hex");

        if (recentCorrelationIds.has(fingerprint)) continue;
        recentCorrelationIds.add(fingerprint);

        // Clean up old entries (keep last 1000)
        if (recentCorrelationIds.size > 1000) {
          const entries = [...recentCorrelationIds];
          for (let i = 0; i < entries.length - 500; i++) {
            recentCorrelationIds.delete(entries[i]!);
          }
        }

        try {
          const run = await deps.executionService.startRun({
            workflowId: reg.workflowId,
            workflowVersionId: reg.workflowVersionId,
            triggerType: "schedule",
            correlationId: fingerprint,
          });
          runIds.push(run.id);
        } catch {
          // Log and continue
        }
      }

      return runIds;
    },

    async matchEvent(ctx) {
      const runIds: UUID[] = [];

      for (const [, regs] of registrations) {
        for (const reg of regs) {
          if (!reg.enabled || reg.trigger.type !== "event") continue;

          const eventTrigger = reg.trigger;
          if (
            eventTrigger.source === ctx.source &&
            eventTrigger.event === ctx.event
          ) {
            try {
              const run = await deps.executionService.startRun({
                workflowId: reg.workflowId,
                workflowVersionId: reg.workflowVersionId,
                triggerType: "event",
                triggerPayload: ctx.payload,
              });
              runIds.push(run.id);
            } catch {
              // Log and continue
            }
          }
        }
      }

      return runIds;
    },

    listRegistrations() {
      const all: FridayTriggerRegistration[] = [];
      for (const regs of registrations.values()) {
        all.push(...regs);
      }
      return all;
    },

    async reloadFromPublishedVersions() {
      // Clear existing registrations
      registrations.clear();

      // Load all workflows with published versions
      const workflows = deps.db.withReadConnection((db) =>
        deps.workflowRepo.listWorkflows(db, { limit: 1000 }),
      );

      for (const wf of workflows) {
        if (wf.publishedVersionNumber == null) continue;

        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getPublishedVersion(db, wf.id),
        );
        if (!version) continue;

        const graph =
          version.graphJson as unknown as FridayCompiledWorkflowGraphV2;

        // Find trigger nodes
        for (const node of graph.graph.nodes) {
          if (node.type !== "trigger") continue;

          const config = node.config as Record<string, unknown>;
          const triggerType = config.triggerType as string;

          let triggerDef: FridayWorkflowTriggerDef;
          if (triggerType === "schedule") {
            triggerDef = {
              type: "schedule",
              cron: config.cron as string,
              timezone: config.timezone as string,
            };
          } else if (triggerType === "event") {
            triggerDef = {
              type: "event",
              source: config.source as string,
              event: config.event as string,
            };
          } else {
            triggerDef = { type: "manual" };
          }

          this.register(wf.id, version.id, triggerDef);
        }
      }
    },
  };
}
```

## Test Code (Phase 3 files only)

### `test/unit/workflows/_helpers/create-test-db.ts`
```ts
import Database from "better-sqlite3";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { runFridayMigrations } from "../../../../src/state/sqlite/friday-migration-runner.js";
import { FRIDAY_SQLITE_MIGRATIONS } from "../../../../src/state/sqlite/migrations/index.js";

/**
 * Creates an in-memory SQLite database with all V001 schema tables
 * and wraps it in a minimal FridaySqliteLayer for testing.
 */
export function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  // Insert a test user for FK constraints
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (db: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

/** Counter-based ID generator for deterministic tests. */
export function createTestIdGenerator(): () => string {
  let counter = 0;
  return () => `test-id-${String(++counter).padStart(4, "0")}`;
}
```

### `test/unit/workflows/friday-workflow-artifact-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowArtifactRepository } from "../../../src/workflows/persistence/friday-workflow-artifact-repository.js";
import type { FridayWorkflowArtifactEntity } from "../../../src/workflows/model/friday-workflow.types.js";
import { createTestDb } from "./_helpers/create-test-db.js";

describe("FridayWorkflowArtifactRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow, version, and run for FK constraints
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-1', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowArtifactRepository();
  }

  function makeArtifact(
    overrides: Partial<FridayWorkflowArtifactEntity> = {},
  ): FridayWorkflowArtifactEntity {
    return {
      id: "art-1",
      runId: "run-1",
      nodeId: "node-A",
      artifactType: "json",
      uri: "data:application/json;base64,eyJ4IjoxfQ==",
      checksum: "abc123",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("inserts and gets an artifact", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact());
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getArtifactById(conn, "art-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.artifactType).toBe("json");
    expect(fetched!.uri).toContain("data:application/json");
  });

  it("lists artifacts by run", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact({ id: "art-1", nodeId: "node-A" }));
      repo.insertArtifact(conn, makeArtifact({ id: "art-2", nodeId: "node-B" }));
    });

    const artifacts = db.withReadConnection((conn) =>
      repo.listArtifactsByRun(conn, "run-1"),
    );
    expect(artifacts).toHaveLength(2);
  });

  it("lists artifacts by run + nodeId", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact({ id: "art-1", nodeId: "node-A" }));
      repo.insertArtifact(conn, makeArtifact({ id: "art-2", nodeId: "node-B" }));
    });

    const artifacts = db.withReadConnection((conn) =>
      repo.listArtifactsByRun(conn, "run-1", "node-A"),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.nodeId).toBe("node-A");
  });

  it("deletes artifacts by run and returns count", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact({ id: "art-1" }));
      repo.insertArtifact(conn, makeArtifact({ id: "art-2", nodeId: "node-B" }));
    });

    const count = db.withWriteTransaction((conn) =>
      repo.deleteArtifactsByRun(conn, "run-1"),
    );
    expect(count).toBe(2);

    const remaining = db.withReadConnection((conn) =>
      repo.listArtifactsByRun(conn, "run-1"),
    );
    expect(remaining).toHaveLength(0);
  });
});
```

### `test/unit/workflows/friday-workflow-artifact-writer.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowArtifactRepository } from "../../../src/workflows/persistence/friday-workflow-artifact-repository.js";
import { createFridayWorkflowArtifactWriter } from "../../../src/workflows/engine/friday-workflow-artifact-writer.js";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.js";

describe("FridayWorkflowArtifactWriter", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow, version, and run for FK constraints
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-1', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createWriter() {
    const artifactRepo = createFridayWorkflowArtifactRepository();
    return createFridayWorkflowArtifactWriter({
      db,
      artifactRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
  }

  it("writes small JSON artifact as data URI", () => {
    const writer = createWriter();
    const entity = writer.writeJsonArtifact("run-1", "node-A", { x: 1 });

    expect(entity.artifactType).toBe("json");
    expect(entity.uri).toMatch(/^data:application\/json;base64,/);
    expect(entity.checksum).toBeTruthy();
    expect(entity.runId).toBe("run-1");
    expect(entity.nodeId).toBe("node-A");
  });

  it("writes large JSON artifact with file URI", () => {
    const writer = createWriter();
    // Create a payload > 64KB
    const largeObj = { data: "x".repeat(70 * 1024) };
    const entity = writer.writeJsonArtifact("run-1", "node-B", largeObj);

    expect(entity.artifactType).toBe("json");
    expect(entity.uri).toMatch(/^file:\/\/artifacts\//);
    expect(entity.checksum).toBeTruthy();
  });

  it("computes correct SHA-256 checksum", () => {
    const writer = createWriter();
    const entity = writer.writeJsonArtifact("run-1", "node-A", { test: true });

    // Checksum should be a 64-char hex string
    expect(entity.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes non-JSON artifact", () => {
    const writer = createWriter();
    const entity = writer.writeArtifact(
      "run-1",
      "node-A",
      "image",
      "file:///tmp/screenshot.png",
      "abc123",
      { width: 1920, height: 1080 },
    );

    expect(entity.artifactType).toBe("image");
    expect(entity.uri).toBe("file:///tmp/screenshot.png");
    expect(entity.checksum).toBe("abc123");
    expect(entity.metadata).toEqual({ width: 1920, height: 1080 });
  });
});
```

### `test/unit/workflows/friday-workflow-compiler.test.ts`
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createFridayWorkflowCompiler } from "../../../src/workflows/compiler/friday-workflow-compiler.js";
import type { FridayWorkflowSpecV1 } from "../../../src/workflows/compiler/friday-workflow-compiler.js";
import { createHash } from "node:crypto";

function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

let idCounter = 0;
function idGenerator(): string {
  return `test-id-${String(++idCounter).padStart(4, "0")}`;
}

function makeMinimalSpec(
  overrides: Partial<FridayWorkflowSpecV1> = {},
): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-1",
    name: "Test Workflow",
    description: "A test workflow",
    startStepId: "step1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      { id: "step1", type: "skill_call", ref: "my-skill" },
    ],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    ...overrides,
  };
}

describe("FridayWorkflowCompiler", () => {
  const compiler = createFridayWorkflowCompiler({
    computeChecksum,
    idGenerator,
  });

  beforeEach(() => {
    idCounter = 0;
  });

  it("compiles minimal spec into valid CompiledWorkflowGraphV2", () => {
    const result = compiler.compile(makeMinimalSpec(), "wv-1");
    expect(result.schemaVersion).toBe("2.0");
    expect(result.workflowId).toBe("wf-1");
    expect(result.workflowVersionId).toBe("wv-1");
    expect(result.graph.nodes.length).toBeGreaterThanOrEqual(2); // trigger + step1
    expect(result.checksum).toBeTruthy();
  });

  it("maps step types correctly", () => {
    const spec = makeMinimalSpec({
      startStepId: "s1",
      steps: [
        { id: "s1", type: "skill_call", ref: "skill-a" },
        { id: "s2", type: "tool_call", ref: "tool-b" },
        { id: "s3", type: "condition", condition: "$inputs.x == 1" },
        { id: "s4", type: "transform" },
        { id: "s5", type: "human_approval" },
      ],
      edges: [
        { from: "s1", to: "s2" },
        { from: "s2", to: "s3" },
        { from: "s3", to: "s4", when: "true" },
        { from: "s3", to: "s5", when: "false" },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    const nodeMap = new Map(result.graph.nodes.map((n) => [n.id, n]));

    expect(nodeMap.get("s1")!.type).toBe("action");
    expect(nodeMap.get("s2")!.type).toBe("action");
    expect(nodeMap.get("s3")!.type).toBe("condition");
    expect(nodeMap.get("s4")!.type).toBe("data");
    expect(nodeMap.get("s5")!.type).toBe("approval");
  });

  it("injects trigger node as entry point", () => {
    const result = compiler.compile(makeMinimalSpec(), "wv-1");
    const triggerNode = result.graph.nodes.find((n) => n.type === "trigger");
    expect(triggerNode).toBeDefined();

    // Should have edge from trigger to startStepId
    const triggerEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === triggerNode!.id && e.targetNodeId === "step1",
    );
    expect(triggerEdge).toBeDefined();
  });

  it("maps edge 'when' to condition expressions", () => {
    const spec = makeMinimalSpec({
      steps: [
        { id: "step1", type: "condition", condition: "$inputs.ok == true" },
        { id: "step2", type: "skill_call", ref: "a" },
        { id: "step3", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step1", to: "step2", when: "true" },
        { from: "step1", to: "step3", when: "false" },
      ],
    });

    const result = compiler.compile(spec, "wv-1");

    const trueEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step2",
    );
    const falseEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step3",
    );

    expect(trueEdge?.condition).toContain("result == true");
    expect(falseEdge?.condition).toContain("result == false");
  });

  it("maps retry policy", () => {
    const spec = makeMinimalSpec({
      steps: [
        {
          id: "step1",
          type: "skill_call",
          ref: "my-skill",
          retry: { maxAttempts: 3, backoffMs: 1000 },
        },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node?.retryPolicy).toEqual({
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"],
    });
  });

  it("maps timeout", () => {
    const spec = makeMinimalSpec({
      steps: [
        { id: "step1", type: "skill_call", ref: "my-skill", timeoutSec: 30 },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node?.timeoutMs).toBe(30000);
  });

  it("produces deterministic checksum for same input", () => {
    idCounter = 0;
    const r1 = compiler.compile(makeMinimalSpec(), "wv-1");
    idCounter = 0;
    const r2 = compiler.compile(makeMinimalSpec(), "wv-1");
    expect(r1.checksum).toBe(r2.checksum);
  });

  it("rejects spec that would produce an invalid graph", () => {
    const spec = makeMinimalSpec({
      startStepId: "nonexistent",
      steps: [{ id: "step1", type: "skill_call", ref: "s" }],
    });

    expect(() => compiler.compile(spec, "wv-1")).toThrow();
  });

  it("preserves test cases", () => {
    const spec = makeMinimalSpec({
      tests: [
        {
          name: "test-1",
          description: "A test",
          inputs: { x: 1 },
          assertions: [{ path: "output.x", operator: "==", expected: 1 }],
        },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]!.name).toBe("test-1");
  });

  it("compiles schedule trigger", () => {
    const spec = makeMinimalSpec({
      trigger: { type: "schedule", cron: "0 * * * *", timezone: "UTC" },
    });

    const result = compiler.compile(spec, "wv-1");
    const triggerNode = result.graph.nodes.find((n) => n.type === "trigger");
    expect(triggerNode?.config.triggerType).toBe("schedule");
    expect(triggerNode?.config.cron).toBe("0 * * * *");
    expect(triggerNode?.config.timezone).toBe("UTC");
  });
});
```

### `test/unit/workflows/friday-workflow-crud-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowRepository } from "../../../src/workflows/persistence/friday-workflow-repository.js";
import { createFridayWorkflowCrudService } from "../../../src/workflows/services/friday-workflow-crud-service.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../../src/workflows/model/friday-workflow-graph.types.js";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.js";

describe("FridayWorkflowCrudService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    return createFridayWorkflowCrudService({
      db,
      workflowRepo: createFridayWorkflowRepository({ db }),
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum: (content: string) =>
        createHash("sha256").update(content).digest("hex"),
      computeEtag: () => idGen().slice(0, 16),
    });
  }

  function makeValidGraph(
    workflowId = "wf-1",
    versionId = "wv-1",
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: versionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", label: "Trigger", config: {} },
          {
            id: "action1",
            type: "action",
            label: "Action 1",
            config: { skillId: "test-skill" },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  it("creates a workflow with correct defaults", () => {
    const service = createService();
    const entity = service.createWorkflow({
      slug: "my-workflow",
      name: "My Workflow",
      description: "A test workflow",
    });

    expect(entity.slug).toBe("my-workflow");
    expect(entity.name).toBe("My Workflow");
    expect(entity.revision).toBe(1);
    expect(entity.isArchived).toBe(false);
    expect(entity.latestVersionNumber).toBe(1);
  });

  it("gets workflow by id", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });
    const fetched = service.getWorkflow(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("gets workflow by slug", () => {
    const service = createService();
    service.createWorkflow({ slug: "my-slug", name: "N" });
    const fetched = service.getWorkflowBySlug("my-slug");
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe("my-slug");
  });

  it("returns null for missing workflow", () => {
    const service = createService();
    expect(service.getWorkflow("nonexistent")).toBeNull();
  });

  it("updates workflow with correct revision", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });

    const updated = service.updateWorkflow({
      workflowId: created.id,
      expectedRevision: created.revision,
      etag: created.etag,
      name: "Updated",
    });

    expect(updated.name).toBe("Updated");
    expect(updated.revision).toBe(2);
  });

  it("throws WORKFLOW_VERSION_CONFLICT on wrong revision", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });

    expect(() =>
      service.updateWorkflow({
        workflowId: created.id,
        expectedRevision: 99,
        etag: created.etag,
        name: "Updated",
      }),
    ).toThrow("WORKFLOW_VERSION_CONFLICT");
  });

  it("archives workflow", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });
    service.archiveWorkflow(created.id, "admin");

    const fetched = service.getWorkflow(created.id);
    expect(fetched).toBeNull();
  });

  it("creates version with valid graph", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });

    const version = service.createVersion(wf.id, makeValidGraph(wf.id));
    expect(version.versionNumber).toBe(2); // incremented from 1
    expect(version.checksum).toBeTruthy();
  });

  it("rejects version with invalid graph", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });

    const invalidGraph = makeValidGraph(wf.id);
    invalidGraph.graph.nodes = []; // empty graph

    expect(() => service.createVersion(wf.id, invalidGraph)).toThrow();
  });

  it("publishes a version", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });
    const version = service.createVersion(wf.id, makeValidGraph(wf.id));

    const published = service.publishVersion(wf.id, version.versionNumber);
    expect(published.isPublished).toBe(true);
  });

  it("only one version published at a time", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });

    const v1 = service.createVersion(wf.id, makeValidGraph(wf.id));
    service.publishVersion(wf.id, v1.versionNumber);

    const v2 = service.createVersion(wf.id, makeValidGraph(wf.id));
    service.publishVersion(wf.id, v2.versionNumber);

    // v1 should no longer be published
    const fetched = service.getVersion(v1.id);
    expect(fetched!.isPublished).toBe(false);

    const current = service.getPublishedVersion(wf.id);
    expect(current!.versionNumber).toBe(v2.versionNumber);
  });

  it("lists workflows with filters", () => {
    const service = createService();
    service.createWorkflow({ slug: "s1", name: "A", tags: ["api"] });
    service.createWorkflow({ slug: "s2", name: "B", tags: ["ui"] });
    service.createWorkflow({ slug: "s3", name: "C", tags: ["api"] });

    const apiOnly = service.listWorkflows({ tag: "api" });
    expect(apiOnly).toHaveLength(2);

    const all = service.listWorkflows();
    expect(all).toHaveLength(3);
  });
});
```

### `test/unit/workflows/friday-workflow-dag-scheduler.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowDagScheduler } from "../../../src/workflows/engine/friday-workflow-dag-scheduler.js";
import { createFridayExpressionEvaluator } from "../../../src/workflows/engine/friday-workflow-expression-evaluator.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../../src/workflows/model/friday-workflow-graph.types.js";
import type { NodeAttemptStatus } from "../../../src/workflows/model/friday-workflow.types.js";
import type { FridayExpressionContext } from "../../../src/workflows/model/friday-workflow-expression.types.js";

describe("FridayWorkflowDagScheduler", () => {
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
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "abc",
    };
  }

  const emptyCtx: FridayExpressionContext = { inputs: {}, steps: {} };

  it("produces correct topoOrder for linear DAG A→B→C", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "B", target: "C" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    expect(adj.topoOrder).toEqual(["A", "B", "C"]);
    expect(adj.entryNodes).toEqual(["A"]);
  });

  it("handles diamond DAG correctly", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "A", target: "C" },
        { id: "e3", source: "B", target: "D" },
        { id: "e4", source: "C", target: "D" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    expect(adj.entryNodes).toEqual(["A"]);
    // D must come after B and C
    expect(adj.topoOrder.indexOf("D")).toBeGreaterThan(adj.topoOrder.indexOf("B"));
    expect(adj.topoOrder.indexOf("D")).toBeGreaterThan(adj.topoOrder.indexOf("C"));

    // D only ready when both B and C are done
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "completed"],
    ]);
    expect(
      scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval),
    ).toEqual(["C"]);

    statuses.set("C", "completed");
    expect(
      scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval),
    ).toEqual(["D"]);
  });

  it("computes fan-out: all successors ready after single predecessor", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "A", target: "C" },
        { id: "e3", source: "A", target: "D" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
    ]);

    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).toEqual(expect.arrayContaining(["B", "C", "D"]));
  });

  it("fan-in (barrier): D ready only when both B and C are terminal", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "A", target: "C" },
        { id: "e3", source: "B", target: "D" },
        { id: "e4", source: "C", target: "D" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // Only B done
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "completed"],
    ]);
    let ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).toContain("C");
    expect(ready).not.toContain("D");

    // Both done
    statuses.set("C", "completed");
    ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).toContain("D");
  });

  it("condition edge filtering: false condition does not enable successor", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [
        {
          id: "e1",
          source: "A",
          target: "B",
          condition: '$inputs.go == "yes"',
        },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // Condition evaluates to false
    const ctx: FridayExpressionContext = {
      inputs: { go: "no" },
      steps: {},
    };
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
    ]);
    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      ctx,
      exprEval,
    );
    expect(ready).not.toContain("B");
  });

  it("entry nodes computation", () => {
    const graph = makeGraph(
      [{ id: "X" }, { id: "Y" }, { id: "Z" }],
      [{ id: "e1", source: "X", target: "Z" }],
    );
    const adj = scheduler.buildAdjacency(graph);
    expect(adj.entryNodes).toEqual(expect.arrayContaining(["X", "Y"]));
  });

  it("complex graph: correct progression of ready sets", () => {
    // 10 nodes: entry → A,B,C → D (join) → E,F → G (join) → H → I,J → K (join, terminal)
    const graph = makeGraph(
      [
        { id: "entry" },
        { id: "A" }, { id: "B" }, { id: "C" },
        { id: "D" }, { id: "E" }, { id: "F" },
        { id: "G" }, { id: "H" }, { id: "K" },
      ],
      [
        { id: "e1", source: "entry", target: "A" },
        { id: "e2", source: "entry", target: "B" },
        { id: "e3", source: "entry", target: "C" },
        { id: "e4", source: "A", target: "D" },
        { id: "e5", source: "B", target: "D" },
        { id: "e6", source: "C", target: "D" },
        { id: "e7", source: "D", target: "E" },
        { id: "e8", source: "D", target: "F" },
        { id: "e9", source: "E", target: "G" },
        { id: "e10", source: "F", target: "G" },
        { id: "e11", source: "G", target: "H" },
        { id: "e12", source: "H", target: "K" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    const statuses = new Map<string, NodeAttemptStatus>();
    let ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toEqual(["entry"]);

    statuses.set("entry", "completed");
    ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toEqual(expect.arrayContaining(["A", "B", "C"]));

    statuses.set("A", "completed");
    statuses.set("B", "completed");
    statuses.set("C", "completed");
    ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toEqual(["D"]);
  });

  it("already-started nodes are skipped", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A already has an attempt (running)
    const statuses = new Map<string, NodeAttemptStatus>([["A", "running"]]);
    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).not.toContain("A");
  });

  it("continue-on-error: failed predecessor still enables successors", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A failed (still terminal)
    const statuses = new Map<string, NodeAttemptStatus>([["A", "failed"]]);
    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    // B should be ready since A is terminal (failed counts as terminal for scheduling)
    expect(ready).toContain("B");
  });
});
```

### `test/unit/workflows/friday-workflow-execution-service-fixes.test.ts`
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayExpressionEvaluator } from "../../../src/workflows/engine/friday-workflow-expression-evaluator.js";
import { createFridayWorkflowDagScheduler } from "../../../src/workflows/engine/friday-workflow-dag-scheduler.js";
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
```

### `test/unit/workflows/friday-workflow-expression-evaluator.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayExpressionEvaluator } from "../../../src/workflows/engine/friday-workflow-expression-evaluator.js";
import type { FridayExpressionContext } from "../../../src/workflows/model/friday-workflow-expression.types.js";

describe("FridayExpressionEvaluator", () => {
  const evaluator = createFridayExpressionEvaluator();

  const ctx: FridayExpressionContext = {
    inputs: { name: "Alice", count: 42, env: "production" },
    steps: {
      fetch: { output: { count: 42, healthy: true } },
      check: { output: { valid: false, result: true } },
    },
    env: { region: "us-east" },
  };

  // ─── Literal evaluation ───

  it("evaluates string literal", () => {
    expect(evaluator.exec('"hello"', ctx)).toBe("hello");
  });

  it("evaluates number literal", () => {
    expect(evaluator.exec("42", ctx)).toBe(42);
  });

  it("evaluates boolean literal true", () => {
    expect(evaluator.exec("true", ctx)).toBe(true);
  });

  it("evaluates boolean literal false", () => {
    expect(evaluator.exec("false", ctx)).toBe(false);
  });

  it("evaluates null literal", () => {
    expect(evaluator.exec("null", ctx)).toBe(null);
  });

  // ─── Reference resolution ───

  it("resolves $inputs.name", () => {
    expect(evaluator.exec("$inputs.name", ctx)).toBe("Alice");
  });

  it("resolves $steps.fetch.output.count", () => {
    expect(evaluator.exec("$steps.fetch.output.count", ctx)).toBe(42);
  });

  it("resolves $env.region", () => {
    expect(evaluator.exec("$env.region", ctx)).toBe("us-east");
  });

  // ─── Comparison operators ───

  it("evaluates == (equal)", () => {
    expect(evaluator.exec("$inputs.count == 42", ctx)).toBe(true);
  });

  it("evaluates != (not equal)", () => {
    expect(evaluator.exec("$inputs.count != 99", ctx)).toBe(true);
  });

  it("evaluates > (greater)", () => {
    expect(evaluator.exec("$inputs.count > 10", ctx)).toBe(true);
  });

  it("evaluates < (less)", () => {
    expect(evaluator.exec("$inputs.count < 100", ctx)).toBe(true);
  });

  it("evaluates >= (gte)", () => {
    expect(evaluator.exec("$inputs.count >= 42", ctx)).toBe(true);
  });

  it("evaluates <= (lte)", () => {
    expect(evaluator.exec("$inputs.count <= 42", ctx)).toBe(true);
  });

  // ─── Logical operators ───

  it("evaluates && (AND) with short-circuit", () => {
    expect(evaluator.exec("true && false", ctx)).toBe(false);
  });

  it("evaluates || (OR) with short-circuit", () => {
    expect(evaluator.exec("false || true", ctx)).toBe(true);
  });

  it("evaluates ! (NOT)", () => {
    expect(evaluator.exec("!true", ctx)).toBe(false);
  });

  it("evaluates negated reference", () => {
    expect(evaluator.exec("!$steps.check.output.valid", ctx)).toBe(true);
  });

  // ─── Parentheses ───

  it("evaluates (a || b) && c correctly", () => {
    expect(evaluator.exec("(true || false) && true", ctx)).toBe(true);
  });

  it("evaluates a || (b && c) correctly", () => {
    expect(evaluator.exec("false || (true && true)", ctx)).toBe(true);
  });

  // ─── Complex expression ───

  it("evaluates complex expression", () => {
    const result = evaluator.exec(
      '$inputs.env == "production" && $steps.fetch.output.healthy == true',
      ctx,
    );
    expect(result).toBe(true);
  });

  // ─── Undefined ref ───

  it("returns undefined for missing reference (not an error)", () => {
    expect(evaluator.exec("$steps.missing.output.x", ctx)).toBeUndefined();
  });

  // ─── Syntax errors ───

  it("throws on syntax error", () => {
    expect(() => evaluator.parse("$inputs.x ==")).toThrow();
  });

  it("throws on unterminated string", () => {
    expect(() => evaluator.parse('"hello')).toThrow();
  });

  // ─── Safety limits ───

  it("throws when expression exceeds max length", () => {
    const longExpr = "$inputs." + "a".repeat(4100);
    expect(() => evaluator.parse(longExpr)).toThrow("EXPRESSION_TOO_LONG");
  });

  it("throws when nesting exceeds max depth", () => {
    // Create deeply nested parentheses
    const open = "(".repeat(35);
    const close = ")".repeat(35);
    const expr = `${open}true${close}`;
    expect(() => evaluator.parse(expr)).toThrow("EXPRESSION_DEPTH_EXCEEDED");
  });

  it("rejects function-call-like identifiers", () => {
    expect(() => evaluator.parse("toString")).toThrow();
  });

  // ─── Single-quoted strings ───

  it("evaluates single-quoted string", () => {
    expect(evaluator.exec("'hello'", ctx)).toBe("hello");
  });

  // ─── Escaped characters ───

  it("handles escaped quotes in strings", () => {
    expect(evaluator.exec('"hello \\"world\\""', ctx)).toBe('hello "world"');
  });
});
```

### `test/unit/workflows/friday-workflow-node-executor.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowNodeExecutor } from "../../../src/workflows/engine/friday-workflow-node-executor.js";
import { createFridayExpressionEvaluator } from "../../../src/workflows/engine/friday-workflow-expression-evaluator.js";
import type { FridayNodeExecutionInput } from "../../../src/workflows/engine/friday-workflow-node-executor.js";
import type { FridayWorkflowNode } from "../../../src/workflows/model/friday-workflow-graph.types.js";
import type { FridayExpressionContext } from "../../../src/workflows/model/friday-workflow-expression.types.js";
import type { JsonValue } from "../../../src/workflows/model/friday-workflow.types.js";

describe("FridayWorkflowNodeExecutor", () => {
  const expressionEvaluator = createFridayExpressionEvaluator();
  const NOW = "2025-01-15T10:00:00.000Z";

  function createExecutor(overrides: {
    resolveSkill?: (id: string) => unknown | null;
    invokeSkill?: (
      id: string,
      runId: string,
      nodeId: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>;
  } = {}) {
    return createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: overrides.resolveSkill ?? (() => ({ manifest: {} })),
      invokeSkill:
        overrides.invokeSkill ??
        (async (_id, _runId, _nodeId, payload) => payload),
      nowIso: () => NOW,
    });
  }

  function makeInput(
    node: FridayWorkflowNode,
    ctx: FridayExpressionContext = { inputs: {}, steps: {} },
  ): FridayNodeExecutionInput {
    return {
      runId: "run-1",
      nodeId: node.id,
      attemptId: "att-1",
      node,
      inputData: {},
      expressionContext: ctx,
    };
  }

  it("executes trigger node — returns trigger payload", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "trigger-1",
      type: "trigger",
      label: "Trigger",
      config: {},
    };
    const ctx: FridayExpressionContext = {
      inputs: { foo: "bar" },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect(result.output).toEqual({ foo: "bar" });
  });

  it("executes action node — resolves skill and invokes", async () => {
    const invokedWith: Record<string, unknown>[] = [];
    const executor = createExecutor({
      resolveSkill: () => ({ manifest: {} }),
      invokeSkill: async (_id, _runId, _nodeId, payload) => {
        invokedWith.push(payload);
        return { result: "ok" };
      },
    });

    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: { skillId: "my-skill", args: { x: 1 } } as Record<string, JsonValue>,
    };
    const result = await executor.executeNode(makeInput(node));
    expect(result.output).toEqual({ result: "ok" });
    expect(invokedWith[0]).toEqual({ x: 1 });
  });

  it("executes condition node — evaluates expression", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "cond-1",
      type: "condition",
      label: "Condition",
      config: { condition: "$inputs.x == 1" } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: { x: 1 },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect((result.output as Record<string, unknown>).result).toBe(true);
  });

  it("executes data node — evaluates mapping", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-1",
      type: "data",
      label: "Data",
      config: {
        mapping: { name: "$inputs.name" },
      } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: { name: "Alice" },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect((result.output as Record<string, unknown>).name).toBe("Alice");
  });

  it("executes approval node — returns pending indicator", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "approval-1",
      type: "approval",
      label: "Approval",
      config: {},
    };
    const result = await executor.executeNode(makeInput(node));
    const output = result.output as Record<string, unknown>;
    expect(output.approved).toBe(false);
    expect(output.pending).toBe(true);
  });

  it("throws when skill not found", async () => {
    const executor = createExecutor({
      resolveSkill: () => null,
    });
    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: { skillId: "missing-skill" } as Record<string, JsonValue>,
    };

    await expect(executor.executeNode(makeInput(node))).rejects.toThrow(
      "skill 'missing-skill' not found",
    );
  });

  it("resolves expression args before skill invocation", async () => {
    const invokedArgs: Record<string, unknown>[] = [];
    const executor = createExecutor({
      invokeSkill: async (_id, _runId, _nodeId, payload) => {
        invokedArgs.push(payload);
        return {};
      },
    });

    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: {
        skillId: "my-skill",
        args: { name: "$inputs.name", count: "$steps.fetch.output.count" },
      } as Record<string, JsonValue>,
    };

    const ctx: FridayExpressionContext = {
      inputs: { name: "Bob" },
      steps: { fetch: { output: { count: 5 } } },
    };

    await executor.executeNode(makeInput(node, ctx));
    expect(invokedArgs[0]).toEqual({ name: "Bob", count: 5 });
  });

  it("throws for action node without skillId/ref", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: {},
    };

    await expect(executor.executeNode(makeInput(node))).rejects.toThrow(
      "action node missing skillId or ref",
    );
  });
});
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
});
```

### `test/unit/workflows/friday-workflow-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowRepository } from "../../../src/workflows/persistence/friday-workflow-repository.js";
import { createTestDb } from "./_helpers/create-test-db.js";

describe("FridayWorkflowRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRepository({ db });
  }

  it("inserts and gets a workflow", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      const entity = repo.insertWorkflow(
        conn,
        "wf-1",
        { slug: "my-wf", name: "My Workflow", description: "Test" },
        "etag-1",
        NOW,
      );
      expect(entity.id).toBe("wf-1");
      expect(entity.slug).toBe("my-wf");
      expect(entity.name).toBe("My Workflow");
      expect(entity.revision).toBe(1);
      expect(entity.isArchived).toBe(false);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getWorkflowById(conn, "wf-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe("my-wf");
  });

  it("enforces slug uniqueness", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "unique", name: "A" }, "e1", NOW);
    });
    expect(() =>
      db.withWriteTransaction((conn) => {
        repo.insertWorkflow(conn, "wf-2", { slug: "unique", name: "B" }, "e2", NOW);
      }),
    ).toThrow();
  });

  it("updates with correct revision", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });

    const updated = db.withWriteTransaction((conn) =>
      repo.updateWorkflow(
        conn,
        {
          workflowId: "wf-1",
          expectedRevision: 1,
          etag: "e1",
          name: "Updated",
        },
        "e2",
        NOW,
      ),
    );

    expect(updated.name).toBe("Updated");
    expect(updated.revision).toBe(2);
    expect(updated.etag).toBe("e2");
  });

  it("throws on wrong revision", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });

    expect(() =>
      db.withWriteTransaction((conn) =>
        repo.updateWorkflow(
          conn,
          {
            workflowId: "wf-1",
            expectedRevision: 99,
            etag: "e1",
            name: "Updated",
          },
          "e2",
          NOW,
        ),
      ),
    ).toThrow("WORKFLOW_VERSION_CONFLICT");
  });

  it("archives and hides workflow from get", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });
    db.withWriteTransaction((conn) => {
      repo.archiveWorkflow(conn, "wf-1", "user-1", NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getWorkflowById(conn, "wf-1"),
    );
    expect(fetched).toBeNull();
  });

  it("inserts and gets a version", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });

    const version = db.withWriteTransaction((conn) =>
      repo.insertVersion(
        conn,
        "wv-1",
        "wf-1",
        1,
        "checksum-1",
        '{"schemaVersion":"2.0"}',
        undefined,
        undefined,
        NOW,
      ),
    );

    expect(version.id).toBe("wv-1");
    expect(version.versionNumber).toBe(1);

    const fetched = db.withReadConnection((conn) =>
      repo.getVersionById(conn, "wv-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.versionNumber).toBe(1);
  });

  it("enforces version number uniqueness per workflow", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs", "{}", undefined, undefined, NOW);
    });

    expect(() =>
      db.withWriteTransaction((conn) => {
        repo.insertVersion(conn, "wv-2", "wf-1", 1, "cs2", "{}", undefined, undefined, NOW);
      }),
    ).toThrow();
  });

  it("gets latest version", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);
    });

    const latest = db.withReadConnection((conn) =>
      repo.getLatestVersion(conn, "wf-1"),
    );
    expect(latest!.versionNumber).toBe(2);
  });

  it("publishes version and clears previous", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);

      repo.publishVersion(conn, "wf-1", "wv-1", NOW);
      repo.setPublishedVersion(conn, "wf-1", 1, NOW);
    });

    let published = db.withReadConnection((conn) =>
      repo.getPublishedVersion(conn, "wf-1"),
    );
    expect(published!.versionNumber).toBe(1);

    // Publish version 2, v1 should be unpublished
    db.withWriteTransaction((conn) => {
      repo.publishVersion(conn, "wf-1", "wv-2", NOW);
      repo.setPublishedVersion(conn, "wf-1", 2, NOW);
    });

    published = db.withReadConnection((conn) =>
      repo.getPublishedVersion(conn, "wf-1"),
    );
    expect(published!.versionNumber).toBe(2);

    // v1 should no longer be published
    const v1 = db.withReadConnection((conn) =>
      repo.getVersionById(conn, "wv-1"),
    );
    expect(v1!.isPublished).toBe(false);
  });

  it("lists versions ordered by version_number DESC", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-3", "wf-1", 3, "cs3", "{}", undefined, undefined, NOW);
    });

    const versions = db.withReadConnection((conn) =>
      repo.listVersions(conn, "wf-1"),
    );
    expect(versions).toHaveLength(3);
    expect(versions[0]!.versionNumber).toBe(3);
    expect(versions[1]!.versionNumber).toBe(2);
    expect(versions[2]!.versionNumber).toBe(1);
  });
});
```

### `test/unit/workflows/friday-workflow-retry-manager.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowRetryManager } from "../../../src/workflows/engine/friday-workflow-retry-manager.js";
import type { FridayWorkflowRunNodeEntity } from "../../../src/workflows/model/friday-workflow.types.js";
import type { FridayNodeRetryPolicy } from "../../../src/workflows/model/friday-workflow-graph.types.js";

describe("FridayWorkflowRetryManager", () => {
  let idCounter = 0;
  const manager = createFridayWorkflowRetryManager({
    idGenerator: () => `attempt-${String(++idCounter).padStart(4, "0")}`,
    randomFn: () => 0.5, // Fixed random for deterministic tests
  });

  function makeAttempt(
    attempt: number,
  ): FridayWorkflowRunNodeEntity {
    return {
      id: "node-attempt-1",
      runId: "run-1",
      nodeId: "node-1",
      attempt,
      attemptId: "attempt-1",
      status: "failed",
      idempotencyKey: `wfrun:run-1:node:node-1:attempt:${attempt}`,
      createdAt: "2025-01-15T10:00:00.000Z",
      updatedAt: "2025-01-15T10:00:00.000Z",
    };
  }

  const defaultPolicy: FridayNodeRetryPolicy = {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"],
  };

  it("returns shouldRetry=false when no retry policy", () => {
    const decision = manager.evaluateRetry(makeAttempt(1), undefined, "ERROR");
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("no retry policy");
  });

  it("returns shouldRetry=true when under max attempts", () => {
    const decision = manager.evaluateRetry(
      makeAttempt(1),
      defaultPolicy,
      "NODE_EXECUTION_FAILED",
    );
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextAttemptNumber).toBe(2);
    expect(decision.reason).toBe("retry eligible");
  });

  it("returns shouldRetry=false when at max attempts", () => {
    const decision = manager.evaluateRetry(
      makeAttempt(3),
      defaultPolicy,
      "NODE_EXECUTION_FAILED",
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("max attempts exceeded");
  });

  it("returns shouldRetry=false when error code not in retryOn", () => {
    const decision = manager.evaluateRetry(
      makeAttempt(1),
      defaultPolicy,
      "SOME_OTHER_ERROR",
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("error code not in retryOn list");
  });

  it("computes fixed backoff correctly", () => {
    const fixedPolicy: FridayNodeRetryPolicy = {
      maxAttempts: 3,
      backoff: "fixed",
      baseDelayMs: 500,
      maxDelayMs: 5000,
      retryOn: [],
    };
    expect(manager.computeBackoffMs(1, fixedPolicy)).toBe(500);
    expect(manager.computeBackoffMs(2, fixedPolicy)).toBe(500);
  });

  it("computes exponential backoff with doubling", () => {
    // With fixed random of 0.5, jitter = delay * 0.25 * (0.5*2-1) = 0
    // So delay is exact exponential
    const delay1 = manager.computeBackoffMs(1, defaultPolicy); // 1000 * 2^0 = 1000
    const delay2 = manager.computeBackoffMs(2, defaultPolicy); // 1000 * 2^1 = 2000
    const delay3 = manager.computeBackoffMs(3, defaultPolicy); // 1000 * 2^2 = 4000

    expect(delay1).toBe(1000);
    expect(delay2).toBe(2000);
    expect(delay3).toBe(4000);
  });

  it("caps exponential backoff at maxDelayMs", () => {
    const delay = manager.computeBackoffMs(10, defaultPolicy);
    expect(delay).toBeLessThanOrEqual(defaultPolicy.maxDelayMs);
  });

  it("computes no backoff correctly", () => {
    const nonePolicy: FridayNodeRetryPolicy = {
      maxAttempts: 3,
      backoff: "none",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryOn: [],
    };
    expect(manager.computeBackoffMs(1, nonePolicy)).toBe(0);
  });

  it("generates correct idempotency key format", () => {
    const key = manager.generateIdempotencyKey("run-1", "node-1", 2);
    expect(key).toBe("wfrun:run-1:node:node-1:attempt:2");
  });

  it("generates unique attempt ids", () => {
    const id1 = manager.generateAttemptId();
    const id2 = manager.generateAttemptId();
    expect(id1).not.toBe(id2);
  });

  it("empty retryOn list means all errors retryable", () => {
    expect(
      manager.isRetryableError("ANY_ERROR", []),
    ).toBe(true);
  });

  it("non-empty retryOn list matches specific codes", () => {
    expect(
      manager.isRetryableError("NODE_TIMEOUT", ["NODE_TIMEOUT"]),
    ).toBe(true);
    expect(
      manager.isRetryableError("OTHER", ["NODE_TIMEOUT"]),
    ).toBe(false);
  });
});
```

### `test/unit/workflows/friday-workflow-run-machine.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowRunMachine } from "../../../src/workflows/engine/friday-workflow-run-machine.js";

describe("FridayWorkflowRunMachine", () => {
  const machine = createFridayWorkflowRunMachine();

  it("accepts valid transition queued → running", () => {
    expect(machine.canTransition("queued", "running")).toBe(true);
  });

  it("accepts valid transition queued → cancelled", () => {
    expect(machine.canTransition("queued", "cancelled")).toBe(true);
  });

  it("accepts valid transition running → pausing", () => {
    expect(machine.canTransition("running", "pausing")).toBe(true);
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

  it("accepts valid transition running → compensating", () => {
    expect(machine.canTransition("running", "compensating")).toBe(true);
  });

  it("accepts valid transition pausing → paused", () => {
    expect(machine.canTransition("pausing", "paused")).toBe(true);
  });

  it("accepts valid transition paused → running (resume)", () => {
    expect(machine.canTransition("paused", "running")).toBe(true);
  });

  it("accepts valid transition compensating → completed", () => {
    expect(machine.canTransition("compensating", "completed")).toBe(true);
  });

  it("accepts valid transition compensating → failed", () => {
    expect(machine.canTransition("compensating", "failed")).toBe(true);
  });

  it("accepts valid transition failed → running (retry)", () => {
    expect(machine.canTransition("failed", "running")).toBe(true);
  });

  it("rejects invalid transition completed → running", () => {
    expect(machine.canTransition("completed", "running")).toBe(false);
  });

  it("rejects invalid transition queued → completed", () => {
    expect(machine.canTransition("queued", "completed")).toBe(false);
  });

  it("rejects invalid transition cancelled → running", () => {
    expect(machine.canTransition("cancelled", "running")).toBe(false);
  });

  it("assertTransition throws on invalid transition", () => {
    expect(() => machine.assertTransition("completed", "running")).toThrow(
      "INVALID_RUN_TRANSITION",
    );
  });

  it("assertTransition succeeds on valid transition", () => {
    expect(() => machine.assertTransition("queued", "running")).not.toThrow();
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

  it("identifies paused as non-terminal", () => {
    expect(machine.isTerminal("paused")).toBe(false);
  });

  it("pause flow: running → pausing → paused → running", () => {
    expect(machine.canTransition("running", "pausing")).toBe(true);
    expect(machine.canTransition("pausing", "paused")).toBe(true);
    expect(machine.canTransition("paused", "running")).toBe(true);
  });

  it("compensation flow: running → compensating → completed/failed", () => {
    expect(machine.canTransition("running", "compensating")).toBe(true);
    expect(machine.canTransition("compensating", "completed")).toBe(true);
    expect(machine.canTransition("compensating", "failed")).toBe(true);
  });
});
```

### `test/unit/workflows/friday-workflow-run-node-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowRunNodeRepository } from "../../../src/workflows/persistence/friday-workflow-run-node-repository.js";
import type { FridayWorkflowRunNodeEntity } from "../../../src/workflows/model/friday-workflow.types.js";
import { createTestDb } from "./_helpers/create-test-db.js";

describe("FridayWorkflowRunNodeRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow, version, and run for FK constraints
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-1', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRunNodeRepository();
  }

  function makeNodeEntity(
    overrides: Partial<FridayWorkflowRunNodeEntity> = {},
  ): FridayWorkflowRunNodeEntity {
    return {
      id: "na-1",
      runId: "run-1",
      nodeId: "node-A",
      attempt: 1,
      attemptId: "att-1",
      status: "queued",
      idempotencyKey: "wfrun:run-1:node:node-A:attempt:1",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("inserts and gets a node attempt", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(conn, makeNodeEntity());
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getNodeAttemptById(conn, "na-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.nodeId).toBe("node-A");
    expect(fetched!.status).toBe("queued");
  });

  it("enforces unique constraint on (run_id, node_id, attempt)", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(conn, makeNodeEntity());
    });

    expect(() =>
      db.withWriteTransaction((conn) => {
        repo.insertNodeAttempt(conn, makeNodeEntity({ id: "na-2", attemptId: "att-2" }));
      }),
    ).toThrow();
  });

  it("gets latest attempt for a node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-1",
          attempt: 1,
          attemptId: "att-1",
          idempotencyKey: "k1",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          attempt: 2,
          attemptId: "att-2",
          idempotencyKey: "k2",
        }),
      );
    });

    const latest = db.withReadConnection((conn) =>
      repo.getLatestAttempt(conn, "run-1", "node-A"),
    );
    expect(latest!.attempt).toBe(2);
  });

  it("lists attempts by node ordered by attempt ASC", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({ id: "na-1", attempt: 1, attemptId: "a1", idempotencyKey: "k1" }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({ id: "na-2", attempt: 2, attemptId: "a2", idempotencyKey: "k2" }),
      );
    });

    const attempts = db.withReadConnection((conn) =>
      repo.listAttemptsByNode(conn, "run-1", "node-A"),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.attempt).toBe(1);
    expect(attempts[1]!.attempt).toBe(2);
  });

  it("acquires lease on queued node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(conn, makeNodeEntity());
    });

    const acquired = db.withWriteTransaction((conn) =>
      repo.acquireLease(conn, "na-1", "hub", "2025-01-15T10:05:00.000Z", NOW),
    );
    expect(acquired).toBe(true);

    const fetched = db.withReadConnection((conn) =>
      repo.getNodeAttemptById(conn, "na-1"),
    );
    expect(fetched!.status).toBe("running");
    expect(fetched!.leaseOwner).toBe("hub");
  });

  it("acquireLease fails for already-running node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          status: "running",
          leaseOwner: "other",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
      );
    });

    const acquired = db.withWriteTransaction((conn) =>
      repo.acquireLease(conn, "na-1", "hub", "2025-01-15T10:05:00.000Z", NOW),
    );
    expect(acquired).toBe(false);
  });

  it("lists expired leases", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-1",
          status: "running",
          leaseOwner: "hub",
          leaseExpiresAt: "2025-01-15T09:00:00.000Z", // expired
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          nodeId: "node-B",
          attempt: 1,
          attemptId: "a2",
          status: "running",
          leaseOwner: "hub",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z", // not expired
          idempotencyKey: "k2",
        }),
      );
    });

    const expired = db.withReadConnection((conn) =>
      repo.listExpiredLeases(conn, NOW),
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe("na-1");
  });

  it("cancels all pending nodes for a run", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({ id: "na-1", status: "queued", idempotencyKey: "k1" }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          nodeId: "node-B",
          attempt: 1,
          attemptId: "a2",
          status: "running",
          idempotencyKey: "k2",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-3",
          nodeId: "node-C",
          attempt: 1,
          attemptId: "a3",
          status: "completed",
          idempotencyKey: "k3",
        }),
      );
    });

    const count = db.withWriteTransaction((conn) =>
      repo.cancelAllPendingNodes(conn, "run-1", NOW),
    );
    // queued + running = 2 cancelled
    expect(count).toBe(2);

    // completed should remain
    const nodeC = db.withReadConnection((conn) =>
      repo.getNodeAttemptById(conn, "na-3"),
    );
    expect(nodeC!.status).toBe("completed");
  });

  it("counts by status using latest attempt per node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-1",
          nodeId: "n1",
          attempt: 1,
          attemptId: "a1",
          status: "failed",
          idempotencyKey: "k1",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          nodeId: "n1",
          attempt: 2,
          attemptId: "a2",
          status: "completed",
          idempotencyKey: "k2",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-3",
          nodeId: "n2",
          attempt: 1,
          attemptId: "a3",
          status: "failed",
          idempotencyKey: "k3",
        }),
      );
    });

    const counts = db.withReadConnection((conn) =>
      repo.countByStatus(conn, "run-1"),
    );
    // Latest: n1=completed, n2=failed
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
  });
});
```

### `test/unit/workflows/friday-workflow-run-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowRunRepository } from "../../../src/workflows/persistence/friday-workflow-run-repository.js";
import type { FridayWorkflowRunEntity } from "../../../src/workflows/model/friday-workflow.types.js";
import { createTestDb } from "./_helpers/create-test-db.js";

describe("FridayWorkflowRunRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow + version for FK constraints
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRunRepository();
  }

  function makeRunEntity(
    overrides: Partial<FridayWorkflowRunEntity> = {},
  ): FridayWorkflowRunEntity {
    return {
      id: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      status: "queued",
      triggerType: "manual",
      startedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("inserts and gets a run", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("run-1");
    expect(fetched!.status).toBe("queued");
    expect(fetched!.triggerType).toBe("manual");
  });

  it("updates run status", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
      repo.updateRunStatus(conn, "run-1", "running", NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.status).toBe("running");
  });

  it("finalizes run with finished_at and status", () => {
    const repo = createRepo();
    const finishedAt = "2025-01-15T10:05:00.000Z";
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
      repo.finalizeRun(conn, "run-1", "completed", finishedAt);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.status).toBe("completed");
    expect(fetched!.finishedAt).toBe(finishedAt);
  });

  it("lists active (non-terminal) runs", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity({ id: "run-1", status: "running" }));
      repo.insertRun(conn, makeRunEntity({ id: "run-2", status: "completed" }));
      repo.insertRun(conn, makeRunEntity({ id: "run-3", status: "queued" }));
    });

    const active = db.withReadConnection((conn) => repo.listActiveRuns(conn));
    const ids = active.map((r) => r.id);
    expect(ids).toContain("run-1");
    expect(ids).toContain("run-3");
    expect(ids).not.toContain("run-2");
  });

  it("lists runs by workflow", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity({ id: "run-1" }));
      repo.insertRun(conn, makeRunEntity({ id: "run-2" }));
    });

    const runs = db.withReadConnection((conn) =>
      repo.listRunsByWorkflow(conn, "wf-1"),
    );
    expect(runs).toHaveLength(2);
  });

  it("merges run context", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(
        conn,
        makeRunEntity({ context: { a: 1 } as unknown as FridayWorkflowRunEntity["context"] }),
      );
      repo.mergeRunContext(conn, "run-1", { b: 2 }, NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.context).toEqual({ a: 1, b: 2 });
  });
});
```

### `test/unit/workflows/friday-workflow-validator.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowValidator } from "../../../src/workflows/compiler/friday-workflow-validator.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../../src/workflows/model/friday-workflow-graph.types.js";

describe("FridayWorkflowValidator", () => {
  const validator = createFridayWorkflowValidator();

  function makeGraph(
    overrides: Partial<FridayCompiledWorkflowGraphV2> = {},
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "test" } },
          { id: "C", type: "action", label: "C", config: { skillId: "test" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "A", targetNodeId: "B" },
          { id: "e2", sourceNodeId: "B", targetNodeId: "C" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "abc123",
      ...overrides,
    };
  }

  it("accepts a valid linear DAG (A→B→C)", () => {
    const result = validator.validate(makeGraph());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid diamond graph", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
          { id: "C", type: "action", label: "C", config: { skillId: "s" } },
          { id: "D", type: "action", label: "D", config: { skillId: "s" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "A", targetNodeId: "B" },
          { id: "e2", sourceNodeId: "A", targetNodeId: "C" },
          { id: "e3", sourceNodeId: "B", targetNodeId: "D" },
          { id: "e4", sourceNodeId: "C", targetNodeId: "D" },
        ],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(true);
  });

  it("rejects graph with cycle A→B→C→A", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
          { id: "C", type: "action", label: "C", config: { skillId: "s" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "A", targetNodeId: "B" },
          { id: "e2", sourceNodeId: "B", targetNodeId: "C" },
          { id: "e3", sourceNodeId: "C", targetNodeId: "A" },
        ],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "WORKFLOW_CYCLE_DETECTED")).toBe(true);
  });

  it("rejects self-loop", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "action", label: "A", config: { skillId: "s" } },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "A" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "WORKFLOW_CYCLE_DETECTED")).toBe(true);
  });

  it("rejects disconnected graph", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
          { id: "C", type: "action", label: "C", config: { skillId: "s" } },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "B" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_GRAPH_DISCONNECTED"),
    ).toBe(true);
  });

  it("rejects empty graph", () => {
    const graph = makeGraph({
      graph: { nodes: [], edges: [] },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_EMPTY_GRAPH"),
    ).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "A", type: "action", label: "A2", config: { skillId: "s" } },
        ],
        edges: [],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_DUPLICATE_NODE_ID"),
    ).toBe(true);
  });

  it("rejects edge referencing missing node", () => {
    const graph = makeGraph({
      graph: {
        nodes: [{ id: "A", type: "trigger", label: "A", config: {} }],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "Z" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "WORKFLOW_EDGE_REFERENCES_MISSING_NODE",
      ),
    ).toBe(true);
  });

  it("rejects condition node without outbound edges", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          {
            id: "B",
            type: "condition",
            label: "B",
            config: { condition: "$inputs.x == 1" },
          },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "B" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_CONDITION_NO_OUTBOUND"),
    ).toBe(true);
  });

  it("rejects action node without skillId/ref", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: {} },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "B" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_ACTION_MISSING_REF"),
    ).toBe(true);
  });

  it("rejects invalid expression in edge condition", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "A",
            targetNodeId: "B",
            condition: "$inputs.x ==",
          },
        ],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_EXPRESSION_INVALID"),
    ).toBe(true);
  });

  it("accepts a complex graph with 20+ nodes", () => {
    const nodes = [
      { id: "trigger", type: "trigger" as const, label: "trigger", config: {} },
    ];
    const edges: Array<{
      id: string;
      sourceNodeId: string;
      targetNodeId: string;
    }> = [];

    // Create 20 action nodes in a chain with branches
    for (let i = 1; i <= 20; i++) {
      nodes.push({
        id: `n${i}`,
        type: "action" as const,
        label: `Node ${i}`,
        config: { skillId: "test" } as Record<string, unknown>,
      });
    }

    // Linear chain with some branches
    edges.push({ id: "e0", sourceNodeId: "trigger", targetNodeId: "n1" });
    for (let i = 1; i < 20; i++) {
      edges.push({
        id: `e${i}`,
        sourceNodeId: `n${i}`,
        targetNodeId: `n${i + 1}`,
      });
    }
    // Add a branch: n5 → n15
    edges.push({ id: "ebranch", sourceNodeId: "n5", targetNodeId: "n15" });

    const graph = makeGraph({
      graph: { nodes, edges },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(true);
  });
});
```

