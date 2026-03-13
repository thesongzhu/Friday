import { FridayDomainError } from "#errors";
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

// ─── Safety limits ───

/** Maximum number of nodes that can be scheduled concurrently in a single tick. */
const MAX_CONCURRENT_NODES = 50;

/** Maximum total nodes allowed in a workflow graph. */
const MAX_TOTAL_STEPS = 500;

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

  computeSchedulingResult(
    adjacency: FridayDagAdjacency,
    nodeStatuses: Map<string, NodeAttemptStatus>,
    graph: FridayCompiledWorkflowGraphV2,
    expressionContext: FridayExpressionContext,
    expressionEvaluator: FridayExpressionEvaluator,
  ): {
    readyNodes: string[];
    deadEndedNodes: string[];
  };
}

// ─── Terminal node statuses for scheduling purposes ───

const TERMINAL_STATUSES: ReadonlySet<NodeAttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ─── Factory ───

export function createFridayWorkflowDagScheduler(): FridayWorkflowDagScheduler {
  function evaluateSchedulingResult(
    adjacency: FridayDagAdjacency,
    nodeStatuses: Map<string, NodeAttemptStatus>,
    graph: FridayCompiledWorkflowGraphV2,
    expressionContext: FridayExpressionContext,
    expressionEvaluator: FridayExpressionEvaluator,
  ): {
    readyNodes: string[];
    deadEndedNodes: string[];
  } {
    const readyNodes: string[] = [];
    const deadEndedNodes: string[] = [];

    const edgeIndex = new Map<string, typeof graph.graph.edges[0]>();
    for (const edge of graph.graph.edges) {
      edgeIndex.set(`${edge.sourceNodeId}→${edge.targetNodeId}`, edge);
    }

    for (const nodeId of adjacency.topoOrder) {
      const currentStatus = nodeStatuses.get(nodeId);
      if (currentStatus && currentStatus !== "retrying") continue;

      if (currentStatus === "retrying") {
        readyNodes.push(nodeId);
        continue;
      }

      const predecessors = adjacency.inbound.get(nodeId) ?? [];
      if (predecessors.length === 0) {
        readyNodes.push(nodeId);
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
          } catch (err) {
            console.warn(
              `[friday] Workflow DAG edge condition evaluation failed for edge ${pred}→${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          anyEnabledEdge = true;
        }
      }

      if (allSatisfied && anyEnabledEdge) {
        readyNodes.push(nodeId);
      } else if (allSatisfied && !anyEnabledEdge && predecessors.length > 0) {
        deadEndedNodes.push(nodeId);
      }
    }

    return {
      readyNodes: readyNodes.slice(0, MAX_CONCURRENT_NODES),
      deadEndedNodes,
    };
  }

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
        throw new FridayDomainError("WORKFLOW_CYCLE_DETECTED", "WORKFLOW_CYCLE_DETECTED: graph contains a cycle", { httpStatus: 400 });
      }

      return { outbound, inbound, entryNodes, topoOrder };
    },

    buildExecutionPlan(runId, graph) {
      if (graph.graph.nodes.length > MAX_TOTAL_STEPS) {
        throw new FridayDomainError(
          "WORKFLOW_TOO_MANY_NODES",
          `Workflow graph contains ${graph.graph.nodes.length} nodes, exceeding the maximum of ${MAX_TOTAL_STEPS}`,
          { httpStatus: 400 },
        );
      }

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
      return evaluateSchedulingResult(
        adjacency,
        nodeStatuses,
        graph,
        expressionContext,
        expressionEvaluator,
      ).readyNodes;
    },

    computeSchedulingResult(
      adjacency,
      nodeStatuses,
      graph,
      expressionContext,
      expressionEvaluator,
    ) {
      return evaluateSchedulingResult(
        adjacency,
        nodeStatuses,
        graph,
        expressionContext,
        expressionEvaluator,
      );
    },
  };
}
