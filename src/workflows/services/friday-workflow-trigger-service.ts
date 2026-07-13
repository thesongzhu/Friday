import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import type { JsonObject, UUID } from "../model/friday-workflow.types.js";
import type {
  FridayEventMatchContext,
  FridayTriggerFireInput,
  FridayTriggerRegistration,
  FridayWorkflowTriggerDef,
} from "../model/friday-workflow-trigger.types.js";
import type {
  FridayWorkflowEngineTriggerType,
  FridayWorkflowTriggerRegistrationEntity,
} from "../model/friday-workflow-engine.types.js";
import type { FridayWorkflowExecutionService } from "./friday-workflow-execution-service.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type { FridayWorkflowTriggerRepository } from "../persistence/friday-workflow-trigger-repository.js";
import { type FridayCompiledWorkflowGraphV2, parseGraphJson } from "../model/friday-workflow-graph.types.js";
import { parseFridaySecretInput, resolveFridaySecretInput } from "../../security/friday-secret-ref.js";
import {
  evaluateWorkflowWebhookGate,
  readWorkflowWebhookBearerOnlyAllowlistFromEnv,
  redactSensitiveWebhookHeaders,
} from "../../security/friday-owner-session-channel-capability.js";
// F12: Use shared cron utils — no local matcher
import { computeNextCronFire, matchesCron } from "./friday-workflow-cron-utils.js";

// ─── Webhook invoke types ───

export interface FridayWorkflowWebhookInvokeInput {
  pathToken: string;
  body: JsonObject;
  headers?: Record<string, string>;
  /** Raw request body bytes for HMAC signature verification. */
  rawBody?: string;
}

export interface FridayWorkflowWebhookInvokeResult {
  accepted: boolean;
  runId?: string;
  /** HTTP status code to use for rejections (401/403/404). */
  statusCode?: number;
  /** Error code for rejected webhooks. */
  errorCode?: string;
}

// ─── Event trigger input ───

export interface FridayWorkflowTriggerEventInput {
  source: string;
  event: string;
  payload: JsonObject;
}

// ─── Interface ───

export interface FridayWorkflowTriggerService {
  // ─── Design Section 4 methods ───

  syncPublishedVersionTriggers(workflowId: string): Promise<void>;

  syncAllPublishedWorkflowTriggers(): Promise<void>;

  /** Design Section 4: tick cron triggers, returns count of runs started. */
  tickCron(nowIso: string, limit?: number): Promise<number>;

  handleWebhook(input: FridayWorkflowWebhookInvokeInput): Promise<FridayWorkflowWebhookInvokeResult>;

  handleEvent(input: FridayWorkflowTriggerEventInput): Promise<number>;

  /** Design Section 4: list trigger registrations for a workflow. */
  listRegistrations(workflowId: string): FridayWorkflowTriggerRegistrationEntity[];

  setRegistrationEnabled(registrationId: string, enabled: boolean): Promise<void>;

  // ─── Backward-compatible methods ───

  register(
    workflowId: UUID,
    workflowVersionId: UUID,
    trigger: FridayWorkflowTriggerDef,
  ): FridayTriggerRegistration;

  unregister(workflowId: UUID): void;

  fireManual(input: FridayTriggerFireInput): Promise<UUID>;

  matchEvent(ctx: FridayEventMatchContext): Promise<UUID[]>;

  /** Internal: list all in-memory registrations (no filter). */
  listAllRegistrations(): FridayTriggerRegistration[];

  reloadFromPublishedVersions(): Promise<void>;
}

// ─── Dependencies ───

export interface CreateWorkflowTriggerServiceDeps {
  db: FridaySqliteLayer;
  executionService: FridayWorkflowExecutionService;
  workflowRepo: FridayWorkflowRepository;
  triggerRepo?: FridayWorkflowTriggerRepository;
  resolveWebhookSecretRef?: (refKey: string) => string | null | Promise<string | null>;
  idGenerator: () => string;
  nowIso: () => string;
  /**
   * Phase 14.5A owner/session/channel capability gate (module_28a).
   * When omitted, the allowlist defaults to FRIDAY_WORKFLOW_WEBHOOK_BEARER_ONLY_PATH_TOKENS.
   * The gate cannot be disabled; only specific tokens can be explicitly opted in.
   */
  readWebhookBearerOnlyAllowlist?: () => ReadonlySet<string>;
}

async function resolveWebhookSigningSecret(
  secretRef: string,
  resolveSecretRef: CreateWorkflowTriggerServiceDeps["resolveWebhookSecretRef"],
): Promise<{ ok: true; value: string } | { ok: false; statusCode: number; errorCode: string }> {
  const parsed = parseFridaySecretInput(secretRef, {
    secretRefPrefixes: ["secret://workflow-webhook/", "secret://workflow/", "secret://"],
  });

  if (parsed.kind === "inline") {
    return {
      ok: false,
      statusCode: 500,
      errorCode: "WEBHOOK_SECRET_REF_INVALID",
    };
  }

  if (parsed.kind === "command-ref") {
    return {
      ok: false,
      statusCode: 500,
      errorCode: "WEBHOOK_SECRET_COMMAND_REF_DISABLED",
    };
  }

  const resolved = await resolveFridaySecretInput(parsed, {
    env: process.env,
    readSecretRef: async (refKey) => resolveSecretRef?.(refKey) ?? null,
    allowCommandRefs: false,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      statusCode: 500,
      errorCode: "WEBHOOK_SECRET_REF_UNRESOLVED",
    };
  }

  return { ok: true, value: resolved.value };
}

// ─── Shared fire helper (F7: avoids DB vs in-memory divergence) ───

async function fireCronRegistration(
  reg: { workflowId: string; workflowVersionId: string; cronExpression?: string; cronTimezone?: string },
  nowIso: string,
  executionService: FridayWorkflowExecutionService,
  triggerRepo: FridayWorkflowTriggerRepository | undefined,
  regId: string | undefined,
  recentCorrelationIds: Set<string>,
): Promise<boolean> {
  const minuteIso = nowIso.slice(0, 16);
  const fingerprint = createHash("sha256")
    .update(`${reg.workflowId}:${reg.workflowVersionId}:schedule:${minuteIso}`)
    .digest("hex");

  if (recentCorrelationIds.has(fingerprint)) return false;
  recentCorrelationIds.add(fingerprint);

  // Clean up old entries (keep last 1000)
  if (recentCorrelationIds.size > 1000) {
    const entries = [...recentCorrelationIds];
    for (let i = 0; i < entries.length - 500; i++) {
      recentCorrelationIds.delete(entries[i]!);
    }
  }

  try {
    await executionService.startRun({
      workflowId: reg.workflowId,
      workflowVersionId: reg.workflowVersionId,
      triggerType: "schedule",
      correlationId: fingerprint,
    });

    // Update DB trigger state if available
    if (triggerRepo && regId && reg.cronExpression) {
      const nextFire = computeNextCronFire(reg.cronExpression, new Date(nowIso), 525_600, reg.cronTimezone);
      triggerRepo.markFired(regId, nowIso, nextFire?.toISOString());
    }

    return true;
  } catch (err) {
    // P2-WF-004: Log trigger fire failures instead of silent swallow
    console.warn("[friday] Cron trigger fire failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ─── Factory ───

export function createFridayWorkflowTriggerService(
  deps: CreateWorkflowTriggerServiceDeps,
): FridayWorkflowTriggerService {
  // In-memory trigger registrations: workflowId → registrations
  const registrations = new Map<UUID, FridayTriggerRegistration[]>();

  // Dedup set: correlation IDs for recent fires (to prevent duplicate cron fires)
  const recentCorrelationIds = new Set<string>();

  return {
    register(workflowId, workflowVersionId, trigger) {
      const reg: FridayTriggerRegistration = {
        id: deps.idGenerator(),
        workflowId,
        workflowVersionId,
        trigger,
        enabled: true,
        createdAt: deps.nowIso(),
      };

      const existing = registrations.get(workflowId) ?? [];
      existing.push(reg);
      registrations.set(workflowId, existing);

      return reg;
    },

    unregister(workflowId) {
      registrations.delete(workflowId);
    },

    async fireManual(input) {
      const run = await deps.executionService.startRun({
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        triggerType: input.triggerType,
        triggerPayload: input.triggerPayload,
        startedByUserId: input.startedByUserId,
        correlationId: input.correlationId,
      });
      return run.id;
    },

    // F7: Use DB listDueCron when triggerRepo available, else in-memory fallback
    async tickCron(nowIso: string, limit?: number) {
      if (deps.triggerRepo) {
        // ─── DB-first path ───
        const dueLimit = limit ?? 100;
        const dueRegs = deps.triggerRepo.listDueCron(nowIso, dueLimit);
        let started = 0;

        for (const reg of dueRegs) {
          if (limit != null && started >= limit) break;

          const fired = await fireCronRegistration(
            { workflowId: reg.workflowId, workflowVersionId: reg.workflowVersionId, cronExpression: reg.cronExpression, cronTimezone: reg.cronTimezone },
            nowIso,
            deps.executionService,
            deps.triggerRepo,
            reg.id,
            recentCorrelationIds,
          );
          if (fired) started++;
        }

        return started;
      }

      // ─── In-memory fallback (no triggerRepo) ───
      const allRegs: FridayTriggerRegistration[] = [];
      for (const regs of registrations.values()) {
        allRegs.push(...regs);
      }

      const tickDate = new Date(nowIso);
      let started = 0;

      for (const reg of allRegs) {
        if (limit != null && started >= limit) break;
        if (!reg.enabled || reg.trigger.type !== "schedule") continue;

        const schedule = reg.trigger;
        if (!matchesCron(schedule.cron, tickDate, schedule.timezone)) continue;

        const fired = await fireCronRegistration(
          { workflowId: reg.workflowId, workflowVersionId: reg.workflowVersionId, cronExpression: schedule.cron, cronTimezone: schedule.timezone },
          nowIso,
          deps.executionService,
          undefined,
          undefined,
          recentCorrelationIds,
        );
        if (fired) started++;
      }

      return started;
    },

    async matchEvent(ctx) {
      const runIds: UUID[] = [];

      for (const [, regs] of registrations) {
        for (const reg of regs) {
          if (!reg.enabled || reg.trigger.type !== "event") continue;

          const eventTrigger = reg.trigger;
          if (
            eventTrigger.source === ctx.source &&
            eventTrigger.event === ctx.event
          ) {
            try {
              const run = await deps.executionService.startRun({
                workflowId: reg.workflowId,
                workflowVersionId: reg.workflowVersionId,
                triggerType: "event",
                triggerPayload: ctx.payload,
              });
              runIds.push(run.id);
            } catch (err) {
              // P2-WF-004: Log event trigger failures
              console.warn("[friday] Event trigger startRun failed:", err instanceof Error ? err.message : String(err));
            }
          }
        }
      }

      return runIds;
    },

    listRegistrations(workflowId: string) {
      if (deps.triggerRepo) {
        return deps.triggerRepo.listByWorkflow(workflowId);
      }
      return [];
    },

    listAllRegistrations() {
      const all: FridayTriggerRegistration[] = [];
      for (const regs of registrations.values()) {
        all.push(...regs);
      }
      return all;
    },

    // ─── Design Section 4: syncPublishedVersionTriggers ───

    async syncPublishedVersionTriggers(workflowId: string) {
      // Clear in-memory registrations for this workflow
      registrations.delete(workflowId);

      const version = deps.db.withReadConnection((db) =>
        deps.workflowRepo.getPublishedVersion(db, workflowId),
      );
      if (!version) return;

      const graph = parseGraphJson(version.graphJson);

      // Defensive guard: skip trigger sync if graph is malformed
      const nodes = graph.graph?.nodes;
      if (!Array.isArray(nodes)) return;

      // Collect DB entities for batch upsert
      const dbEntities: FridayWorkflowTriggerRegistrationEntity[] = [];

      for (const node of nodes) {
        if (node.type !== "trigger") continue;

        const config = (node.config ?? (node as { data?: unknown }).data ?? {}) as Record<string, unknown>;
        const triggerType = config.triggerType as string | undefined;
        if (!triggerType) continue;

        let triggerDef: FridayWorkflowTriggerDef;
        if (triggerType === "schedule") {
          triggerDef = {
            type: "schedule",
            cron: config.cron as string,
            timezone: config.timezone as string,
          };
        } else if (triggerType === "event") {
          triggerDef = {
            type: "event",
            source: config.source as string,
            event: config.event as string,
          };
        } else {
          triggerDef = { type: "manual" };
        }

        this.register(workflowId, version.id, triggerDef);

        // Build DB entity if triggerRepo is available (skip manual triggers — DB uses cron/webhook/event)
        if (deps.triggerRepo && triggerType !== "manual") {
          const engineTriggerType: FridayWorkflowEngineTriggerType =
            triggerType === "schedule" ? "cron" :
            triggerType === "webhook" ? "webhook" :
            "event";

          const nowIso = deps.nowIso();

          // F8: Compute nextFireAt for schedule triggers
          let nextFireAt: string | undefined;
          if (triggerType === "schedule") {
            const cronExpr = config.cron as string;
            try {
              const next = computeNextCronFire(cronExpr, new Date(nowIso), 525_600, config.timezone as string | undefined);
              if (next) {
                nextFireAt = next.toISOString();
              }
            } catch (err) {
              // P2-WF-004: Log invalid cron expression
              console.warn("[friday] Invalid cron expression during trigger sync:", err instanceof Error ? err.message : String(err));
            }
          }

          const entity: FridayWorkflowTriggerRegistrationEntity = {
            id: deps.idGenerator(),
            workflowId,
            workflowVersionId: version.id,
            triggerNodeId: node.id,
            triggerType: engineTriggerType,
            enabled: true,
            cronExpression: triggerType === "schedule" ? (config.cron as string) : undefined,
            cronTimezone: triggerType === "schedule" ? (config.timezone as string) : undefined,
            webhookPathToken: triggerType === "webhook" ? ((config.pathToken as string | undefined) ?? deps.idGenerator()) : undefined,
            webhookSecretRef: triggerType === "webhook" ? (config.secretRef as string | undefined) : undefined,
            webhookSignatureHeader: triggerType === "webhook" ? (config.signatureHeader as string | undefined) : undefined,
            eventSource: triggerType === "event" ? (config.source as string) : undefined,
            eventName: triggerType === "event" ? (config.event as string) : undefined,
            eventFilterExpr: triggerType === "event" ? (config.filterExpr as string | undefined) : undefined,
            dedupeWindowSec: 0,
            nextFireAt,
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          dbEntities.push(entity);
        }
      }

      // Persist to DB: clear ALL old registrations for this workflow, then upsert new ones
      if (deps.triggerRepo) {
        deps.triggerRepo.deleteByWorkflow(workflowId);
        if (dbEntities.length > 0) {
          deps.triggerRepo.upsertManyForVersion(dbEntities);
        }
      }
    },

    // ─── Design Section 4: syncAllPublishedWorkflowTriggers ───

    async syncAllPublishedWorkflowTriggers() {
      await this.reloadFromPublishedVersions();
    },

    // ─── Design Section 4: handleWebhook ───

    async handleWebhook(input) {
      if (!deps.triggerRepo) {
        return { accepted: false };
      }

      const reg = deps.triggerRepo.getByWebhookToken(input.pathToken);
      if (!reg || !reg.enabled) {
        return { accepted: false };
      }

      // ─── Phase 14.5A owner/session/channel capability gate (module_28a) ───
      // Require HMAC (webhookSecretRef) by default. Bearer path-token-only mode
      // is opt-in per token via FRIDAY_WORKFLOW_WEBHOOK_BEARER_ONLY_PATH_TOKENS;
      // even then, the token must meet the minimum-entropy length. The gate is
      // non-disableable and not affected by Light/Standard/Strict profiles.
      const bearerAllowlist = deps.readWebhookBearerOnlyAllowlist
        ? deps.readWebhookBearerOnlyAllowlist()
        : readWorkflowWebhookBearerOnlyAllowlistFromEnv();
      const gateRejection = evaluateWorkflowWebhookGate({
        pathToken: input.pathToken,
        hasSecretRef: Boolean(reg.webhookSecretRef),
        explicitBearerOnlyAllowlist: bearerAllowlist,
      });
      if (gateRejection) {
        return {
          accepted: false,
          statusCode: gateRejection.statusCode,
          errorCode: gateRejection.errorCode,
        };
      }

      // ─── HMAC signature verification (M4) ───
      if (reg.webhookSecretRef) {
        const secret = await resolveWebhookSigningSecret(reg.webhookSecretRef, deps.resolveWebhookSecretRef);
        if (!secret.ok) {
          return {
            accepted: false,
            statusCode: secret.statusCode,
            errorCode: secret.errorCode,
          };
        }

        const sigHeader = reg.webhookSignatureHeader ?? "x-hub-signature-256";
        const receivedSig = input.headers?.[sigHeader] ?? input.headers?.[sigHeader.toLowerCase()];

        if (!receivedSig) {
          return {
            accepted: false,
            statusCode: 401,
            errorCode: "WEBHOOK_SIGNATURE_MISSING",
          };
        }

        const rawBody = input.rawBody ?? JSON.stringify(input.body);
        const expectedSig = "sha256=" + createHmac("sha256", secret.value)
          .update(rawBody)
          .digest("hex");

        const sigBuffer = Buffer.from(receivedSig);
        const expectedBuffer = Buffer.from(expectedSig);

        if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
          return {
            accepted: false,
            statusCode: 403,
            errorCode: "WEBHOOK_SIGNATURE_INVALID",
          };
        }
      }

      try {
        const redactedHeaders = redactSensitiveWebhookHeaders(input.headers) as JsonObject;
        const run = await deps.executionService.startRun({
          workflowId: reg.workflowId,
          workflowVersionId: reg.workflowVersionId,
          triggerType: "webhook",
          triggerPayload: {
            ...input.body,
            _webhookHeaders: redactedHeaders,
          },
        });

        deps.triggerRepo.markFired(reg.id, deps.nowIso());

        return { accepted: true, runId: run.id };
      } catch (err) {
        // P2-WF-004: Log webhook trigger failures
        console.warn("[friday] Webhook trigger handling failed:", err instanceof Error ? err.message : String(err));
        return { accepted: false };
      }
    },

    // ─── Design Section 4: handleEvent ───

    async handleEvent(input) {
      if (!deps.triggerRepo) {
        // Fall back to legacy in-memory matchEvent
        const runIds = await this.matchEvent(input);
        return runIds.length;
      }

      const regs = deps.triggerRepo.listByEvent(input.source, input.event);
      let started = 0;

      for (const reg of regs) {
        if (!reg.enabled) continue;

        try {
          await deps.executionService.startRun({
            workflowId: reg.workflowId,
            workflowVersionId: reg.workflowVersionId,
            triggerType: "event",
            triggerPayload: input.payload,
          });

          deps.triggerRepo.markFired(reg.id, deps.nowIso());
          started++;
        } catch (err) {
          // P2-WF-004: Log event handler failures
          console.warn("[friday] Event handler startRun failed:", err instanceof Error ? err.message : String(err));
        }
      }

      return started;
    },

    // ─── Design Section 4: setRegistrationEnabled ───

    async setRegistrationEnabled(registrationId: string, enabled: boolean) {
      if (!deps.triggerRepo) return;
      deps.triggerRepo.setEnabled(registrationId, enabled, deps.nowIso());
    },

    async reloadFromPublishedVersions() {
      // Clear all in-memory registrations
      registrations.clear();

      // Load all workflows with published versions
      const workflows = deps.db.withReadConnection((db) =>
        deps.workflowRepo.listWorkflows(db, { limit: 1000 }),
      );

      for (const wf of workflows) {
        if (wf.publishedVersionNumber == null) continue;
        // Delegate to syncPublishedVersionTriggers which handles both
        // in-memory registration and DB persistence
        await this.syncPublishedVersionTriggers(wf.id);
      }
    },
  };
}
