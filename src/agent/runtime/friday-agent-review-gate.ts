// ─── Review gate modes ───

export type FridayAgentReviewMode = "off" | "auto-approve" | "auto-reject";

// ─── Review decision ───

export interface FridayAgentReviewDecision {
  approved: boolean;
  mode: FridayAgentReviewMode;
  reason?: string;
  reviewedAt: string;
}

// ─── Plan review payload (persisted as plan_review_json) ───

export interface FridayAgentPlanReview {
  plan: FridayAgentPlanSummary;
  decision?: FridayAgentReviewDecision;
}

export interface FridayAgentPlanSummary {
  task: string;
  stepCount: number;
  description: string;
}

// ─── Review gate interface ───

export interface FridayAgentReviewGate {
  /** The current mode. */
  mode: FridayAgentReviewMode;
  /** Decide whether to approve a plan. Returns the decision. */
  review(plan: FridayAgentPlanSummary, nowIso: string): FridayAgentReviewDecision;
}

// ─── Factory ───

export function createFridayAgentReviewGate(
  mode: FridayAgentReviewMode = "off",
): FridayAgentReviewGate {
  return {
    mode,
    review(plan: FridayAgentPlanSummary, nowIso: string): FridayAgentReviewDecision {
      switch (mode) {
        case "off":
          // No review — auto-approve silently
          return {
            approved: true,
            mode: "off",
            reason: "Review gate is off — auto-approved",
            reviewedAt: nowIso,
          };
        case "auto-approve":
          return {
            approved: true,
            mode: "auto-approve",
            reason: `Auto-approved plan with ${String(plan.stepCount)} step(s)`,
            reviewedAt: nowIso,
          };
        case "auto-reject":
          return {
            approved: false,
            mode: "auto-reject",
            reason: `Auto-rejected plan: ${plan.description}`,
            reviewedAt: nowIso,
          };
      }
    },
  };
}
