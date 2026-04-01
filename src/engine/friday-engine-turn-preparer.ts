/**
 * Engine Turn Preparer — Initiative A.2
 *
 * Extracts the prompt-assembly / memory-injection logic that was
 * previously inlined in `executeAgentRunWithSessionContext()` into
 * a composable, testable function.
 *
 * Responsibilities:
 * 1. Load session history messages
 * 2. Classify conversation turn (via session conversation orchestrator)
 * 3. Build evidence blocks (capabilities, task status, focus)
 * 4. Re-run turn preparation with evidence blocks if any were produced
 * 5. Update conversation focus for non-status-check / non-clarification turns
 * 6. Classify execution category (sync_immediate / managed_async / agent)
 * 7. Run planning gate (if applicable)
 *
 * The caller (engine or existing facade) receives a fully prepared
 * context and does not need to know about the intermediate steps.
 */

import type { FridayAgentMessage } from "../agent/model/friday-agent.types.js";
import type {
  FridayConversationBlock,
  FridayConversationTurnKind,
  FridayEvidenceBlock,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "../sessions/model/friday-session.types.js";
import type { FridayEngineRunInput } from "./friday-orchestration-engine.types.js";

// ─── Dependency interfaces (narrow — only what the preparer needs) ───

export interface FridayEngineTurnPreparerSessionDeps {
  getMessages(key: string, limit?: number): Promise<FridaySessionMessageRecord[]>;
  addMessage(
    key: string,
    message: {
      role: "user" | "assistant";
      content: string;
      contentText: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<FridaySessionMessageRecord>;
  getConversationFocus(key: string): Promise<FridaySessionConversationFocusState | null>;
  setConversationFocus(key: string, state: FridaySessionConversationFocusState): Promise<void>;
}

export interface FridayPrepareConversationTurnInput {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  replyToMessageId?: string;
  evidenceBlocks?: FridayEvidenceBlock[];
}

export interface FridayPreparedConversationTurn {
  turnKind: FridayConversationTurnKind;
  historyMessages: FridayAgentMessage[];
  taskPrompt: string;
  previousTopicSummary?: string;
  currentTopicSummary?: string;
  selectedBlocks: FridayConversationBlock[];
  selectionReasons: string[];
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
}

export interface FridayBuildEvidenceBlocksInput {
  task: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  capabilitiesSnapshot?: Record<string, unknown>;
  taskStatusSnapshot?: Record<string, unknown>;
}

export type FridayExecutionCategory =
  | "sync_immediate"
  | "managed_async"
  | "agent_exception_path";

export interface FridayExecutionClassification {
  readonly category: FridayExecutionCategory;
  readonly handler?: string;
  readonly extractedParams?: {
    readonly approvalId?: string;
    readonly runId?: string;
    readonly decision?: "approve" | "reject";
    readonly controlAction?: "cancel" | "retry" | "resume";
  };
}

export interface FridayClassifyExecutionInput {
  readonly task: string;
  readonly turnKind: FridayConversationTurnKind;
  readonly focusState?: FridaySessionConversationFocusState | null;
}

// ─── Prepared context (output of the turn preparer) ───

export interface FridayPreparedEngineContext {
  /** Conversation history messages for the LLM. */
  historyMessages?: FridayAgentMessage[];
  /** Potentially rewritten task prompt (with evidence injected). */
  taskPrompt: string;
  /** Conversation metadata for answer alignment. */
  conversationContext?: {
    turnKind?: FridayConversationTurnKind;
    previousTopicSummary?: string;
    currentTopicSummary?: string;
    selectedBlocks?: FridayConversationBlock[];
    selectionReasons?: string[];
    replyToMessageId?: string;
  };
  /** Execution classification result. */
  executionClassification: FridayExecutionClassification;
  /** Evidence blocks injected into the turn. */
  evidenceBlocks: FridayEvidenceBlock[];
  /** Current focus state (for finalization after run). */
  focusState: FridaySessionConversationFocusState | null;
  /** Sequence number of the persisted user message (if any). */
  currentUserSequence?: number;
  /** Reply anchor (for focus finalization). */
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
  /** Idempotency key of the persisted user message (for history filtering). */
  inboundIdempotencyKey?: string;
}

// ─── Factory deps ───

export interface CreateFridayEngineTurnPreparerDeps {
  sessionDeps: FridayEngineTurnPreparerSessionDeps;
  /** Maximum number of raw history records to load. */
  historyLimit: number;
  nowIso: () => string;

  // Pure functions injected for testability
  prepareTurn: (input: FridayPrepareConversationTurnInput) => FridayPreparedConversationTurn;
  buildEvidenceBlocks: (input: FridayBuildEvidenceBlocksInput) => FridayEvidenceBlock[];
  classifyExecution: (input: FridayClassifyExecutionInput) => FridayExecutionClassification;

  // Optional snapshot getters (may not be wired in all configurations)
  capabilitySnapshotGetter?: (input: { readOnly: boolean }) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  taskStatusSnapshotGetter?: (input: {
    runId: string;
    sessionKey?: string;
    readOnly: boolean;
  }) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
}

// ─── Prepare input (subset of engine run input + persistence flag) ───

export interface FridayTurnPreparerInput {
  task: string;
  runId: string;
  sessionKey?: string;
  replyToMessageId?: string;
  constraints?: { readOnly?: boolean };
  persistTaskMessage?: boolean;
  taskAlreadyInHistory?: boolean;
  idempotencyPrefix?: string;
}

// ─── Factory ───

export function createFridayEngineTurnPreparer(deps: CreateFridayEngineTurnPreparerDeps) {
  const {
    sessionDeps,
    historyLimit,
    nowIso,
    prepareTurn,
    buildEvidenceBlocks,
    classifyExecution,
    capabilitySnapshotGetter,
    taskStatusSnapshotGetter,
  } = deps;

  async function loadHistory(sessionKey: string): Promise<FridaySessionMessageRecord[]> {
    return sessionDeps
      .getMessages(sessionKey, historyLimit * 2)
      .catch(() => [] as FridaySessionMessageRecord[]);
  }

  async function prepare(input: FridayTurnPreparerInput): Promise<FridayPreparedEngineContext> {
    const task = input.task.trim();
    const shouldPersist = input.sessionKey && input.persistTaskMessage !== false;
    let inboundIdempotencyKey: string | undefined;
    let currentUserSequence: number | undefined;
    let focusState: FridaySessionConversationFocusState | null = null;

    // ── Load focus state ──
    if (input.sessionKey) {
      focusState = await sessionDeps.getConversationFocus(input.sessionKey).catch(() => null);
    }

    // ── Persist inbound user message ──
    if (input.sessionKey && shouldPersist) {
      inboundIdempotencyKey = `${input.idempotencyPrefix ?? "engine-run"}:${input.runId}:user`;
      const msg = await sessionDeps.addMessage(input.sessionKey, {
        role: "user",
        content: task,
        contentText: task,
        idempotencyKey: inboundIdempotencyKey,
        metadata: input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : undefined,
      });
      currentUserSequence = msg.sequence;
    }

    // ── Session-based turn preparation ──
    let historyMessages: FridayAgentMessage[] | undefined;
    let taskPrompt = task;
    let replyAnchorMessageId: string | undefined;
    let replyAnchorSequence: number | undefined;
    let conversationContext: FridayPreparedEngineContext["conversationContext"];
    let evidenceBlocks: FridayEvidenceBlock[] = [];

    if (input.sessionKey) {
      const historyRecords = await loadHistory(input.sessionKey);

      // Resolve sequence from history when task was already persisted externally
      if (input.taskAlreadyInHistory && !shouldPersist) {
        const last = [...historyRecords]
          .reverse()
          .find((m) => m.role === "user" && m.contentText.trim() === task);
        currentUserSequence = last?.sequence;
      }

      // First pass — classify turn without evidence
      let preparedTurn = prepareTurn({
        task,
        historyRecords: historyRecords.filter(
          (m) => !inboundIdempotencyKey || m.idempotencyKey !== inboundIdempotencyKey,
        ),
        focusState,
        currentUserSequence,
        replyToMessageId: input.replyToMessageId,
      });

      // Build evidence blocks
      evidenceBlocks = buildEvidenceBlocks({
        task,
        turnKind: preparedTurn.turnKind,
        focusState,
        capabilitiesSnapshot: capabilitySnapshotGetter
          ? await Promise.resolve(
              capabilitySnapshotGetter({ readOnly: input.constraints?.readOnly ?? false }),
            ).catch(() => undefined)
          : undefined,
        taskStatusSnapshot: taskStatusSnapshotGetter
          ? await Promise.resolve(
              taskStatusSnapshotGetter({
                runId: input.runId,
                sessionKey: input.sessionKey,
                readOnly: input.constraints?.readOnly ?? false,
              }),
            ).catch(() => undefined)
          : undefined,
      });

      // Second pass — re-classify with evidence
      if (evidenceBlocks.length > 0) {
        preparedTurn = prepareTurn({
          task,
          historyRecords: historyRecords.filter(
            (m) => !inboundIdempotencyKey || m.idempotencyKey !== inboundIdempotencyKey,
          ),
          focusState,
          currentUserSequence,
          replyToMessageId: input.replyToMessageId,
          evidenceBlocks,
        });
      }

      // Update focus for non-status-check / non-clarification turns
      if (
        input.sessionKey &&
        preparedTurn.turnKind !== "status_check" &&
        preparedTurn.turnKind !== "clarification"
      ) {
        await sessionDeps
          .setConversationFocus(input.sessionKey, {
            ...(focusState ?? { updatedAt: nowIso() }),
            activeRunId: input.runId,
            updatedAt: nowIso(),
          })
          .catch(() => undefined);
        focusState = await sessionDeps.getConversationFocus(input.sessionKey).catch(() => focusState);
      }

      historyMessages = preparedTurn.historyMessages;
      taskPrompt = preparedTurn.taskPrompt;
      conversationContext = {
        turnKind: preparedTurn.turnKind,
        previousTopicSummary: preparedTurn.previousTopicSummary,
        currentTopicSummary: preparedTurn.currentTopicSummary,
        selectedBlocks: preparedTurn.selectedBlocks,
        selectionReasons: preparedTurn.selectionReasons,
        replyToMessageId: input.replyToMessageId,
      };
      replyAnchorMessageId = preparedTurn.replyAnchorMessageId;
      replyAnchorSequence = preparedTurn.replyAnchorSequence;
    } else if (capabilitySnapshotGetter) {
      // No session — still build capability evidence for standalone runs
      evidenceBlocks = buildEvidenceBlocks({
        task,
        turnKind: "new_topic",
        capabilitiesSnapshot: await Promise.resolve(
          capabilitySnapshotGetter({ readOnly: input.constraints?.readOnly ?? false }),
        ).catch(() => undefined),
      });
      if (evidenceBlocks.length > 0) {
        conversationContext = {
          turnKind: "new_topic",
          currentTopicSummary: task,
          selectedBlocks: evidenceBlocks.map((b) => ({
            id: b.id,
            source: b.source,
            summary: b.summary,
            score: b.score,
            reason: b.reason,
          })),
          selectionReasons: evidenceBlocks.map((b) => `${b.source} → ${b.reason}`),
        };
      }
    }

    // ── Classify execution category ──
    const resolvedTurnKind = conversationContext?.turnKind ?? "new_topic";
    const executionClassification = classifyExecution({
      task,
      turnKind: resolvedTurnKind,
      focusState,
    });

    return {
      historyMessages,
      taskPrompt,
      conversationContext,
      executionClassification,
      evidenceBlocks,
      focusState,
      currentUserSequence,
      replyAnchorMessageId,
      replyAnchorSequence,
      inboundIdempotencyKey,
    };
  }

  return { prepare };
}
