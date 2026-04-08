export const FRIDAY_WORKFLOW_STEP_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function isFridayWorkflowStepIdExpressionSafe(stepId: string): boolean {
  return FRIDAY_WORKFLOW_STEP_ID_PATTERN.test(stepId);
}

export function getFridayWorkflowStepIdFormatMessage(): string {
  return "Step ids must start with a letter and use only letters, numbers, underscores, or hyphens.";
}
