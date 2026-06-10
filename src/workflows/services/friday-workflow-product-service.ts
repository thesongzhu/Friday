import type { Database } from "better-sqlite3";
import { FridayDomainError } from "#errors";
import type { FridaySelfHealingApiService } from "#learning";
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowDraftEntity,
  FridayWorkflowRuntime,
  FridayWorkflowSpecV1,
  FridayWorkflowVersionEntity,
  FridayWorkflowVisualGraphV1,
  UUID,
} from "#workflows";
import { parseGraphJson } from "#workflows";
import type {
  FridayAssistantWorkflowCard,
  FridayWorkflowDeployEvidenceSummary,
  FridayWorkflowDeployResult,
  FridayWorkflowOverview,
  FridayWorkflowVisualization,
} from "../../api/model/friday-api-workflow.types.js";
import type { FridayObservabilityApiService } from "../../observability/services/friday-observability-api-service.js";
import type { FridayWorkflowBuilderRuntime } from "../builder/runtime/friday-workflow-builder-runtime.js";
import { createFridayWorkflowBuilderSpecVersionRepository } from "../builder/persistence/friday-workflow-builder-spec-version-repository.js";
import type { FridayWorkflowGeneratorService } from "../generator/services/friday-workflow-generator-service.types.js";
import {
  FRIDAY_WORKFLOW_GENERATION_APPROVAL_NAMESPACE,
  type FridayWorkflowGenerationApprovalRecord,
} from "../generator/persistence/friday-workflow-generation-approval-repository.js";
import { safeJsonParse } from "#utilities";

export interface FridayWorkflowProductService {
  deployDraft(input: {
    workflowId: UUID;
    draftId: UUID;
    actorUserId: string;
    runNow?: boolean;
    resyncTriggers?: boolean;
    includeExport?: boolean;
    changeNote?: string;
    lockToken?: string;
    ownerSessionId?: string;
    lockTtlSec?: number;
    externalReviewConfirmed?: boolean;
  }): Promise<FridayWorkflowDeployResult>;
  getOverview(input: {
    workflowId: UUID;
    recentRunLimit?: number;
  }): FridayWorkflowOverview;
  getVisualization(input: {
    workflowId: UUID;
    draftId?: UUID;
    versionId?: UUID;
    timelineLimit?: number;
  }): FridayWorkflowVisualization;
  materializeGeneratedSession(input: {
    sessionId: string;
    actorUserId: string;
  }): Promise<FridayAssistantWorkflowCard>;
}

export interface CreateFridayWorkflowProductServiceDeps {
  builderRuntime: FridayWorkflowBuilderRuntime;
  workflowRuntime: FridayWorkflowRuntime;
  workflowGenerator?: FridayWorkflowGeneratorService;
  observability?: FridayObservabilityApiService;
  selfHealing?: FridaySelfHealingApiService;
  db: {
    withReadConnection<T>(fn: (db: Database) => T): T;
  };
  idGenerator: () => string;
  nowIso: () => string;
  /**
   * Test-oracle only: allows the legacy TypeScript workflow deploy mutations
   * (`deployDraft` and `materializeGeneratedSession`, which persists a workflow/
   * draft as the deploy-preparation step) in isolated test/validation harnesses.
   * Default/live runtime must leave this unset so the methods fail closed for
   * ALL callers — including the UIX deploy-workflow card, the UIX assistant
   * create/continue/generate-workflow flows, and the cross-border pack service,
   * which bypass the HTTP route guard.
   */
  allowTestOnlyWorkflowDeployExecution?: boolean;
}

function sortDraftsByUpdatedAtDescending(
  drafts: FridayWorkflowDraftEntity[],
): FridayWorkflowDraftEntity[] {
  return [...drafts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function toWorkflowSpecStepType(
  nodeType: string,
): FridayWorkflowSpecV1["steps"][number]["type"] {
  switch (nodeType) {
    case "condition":
      return "condition";
    case "approval":
      return "human_approval";
    case "data":
      return "transform";
    case "trigger":
    case "action":
    case "ai":
    default:
      return "tool_call";
  }
}

function synthesizeSpecFromCompiledGraph(input: {
  workflowId: string;
  workflowName: string;
  workflowDescription?: string;
  compiled: FridayCompiledWorkflowGraphV2;
}): FridayWorkflowSpecV1 {
  const nonTriggerNodes = input.compiled.graph.nodes.filter((node) => node.type !== "trigger");
  const startNode = nonTriggerNodes[0] ?? input.compiled.graph.nodes[0];

  return {
    schemaVersion: "1.0",
    workflowId: input.workflowId,
    name: input.workflowName,
    description: input.workflowDescription ?? "",
    startStepId: startNode?.id ?? "start",
    trigger: { type: "manual" },
    inputs: [],
    steps: nonTriggerNodes.map((node) => ({
      id: node.id,
      type: toWorkflowSpecStepType(node.type),
      ref: typeof node.config.skillId === "string"
        ? node.config.skillId
        : typeof node.config.tool === "string"
          ? node.config.tool
          : undefined,
      args:
        node.config && typeof node.config === "object" && !Array.isArray(node.config)
          ? (node.config as Record<string, unknown>)
          : undefined,
      condition: typeof node.config.condition === "string" ? node.config.condition : undefined,
      timeoutSec: typeof node.timeoutMs === "number" ? Math.round(node.timeoutMs / 1000) : undefined,
      retry: node.retryPolicy
        ? {
            maxAttempts: node.retryPolicy.maxAttempts,
            backoffMs: node.retryPolicy.baseDelayMs,
          }
        : undefined,
    })),
    edges: input.compiled.graph.edges
      .filter((edge) => edge.sourceNodeId !== "trigger")
      .map((edge) => ({
        from: edge.sourceNodeId,
        to: edge.targetNodeId,
        when: edge.condition === "failure"
          ? "failure"
          : edge.condition === "true"
            ? "true"
            : edge.condition === "false"
              ? "false"
              : "success",
      })),
    outputs: startNode
      ? [
          {
            key: "result",
            fromStep: startNode.id,
            path: "output",
          },
        ]
      : [],
    errorPolicy: input.compiled.failurePolicy,
    tests: input.compiled.tests,
  };
}

function synthesizeVisualFromSpec(spec: FridayWorkflowSpecV1): FridayWorkflowVisualGraphV1 {
  const nodes: FridayWorkflowVisualGraphV1["nodes"] = [
    { nodeId: "__trigger__", x: 56, y: 72 },
    ...spec.steps.map((step, index) => ({
      nodeId: step.id,
      x: 320 * (index + 1),
      y: index % 2 === 0 ? 72 : 248,
    })),
  ];

  const edges: FridayWorkflowVisualGraphV1["edges"] = [];
  if (spec.startStepId) {
    edges.push({ edgeKey: `__trigger__:${spec.startStepId}:any` });
  }
  for (const edge of spec.edges) {
    edges.push({
      edgeKey: `${edge.from}:${edge.to}:${edge.when ?? "success"}`,
    });
  }

  return {
    schemaVersion: "1.0",
    workflowId: spec.workflowId,
    viewport: { x: 0, y: 0, zoom: 0.85 },
    panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
    nodes,
    edges,
  };
}

function extractRunFailurePath(input: {
  nodes: ReturnType<FridayWorkflowRuntime["execution"]["getRunNodes"]>;
  limit: number;
}): Array<{
  nodeId: string;
  attempt: number;
  status: string;
  message?: string;
  finishedAt?: string;
}> {
  return [...input.nodes]
    .sort((left, right) => {
      const leftTs = left.finishedAt ?? left.updatedAt;
      const rightTs = right.finishedAt ?? right.updatedAt;
      return rightTs.localeCompare(leftTs);
    })
    .slice(0, input.limit)
    .map((node) => ({
      nodeId: node.nodeId,
      attempt: node.attempt,
      status: node.status,
      message: node.error?.message,
      finishedAt: node.finishedAt,
    }));
}

function buildDeployEvidenceSummary(input: {
  incidentId?: string;
  runId?: string;
  exportedBundleChecksum?: string;
  exportedAt?: string;
  traceSummary: string;
}): FridayWorkflowDeployEvidenceSummary {
  return {
    incidentId: input.incidentId,
    runId: input.runId,
    exportedBundleChecksum: input.exportedBundleChecksum,
    exportedAt: input.exportedAt,
    traceSummary: input.traceSummary,
  };
}

export function createFridayWorkflowProductService(
  deps: CreateFridayWorkflowProductServiceDeps,
): FridayWorkflowProductService {
  const specVersionRepo = createFridayWorkflowBuilderSpecVersionRepository();
  function getSavedApproval(sessionId: string): FridayWorkflowGenerationApprovalRecord | null {
    return deps.db.withReadConnection((db) => {
      const row = db
        .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
        .get(
          FRIDAY_WORKFLOW_GENERATION_APPROVAL_NAMESPACE,
          sessionId,
        ) as { value_json: string } | undefined;
      if (!row) {
        return null;
      }
      return safeJsonParse<FridayWorkflowGenerationApprovalRecord>(row.value_json) ?? null;
    });
  }

  function makeUniqueSlug(base: string): string {
    const normalized = base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const seed = normalized.length > 0 ? normalized : "generated-workflow";

    let candidate = seed;
    let suffix = 2;
    while (deps.workflowRuntime.crud.getWorkflowBySlug(candidate)) {
      candidate = `${seed}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  function getWorkflowOrThrow(workflowId: UUID) {
    const workflow = deps.workflowRuntime.crud.getWorkflow(workflowId);
    if (!workflow) {
      throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
    }
    return workflow;
  }

  function getDraftOrThrow(workflowId: UUID, draftId: UUID) {
    const draft = deps.builderRuntime.drafts.getDraft(draftId);
    if (!draft || draft.workflowId !== workflowId) {
      throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
    }
    return draft;
  }

  function buildOverview(workflowId: UUID, recentRunLimit = 8): FridayWorkflowOverview {
    const workflow = getWorkflowOrThrow(workflowId);
    const latestVersion = deps.workflowRuntime.crud.listVersions(workflowId, 1)[0] ?? null;
    const publishedVersion = deps.workflowRuntime.crud.getPublishedVersion(workflowId);
    const drafts = sortDraftsByUpdatedAtDescending(
      deps.builderRuntime.drafts.listDrafts(workflowId),
    );
    const recentRuns = deps.workflowRuntime.execution.listRuns(workflowId, undefined, recentRunLimit);
    const latestRun = recentRuns[0] ?? null;
    const latestRunNodes = latestRun
      ? deps.workflowRuntime.execution.getRunNodes(latestRun.id)
      : [];
    const latestExports = latestRun
      ? deps.workflowRuntime.evidence.listRunEvidenceExports(latestRun.id, 5)
      : [];
    const versions = deps.workflowRuntime.crud.listVersions(workflowId, 8);

    return {
      workflow,
      latestVersion: latestVersion ?? undefined,
      publishedVersion: publishedVersion ?? undefined,
      drafts,
      latestDraft: drafts[0],
      recentRuns,
      latestRun: latestRun ?? undefined,
      latestRunNodeTimeline: extractRunFailurePath({ nodes: latestRunNodes, limit: 12 }),
      latestEvidenceExports: latestExports,
      versionHistory: versions,
    };
  }

  function buildVisualizationTarget(input: {
    workflowId: UUID;
    draftId?: UUID;
    versionId?: UUID;
  }): {
    targetKind: "draft" | "published_version" | "version";
    draft?: FridayWorkflowDraftEntity;
    version?: FridayWorkflowVersionEntity;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
  } {
    const workflow = getWorkflowOrThrow(input.workflowId);
    if (input.draftId) {
      const draft = getDraftOrThrow(input.workflowId, input.draftId);
      return {
        targetKind: "draft",
        draft,
        spec: draft.spec,
        visual: draft.visual,
      };
    }

    const version = input.versionId
      ? deps.workflowRuntime.crud.getVersion(input.versionId)
      : deps.workflowRuntime.crud.getPublishedVersion(input.workflowId)
        ?? deps.workflowRuntime.crud.listVersions(input.workflowId, 1)[0]
        ?? null;

    if (!version || version.workflowId !== input.workflowId) {
      throw new FridayDomainError(
        "WORKFLOW_VERSION_NOT_FOUND",
        "Workflow version not found for visualization",
        { httpStatus: 404 },
      );
    }

    const specSnapshot = deps.db.withReadConnection((db) =>
      specVersionRepo.getByVersionId(db, version.id),
    );
    const spec = specSnapshot?.spec
      ?? synthesizeSpecFromCompiledGraph({
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowDescription: workflow.description,
        compiled: parseGraphJson(version.graphJson),
      });
    return {
      targetKind: input.versionId ? "version" : "published_version",
      version,
      spec,
      visual: synthesizeVisualFromSpec(spec),
    };
  }

  function createDraftFromVisualization(input: {
    workflowId: UUID;
    actorUserId: string;
    title: string;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
  }) {
    return deps.builderRuntime.drafts.createDraft({
      workflowId: input.workflowId,
      title: input.title,
      spec: {
        ...input.spec,
        workflowId: input.workflowId,
      },
      visual: {
        ...input.visual,
        workflowId: input.workflowId,
      },
      ownerUserId: input.actorUserId,
    });
  }

  return {
    async materializeGeneratedSession(input) {
      // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
      // materializeGeneratedSession is NOT a read: in the draft-present branch
      // it persists a NEW workflow row (deps.workflowRuntime.crud.createWorkflow)
      // and a draft (createDraftFromVisualization), and in the restore branch it
      // persists a draft from a saved-approval/session record — both DB writes.
      // It has no HTTP route; its only callers are the UIX assistant
      // create/continue/generate-workflow flows (startWorkflowSession /
      // continueWorkflowSession / the `generate-workflow` action), which are part
      // of the retired generation+deploy lifecycle and bypass the HTTP route
      // guard. Guarding here with the SAME deploy test-oracle flag fails ALL
      // these non-route callers closed BEFORE any workflow/draft persist unless
      // the flag is explicitly set. Never default this flag on in production.
      if (deps.allowTestOnlyWorkflowDeployExecution !== true) {
        void input;
        throw new FridayDomainError(
          "TS_RUNTIME_WORKFLOW_DEPLOY_RETIRED",
          "TypeScript workflow deploy execution is retired in default/live runtime; use the Rust-owned workflow deployment entrypoint.",
          {
            httpStatus: 503,
            details: {
              classification: "fail_closed",
              replacement: "rust_owned_workflow_deployment_entrypoint_required",
            },
          },
        );
      }
      if (!deps.workflowGenerator) {
        throw new FridayDomainError(
          "WORKFLOW_GENERATOR_UNAVAILABLE",
          "Workflow generation is not available in this runtime",
          { httpStatus: 503 },
        );
      }
      const sessionState = await deps.workflowGenerator.getSession(input.sessionId);
      const approvalRecord = getSavedApproval(input.sessionId);
      if (!sessionState && !approvalRecord) {
        throw new FridayDomainError(
          "WORKFLOW_GENERATOR_DRAFT_NOT_FOUND",
          "Generate a workflow draft before preparing deploy actions",
          { httpStatus: 404 },
        );
      }

      if (!sessionState?.draft) {
        const workflowId = (
          sessionState?.session.workflowId
          ?? approvalRecord?.workflowId
        ) as UUID | undefined;
        const workflowVersionId = (
          sessionState?.session.workflowVersionId
          ?? approvalRecord?.workflowVersionId
        ) as UUID | undefined;
        if (!workflowId || !workflowVersionId) {
          throw new FridayDomainError(
            "WORKFLOW_GENERATOR_DRAFT_NOT_FOUND",
            "Generate a workflow draft before preparing deploy actions",
            { httpStatus: 404 },
          );
        }

        const workflow = getWorkflowOrThrow(workflowId);
        const versionTarget = buildVisualizationTarget({
          workflowId,
          versionId: workflowVersionId,
        });
        const restoredDraft = createDraftFromVisualization({
          workflowId,
          actorUserId: input.actorUserId,
          title: `${workflow.name} Draft`,
          spec: versionTarget.spec,
          visual: versionTarget.visual,
        });

        return {
          kind: "draft_ready",
          workflowId,
          workflowName: workflow.name,
          draftId: restoredDraft.draftId,
          sessionId: input.sessionId,
          summary: sessionState
            ? "Friday restored the saved workflow session into a deployable draft."
            : "Friday restored the saved workflow approval into a deployable draft.",
          routeTarget: "/workflows",
          deployReady: true,
          questions: sessionState?.session.openQuestions ?? [],
        };
      }

      const generated = sessionState.draft;
      const workflow = deps.workflowRuntime.crud.createWorkflow({
        slug: makeUniqueSlug(generated.spec.name || sessionState.session.goal),
        name: generated.spec.name,
        description: generated.spec.description,
      });
      const draft = createDraftFromVisualization({
        workflowId: workflow.id,
        actorUserId: input.actorUserId,
        title: `${generated.spec.name} Draft`,
        spec: generated.spec,
        visual: generated.visual,
      });

      return {
        kind: "draft_ready",
        workflowId: workflow.id,
        workflowName: workflow.name,
        draftId: draft.draftId,
        sessionId: input.sessionId,
        summary: generated.validation.ok
          ? "Friday prepared a workflow draft that is ready for one-click deploy."
          : "Friday created the workflow draft, but it still needs fixes before deploy.",
        routeTarget: "/workflows",
        deployReady: generated.validation.ok,
        questions: sessionState.session.openQuestions,
      };
    },

    async deployDraft(input) {
      // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
      // Phase 3 (route-only-guard defect): the workflow-deploy retirement was
      // ROUTE-only (friday-workflow-product-routes asserts the test-oracle
      // flag before POST .../deploy). The UIX deploy-workflow card
      // (`deployWorkflowCard`) and the cross-border pack service
      // (`enableWorkflow` preset deployment) reach this method directly,
      // bypassing the HTTP route guard. Guarding here fails ALL non-route
      // callers closed BEFORE any lock acquisition, draft compile, publish,
      // trigger resync, or run start — unless the explicit test-oracle flag is
      // set. Never default this flag on in production. Reads
      // (getOverview/getVisualization) stay live. NOTE:
      // materializeGeneratedSession is NOT a read — it persists a workflow/draft
      // and is guarded with this SAME deploy flag at its own method head.
      if (deps.allowTestOnlyWorkflowDeployExecution !== true) {
        void input;
        throw new FridayDomainError(
          "TS_RUNTIME_WORKFLOW_DEPLOY_RETIRED",
          "TypeScript workflow deploy execution is retired in default/live runtime; use the Rust-owned workflow deployment entrypoint.",
          {
            httpStatus: 503,
            details: {
              classification: "fail_closed",
              replacement: "rust_owned_workflow_deployment_entrypoint_required",
            },
          },
        );
      }
      const workflow = getWorkflowOrThrow(input.workflowId);
      const draft = getDraftOrThrow(input.workflowId, input.draftId);
      let acquiredLockToken: string | undefined;
      let incidentId: string | undefined;
      let exportedBundleChecksum: string | undefined;
      let exportedAt: string | undefined;

      const lockToken = input.lockToken
        ?? (() => {
          const result = deps.builderRuntime.collaboration.acquireLock({
            workflowId: input.workflowId,
            ownerUserId: input.actorUserId,
            ownerSessionId: input.ownerSessionId,
            ttlSec: input.lockTtlSec ?? 120,
          });
          if (!result.acquired || !result.lock) {
            throw new FridayDomainError(
              "WORKFLOW_EDIT_LOCK_REQUIRED",
              "Workflow is currently locked by another operator",
              { httpStatus: 409 },
            );
          }
          acquiredLockToken = result.lock.lockToken;
          return result.lock.lockToken;
        })();

      const runDeploy = async (): Promise<FridayWorkflowDeployResult> => {
        const compiled = deps.builderRuntime.compositor.compileDraft(input.draftId);
        if (!compiled.validation.valid) {
          throw new FridayDomainError(
            "WORKFLOW_DEPLOY_COMPILE_FAILED",
            "Workflow draft must compile successfully before deployment",
            { httpStatus: 422, details: { validation: compiled.validation } },
          );
        }

        const published = deps.builderRuntime.compositor.publishDraft({
          draftId: input.draftId,
          workflowId: input.workflowId,
          lockToken,
          createdByUserId: input.actorUserId,
          changeNote: input.changeNote,
          publishNow: true,
          externalReviewConfirmed: input.externalReviewConfirmed,
        });

        if (!published.validation.valid || !published.workflowVersionId) {
          throw new FridayDomainError(
            "WORKFLOW_DEPLOY_BLOCKED",
            "Workflow draft failed publish validation",
            { httpStatus: 422, details: { validation: published.validation } },
          );
        }

        if (input.resyncTriggers) {
          await deps.workflowRuntime.triggers.syncPublishedVersionTriggers(input.workflowId);
        }

        let run: FridayWorkflowDeployResult["run"] | undefined;
        if (input.runNow) {
          run = await deps.workflowRuntime.execution.startRun({
            workflowId: input.workflowId,
            workflowVersionId: published.workflowVersionId,
            triggerType: "manual",
            startedByUserId: input.actorUserId,
            triggerPayload: {
              source: "workflow-deploy",
              draftId: input.draftId,
            },
          });
        }

        let exportBundle: FridayWorkflowDeployResult["exportBundle"] | undefined;
        if (input.includeExport) {
          const bundle = deps.builderRuntime.importExport.exportDraft(input.draftId);
          exportedBundleChecksum = bundle.checksum;
          exportedAt = bundle.exportedAt;
          exportBundle = {
            bundleSchemaVersion: bundle.bundleSchemaVersion,
            exportedAt: bundle.exportedAt,
            checksum: bundle.checksum,
            sourceType: bundle.source.type,
            sourceId: bundle.source.id,
            workflowId: bundle.source.workflowId,
          };
        }

        return {
          workflowId: input.workflowId,
          draftId: input.draftId,
          workflowVersionId: published.workflowVersionId,
          versionNumber: published.versionNumber,
          published: true,
          triggerSync: {
            requested: input.resyncTriggers === true,
            synced: input.resyncTriggers === true,
          },
          run,
          exportBundle,
          validation: compiled.validation,
          evidence: buildDeployEvidenceSummary({
            incidentId,
            runId: run?.id,
            exportedBundleChecksum,
            exportedAt,
            traceSummary: `Workflow deploy observed for ${workflow.slug}`,
          }),
        };
      };

      try {
        const deployResult = deps.observability
          ? await deps.observability.observeAsync({
            module: "workflows",
            operationName: "workflows.deploy",
            actionCategory: "execute",
            action: "workflows.deploy",
            resourceType: "workflow",
            resourceId: workflow.id,
            resourceDisplayName: workflow.name,
            actor: { type: "user", id: input.actorUserId, displayName: input.actorUserId },
            description: `Deploy workflow draft ${draft.title}`,
            successMetric: "friday.workflows.deployments.total",
            failureMetric: "friday.workflows.deploy_failures.total",
            durationMetric: "friday.workflows.deploy.duration_ms",
            metadata: {
              workflowId: workflow.id,
              draftId: draft.draftId,
              runNow: input.runNow === true,
              includeExport: input.includeExport === true,
            },
          }, runDeploy)
          : await runDeploy();

        return deployResult;
      } catch (error) {
        if (deps.selfHealing) {
          const failure = deps.selfHealing.reportStructuredFailure({
            userId: input.actorUserId,
            category: "workflow",
            severity: "high",
            message: error instanceof Error ? error.message : "Workflow deploy failed",
            context: {
              workflowId: input.workflowId,
              workflowName: workflow.name,
              draftId: input.draftId,
              changeNote: input.changeNote,
              runNow: input.runNow === true,
              includeExport: input.includeExport === true,
            },
          });
          incidentId = failure.incidentsCreated[0]?.incidentId;
        }
        throw error;
      } finally {
        if (acquiredLockToken) {
          try {
            deps.builderRuntime.collaboration.releaseLock(input.workflowId, acquiredLockToken);
          } catch (err) {
            // Best-effort release for one-click deploy helper locks.
            console.warn("[friday][workflow-product-service] lock release failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }
    },

    getOverview(input) {
      return buildOverview(input.workflowId, input.recentRunLimit);
    },

    getVisualization(input) {
      const workflow = getWorkflowOrThrow(input.workflowId);
      const overview = buildOverview(input.workflowId);
      const target = buildVisualizationTarget(input);
      const latestRun = overview.latestRun ?? null;
      const runNodes = latestRun
        ? deps.workflowRuntime.execution.getRunNodes(latestRun.id)
        : [];

      return {
        workflow,
        targetKind: target.targetKind,
        draft: target.draft,
        version: target.version,
        spec: target.spec,
        visual: target.visual,
        latestRun: latestRun ?? undefined,
        recentRuns: overview.recentRuns,
        nodeTimeline: extractRunFailurePath({
          nodes: runNodes,
          limit: input.timelineLimit ?? 16,
        }),
        latestEvidenceExports: overview.latestEvidenceExports,
      };
    },
  };
}
