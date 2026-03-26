import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 120;

export function applyDagreLayout<
  TNode extends Node<Record<string, unknown>>,
  TEdge extends Edge<Record<string, unknown>>,
>(
  input: {
    nodes: TNode[];
    edges: TEdge[];
    direction?: "LR" | "TB";
  },
): TNode[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: input.direction ?? "LR",
    nodesep: 48,
    ranksep: 88,
    marginx: 32,
    marginy: 32,
  });

  for (const node of input.nodes) {
    graph.setNode(node.id, {
      width: node.width ?? DEFAULT_NODE_WIDTH,
      height: node.height ?? DEFAULT_NODE_HEIGHT,
    });
  }

  for (const edge of input.edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  return input.nodes.map((node) => {
    const positioned = graph.node(node.id);
    if (!positioned) {
      return node;
    }
    const width = node.width ?? DEFAULT_NODE_WIDTH;
    const height = node.height ?? DEFAULT_NODE_HEIGHT;
    return {
      ...node,
      position: {
        x: positioned.x - width / 2,
        y: positioned.y - height / 2,
      },
    };
  });
}
