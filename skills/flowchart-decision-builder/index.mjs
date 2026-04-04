import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const DECISION_PATTERNS = [
  /\bif\b/i, /\bwhether\b/i, /\bdecide\b/i, /\bchoose\b/i,
  /\bcheck\b/i, /\bverif/i, /\bvalid/i, /\bcondition/i,
  /\byes\s*\/?\s*no\b/i, /\bor\b/i, /\bdepending\b/i,
];

const END_PATTERNS = [
  /\bend\b/i, /\bstop\b/i, /\bdone\b/i, /\bcomplete/i,
  /\bfinish/i, /\bfinal\b/i, /\breturn\b/i, /\bexit\b/i,
];

const START_PATTERNS = [
  /\bstart\b/i, /\bbegin\b/i, /\binitiat/i, /\breceive\b/i,
  /\btrigger\b/i, /\binput\b/i, /\buser\s+submits?\b/i,
];

function extractSteps(text) {
  // Try numbered list
  const numbered = text.match(/(?:^|\n)\s*\d+[.)]\s*(.+)/g);
  if (numbered && numbered.length > 1) {
    return numbered.map(s => s.replace(/^\s*\d+[.)]\s*/, "").trim());
  }

  // Try bullet list
  const bullets = text.match(/(?:^|\n)\s*[-*]\s+(.+)/g);
  if (bullets && bullets.length > 1) {
    return bullets.map(s => s.replace(/^\s*[-*]\s+/, "").trim());
  }

  // Try "then"/"next" splitting
  const sequential = text.split(/\b(?:then|next|after that|afterwards|subsequently|finally)\b/i);
  if (sequential.length > 2) {
    return sequential.map(s => s.trim()).filter(s => s.length > 5);
  }

  // Fall back to sentence splitting
  return text.replace(/([.!?])\s+/g, "$1\n").split("\n").map(s => s.trim()).filter(s => s.length > 10);
}

function classifyStep(stepText) {
  const isDecision = DECISION_PATTERNS.some(p => p.test(stepText));
  const isEnd = END_PATTERNS.some(p => p.test(stepText));
  const isStart = START_PATTERNS.some(p => p.test(stepText));

  if (isStart) return "start";
  if (isEnd) return "end";
  if (isDecision) return "decision";
  return "process";
}

function shapeForType(type) {
  switch (type) {
    case "start": return "ellipse";
    case "end": return "rounded-rectangle";
    case "decision": return "diamond";
    default: return "rectangle";
  }
}

function extractBranches(stepText) {
  // Look for yes/no or option patterns
  if (/yes\s*\/?\s*no/i.test(stepText)) {
    return [{ label: "Yes", condition: "true" }, { label: "No", condition: "false" }];
  }
  const orMatch = stepText.match(/(.+?)\s+or\s+(.+?)(?:[.!?,]|$)/i);
  if (orMatch) {
    return [
      { label: compact(orMatch[1], 30), condition: "option_a" },
      { label: compact(orMatch[2], 30), condition: "option_b" },
    ];
  }
  return [];
}

export async function execute(input = {}) {
  const process = asString(input.process ?? input.content ?? input.text);
  if (!process) {
    throw new Error("flowchart-decision-builder requires a process input.");
  }

  const rawSteps = extractSteps(process);
  const nodes = [];
  const connections = [];
  let decisionCount = 0;

  // Build nodes
  for (let i = 0; i < rawSteps.length && i < 15; i++) {
    const stepText = rawSteps[i];
    const type = i === 0 ? "start" : i === rawSteps.length - 1 ? "end" : classifyStep(stepText);
    if (type === "decision") decisionCount++;

    nodes.push({
      id: `node_${i + 1}`,
      label: compact(stepText, 60),
      type,
      shape: shapeForType(type),
      branches: type === "decision" ? extractBranches(stepText) : [],
      x: 100,
      y: i * 120,
    });
  }

  // Build connections
  for (let i = 0; i < nodes.length - 1; i++) {
    const node = nodes[i];
    if (node.type === "decision" && node.branches.length > 0) {
      // Connect "yes" branch to next node
      connections.push({
        from: node.id,
        to: nodes[i + 1].id,
        label: node.branches[0].label,
        type: "arrow",
      });
      // Connect "no" branch to node after next (or last)
      const skipTarget = i + 2 < nodes.length ? nodes[i + 2].id : nodes[nodes.length - 1].id;
      connections.push({
        from: node.id,
        to: skipTarget,
        label: node.branches.length > 1 ? node.branches[1].label : "No",
        type: "arrow",
      });
    } else {
      connections.push({
        from: node.id,
        to: nodes[i + 1].id,
        label: "",
        type: "arrow",
      });
    }
  }

  const flowchartType = decisionCount > 0 ? "decision-tree" : "linear-flow";

  return {
    summary: `Flowchart built: ${nodes.length} nodes (${decisionCount} decision points), ${connections.length} connections.`,
    nextStep: "Review node labels and branch conditions, then render in your preferred diagram tool.",
    details: {
      flowchartType,
      layoutDirection: "top-to-bottom",
      nodes,
      connections,
      nodeCount: nodes.length,
      decisionCount,
      connectionCount: connections.length,
      suggestedSkillId: "excalidraw-diagram-generator",
    },
  };
}
