import type Database from "better-sqlite3";
import { FridayDomainError } from "#errors";
import { buildFridaySubagentSessionKey } from "#sessions";

import type {
  CreateFridaySubagentRegistryDeps,
  FridaySubagentDetachedResult,
  FridaySubagentListFilters,
  FridaySubagentOutcome,
  FridaySubagentRegistry,
  FridaySubagentRegistrySpawnInput,
  FridaySubagentRunRecord,
} from "./friday-subagent.types.js";
import {
  FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS,
  FRIDAY_SUBAGENT_ERROR_CODES,
  FRIDAY_SUBAGENT_MAX_CONCURRENT,
  FRIDAY_SUBAGENT_MAX_DEPTH,
} from "./friday-subagent-constants.js";
import {
  inferFridaySubagentProfile,
  resolveFridaySubagentProfile,
} from "./friday-subagent-profile.js";
import { buildFridaySubagentSystemPrompt } from "./friday-subagent-system-prompt.js";
import { createFridaySubagentRunRepository } from "../persistence/friday-subagent-run-repository.js";

/** Default archival deadline offset: 24 hours after finalization. */
const FRIDAY_SUBAGENT_DEFAULT_ARCHIVAL_OFFSET_MS = 24 * 60 * 60 * 1000;

/** Poll interval for waitForCompletion (ms). */
const FRIDAY_SUBAGENT_POLL_INTERVAL_MS = 250;
/** Shutdown grace period for detached children (ms). */
const FRIDAY_SUBAGENT_DRAIN_TIMEOUT_MS = 15_000;

// ─── Factory ───

export function createFridaySubagentRegistry(
  deps: CreateFridaySubagentRegistryDeps,
): FridaySubagentRegistry {
  const { db, createChildRuntime, eventEmitter, idGenerator, nowIso } = deps;
  const repo = createFridaySubagentRunRepository();
  const inFlightExecutions = new Map<string, Promise<FridaySubagentOutcome>>();

  function isClosedDbError(error: unknown): boolean {
    return error instanceof Error && /database connection is not open/i.test(error.message);
  }

  function safeWrite(
    operation: (writer: Database.Database) => void,
  ): void {
    try {
      db.withWriteTransaction(operation);
    } catch (error) {
      if (!isClosedDbError(error)) {
        throw error;
      }
    }
  }

  /** Shared validation + record creation for both spawn() and spawnDetached(). */
  function prepareSpawn(input: FridaySubagentRegistrySpawnInput): {
    subagentRecordId: string;
    childRunId: string;
    childSessionKey: string;
  } {
    // 1. Validate depth
    if (input.depth >= FRIDAY_SUBAGENT_MAX_DEPTH) {
      throw new FridayDomainError(
        FRIDAY_SUBAGENT_ERROR_CODES.MAX_DEPTH_EXCEEDED,
        `Sub-agent max depth (${String(FRIDAY_SUBAGENT_MAX_DEPTH)}) exceeded at depth ${String(input.depth)}`,
        { httpStatus: 400 },
      );
    }

    // 2. Validate concurrency
    const activeCount = db.withReadConnection((reader) =>
      repo.countActiveByParentRunId(reader, input.parentRunId),
    );
    if (activeCount >= FRIDAY_SUBAGENT_MAX_CONCURRENT) {
      throw new FridayDomainError(
        FRIDAY_SUBAGENT_ERROR_CODES.MAX_CONCURRENT_EXCEEDED,
        `Max concurrent sub-agents (${String(FRIDAY_SUBAGENT_MAX_CONCURRENT)}) for parent run ${input.parentRunId}`,
        { httpStatus: 429 },
      );
    }

    // 3. Generate IDs
    const subagentRecordId = idGenerator();
    const childRunId = idGenerator();
    const childSessionKey = buildFridaySubagentSessionKey(input.parentSessionKey, childRunId);

    // 4. Create subagent record
    safeWrite((writer) =>
      repo.create(writer, {
        id: subagentRecordId,
        parentRunId: input.parentRunId,
        parentSessionKey: input.parentSessionKey,
        childRunId,
        childSessionKey,
        task: input.task,
        label: input.label,
        model: input.model,
        depth: input.depth + 1,
        nowIso: nowIso(),
        requesterSessionKey: input.parentSessionKey,
        rootRunId: input.rootRunId,
      }),
    );

    // 5. Emit spawned event
    eventEmitter.emit("agent.subagent.spawned", {
      subagentId: subagentRecordId,
      childRunId,
      parentRunId: input.parentRunId,
      task: input.task,
      label: input.label,
      depth: input.depth + 1,
    });

    return { subagentRecordId, childRunId, childSessionKey };
  }

  /** Execute the child run and finalize the record. Shared by spawn() and startRun(). */
  async function executeChild(
    subagentRecordId: string,
    childRunId: string,
    input: FridaySubagentRegistrySpawnInput,
    childSessionKey: string,
  ): Promise<FridaySubagentOutcome> {
    const resolvedProfile = resolveFridaySubagentProfile(
      input.profile ?? inferFridaySubagentProfile(input.task, input.label),
    );
    // Build child system prompt
    const systemPrompt = buildFridaySubagentSystemPrompt({
      task: input.task,
      label: input.label,
      profileLabel: resolvedProfile.label,
      profileDescription: resolvedProfile.description,
      profileInstructions: resolvedProfile.instructions,
      parentSessionKey: input.parentSessionKey,
      depth: input.depth + 1,
    });

    // Create child runtime
    const childRuntime = createChildRuntime({
      providerId: input.providerId,
      model: resolvedProfile.model ?? input.model,
      systemPrompt,
      depth: input.depth + 1,
      rootRunId: input.rootRunId,
    });

    // Transition to running
    safeWrite((writer) =>
      repo.update(writer, {
        id: subagentRecordId,
        status: "running",
        startedAt: nowIso(),
      }),
    );

    try {
      // Execute child run
      const timeoutMs = input.timeoutMs ?? FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS;
      const result = await childRuntime.executeRun({
        task: input.task,
        taskPrompt: input.taskPrompt,
        runId: childRunId,
        sessionKey: childSessionKey,
        providerId: input.providerId,
        model: resolvedProfile.model ?? input.model,
        timezone: input.timezone,
        timeoutMs,
        conversationContext: input.conversationContext,
        tenantContext: input.tenantContext,
        signal: input.signal,
        constraints: {
          ...(input.constraints ?? {}),
          ...(resolvedProfile.readOnly ? { readOnly: true } : {}),
        },
        principalId: input.principalId,
        taskProfile: { id: resolvedProfile.taskProfile },
      });

      // Build outcome
      const terminalStatus: FridaySubagentOutcome["status"] = result.status === "completed"
        ? "completed"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed";
      const outcome: FridaySubagentOutcome = {
        status: terminalStatus,
        response: result.response,
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
        usageInput: result.usageInput,
        usageOutput: result.usageOutput,
        images: result.images,
      };

      // Finalize record
      safeWrite((writer) =>
        repo.update(writer, {
          id: subagentRecordId,
          status: terminalStatus,
          outcome,
          completedAt: nowIso(),
          durationMs: result.durationMs,
        }),
      );

      // Emit completed event
      eventEmitter.emit("agent.subagent.completed", {
        subagentId: subagentRecordId,
        parentRunId: input.parentRunId,
        childRunId,
        outcome,
      });

      return outcome;
    } catch (error) {
      // Handle child runtime exception
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedOutcome: FridaySubagentOutcome = {
        status: "failed",
        response: errorMessage,
        toolCallCount: 0,
        durationMs: 0,
        usageInput: 0,
        usageOutput: 0,
        images: [],
      };

      safeWrite((writer) =>
        repo.update(writer, {
          id: subagentRecordId,
          status: "failed",
          outcome: failedOutcome,
          completedAt: nowIso(),
          durationMs: 0,
        }),
      );

      eventEmitter.emit("agent.subagent.completed", {
        subagentId: subagentRecordId,
        parentRunId: input.parentRunId,
        childRunId,
        outcome: failedOutcome,
      });

      return failedOutcome;
    }
  }

  // Map to keep detached spawn inputs alive for startRun()
  const detachedInputs = new Map<string, { input: FridaySubagentRegistrySpawnInput; childSessionKey: string }>();

  return {
    async spawn(input: FridaySubagentRegistrySpawnInput): Promise<FridaySubagentOutcome> {
      const { subagentRecordId, childRunId, childSessionKey } = prepareSpawn(input);
      return executeChild(subagentRecordId, childRunId, input, childSessionKey);
    },

    spawnDetached(input: FridaySubagentRegistrySpawnInput): FridaySubagentDetachedResult {
      const { subagentRecordId, childRunId, childSessionKey } = prepareSpawn(input);

      // Store input for later startRun()
      detachedInputs.set(subagentRecordId, { input, childSessionKey });

      // Fire-and-forget the child execution
      const execution = executeChild(subagentRecordId, childRunId, input, childSessionKey).finally(() => {
        detachedInputs.delete(subagentRecordId);
        inFlightExecutions.delete(subagentRecordId);
      });
      inFlightExecutions.set(subagentRecordId, execution);
      void execution;

      const record = db.withReadConnection((reader) =>
        repo.getById(reader, subagentRecordId),
      );

      return {
        subagentId: subagentRecordId,
        childRunId,
        childSessionKey,
        status: "accepted",
        statusSnapshot: record?.status ?? "pending",
        outcome: record?.outcome,
        detached: true,
        awaited: false,
      };
    },

    async drain(timeoutMs = FRIDAY_SUBAGENT_DRAIN_TIMEOUT_MS): Promise<void> {
      if (inFlightExecutions.size === 0) {
        return;
      }
      const pending = Array.from(inFlightExecutions.values());
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
    },

    async startRun(subagentId: string): Promise<FridaySubagentOutcome> {
      // If the run was spawned detached, the execution is already in-flight.
      // Wait for it to complete via polling.
      return this.waitForCompletion(subagentId);
    },

    async waitForCompletion(subagentId: string, timeoutMs?: number): Promise<FridaySubagentOutcome> {
      const deadline = Date.now() + (timeoutMs ?? FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS);

      while (Date.now() < deadline) {
        const record = db.withReadConnection((reader) =>
          repo.getById(reader, subagentId),
        );

        if (!record) {
          throw new FridayDomainError(
            FRIDAY_SUBAGENT_ERROR_CODES.NOT_FOUND,
            `Sub-agent '${subagentId}' not found`,
            { httpStatus: 404 },
          );
        }

        if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
          return record.outcome ?? {
            status: record.status === "completed" ? "completed" : record.status === "cancelled" ? "cancelled" : "failed",
            response: "",
            toolCallCount: 0,
            durationMs: record.durationMs ?? 0,
            usageInput: 0,
            usageOutput: 0,
            images: [],
          };
        }

        // Wait before polling again
        await new Promise((resolve) => setTimeout(resolve, FRIDAY_SUBAGENT_POLL_INTERVAL_MS));
      }

      // Timed out waiting
      throw new FridayDomainError(
        FRIDAY_SUBAGENT_ERROR_CODES.SPAWN_FAILED,
        `Timed out waiting for sub-agent '${subagentId}' to complete`,
        { httpStatus: 504 },
      );
    },

    finalize(subagentId: string, opts?: { archivalDeadline?: string }): void {
      const deadline = opts?.archivalDeadline
        ?? new Date(Date.now() + FRIDAY_SUBAGENT_DEFAULT_ARCHIVAL_OFFSET_MS).toISOString();

      safeWrite((writer) =>
        repo.update(writer, {
          id: subagentId,
          cleanupRequested: true,
          archivalDeadline: deadline,
        }),
      );
    },

    cleanup(beforeIso?: string): number {
      const cutoff = beforeIso ?? nowIso();
      try {
        return db.withWriteTransaction((writer) =>
          repo.deleteCleanedUp(writer, cutoff),
        );
      } catch (error) {
        if (isClosedDbError(error)) {
          return 0;
        }
        throw error;
      }
    },

    resumeOnBoot(): number {
      const pendingOrRunning = db.withReadConnection((reader) =>
        repo.listPendingOrRunning(reader),
      );

      let failedCount = 0;
      for (const record of pendingOrRunning) {
        const failedOutcome: FridaySubagentOutcome = {
          status: "failed",
          response: "Sub-agent was pending/running when the system restarted. Marked as failed on boot.",
          toolCallCount: 0,
          durationMs: 0,
          usageInput: 0,
          usageOutput: 0,
          images: [],
        };

        safeWrite((writer) =>
          repo.update(writer, {
            id: record.id,
            status: "failed",
            outcome: failedOutcome,
            completedAt: nowIso(),
            durationMs: 0,
          }),
        );

        eventEmitter.emit("agent.subagent.completed", {
          subagentId: record.id,
          parentRunId: record.parentRunId,
          childRunId: record.childRunId,
          outcome: failedOutcome,
        });

        failedCount++;
      }

      return failedCount;
    },

    listByParentRunId(parentRunId: string): FridaySubagentRunRecord[] {
      return db.withReadConnection((reader) =>
        repo.listByParentRunId(reader, parentRunId),
      );
    },

    getById(id: string): FridaySubagentRunRecord | null {
      return db.withReadConnection((reader) =>
        repo.getById(reader, id),
      );
    },

    list(filters?: FridaySubagentListFilters): FridaySubagentRunRecord[] {
      return db.withReadConnection((reader) =>
        repo.list(reader, filters),
      );
    },

    activeCountForParent(parentRunId: string): number {
      return db.withReadConnection((reader) =>
        repo.countActiveByParentRunId(reader, parentRunId),
      );
    },
  };
}
