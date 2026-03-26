import type { FridayAgentTaskProfileId } from "../../agent/runtime/friday-agent-task-profile.js";
import type { FridayWorkflowSpecV1 } from "../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../builder/model/friday-workflow-builder-canvas.types.js";

export interface FridayStableWorkflowTemplate {
  id: string;
  label: string;
  description: string;
  preferredBinding: "stable-skill" | "built-in-tool";
  defaultTaskProfile: FridayAgentTaskProfileId;
  tags: string[];
}

export const FRIDAY_STABLE_WORKFLOW_TEMPLATES: FridayStableWorkflowTemplate[] = [
  {
    id: "search",
    label: "Search",
    description: "Search the web or indexed sources with stable request/response structure.",
    preferredBinding: "built-in-tool",
    defaultTaskProfile: "deterministic",
    tags: ["lookup", "research"],
  },
  {
    id: "fetch",
    label: "Fetch",
    description: "Fetch a specific page or resource and normalize it for downstream steps.",
    preferredBinding: "built-in-tool",
    defaultTaskProfile: "deterministic",
    tags: ["web", "io"],
  },
  {
    id: "summarize",
    label: "Summarize",
    description: "Summarize gathered evidence into a compact stable artifact.",
    preferredBinding: "stable-skill",
    defaultTaskProfile: "review",
    tags: ["llm", "compression"],
  },
  {
    id: "browser_qa",
    label: "Browser QA",
    description: "Execute browser checks and capture UI evidence.",
    preferredBinding: "stable-skill",
    defaultTaskProfile: "review",
    tags: ["qa", "browser"],
  },
  {
    id: "diff_review",
    label: "Diff Review",
    description: "Review code or config diffs for regressions and risk.",
    preferredBinding: "stable-skill",
    defaultTaskProfile: "review",
    tags: ["review", "code"],
  },
  {
    id: "release_check",
    label: "Release Check",
    description: "Run a stable readiness pass before release or deployment.",
    preferredBinding: "stable-skill",
    defaultTaskProfile: "review",
    tags: ["release", "ops"],
  },
  {
    id: "security_review",
    label: "Security Review",
    description: "Perform a bounded security-oriented review over changed surfaces.",
    preferredBinding: "stable-skill",
    defaultTaskProfile: "review",
    tags: ["security", "audit"],
  },
  {
    id: "incident_triage",
    label: "Incident Triage",
    description: "Gather logs, classify failures, and summarize next actions for incident response.",
    preferredBinding: "stable-skill",
    defaultTaskProfile: "planning",
    tags: ["incident", "debug"],
  },
];

export function listFridayStableWorkflowTemplates(): FridayStableWorkflowTemplate[] {
  return [...FRIDAY_STABLE_WORKFLOW_TEMPLATES];
}

export function getFridayStableWorkflowTemplate(
  templateId: string,
): FridayStableWorkflowTemplate | null {
  return FRIDAY_STABLE_WORKFLOW_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

interface FridayStableWorkflowBindingBlueprint {
  stepType: "skill_call" | "tool_call";
  ref: string;
  inputKey: string;
  inputDescription: string;
}

const FRIDAY_STABLE_WORKFLOW_BINDINGS: Record<string, FridayStableWorkflowBindingBlueprint> = {
  search: {
    stepType: "tool_call",
    ref: "web_search",
    inputKey: "query",
    inputDescription: "Search query or lookup target.",
  },
  fetch: {
    stepType: "tool_call",
    ref: "web_fetch",
    inputKey: "url",
    inputDescription: "Target URL or resource identifier.",
  },
  summarize: {
    stepType: "skill_call",
    ref: "incident-brief-generator",
    inputKey: "goal",
    inputDescription: "What the summary should focus on.",
  },
  browser_qa: {
    stepType: "skill_call",
    ref: "browser-qa-report",
    inputKey: "goal",
    inputDescription: "Page URL or QA objective.",
  },
  diff_review: {
    stepType: "skill_call",
    ref: "workspace-diff-review",
    inputKey: "goal",
    inputDescription: "Review target or diff context.",
  },
  release_check: {
    stepType: "skill_call",
    ref: "release-readiness-check",
    inputKey: "goal",
    inputDescription: "Release scope or readiness objective.",
  },
  security_review: {
    stepType: "skill_call",
    ref: "security-review",
    inputKey: "goal",
    inputDescription: "Security review scope.",
  },
  incident_triage: {
    stepType: "skill_call",
    ref: "local-service-diagnose",
    inputKey: "goal",
    inputDescription: "Incident summary or failing service target.",
  },
};

function buildStableWorkflowVisual(
  workflowId: string,
  stepId: string,
): FridayWorkflowVisualGraphV1 {
  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
    nodes: [
      { nodeId: "__trigger__", x: 72, y: 120 },
      { nodeId: stepId, x: 356, y: 120 },
    ],
    edges: [],
  };
}

export function createFridayStableWorkflowDraftBundle(input: {
  templateId: string;
  workflowId: string;
  title: string;
  taskProfileId?: FridayAgentTaskProfileId;
}): {
  template: FridayStableWorkflowTemplate;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
} | null {
  const template = getFridayStableWorkflowTemplate(input.templateId);
  if (!template) {
    return null;
  }

  const binding = FRIDAY_STABLE_WORKFLOW_BINDINGS[template.id];
  if (!binding) {
    return null;
  }

  const stepId = `${template.id}-step`;
  const taskProfileId = input.taskProfileId ?? template.defaultTaskProfile;

  return {
    template,
    spec: {
      schemaVersion: "1.0",
      workflowId: input.workflowId,
      name: input.title,
      description: template.description,
      startStepId: stepId,
      trigger: { type: "manual" },
      inputs: [
        {
          key: binding.inputKey,
          type: "string",
          required: true,
        },
      ],
      steps: [
        {
          id: stepId,
          type: binding.stepType,
          ref: binding.ref,
          args: {
            [binding.inputKey]: `$inputs.${binding.inputKey}`,
            taskProfile: taskProfileId,
            stableTemplateId: template.id,
            preferredBinding: template.preferredBinding,
          },
        },
      ],
      edges: [],
      outputs: [
        {
          key: "result",
          fromStep: stepId,
          path: "result",
        },
      ],
      errorPolicy: {
        onFailure: "fail_fast",
        notifyUser: true,
      },
      tests: [
        {
          name: `${template.id} basic`,
          description: "Validates the starter template wiring.",
          inputs: {
            [binding.inputKey]: binding.inputDescription,
          },
          mocks: {
            [stepId]: {
              output: {
                result: "ok",
              },
            },
          },
          assertions: [
            {
              path: `steps.${stepId}.output.result`,
              operator: "==",
              expected: "ok",
            },
          ],
        },
      ],
    },
    visual: buildStableWorkflowVisual(input.workflowId, stepId),
  };
}
