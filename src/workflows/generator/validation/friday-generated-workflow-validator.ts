import type { FridaySkillRegistry, SkillLifecycleStatus } from "#skills";
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowCompiler,
  FridayWorkflowSpecTestCase,
  FridayWorkflowSpecV1,
  FridayWorkflowValidator,
  FridayWorkflowVisualGraphV1,
} from "#workflows";
import type { FridayGeneratedWorkflowValidationIssue } from "../model/friday-workflow-generator.types.js";
import {
  getFridayWorkflowStepIdFormatMessage,
  isFridayWorkflowStepIdExpressionSafe,
} from "../../utils/friday-workflow-step-id.js";

// ─── Interface ───

export interface FridayGeneratedWorkflowValidator {
  validate(input: {
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
    tests: FridayWorkflowSpecTestCase[];
  }): {
    compiledGraph?: FridayCompiledWorkflowGraphV2;
    issues: FridayGeneratedWorkflowValidationIssue[];
  };
}

// ─── Deps ───

export interface CreateFridayGeneratedWorkflowValidatorDeps {
  compiler: FridayWorkflowCompiler;
  workflowValidator: FridayWorkflowValidator;
  skillRegistry: FridaySkillRegistry;
  getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | null | undefined;
  idGenerator: () => string;
}

// ─── Allowed test assertion operators ───

const ALLOWED_TEST_OPERATORS = new Set(["==", "!=", ">", "<", "contains", "matches"]);

// ─── Allowed assertion path prefixes ───

const ALLOWED_PATH_PREFIXES = ["inputs.", "steps.", "outputs."];

// ─── Factory ───

export function createFridayGeneratedWorkflowValidator(
  deps: CreateFridayGeneratedWorkflowValidatorDeps,
): FridayGeneratedWorkflowValidator {
  return {
    validate(input) {
      const { spec, visual, tests } = input;
      const issues: FridayGeneratedWorkflowValidationIssue[] = [];

      // ─── Spec validation ───

      // schemaVersion
      if (spec.schemaVersion !== "1.0") {
        issues.push({
          code: "SPEC_INVALID_SCHEMA_VERSION",
          stage: "spec",
          severity: "error",
          message: `Expected schemaVersion "1.0", got "${spec.schemaVersion}"`,
        });
      }

      // startStepId must exist in steps
      const stepIds = new Set(spec.steps.map((s) => s.id));
      if (!isFridayWorkflowStepIdExpressionSafe(spec.startStepId)) {
        issues.push({
          code: "SPEC_INVALID_START_STEP_ID",
          stage: "spec",
          severity: "error",
          message: `startStepId "${spec.startStepId}" is invalid. ${getFridayWorkflowStepIdFormatMessage()}`,
          stepId: spec.startStepId,
        });
      }
      if (!stepIds.has(spec.startStepId)) {
        issues.push({
          code: "SPEC_START_STEP_MISSING",
          stage: "spec",
          severity: "error",
          message: `startStepId "${spec.startStepId}" not found in steps`,
          stepId: spec.startStepId,
        });
      }

      // Edge references valid steps
      for (const step of spec.steps) {
        if (!isFridayWorkflowStepIdExpressionSafe(step.id)) {
          issues.push({
            code: "SPEC_INVALID_STEP_ID",
            stage: "spec",
            severity: "error",
            message: `Step "${step.id}" uses an invalid id. ${getFridayWorkflowStepIdFormatMessage()}`,
            stepId: step.id,
          });
        }
      }

      for (const edge of spec.edges) {
        if (!stepIds.has(edge.from)) {
          issues.push({
            code: "SPEC_EDGE_MISSING_SOURCE",
            stage: "spec",
            severity: "error",
            message: `Edge from "${edge.from}" references unknown step`,
            edgeRef: { from: edge.from, to: edge.to, when: edge.when },
          });
        }
        if (!stepIds.has(edge.to)) {
          issues.push({
            code: "SPEC_EDGE_MISSING_TARGET",
            stage: "spec",
            severity: "error",
            message: `Edge to "${edge.to}" references unknown step`,
            edgeRef: { from: edge.from, to: edge.to, when: edge.when },
          });
        }
      }

      // Output fromStep references valid steps
      for (const out of spec.outputs) {
        if (!stepIds.has(out.fromStep)) {
          issues.push({
            code: "SPEC_OUTPUT_MISSING_STEP",
            stage: "spec",
            severity: "error",
            message: `Output "${out.key}" references unknown step "${out.fromStep}"`,
            path: `outputs.${out.key}`,
          });
        }
      }

      // ─── Skill reference validation ───

      for (const step of spec.steps) {
        if (
          (step.type === "skill_call" || step.type === "tool_call") &&
          step.ref
        ) {
          const skill = deps.skillRegistry.get(step.ref);
          if (!skill) {
            issues.push({
              code: "SKILL_REF_NOT_FOUND",
              stage: "skill_refs",
              severity: "error",
              message: `Step "${step.id}" references unknown skill "${step.ref}"`,
              stepId: step.id,
            });
            continue;
          }
          const lifecycleStatus = deps.getSkillLifecycleStatus?.(step.ref) ?? skill.status ?? "installed";
          if (lifecycleStatus !== "installed") {
            issues.push({
              code: "SKILL_REF_NOT_AVAILABLE",
              stage: "skill_refs",
              severity: "error",
              message: `Step "${step.id}" references unavailable skill "${step.ref}"`,
              stepId: step.id,
            });
          }
        }
      }

      // ─── Visual validation ───

      if (visual.schemaVersion !== "1.0") {
        issues.push({
          code: "VISUAL_INVALID_SCHEMA_VERSION",
          stage: "visual",
          severity: "error",
          message: `Expected visual schemaVersion "1.0", got "${visual.schemaVersion}"`,
        });
      }

      if (visual.workflowId !== spec.workflowId) {
        issues.push({
          code: "VISUAL_WORKFLOW_ID_MISMATCH",
          stage: "visual",
          severity: "error",
          message: `Visual workflowId "${visual.workflowId}" does not match spec workflowId "${spec.workflowId}"`,
        });
      }

      // Visual nodes must include __trigger__ and every step
      const visualNodeIds = new Set(visual.nodes.map((n) => n.nodeId));
      const expectedVisualIds = new Set(["__trigger__", ...stepIds]);

      for (const expectedId of expectedVisualIds) {
        if (!visualNodeIds.has(expectedId)) {
          issues.push({
            code: "VISUAL_MISSING_NODE",
            stage: "visual",
            severity: "error",
            message: `Visual graph missing node for "${expectedId}"`,
            stepId: expectedId,
          });
        }
      }

      // Check for orphan visual nodes
      for (const visualId of visualNodeIds) {
        if (!expectedVisualIds.has(visualId)) {
          issues.push({
            code: "VISUAL_ORPHAN_NODE",
            stage: "visual",
            severity: "warning",
            message: `Visual graph has orphan node "${visualId}" not in spec`,
            stepId: visualId,
          });
        }
      }

      // Check x/y are finite
      for (const node of visual.nodes) {
        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
          issues.push({
            code: "VISUAL_INVALID_POSITION",
            stage: "visual",
            severity: "error",
            message: `Visual node "${node.nodeId}" has non-finite position (x=${node.x}, y=${node.y})`,
            stepId: node.nodeId,
          });
        }
      }

      // ─── Test validation ───

      for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        if (!test.name) {
          issues.push({
            code: "TEST_MISSING_NAME",
            stage: "tests",
            severity: "error",
            message: `Test [${i}] is missing a name`,
            path: `tests[${i}].name`,
          });
        }

        if (!test.assertions || test.assertions.length === 0) {
          issues.push({
            code: "TEST_MISSING_ASSERTIONS",
            stage: "tests",
            severity: "error",
            message: `Test "${test.name ?? i}" has no assertions`,
            path: `tests[${i}].assertions`,
          });
        }

        if (test.assertions) {
          for (let j = 0; j < test.assertions.length; j++) {
            const assertion = test.assertions[j];
            if (!ALLOWED_TEST_OPERATORS.has(assertion.operator)) {
              issues.push({
                code: "TEST_INVALID_OPERATOR",
                stage: "tests",
                severity: "error",
                message: `Test "${test.name}" assertion [${j}] uses invalid operator "${assertion.operator}"`,
                path: `tests[${i}].assertions[${j}].operator`,
              });
            }

            if (!ALLOWED_PATH_PREFIXES.some((p) => assertion.path.startsWith(p))) {
              issues.push({
                code: "TEST_INVALID_PATH",
                stage: "tests",
                severity: "error",
                message: `Test "${test.name}" assertion [${j}] path "${assertion.path}" must start with inputs., steps., or outputs.`,
                path: `tests[${i}].assertions[${j}].path`,
              });
            }
          }
        }

        // Mocks must reference valid step IDs
        if (test.mocks) {
          for (const mockStepId of Object.keys(test.mocks)) {
            if (!stepIds.has(mockStepId)) {
              issues.push({
                code: "TEST_MOCK_UNKNOWN_STEP",
                stage: "tests",
                severity: "error",
                message: `Test "${test.name}" mocks unknown step "${mockStepId}"`,
                path: `tests[${i}].mocks.${mockStepId}`,
                stepId: mockStepId,
              });
            }
          }
        }
      }

      // ─── Compile validation ───

      let compiledGraph: FridayCompiledWorkflowGraphV2 | undefined;
      const hasBlockingErrors = issues.some((i) => i.severity === "error");

      if (!hasBlockingErrors) {
        try {
          compiledGraph = deps.compiler.compile(spec, deps.idGenerator());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          issues.push({
            code: "COMPILE_ERROR",
            stage: "compile",
            severity: "error",
            message: `Compilation failed: ${message}`,
          });
        }
      }

      // ─── Graph validation (if compiled) ───

      if (compiledGraph) {
        for (const node of compiledGraph.graph.nodes) {
          if (node.type !== "data") {
            continue;
          }
          const config = (node.config ?? {}) as Record<string, unknown>;
          if (config.mapping === undefined && config.transform === undefined) {
            issues.push({
              code: "GRAPH_DATA_NODE_MISSING_MAPPING",
              stage: "graph",
              severity: "error",
              message: `Data node "${node.id}" must define config.mapping or config.transform`,
              stepId: node.id,
            });
          }
        }

        const graphValidation = deps.workflowValidator.validate(compiledGraph);
        if (!graphValidation.valid) {
          for (const graphError of graphValidation.errors) {
            issues.push({
              code: graphError.code,
              stage: "graph",
              severity: "error",
              message: graphError.message,
              stepId: graphError.nodeId,
            });
          }
        }
      }

      return { compiledGraph, issues };
    },
  };
}
