/**
 * Converter Pipeline Types (ported from the deprecated compat surface during C-006 convergence).
 *
 * These types represent the pipeline state machine, quality gate, and
 * diagnostic abstractions that augment the core converter interface.
 * They are optional — converters still implement the simple detect/convert
 * interface, but the service layer can use these for pipeline orchestration.
 */

// ─── Pipeline States ───

export const FRIDAY_CONVERTER_PIPELINE_STATES = [
  "pending",
  "detecting",
  "converting",
  "validating",
  "installing",
  "completed",
  "failed",
  "cancelled",
] as const;

export type FridayConverterPipelineState =
  (typeof FRIDAY_CONVERTER_PIPELINE_STATES)[number];

export const FRIDAY_CONVERTER_PIPELINE_TRANSITIONS: Readonly<
  Record<FridayConverterPipelineState, readonly FridayConverterPipelineState[]>
> = {
  pending: ["detecting", "cancelled", "failed"],
  detecting: ["converting", "failed", "cancelled"],
  converting: ["validating", "failed", "cancelled"],
  validating: ["installing", "completed", "failed", "cancelled"],
  installing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const FRIDAY_CONVERTER_PIPELINE_TERMINAL_STATES: readonly FridayConverterPipelineState[] = [
  "completed",
  "failed",
  "cancelled",
];

// ─── Pipeline Stage ───

export interface FridayConverterPipelineStage {
  readonly name: FridayConverterPipelineState;
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly errorMessage: string | null;
}

// ─── Quality Gate ───

export const FRIDAY_CONVERTER_QUALITY_GATES = [
  "schema_validation",
  "manifest_completeness",
  "file_integrity",
] as const;

export type FridayConverterQualityGate =
  (typeof FRIDAY_CONVERTER_QUALITY_GATES)[number];

export interface FridayConverterQualityCheck {
  readonly gate: FridayConverterQualityGate;
  readonly passed: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface FridayConverterQualityResult {
  readonly checks: readonly FridayConverterQualityCheck[];
  readonly allPassed: boolean;
  readonly checkedAt: string;
}

// ─── Diagnostics ───

export const FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES = [
  "info",
  "warning",
  "error",
  "fatal",
] as const;

export type FridayConverterDiagnosticSeverity =
  (typeof FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES)[number];

export interface FridayConverterDiagnostic {
  readonly severity: FridayConverterDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly converterId?: string;
  readonly stage?: FridayConverterPipelineState;
  readonly timestamp: string;
}

// ─── Pipeline Record ───

export interface FridayConverterPipelineRecord {
  readonly id: string;
  readonly state: FridayConverterPipelineState;
  readonly currentStage: FridayConverterPipelineState | null;
  readonly stages: readonly FridayConverterPipelineStage[];
  readonly qualityResult: FridayConverterQualityResult | null;
  readonly diagnostics: readonly FridayConverterDiagnostic[];
  readonly errorMessage: string | null;
  readonly errorCode: string | null;
  readonly sourceFormat: string | null;
  readonly converterId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── Convergence Guard ───

/**
 * Canonical converter stack identifier.
 *
 * After C-006 convergence, only "skills" is the production pipeline.
 * The "universal" stack is deprecated and re-exports from "skills".
 */
export type FridayConverterStack = "skills" | "universal";

export const FRIDAY_CANONICAL_CONVERTER_STACK: FridayConverterStack = "skills";
