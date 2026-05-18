import type { FridayWorkflowTemplateEntity } from "../model/friday-workflow-builder-template.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import {
  type FridayCrossBorderWorkflowCatalogEntry,
  listFridayCrossBorderWorkflowCatalog,
} from "../../../packs/cross-border/friday-cross-border-workflow-catalog.js";

const CREATED_AT = "2026-04-08T00:00:00.000Z";

function buildVisual(
  workflowId: string,
  stepIds: string[],
  edgeKeys: string[],
): FridayWorkflowVisualGraphV1 {
  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 0.92 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: [
      { nodeId: "__trigger__", x: 72, y: 136 },
      ...stepIds.map((stepId, index) => ({
        nodeId: stepId,
        x: 356 + index * 276,
        y: 136,
      })),
    ],
    edges: edgeKeys.map((edgeKey) => ({ edgeKey })),
  };
}

function buildSingleSkillTemplate(
  entry: FridayCrossBorderWorkflowCatalogEntry,
  outputKey: string,
): FridayWorkflowTemplateEntity {
  const stepId = entry.workflowId.replace(/-/g, "_");
  const workflowId = `template-${entry.workflowId}`;
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId,
    name: entry.templateName,
    description: entry.templateDescription,
    startStepId: stepId,
    trigger: { type: "manual" },
    inputs: [
      {
        key: entry.primaryInputKey,
        type: "string",
        required: true,
      },
    ],
    steps: [
      {
        id: stepId,
        type: "skill_call",
        ref: entry.primarySkillId,
        args: {
          [entry.primaryInputKey]: `$inputs.${entry.primaryInputKey}`,
        },
      },
    ],
    edges: [],
    outputs: [
      {
        key: outputKey,
        fromStep: stepId,
        path: outputKey,
      },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [
      {
        name: `${entry.workflowId} basic`,
        inputs: {
          [entry.primaryInputKey]: `${entry.templateName} source notes`,
        },
        mocks: {
          [stepId]: {
            output: {
              [outputKey]: "ok",
            },
          },
        },
        assertions: [
          {
            path: `steps.${stepId}.output.${outputKey}`,
            operator: "==",
            expected: "ok",
          },
        ],
      },
    ],
  };

  return {
    templateId: entry.templateId,
    kind: "builtin",
    scope: "global",
    name: entry.templateName,
    description: entry.templateDescription,
    tags: entry.tags,
    spec,
    visual: buildVisual(workflowId, [stepId], []),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function buildWeeklyHotProductReviewTemplate(
  entry: FridayCrossBorderWorkflowCatalogEntry,
): FridayWorkflowTemplateEntity {
  const workflowId = `template-${entry.workflowId}`;
  const detectStepId = "detect_spikes";
  const scoutStepId = "screen_followups";
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId,
    name: entry.templateName,
    description: entry.templateDescription,
    startStepId: detectStepId,
    trigger: { type: "manual" },
    inputs: [
      {
        key: entry.primaryInputKey,
        type: "string",
        required: true,
      },
    ],
    steps: [
      {
        id: detectStepId,
        type: "skill_call",
        ref: entry.primarySkillId,
        args: {
          [entry.primaryInputKey]: `$inputs.${entry.primaryInputKey}`,
        },
      },
      {
        id: scoutStepId,
        type: "skill_call",
        ref: entry.followupSkillId!,
        args: {
          [entry.followupInputKey!]: `$steps.${detectStepId}.output.spikeReview`,
        },
      },
    ],
    edges: [
      {
        from: detectStepId,
        to: scoutStepId,
        when: "success",
      },
    ],
    outputs: [
      {
        key: "spikeReview",
        fromStep: detectStepId,
        path: "spikeReview",
      },
      {
        key: "productScout",
        fromStep: scoutStepId,
        path: "productScout",
      },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [
      {
        name: `${entry.workflowId} chains spike detection into scouting`,
        inputs: {
          [entry.primaryInputKey]: "hot category notes",
        },
        mocks: {
          [detectStepId]: {
            output: {
              spikeReview: "spike review output",
            },
          },
          [scoutStepId]: {
            output: {
              productScout: "product scout output",
            },
          },
        },
        assertions: [
          {
            path: `steps.${detectStepId}.output.spikeReview`,
            operator: "==",
            expected: "spike review output",
          },
          {
            path: `steps.${scoutStepId}.output.productScout`,
            operator: "==",
            expected: "product scout output",
          },
        ],
      },
    ],
  };

  return {
    templateId: entry.templateId,
    kind: "builtin",
    scope: "global",
    name: entry.templateName,
    description: entry.templateDescription,
    tags: entry.tags,
    spec,
    visual: buildVisual(workflowId, [detectStepId, scoutStepId], [`${detectStepId}:${scoutStepId}:success`]),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function buildWeeklyOperatingProfileTuneTemplate(
  entry: FridayCrossBorderWorkflowCatalogEntry,
): FridayWorkflowTemplateEntity {
  const workflowId = `template-${entry.workflowId}`;
  const weeklyReviewStepId = "weekly_growth_review";
  const listingAuditStepId = "listing_followup";
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId,
    name: entry.templateName,
    description: entry.templateDescription,
    startStepId: weeklyReviewStepId,
    trigger: { type: "manual" },
    inputs: [
      {
        key: entry.primaryInputKey,
        type: "string",
        required: true,
      },
    ],
    steps: [
      {
        id: weeklyReviewStepId,
        type: "skill_call",
        ref: entry.primarySkillId,
        args: {
          [entry.primaryInputKey]: `$inputs.${entry.primaryInputKey}`,
        },
      },
      {
        id: listingAuditStepId,
        type: "skill_call",
        ref: entry.followupSkillId!,
        args: {
          [entry.followupInputKey!]: `$steps.${weeklyReviewStepId}.output.weeklyReview`,
        },
      },
    ],
    edges: [
      {
        from: weeklyReviewStepId,
        to: listingAuditStepId,
        when: "success",
      },
    ],
    outputs: [
      {
        key: "weeklyReview",
        fromStep: weeklyReviewStepId,
        path: "weeklyReview",
      },
      {
        key: "listingAudit",
        fromStep: listingAuditStepId,
        path: "listingAudit",
      },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [
      {
        name: `${entry.workflowId} chains weekly review into listing follow-up`,
        inputs: {
          [entry.primaryInputKey]: "weekly store signals",
        },
        mocks: {
          [weeklyReviewStepId]: {
            output: {
              weeklyReview: "weekly review output",
            },
          },
          [listingAuditStepId]: {
            output: {
              listingAudit: "listing audit output",
            },
          },
        },
        assertions: [
          {
            path: `steps.${weeklyReviewStepId}.output.weeklyReview`,
            operator: "==",
            expected: "weekly review output",
          },
          {
            path: `steps.${listingAuditStepId}.output.listingAudit`,
            operator: "==",
            expected: "listing audit output",
          },
        ],
      },
    ],
  };

  return {
    templateId: entry.templateId,
    kind: "builtin",
    scope: "global",
    name: entry.templateName,
    description: entry.templateDescription,
    tags: entry.tags,
    spec,
    visual: buildVisual(
      workflowId,
      [weeklyReviewStepId, listingAuditStepId],
      [`${weeklyReviewStepId}:${listingAuditStepId}:success`],
    ),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export function createFridayCrossBorderBuiltinWorkflowTemplates(): FridayWorkflowTemplateEntity[] {
  return listFridayCrossBorderWorkflowCatalog().map((entry) => {
    if (entry.workflowId === "weekly-hot-product-review") {
      return buildWeeklyHotProductReviewTemplate(entry);
    }
    if (entry.workflowId === "weekly-operating-profile-tune") {
      return buildWeeklyOperatingProfileTuneTemplate(entry);
    }

    const outputByWorkflowId: Record<string, string> = {
      "daily-store-health-check": "issueClusters",
      "daily-category-top10-watch": "watchBoard",
      "daily-price-gap-watch": "priceReview",
      "daily-customer-service-sweep": "serviceBrief",
    };

    return buildSingleSkillTemplate(entry, outputByWorkflowId[entry.workflowId]!);
  });
}
