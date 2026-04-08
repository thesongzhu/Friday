import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type { FridayWorkflowDraftEntity } from "../model/friday-workflow-builder-draft.types.js";
import type {
  FridayWorkflowBuilderValidationIssue,
  FridayWorkflowBuilderValidationReport,
  FridayWorkflowValidationStage,
} from "../model/friday-workflow-builder-validation.types.js";
import type { FridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import type { FridayWorkflowValidator } from "../../compiler/friday-workflow-validator.js";
import type { FridaySkillRepository } from "#skills";
import {
  getFridayWorkflowStepIdFormatMessage,
  isFridayWorkflowStepIdExpressionSafe,
} from "../../utils/friday-workflow-step-id.js";

// ─── Interface ───

export interface FridayWorkflowBuilderValidationService {
  validateSpec(spec: FridayWorkflowSpecV1): FridayWorkflowBuilderValidationReport;
  validateDraft(draft: FridayWorkflowDraftEntity): FridayWorkflowBuilderValidationReport;
  validateForPublish(draft: FridayWorkflowDraftEntity): FridayWorkflowBuilderValidationReport;
}

// ─── Dependencies ───

export interface CreateValidationServiceDeps {
  compiler: FridayWorkflowCompiler;
  validator: FridayWorkflowValidator;
  db?: FridaySqliteLayer;
  skillRepo?: FridaySkillRepository;
  nowIso: () => string;
  idGenerator: () => string;
}

// ─── Spec Schema Validation ───

function validateSpecSchema(spec: FridayWorkflowSpecV1): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  if (spec.schemaVersion !== "1.0") {
    issues.push({
      code: "SPEC_INVALID_SCHEMA_VERSION",
      stage: "spec_schema",
      severity: "error",
      message: `Expected schemaVersion '1.0', got '${spec.schemaVersion}'`,
    });
  }

  if (!spec.workflowId) {
    issues.push({
      code: "SPEC_MISSING_WORKFLOW_ID",
      stage: "spec_schema",
      severity: "error",
      message: "workflowId is required",
    });
  }

  if (!spec.name) {
    issues.push({
      code: "SPEC_MISSING_NAME",
      stage: "spec_schema",
      severity: "error",
      message: "name is required",
    });
  }

  if (!spec.startStepId) {
    issues.push({
      code: "SPEC_MISSING_START_STEP",
      stage: "spec_schema",
      severity: "error",
      message: "startStepId is required",
    });
  } else if (!isFridayWorkflowStepIdExpressionSafe(spec.startStepId)) {
    issues.push({
      code: "SPEC_INVALID_START_STEP_ID",
      stage: "spec_schema",
      severity: "error",
      message: `startStepId '${spec.startStepId}' is invalid. ${getFridayWorkflowStepIdFormatMessage()}`,
      stepId: spec.startStepId,
    });
  }

  if (!spec.steps || spec.steps.length === 0) {
    issues.push({
      code: "SPEC_NO_STEPS",
      stage: "spec_schema",
      severity: "error",
      message: "At least one step is required",
    });
  }

  // Verify startStepId references an existing step
  if (spec.startStepId && spec.steps.length > 0) {
    const stepIds = new Set(spec.steps.map((s) => s.id));
    if (!stepIds.has(spec.startStepId)) {
      issues.push({
        code: "SPEC_START_STEP_NOT_FOUND",
        stage: "spec_schema",
        severity: "error",
        message: `startStepId '${spec.startStepId}' does not reference any step`,
      });
    }

    // Check for duplicate step IDs
    const seen = new Set<string>();
    for (const step of spec.steps) {
      if (!isFridayWorkflowStepIdExpressionSafe(step.id)) {
        issues.push({
          code: "SPEC_INVALID_STEP_ID",
          stage: "spec_schema",
          severity: "error",
          message: `Step id '${step.id}' is invalid. ${getFridayWorkflowStepIdFormatMessage()}`,
          stepId: step.id,
        });
      }
      if (seen.has(step.id)) {
        issues.push({
          code: "SPEC_DUPLICATE_STEP_ID",
          stage: "spec_schema",
          severity: "error",
          message: `Duplicate step id '${step.id}'`,
          stepId: step.id,
        });
      }
      seen.add(step.id);
    }

    // Verify edge references
    for (const edge of spec.edges) {
      if (!stepIds.has(edge.from)) {
        issues.push({
          code: "SPEC_EDGE_MISSING_SOURCE",
          stage: "spec_schema",
          severity: "error",
          message: `Edge references missing source step '${edge.from}'`,
          edgeRef: { from: edge.from, to: edge.to, when: edge.when },
        });
      }
      if (!stepIds.has(edge.to)) {
        issues.push({
          code: "SPEC_EDGE_MISSING_TARGET",
          stage: "spec_schema",
          severity: "error",
          message: `Edge references missing target step '${edge.to}'`,
          edgeRef: { from: edge.from, to: edge.to, when: edge.when },
        });
      }
    }

    // Verify output references
    for (const output of spec.outputs) {
      if (!stepIds.has(output.fromStep)) {
        issues.push({
          code: "SPEC_OUTPUT_MISSING_STEP",
          stage: "spec_schema",
          severity: "error",
          message: `Output '${output.key}' references missing step '${output.fromStep}'`,
        });
      }
    }
  }

  // Validate trigger
  if (!spec.trigger || !spec.trigger.type) {
    issues.push({
      code: "SPEC_MISSING_TRIGGER",
      stage: "spec_schema",
      severity: "error",
      message: "trigger is required",
    });
  }

  return issues;
}

// ─── Canvas Validation ───

function validateCanvas(
  spec: FridayWorkflowSpecV1,
  visual: FridayWorkflowVisualGraphV1,
): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  const stepIds = new Set(spec.steps.map((s) => s.id));

  for (const nodeLayout of visual.nodes) {
    if (!stepIds.has(nodeLayout.nodeId) && nodeLayout.nodeId !== "__trigger__") {
      issues.push({
        code: "CANVAS_ORPHAN_NODE",
        stage: "canvas",
        severity: "warning",
        message: `Visual node '${nodeLayout.nodeId}' does not reference a spec step`,
      });
    }
  }

  if (visual.viewport.zoom < 0.1 || visual.viewport.zoom > 10) {
    issues.push({
      code: "CANVAS_INVALID_ZOOM",
      stage: "canvas",
      severity: "warning",
      message: `Viewport zoom ${visual.viewport.zoom} is outside reasonable range [0.1, 10]`,
    });
  }

  return issues;
}

// ─── Test Validation ───

function validateTests(spec: FridayWorkflowSpecV1): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];
  const stepIds = new Set(spec.steps.map((s) => s.id));
  const validOperators = new Set(["==", "!=", ">", "<", "contains", "matches"]);

  for (let i = 0; i < spec.tests.length; i++) {
    const test = spec.tests[i]!;
    if (!test.name) {
      issues.push({
        code: "TEST_MISSING_NAME",
        stage: "tests",
        severity: "error",
        message: `Test at index ${i} is missing a name`,
        jsonPath: `tests[${i}].name`,
      });
    }

    // Validate mock references
    if (test.mocks) {
      for (const stepId of Object.keys(test.mocks)) {
        if (!stepIds.has(stepId)) {
          issues.push({
            code: "TEST_MOCK_UNKNOWN_STEP",
            stage: "tests",
            severity: "warning",
            message: `Test '${test.name}' mocks unknown step '${stepId}'`,
            stepId,
            jsonPath: `tests[${i}].mocks.${stepId}`,
          });
        }
      }
    }

    // Validate assertion operators
    for (let j = 0; j < test.assertions.length; j++) {
      const assertion = test.assertions[j]!;
      if (!validOperators.has(assertion.operator)) {
        issues.push({
          code: "TEST_INVALID_OPERATOR",
          stage: "tests",
          severity: "error",
          message: `Test '${test.name}' assertion ${j} has invalid operator '${assertion.operator}'`,
          jsonPath: `tests[${i}].assertions[${j}].operator`,
        });
      }
    }
  }

  return issues;
}

// ─── Skill Refs Validation ───

function validateSkillRefs(
  spec: FridayWorkflowSpecV1,
  db: FridaySqliteLayer,
  skillRepo: FridaySkillRepository,
): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  for (const step of spec.steps) {
    if ((step.type === "skill_call" || step.type === "tool_call") && step.ref) {
      const skill = db.withReadConnection((readerDb) =>
        skillRepo.getSkillById(readerDb, step.ref!),
      );
      if (!skill) {
        issues.push({
          code: "SKILL_REF_NOT_FOUND",
          stage: "skill_refs",
          severity: "error",
          message: `Step '${step.id}' references unknown skill '${step.ref}'`,
          stepId: step.id,
        });
      }
    }
  }

  return issues;
}

// ─── Expression Condition Validation ───

function validateEdgeConditions(
  spec: FridayWorkflowSpecV1,
  compiler: FridayWorkflowCompiler,
): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  for (const step of spec.steps) {
    if (step.condition) {
      // Attempt to parse the condition with a mini-spec
      try {
        compiler.validateSpec({
          ...spec,
          steps: [{ ...step, id: "__validate_cond__" }],
          edges: [],
          startStepId: "__validate_cond__",
          outputs: [],
          tests: [],
        });
      } catch (err) {
        console.warn("[friday][workflow-builder-validation] condition expression invalid:", err instanceof Error ? err.message : String(err));
        issues.push({
          code: "EXPRESSION_INVALID",
          stage: "expressions",
          severity: "error",
          message: `Step '${step.id}' has invalid condition expression: '${step.condition}'`,
          stepId: step.id,
        });
      }
    }
  }

  return issues;
}

// ─── Factory ───

export function createFridayWorkflowBuilderValidationService(
  deps: CreateValidationServiceDeps,
): FridayWorkflowBuilderValidationService {
  function runFullValidation(
    spec: FridayWorkflowSpecV1,
    visual?: FridayWorkflowVisualGraphV1,
    forPublish = false,
  ): FridayWorkflowBuilderValidationReport {
    const issues: FridayWorkflowBuilderValidationIssue[] = [];

    // Stage 1: spec_schema
    issues.push(...validateSpecSchema(spec));

    // Stage 6: tests
    issues.push(...validateTests(spec));

    // Stage 7: canvas
    if (visual) {
      issues.push(...validateCanvas(spec, visual));
    }

    // If spec schema has errors, skip compilation
    const hasSchemaErrors = issues.some(
      (i) => i.stage === "spec_schema" && i.severity === "error",
    );

    let compiledPreview = undefined;

    if (!hasSchemaErrors) {
      // Stage 2: graph_compile
      try {
        const compiled = deps.compiler.compile(spec, deps.idGenerator());
        compiledPreview = compiled;

        // Stage 3: compiled_graph (Phase 3 validator)
        const validation = deps.validator.validate(compiled);
        if (!validation.valid) {
          for (const error of validation.errors) {
            issues.push({
              code: error.code,
              stage: "compiled_graph",
              severity: "error",
              message: error.message,
              stepId: error.nodeId,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        issues.push({
          code: "GRAPH_COMPILATION_FAILED",
          stage: "graph_compile",
          severity: "error",
          message,
        });
      }

      // Stage 4: skill_refs — verify referenced skills exist
      if (deps.db && deps.skillRepo) {
        issues.push(...validateSkillRefs(spec, deps.db, deps.skillRepo));
      }

      // Stage 5: expressions — validate step conditions and edge conditions
      issues.push(...validateEdgeConditions(spec, deps.compiler));
    }

    // For publish: enforce no errors
    const hasErrors = issues.some((i) => i.severity === "error");
    if (forPublish && hasErrors) {
      issues.push({
        code: "PUBLISH_BLOCKED_BY_ERRORS",
        stage: "spec_schema",
        severity: "error",
        message: "Cannot publish: validation errors must be resolved first",
      });
    }

    return {
      valid: !issues.some((i) => i.severity === "error"),
      issues,
      compiledGraphPreview: compiledPreview,
      generatedAt: deps.nowIso(),
    };
  }

  return {
    validateSpec(spec) {
      return runFullValidation(spec);
    },

    validateDraft(draft) {
      return runFullValidation(draft.spec, draft.visual);
    },

    validateForPublish(draft) {
      return runFullValidation(draft.spec, draft.visual, true);
    },
  };
}
