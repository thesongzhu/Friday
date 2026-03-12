import { FridayDomainError } from "#errors";

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
  FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR,
} from "./friday-subagent-constants.js";
import { buildFridaySubagentSystemPrompt } from "./friday-subagent-system-prompt.js";
import { createFridaySubagentRunRepository } from "../persistence/friday-subagent-run-repository.js";

/** Default archival deadline offset: 24 hours after finalization. */
const FRIDAY_SUBAGENT_DEFAULT_ARCHIVAL_OFFSET_MS = 24 * 60 * 60 * 1000;

/** Poll interval for waitForCompletion (ms). */
const FRIDAY_SUBAGENT_POLL_INTERVAL_MS = 250;

// ─── Factory ───

export function createFridaySubagentRegistry(
  deps: CreateFridaySubagentRegistryDeps,
): FridaySubagentRegistry {
  const { db, createChildRuntime, eventEmitter, idGenerator, nowIso } = deps;
  const repo = createFridaySubagentRunRepository();

  /** Shared validation + record creation for both spawn() and spawnDetached(). */
  function prepareSpawn(input: FridaySubagentRegistrySpawnInput): {
    subagentRecordId: string;
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
    const childSessionKey = `${input.parentSessionKey}${FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR}${subagentRecordId}`;

    // 4. Create subagent record
    db.withWriteTransaction((writer) =>
      repo.create(writer, {
        id: subagentRecordId,
        parentRunId: input.parentRunId,
        parentSessionKey: input.parentSessionKey,
        childRunId: "",
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
      parentRunId: input.parentRunId,
      task: input.task,
      label: input.label,
      depth: input.depth + 1,
    });

    return { subagentRecordId, childSessionKey };
  }

  /** Execute the child run and finalize the record. Shared by spawn() and startRun(). */
  async function executeChild(
    subagentRecordId: string,
    input: FridaySubagentRegistrySpawnInput,
    childSessionKey: string,
  ): Promise<FridaySubagentOutcome> {
    // Build child system prompt
    const systemPrompt = buildFridaySubagentSystemPrompt({
      task: input.task,
      label: input.label,
      parentSessionKey: input.parentSessionKey,
      depth: input.depth + 1,
    });

    // Create child runtime
    const childRuntime = createChildRuntime({
      model: input.model,
      systemPrompt,
      depth: input.depth + 1,
    });

    // Transition to running
    db.withWriteTransaction((writer) =>
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
        sessionKey: childSessionKey,
        timeoutMs,
        signal: input.signal,
      });

      // Update child run ID
      db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id: subagentRecordId,
          childRunId: result.runId,
        }),
      );

      // Build outcome
      const outcome: FridaySubagentOutcome = {
        status: result.status,
        response: result.response,
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
        usageInput: result.usageInput,
        usageOutput: result.usageOutput,
      };

      // Finalize record
      db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id: subagentRecordId,
          status: result.status === "completed"
            ? "completed"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed",
          outcome,
          completedAt: nowIso(),
          durationMs: result.durationMs,
        }),
      );

      // Emit completed event
      eventEmitter.emit("agent.subagent.completed", {
        subagentId: subagentRecordId,
        parentRunId: input.parentRunId,
        childRunId: result.runId,
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
      };

      db.withWriteTransaction((writer) =>
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
        childRunId: "",
        outcome: failedOutcome,
      });

      return failedOutcome;
    }
  }

  // Map to keep detached spawn inputs alive for startRun()
  const detachedInputs = new Map<string, { input: FridaySubagentRegistrySpawnInput; childSessionKey: string }>();

  return {
    async spawn(input: FridaySubagentRegistrySpawnInput): Promise<FridaySubagentOutcome> {
      const { subagentRecordId, childSessionKey } = prepareSpawn(input);
      return executeChild(subagentRecordId, input, childSessionKey);
    },

    spawnDetached(input: FridaySubagentRegistrySpawnInput): FridaySubagentDetachedResult {
      const { subagentRecordId, childSessionKey } = prepareSpawn(input);

      // Store input for later startRun()
      detachedInputs.set(subagentRecordId, { input, childSessionKey });

      // Fire-and-forget the child execution
      void executeChild(subagentRecordId, input, childSessionKey).finally(() => {
        detachedInputs.delete(subagentRecordId);
      });

      return {
        subagentId: subagentRecordId,
        childSessionKey,
        status: "accepted",
      };
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

      db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id: subagentId,
          cleanupRequested: true,
          archivalDeadline: deadline,
        }),
      );
    },

    cleanup(beforeIso?: string): number {
      const cutoff = beforeIso ?? nowIso();
      return db.withWriteTransaction((writer) =>
        repo.deleteCleanedUp(writer, cutoff),
      );
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
        };

        db.withWriteTransaction((writer) =>
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
