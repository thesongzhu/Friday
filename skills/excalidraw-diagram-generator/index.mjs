import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const SEQUENCE_PATTERNS = [
  /\bthen\b/i, /\bafter\b/i, /\bnext\b/i, /\bfollowed by\b/i,
  /\bfinally\b/i, /\bfirst\b/i, /\bsecond\b/i, /\bthird\b/i,
  /\bstep\s*\d/i, /\d+\./,
];

const HIERARCHY_PATTERNS = [
  /\bcontains\b/i, /\bincludes?\b/i, /\bcomposed of\b/i,
  /\bpart of\b/i, /\bbelongs to\b/i, /\bunder\b/i, /\bparent\b/i, /\bchild\b/i,
];

const RELATIONSHIP_PATTERNS = [
  /\bconnects? to\b/i, /\blinks? to\b/i, /\bsends? to\b/i,
  /\breceives? from\b/i, /\bcommunicates? with\b/i, /\binteracts? with\b/i,
  /\bdepends? on\b/i, /\btriggers?\b/i, /\bcalls?\b/i,
];

function inferLayoutDirection(text) {
  const seqScore = SEQUENCE_PATTERNS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  const hierScore = HIERARCHY_PATTERNS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  if (hierScore > seqScore) return "top-to-bottom";
  if (seqScore > 2) return "left-to-right";
  return "left-to-right";
}

function extractEntities(text) {
  const entities = new Set();

  // Extract quoted terms
  const quoted = text.match(/["']([^"']+)["']/g);
  if (quoted) {
    for (const q of quoted) entities.add(q.replace(/["']/g, "").trim());
  }

  // Extract capitalized phrases (2+ words or single capitalized word not at sentence start)
  const caps = text.match(/(?<=[.!?\s]|^)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g);
  if (caps) {
    for (const c of caps) {
      if (c.length > 2 && !/^(The|This|That|These|Those|When|Where|What|How|Why|And|But|For|Not|All|Any|Each|From|Into|With|Then|Next|First|After|Finally)$/.test(c)) {
        entities.add(c.trim());
      }
    }
  }

  // Extract items from bullet/numbered lists
  const listItems = text.match(/(?:^|\n)\s*[-*\d.]+\s+(.+)/gm);
  if (listItems) {
    for (const item of listItems) {
      const cleaned = item.replace(/^\s*[-*\d.]+\s+/, "").trim();
      if (cleaned.length > 2 && cleaned.length < 60) entities.add(cleaned);
    }
  }

  // Fallback: split by commas/semicolons if we have few entities
  if (entities.size < 3) {
    const segments = text.split(/[,;]/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 60);
    for (const seg of segments.slice(0, 8)) {
      entities.add(compact(seg, 50));
    }
  }

  return [...entities].slice(0, 12);
}

function buildNodes(entities) {
  return entities.map((label, i) => ({
    id: `node_${i + 1}`,
    label: compact(label, 50),
    x: (i % 4) * 220,
    y: Math.floor(i / 4) * 160,
    width: 180,
    height: 60,
    shape: "rectangle",
  }));
}

function inferConnections(text, nodes) {
  const connections = [];

  // Connect sequentially if sequence patterns are detected
  const isSequential = SEQUENCE_PATTERNS.some(p => p.test(text));
  if (isSequential) {
    for (let i = 0; i < nodes.length - 1; i++) {
      connections.push({
        from: nodes[i].id,
        to: nodes[i + 1].id,
        label: "",
        type: "arrow",
      });
    }
    return connections;
  }

  // Try to find explicit relationships in text
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].label.toLowerCase();
      const b = nodes[j].label.toLowerCase();
      // Check if both appear near each other in text
      const aIdx = text.toLowerCase().indexOf(a);
      const bIdx = text.toLowerCase().indexOf(b);
      if (aIdx >= 0 && bIdx >= 0 && Math.abs(aIdx - bIdx) < 150) {
        connections.push({
          from: nodes[i].id,
          to: nodes[j].id,
          label: "",
          type: "arrow",
        });
      }
    }
  }

  // Fallback: connect first node to all others (hub pattern)
  if (connections.length === 0 && nodes.length > 1) {
    for (let i = 1; i < nodes.length; i++) {
      connections.push({
        from: nodes[0].id,
        to: nodes[i].id,
        label: "",
        type: "arrow",
      });
    }
  }

  return connections;
}

export async function execute(input = {}) {
  const concept = asString(input.concept ?? input.content ?? input.text);
  if (!concept) {
    throw new Error("excalidraw-diagram-generator requires a concept input.");
  }

  const entities = extractEntities(concept);
  const nodes = buildNodes(entities);
  const connections = inferConnections(concept, nodes);
  const layoutDirection = inferLayoutDirection(concept);

  // Determine diagram type
  const hasHierarchy = HIERARCHY_PATTERNS.some(p => p.test(concept));
  const diagramType = hasHierarchy ? "hierarchy" : connections.length >= nodes.length ? "flowchart" : "network";

  return {
    summary: `Diagram generated: ${nodes.length} nodes, ${connections.length} connections, ${layoutDirection} layout.`,
    nextStep: "Import the node and connection data into Excalidraw or refine labels and layout.",
    details: {
      title: compact(concept.split(/[.!?\n]/)[0] || "Diagram", 80),
      diagramType,
      layoutDirection,
      nodes,
      connections,
      nodeCount: nodes.length,
      connectionCount: connections.length,
      suggestedSkillId: "flowchart-decision-builder",
    },
  };
}
