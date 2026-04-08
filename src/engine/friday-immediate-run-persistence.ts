import type {
  FridayAgentRunEventRepository,
  FridayAgentRunRepository,
} from "#agent";
import type { FridaySqliteLayer } from "#state";

export interface CreateFridayImmediateRunPersistenceDeps {
  db: FridaySqliteLayer;
  repo: FridayAgentRunRepository;
  runEventRepository: FridayAgentRunEventRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

export interface FridayImmediateRunPersistenceInput {
  runId: string;
  task: string;
  sessionKey?: string;
  providerId?: string;
  model?: string;
  constraints?: { readOnly?: boolean };
  responseText: string;
}

export function createFridayImmediateRunPersistence(
  deps: CreateFridayImmediateRunPersistenceDeps,
) {
  return (input: FridayImmediateRunPersistenceInput): void => {
    const existingRun = deps.db.withReadConnection((reader) => deps.repo.getById(reader, input.runId));
    if (existingRun) {
      return;
    }

    const now = deps.nowIso();
    const sessionKey = input.sessionKey ?? `agent:run:${input.runId}`;

    deps.db.withWriteTransaction((writer) => {
      deps.repo.create(writer, {
        id: input.runId,
        task: input.task,
        sessionKey,
        providerId: input.providerId,
        model: input.model,
        maxAttempts: 1,
        nowIso: now,
        constraints: input.constraints,
      });
      deps.repo.update(writer, {
        id: input.runId,
        status: "completed",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        responseText: input.responseText,
        summary: input.responseText,
      });
      deps.runEventRepository.append(writer, {
        eventId: deps.idGenerator(),
        runId: input.runId,
        seq: 1,
        eventName: "agent.run.text_delta",
        payload: {
          runId: input.runId,
          delta: input.responseText,
        },
        emittedAt: now,
        createdAt: now,
      });
      deps.runEventRepository.append(writer, {
        eventId: deps.idGenerator(),
        runId: input.runId,
        seq: 2,
        eventName: "agent.run.completed",
        payload: {
          runId: input.runId,
          durationMs: 0,
          toolCallCount: 0,
          testsPassed: true,
          artifacts: [],
        },
        emittedAt: now,
        createdAt: now,
      });
    });

    // Keep deterministic runs immediately visible to the read pool so getRun and
    // SSE replay remain consistent under full-suite load.
    try {
      deps.db.checkpoint("PASSIVE");
    } catch (err) {
      console.warn(
        "[friday][immediate-run-persistence] checkpoint:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
}
