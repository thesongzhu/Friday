import type { ISODateTime, UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "./friday-workflow-builder-canvas.types.js";

// ─── Template Kinds ───

export type FridayWorkflowTemplateKind = "builtin" | "skill" | "user";
export type FridayWorkflowTemplateScope = "global" | "user";

// ─── Template Entity ───

export interface FridayWorkflowTemplateEntity {
  templateId: string;
  kind: FridayWorkflowTemplateKind;
  scope: FridayWorkflowTemplateScope;
  ownerUserId?: UUID;
  name: string;
  description?: string;
  tags: string[];
  sourceSkillId?: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
