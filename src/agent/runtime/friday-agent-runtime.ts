import { FridayDomainError } from "#errors";
import type { FridayEvaluationContext, FridayEvaluationResult } from "#rules";

import {
  FRIDAY_AGENT_ERROR_CODES,
  FRIDAY_AGENT_MAX_ATTEMPTS,
  FRIDAY_AGENT_MAX_LOOP_ITERATIONS,
  FRIDAY_AGENT_MAX_TOOL_CALLS,
  FRIDAY_AGENT_RUN_TIMEOUT_MS,
  FRIDAY_AGENT_SESSION_KEY_PREFIX,
  FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS,
  FRIDAY_AGENT_TOOL_TIMEOUT_MS,
} from "../friday-agent.constants.js";
import type {
  FridayAgentActualExecution,
  FridayAgentActualTurn,
  FridayAgentArtifact,
  FridayAgentContentBlock,
  FridayAgentEtaConfidence,
  FridayAgentImageBlock,
  FridayAgentMessage,
  FridayAgentRunStatus,
  FridayAgentTestResult,
  FridayAgentToolCallRecord,
  FridayAgentToolDefinition,
  FridayAgentToolResult,
  FridayAgentToolResultBlock,
  FridayAgentToolUseBlock,
} from "../model/friday-agent.types.js";
import { createFridayAgentRunRepository } from "../persistence/friday-agent-run-repository.js";
import type { FridayAgentLlmStreamEvent } from "./friday-agent-llm-client.types.js";
import type {
  CreateFridayAgentRuntimeDeps,
  FridayAgentConversationContext,
  FridayAgentExecutionContext,
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
} from "./friday-agent-runtime.types.js";
import { evaluateFridayAnswerAlignment } from "./friday-agent-answer-alignment.js";
import { attachFridayAgentToolExecutionContext } from "./friday-agent-tool-execution-context.js";
import { shouldDelegateFridayAgentTask } from "./friday-agent-delegation-policy.js";
import { isMutatingToolCall } from "./friday-agent-tool-mutation.js";
import { getApprovalRequiredReasonForToolCall } from "./friday-agent-tool-risk.js";

const RULES_EVALUATE_SCOPE = "rules:evaluate";

// ─── Factory ───

export function createFridayAgentRuntime(
  deps: CreateFridayAgentRuntimeDeps,
): FridayAgentRuntime {
  const {
    db,
    llmClient,
    model,
    providerId,
    systemPrompt: staticSystemPrompt,
    systemPromptBuilder,
    tools: depsTools,
    eventEmitter,
    idGenerator,
    nowIso,
    reviewGate,
    runEventRepository,
    selfTestService,
    workdir,
    sessionMirror,
    usageRecorder,
    artifactWriter,
    evaluateRules,
    learningContextBuilder,
    communicationPromptBuilder,
    delegationHandler,
  } = deps;

  // Clone the tools array so registerTool does not mutate the caller's array.
  const tools = [...depsTools];

  const repo = createFridayAgentRunRepository();
  const toolMap = new Map<string, FridayAgentToolDefinition>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  // ─── Per-run event sequence counter ───
  const runSeqCounters = new Map<string, number>();

  function nextSeq(runId: string): number {
    const current = runSeqCounters.get(runId) ?? 0;
    const next = current + 1;
    runSeqCounters.set(runId, next);
    return next;
  }

  /** Persist event durably (if repo available) then emit. */
  function emitRunEvent(
    eventName: string,
    payload: Record<string, unknown>,
    runId: string,
  ): void {
    if (runEventRepository) {
      const seq = nextSeq(runId);
      const now = nowIso();
      try {
        db.withWriteTransaction((writer) =>
          runEventRepository.append(writer, {
            eventId: idGenerator(),
            runId,
            seq,
            eventName,
            payload,
            emittedAt: now,
            createdAt: now,
          }),
        );
      } catch {
        // Non-fatal: event persistence failure should not kill the run
      }
    }
    eventEmitter.emit(eventName as keyof typeof eventEmitter extends never ? never : Parameters<typeof eventEmitter.emit>[0], payload as never);
  }

  return {
    registerTool(tool) {
      const existingIndex = tools.findIndex((t) => t.name === tool.name);
      if (existingIndex >= 0) {
        tools[existingIndex] = tool;
      } else {
        tools.push(tool);
      }
      toolMap.set(tool.name, tool);
    },

    resumeStaleRunsOnBoot(): number {
      const staleRuns = db.withReadConnection((reader) => repo.listActive(reader));
      let failedCount = 0;
      for (const run of staleRuns) {
        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: run.id,
            status: "failed",
            completedAt: nowIso(),
            durationMs: 0,
            errorCode: FRIDAY_AGENT_ERROR_CODES.INTERRUPTED,
            errorMessage: `Agent run was in "${run.status}" state when the system restarted. Marked as failed on boot.`,
          }),
        );

        emitRunEvent("agent.run.failed", {
          runId: run.id,
          error: {
            code: FRIDAY_AGENT_ERROR_CODES.INTERRUPTED,
            message: `Stale run recovered on boot (was "${run.status}")`,
          },
          durationMs: 0,
          routeId: "agent.resume_stale_runs",
          correlationId: run.id,
        }, run.id);

        failedCount++;
      }
      return failedCount;
    },

    async executeRun(params) {
      const runId = params.runId ?? idGenerator();
      const runCorrelationId = runId;
      const sessionKey = params.sessionKey ?? `${FRIDAY_AGENT_SESSION_KEY_PREFIX}${runId}`;
      const maxAttempts = params.maxAttempts ?? FRIDAY_AGENT_MAX_ATTEMPTS;
      const timeoutMs = params.timeoutMs ?? FRIDAY_AGENT_RUN_TIMEOUT_MS;
      const startedAt = Date.now();
      const constraints = params.constraints;
      const isReadOnly = constraints?.readOnly === true;
      const disabledToolNames = normalizeToolNameSet(params.disabledToolNames);
      const executionContext = params.executionContext;
      const conversationContext = params.conversationContext;
      const principalId =
        typeof params.principalId === "string" && params.principalId.trim().length > 0
          ? params.principalId
          : undefined;
      const scopes = normalizeScopes(params.scopes);
      let currentPhase: FridayAgentRunStatus = "pending";
      let activeToolName: string | undefined;
      let latestSubagentId: string | undefined;
      const activeSubagentIds = new Set<string>();

      // Resolve per-run overrides (FIX-1)
      const requestedProviderId = normalizeDefaultRouteSentinel(params.providerId)
        ?? normalizeDefaultRouteSentinel(providerId);
      const requestedModel = normalizeDefaultRouteSentinel(params.model)
        ?? normalizeDefaultRouteSentinel(model);

      function deriveEta(elapsedMs: number): { eta?: number; etaConfidence: FridayAgentEtaConfidence } {
        if (timeoutMs > elapsedMs) {
          return {
            eta: timeoutMs - elapsedMs,
            etaConfidence: "low",
          };
        }
        return { etaConfidence: "unavailable" };
      }

      const emitProgressEvent = (): void => {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const eta = deriveEta(elapsedMs);
        emitRunEvent("agent.run.progress", {
          runId,
          phase: currentPhase,
          elapsedMs,
          ...(activeToolName ? { activeTool: activeToolName } : {}),
          subagentCount: activeSubagentIds.size,
          ...(latestSubagentId ? { latestSubagentId } : {}),
          ...(activeSubagentIds.size > 0 ? { activeSubagentIds: [...activeSubagentIds] } : {}),
          ...(typeof eta.eta === "number" ? { eta: eta.eta } : {}),
          etaConfidence: eta.etaConfidence,
        }, runId);
      };

      const handleTrackedEvent = (eventName: string, payload: Record<string, unknown>): void => {
        switch (eventName) {
          case "agent.run.started":
            currentPhase = "pending";
            break;
          case "agent.run.planning":
            currentPhase = "planning";
            break;
          case "agent.run.executing":
            currentPhase = "executing";
            break;
          case "agent.run.tool_start":
            if (typeof payload.toolName === "string" && payload.toolName.trim().length > 0) {
              activeToolName = payload.toolName;
            }
            break;
          case "agent.run.tool_end":
            if (typeof payload.toolName === "string" && payload.toolName === activeToolName) {
              activeToolName = undefined;
            }
            break;
          case "agent.run.completed":
            currentPhase = "completed";
            activeToolName = undefined;
            break;
          case "agent.run.failed":
            currentPhase = "failed";
            activeToolName = undefined;
            break;
          case "agent.run.cancelled":
            currentPhase = "cancelled";
            activeToolName = undefined;
            break;
        }

        emitRunEvent(eventName, payload, runId);
        if (eventName !== "agent.run.text_delta" && eventName !== "agent.run.progress") {
          emitProgressEvent();
        }
      };

      const onSubagentSpawned = (payload: { parentRunId: string; subagentId: string }): void => {
        if (payload.parentRunId !== runId) return;
        activeSubagentIds.add(payload.subagentId);
        latestSubagentId = payload.subagentId;
        emitProgressEvent();
      };

      const onSubagentCompleted = (payload: { parentRunId: string; subagentId: string }): void => {
        if (payload.parentRunId !== runId) return;
        activeSubagentIds.delete(payload.subagentId);
        latestSubagentId = payload.subagentId;
        emitProgressEvent();
      };

      eventEmitter.on("agent.subagent.spawned", onSubagentSpawned);
      eventEmitter.on("agent.subagent.completed", onSubagentCompleted);
      const progressTimer = setInterval(() => {
        emitProgressEvent();
      }, 15_000);

      // 1. Create run record
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id: runId,
          task: params.task,
          sessionKey,
          providerId: requestedProviderId,
          model: requestedModel,
          maxAttempts,
          nowIso: nowIso(),
          constraints,
        }),
      );

      // Setup abort controller with timeout
      const runAbortController = new AbortController();
      const abortTimer = setTimeout(() => {
        runAbortController.abort(new Error("Agent run timed out"));
      }, Math.max(1, timeoutMs));

      // Wire external signal
      const onExternalAbort = () => {
        runAbortController.abort(params.signal?.reason);
      };
      if (params.signal?.aborted) {
        runAbortController.abort(params.signal.reason);
      } else {
        params.signal?.addEventListener("abort", onExternalAbort, { once: true });
      }

      const messages: FridayAgentMessage[] = normalizeHistoryMessages(params.historyMessages);
      const llmTask = typeof params.taskPrompt === "string" && params.taskPrompt.trim().length > 0
        ? params.taskPrompt.trim()
        : params.task;
      let learnedPreferences: Record<string, unknown> = {};
      if (learningContextBuilder && principalId) {
        try {
          const learningCtx = learningContextBuilder({ userId: principalId, nowIso: nowIso() });
          if (learningCtx.preferences && typeof learningCtx.preferences === "object") {
            learnedPreferences = learningCtx.preferences;
          }
        } catch {
          // Non-fatal: preference enrichment failure should not kill the run.
        }
      }
      const runTimeContext = buildRunTimeContext(
        nowIso(),
        params.timezone,
        readPreferredTimezone(learnedPreferences),
      );
      const timeSensitiveNewsRequested = hasTimeSensitiveNewsIntent(params.task, messages);
      const allToolCalls: FridayAgentToolCallRecord[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let responseText = "";
      const actualTurns: FridayAgentActualTurn[] = [];
      let latestTestResults: FridayAgentTestResult[] = [];
      let latestArtifacts: FridayAgentArtifact[] = [];
      let latestActualExecution: FridayAgentActualExecution | undefined;
      let latestCostUsd: number | undefined;

      const persistRunArtifacts = (input: {
        status: string;
        response: string;
        durationMs: number;
        completedAt: string;
        testResults: FridayAgentTestResult[];
        artifacts: FridayAgentArtifact[];
        costUsd?: number;
      }): { artifactDir?: string; artifacts: FridayAgentArtifact[] } => {
        let artifactDir: string | undefined;
        let writtenArtifacts = input.artifacts;
        if (!artifactWriter) {
          return { artifactDir, artifacts: writtenArtifacts };
        }

        try {
          const writerResult = artifactWriter.writeRunArtifacts({
            runId,
            task: params.task,
            status: input.status,
            response: input.response,
            toolCalls: allToolCalls,
            testResults: input.testResults,
            artifacts: input.artifacts,
            durationMs: input.durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: input.costUsd,
            completedAt: input.completedAt,
          });
          artifactDir = writerResult.artifactDir;
          writtenArtifacts = writerResult.artifacts;
        } catch (error) {
          console.warn(
            `[friday][W-AG-ARTIFACT-WRITE-001] Failed to persist run artifacts for run ${runId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }

        return { artifactDir, artifacts: writtenArtifacts };
      };

      try {
        // 2. Emit started event and transition to planning
        if (evaluateRules) {
          const runPolicy = await safeEvaluateRules(evaluateRules, {
            resource: "agent",
            action: "execute",
            args: {
              task: params.task,
              providerId: requestedProviderId ?? "default",
              model: requestedModel ?? "default",
              constraints: {
                readOnly: isReadOnly,
              },
            },
            source: "agent",
            principalId,
            runId,
            sessionId: sessionKey,
            scopes,
          }, runAbortController.signal);
          if (runPolicy && !runPolicy.allowed) {
            const durationMs = Date.now() - startedAt;
            const message = runPolicy.message ?? "Agent run denied by policy";
            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: "failed",
                completedAt: nowIso(),
                durationMs,
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                errorMessage: message,
                summary: deriveSummary(message),
              }),
            );

            handleTrackedEvent("agent.run.failed", {
              runId,
              error: {
                code: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                message,
              },
              durationMs,
              routeId: "agent.execute.run.policy",
              correlationId: runCorrelationId,
            });

            return {
              runId,
              status: "failed",
              response: message,
              toolCallCount: 0,
              durationMs,
              usageInput: 0,
              usageOutput: 0,
            };
          }
        }

        handleTrackedEvent("agent.run.started", {
          runId,
          task: params.task,
          model: requestedModel,
          providerId: requestedProviderId,
        });

        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "planning",
            startedAt: nowIso(),
          }),
        );

        // Build plan summary
        const planSummary = {
          task: params.task,
          stepCount: 1, // Will be determined during execution
          description: `Planning approach for: ${params.task.slice(0, 200)}`,
        };

        // Persist plan review JSON (IMPL-1)
        const planReview = {
          plan: planSummary,
          decision: undefined as { approved: boolean; mode: string; reason?: string; reviewedAt: string } | undefined,
        };

        // Review gate check (IMPL-1)
        if (params.reviewRequired && reviewGate) {
          const decision = reviewGate.review(planSummary, nowIso());
          planReview.decision = decision;

          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              planReview,
            }),
          );

          if (!decision.approved) {
            // Rejected by review gate
            const durationMs = Date.now() - startedAt;
            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: "failed",
                completedAt: nowIso(),
                durationMs,
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                errorMessage: `Plan rejected by review gate: ${decision.reason ?? "no reason"}`,
                planReview,
              }),
            );

            handleTrackedEvent("agent.run.failed", {
              runId,
              error: {
                code: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                message: `Plan rejected by review gate: ${decision.reason ?? "no reason"}`,
              },
              durationMs,
              routeId: "agent.execute.run.review",
              correlationId: runCorrelationId,
            });

            return {
              runId,
              status: "failed",
              response: `Plan rejected: ${decision.reason ?? "no reason"}`,
              toolCallCount: 0,
              durationMs,
              usageInput: 0,
              usageOutput: 0,
            };
          }
        } else {
          // No review required — auto-approve silently
          planReview.decision = {
            approved: true,
            mode: "off",
            reason: "No review required",
            reviewedAt: nowIso(),
          };
        }

        // Persist plan review
        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            planReview,
          }),
        );

        handleTrackedEvent("agent.run.planning", {
          runId,
          message: `Planning approach (${String(planSummary.stepCount)} step(s))`,
        });

        if (
          delegationHandler
          && shouldDelegateFridayAgentTask({
            task: params.task,
            conversationContext,
          })
        ) {
          handleTrackedEvent("agent.run.executing", {
            runId,
            step: 1,
            description: "Delegating task to sub-agent",
          });

          const delegated = await delegationHandler({
            runId,
            sessionKey,
            task: params.task,
            timezone: params.timezone,
            timeoutMs,
            signal: runAbortController.signal,
            constraints,
            principalId,
            conversationContext,
          });

          if (delegated) {
            responseText = delegated.outcome.response;
            const durationMs = Date.now() - startedAt;
            const completedAt = nowIso();
            const summaryText = deriveSummary(responseText);
            const terminalStatus = delegated.outcome.status;
            const terminalResponse = responseText.trim().length > 0
              ? responseText
              : terminalStatus === "completed"
                ? `Delegated sub-agent ${delegated.subagentId} completed without a response.`
                : `Delegated sub-agent ${delegated.subagentId} ${terminalStatus}.`;
            const persistedArtifacts = persistRunArtifacts({
              status: terminalStatus,
              response: terminalResponse,
              durationMs,
              completedAt,
              testResults: [],
              artifacts: [],
            });

            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: terminalStatus,
                completedAt,
                durationMs,
                usageInput: 0,
                usageOutput: 0,
                artifacts: persistedArtifacts.artifacts,
                responseText: terminalResponse,
                summary: summaryText || undefined,
                artifactDir: persistedArtifacts.artifactDir,
              }),
            );

            if (terminalStatus === "completed") {
              handleTrackedEvent("agent.run.completed", {
                runId,
                durationMs,
                toolCallCount: 0,
                testsPassed: true,
                artifacts: persistedArtifacts.artifacts.map((a) => ({ type: a.type, path: a.path })),
              });

              if (sessionMirror && terminalResponse) {
                try {
                  await sessionMirror(sessionKey, {
                    role: "assistant",
                    content: terminalResponse,
                    contentText: terminalResponse,
                    idempotencyKey: `agent-run:${runId}:response`,
                  });
                } catch (error) {
                  console.warn(
                    `[friday][W-AG-SESSION-MIRROR-001] Failed to mirror assistant response for delegated run ${runId}:`,
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }

              return {
                runId,
                status: "completed",
                response: terminalResponse,
                toolCallCount: 0,
                durationMs,
                usageInput: 0,
                usageOutput: 0,
              };
            }

            if (terminalStatus === "cancelled") {
              handleTrackedEvent("agent.run.cancelled", {
                runId,
                reason: terminalResponse,
              });
            } else {
              handleTrackedEvent("agent.run.failed", {
                runId,
                error: {
                  code: FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
                  message: terminalResponse,
                },
                durationMs,
                routeId: "agent.execute.run.delegated",
                correlationId: delegated.childRunId,
              });
            }

            return {
              runId,
              status: terminalStatus,
              response: terminalResponse,
              toolCallCount: 0,
              durationMs,
              usageInput: 0,
              usageOutput: 0,
            };
          }
        }

        // 3. Add user message (with optional inline images for vision)
        if (params.images && params.images.length > 0) {
          const userContent: FridayAgentContentBlock[] = [
            { type: "text", text: llmTask },
            ...params.images.map((url): FridayAgentImageBlock => ({
              type: "image",
              source: { type: "url", url },
            })),
          ];
          messages.push({ role: "user", content: userContent });
        } else {
          messages.push({ role: "user", content: llmTask });
        }

        // 4. Transition to executing and enter LLM loop
        db.withWriteTransaction((writer) =>
          repo.update(writer, { id: runId, status: "executing" }),
        );

        // ─── Build system prompt dynamically from current tool set ───
        const baseSystemPrompt = systemPromptBuilder
          ? await Promise.resolve(systemPromptBuilder({
            toolNames: [...toolMap.keys()],
            nowIso: runTimeContext.nowIso,
            timezone: runTimeContext.timezone,
            localDate: runTimeContext.localDate,
          }))
          : (staticSystemPrompt ?? "You are an AI assistant.");

        // ─── Enrich system prompt with learned user preferences ───
        let effectiveSystemPrompt = baseSystemPrompt;
        const prefEntries = Object.entries(learnedPreferences);
        if (prefEntries.length > 0) {
          const prefLines = prefEntries.map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
          effectiveSystemPrompt += "\n\nUser preferences (learned from past interactions):\n" + prefLines.join("\n");
        }
        if (communicationPromptBuilder && principalId) {
          try {
            const fragment = communicationPromptBuilder({ userId: principalId, nowIso: nowIso() });
            if (fragment && fragment.trim().length > 0) {
              effectiveSystemPrompt += `\n\n${fragment.trim()}`;
            }
          } catch {
            // Non-fatal: persona enrichment failure should not kill the run
          }
        }

        let iterations = 0;
        let evidenceEnforcementRetries = 0;
        let timelinessEnforcementRetries = 0;
        let answerAlignmentRetries = 0;

        while (iterations < FRIDAY_AGENT_MAX_LOOP_ITERATIONS) {
          if (runAbortController.signal.aborted) {
            break;
          }

          iterations++;

          // Emit executing event per iteration (IMPL-3)
          handleTrackedEvent("agent.run.executing", {
            runId,
            step: iterations,
            description: `LLM turn ${String(iterations)}`,
          });

          const { assistantText, toolUseBlocks, inputTokens, outputTokens, turnMeta } =
            await streamLlmResponse({
              llmClient,
              providerId: requestedProviderId,
              model: requestedModel ?? "default",
              systemPrompt: effectiveSystemPrompt,
              messages,
              tools,
              signal: runAbortController.signal,
              eventEmitter,
              runId,
              emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
            });

          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;

          // Track actual turn metadata (IMPL-2)
          actualTurns.push({
            providerId: turnMeta?.actualProviderId,
            model: turnMeta?.actualModel,
            inputTokens,
            outputTokens,
            costUsd: turnMeta?.costUsd,
          });

          // Record provider usage metrics when execution metadata is available.
          if (usageRecorder && turnMeta?.actualProviderId && turnMeta.actualProviderApi) {
            try {
              await usageRecorder({
                providerId: turnMeta.actualProviderId,
                model: turnMeta.actualModel ?? requestedModel ?? "default",
                providerApi: turnMeta.actualProviderApi,
                inputTokens,
                outputTokens,
                costUsd: turnMeta.costUsd,
              });
            } catch {
              // Non-fatal: usage persistence should not break run execution.
            }
          }

          // Build assistant message content
          const assistantContent: FridayAgentContentBlock[] = [];
          if (assistantText) {
            assistantContent.push({ type: "text", text: assistantText });
          }
          for (const toolUse of toolUseBlocks) {
            assistantContent.push(toolUse);
          }

          messages.push({
            role: "assistant",
            content: assistantContent.length === 1 && assistantContent[0].type === "text"
              ? assistantText
              : assistantContent,
          });

          // 5. If no tool calls, we're done
          if (toolUseBlocks.length === 0) {
            let candidateResponse = enforceToolEvidenceForCompletionClaim(
              assistantText,
              allToolCalls,
            );
            candidateResponse = enforceFeedbackPersistenceEvidence(
              candidateResponse,
              allToolCalls,
            );

            if (
              candidateResponse.trim().length > 0 &&
              evidenceEnforcementRetries < 2 &&
              shouldEnforceToolEvidenceForTask({
                task: params.task,
                responseText: candidateResponse,
                toolMap,
                toolCalls: allToolCalls,
                disabledToolNames,
              })
            ) {
              evidenceEnforcementRetries++;
              const verificationPrompt = buildEvidenceRetryPrompt({
                task: params.task,
                toolMap,
                disabledToolNames,
              });
              messages.push({
                role: "user",
                content: verificationPrompt,
              });
              continue;
            }

            const timelinessDecision = evaluateTimeSensitiveResponse({
              required: timeSensitiveNewsRequested,
              responseText: candidateResponse,
              toolCalls: allToolCalls,
              localDate: runTimeContext.localDate,
              timezone: runTimeContext.timezone,
            });
            if (
              timelinessDecision.retryPrompt &&
              candidateResponse.trim().length > 0 &&
              timelinessEnforcementRetries < 1
            ) {
              timelinessEnforcementRetries++;
              messages.push({
                role: "user",
                content: timelinessDecision.retryPrompt,
              });
              continue;
            }

            const alignedResponse = timelinessDecision.responseText;
            const alignmentDecision = evaluateFridayAnswerAlignment({
              task: params.task,
              responseText: alignedResponse,
              historyMessages: normalizeHistoryMessages(params.historyMessages),
              conversationContext,
            });
            if (
              alignmentDecision.retryPrompt &&
              alignedResponse.trim().length > 0 &&
              answerAlignmentRetries < 1
            ) {
              answerAlignmentRetries++;
              messages.push({
                role: "user",
                content: alignmentDecision.retryPrompt,
              });
              continue;
            }

            responseText = alignedResponse;
            break;
          }

          // 6. Execute tool calls and build tool_result blocks
          const toolResultBlocks: FridayAgentToolResultBlock[] = [];

          for (const toolUse of toolUseBlocks) {
            if (runAbortController.signal.aborted) {
              break;
            }

            if (disabledToolNames.has(toolUse.name)) {
              const blockedResult = {
                content: `Tool '${toolUse.name}' is disabled for this run.`,
                isError: true,
              };
              const blockedRecord: FridayAgentToolCallRecord = {
                toolCallId: toolUse.id,
                toolName: toolUse.name,
                args: toolUse.input,
                result: blockedResult,
                durationMs: 0,
                startedAt: nowIso(),
              };
              allToolCalls.push(blockedRecord);

              handleTrackedEvent("agent.run.tool_start", {
                runId,
                toolName: toolUse.name,
                toolCallId: toolUse.id,
                params: toolUse.input,
              });

              handleTrackedEvent("agent.run.tool_end", {
                runId,
                toolName: toolUse.name,
                toolCallId: toolUse.id,
                durationMs: 0,
                isError: true,
                summary: blockedResult.content.slice(0, 200),
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                routeId: "agent.execute.tool.guard",
                correlationId: runId,
              });

              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: blockedResult.content,
                is_error: true,
              });
              continue;
            }

            if (evaluateRules) {
              const ruleTarget = getRuleTargetForTool(toolUse.name);
              const policyResult = await safeEvaluateRules(evaluateRules, {
                resource: ruleTarget.resource,
                action: ruleTarget.action,
                args: {
                  toolName: toolUse.name,
                  ...toolUse.input,
                },
                source: "agent",
                principalId,
                runId,
                sessionId: sessionKey,
                scopes,
              }, runAbortController.signal);
              if (policyResult && !policyResult.allowed) {
                const message = policyResult.message
                  ?? `Tool '${toolUse.name}' blocked by policy`;
                const blockedResult = {
                  content: message,
                  isError: true,
                };
                const blockedRecord: FridayAgentToolCallRecord = {
                  toolCallId: toolUse.id,
                  toolName: toolUse.name,
                  args: toolUse.input,
                  result: blockedResult,
                  durationMs: 0,
                  startedAt: nowIso(),
                };
                allToolCalls.push(blockedRecord);

                handleTrackedEvent("agent.run.tool_start", {
                  runId,
                  toolName: toolUse.name,
                  toolCallId: toolUse.id,
                  params: toolUse.input,
                });

                handleTrackedEvent("agent.run.tool_end", {
                  runId,
                  toolName: toolUse.name,
                  toolCallId: toolUse.id,
                  durationMs: 0,
                  isError: true,
                  summary: message.slice(0, 200),
                  errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                  routeId: "agent.execute.tool.policy",
                  correlationId: runId,
                });

                toolResultBlocks.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: message,
                  is_error: true,
                });
                continue;
              }
            }

            // IMPL-4: readOnly constraint check
            if (isReadOnly && isMutatingToolCall(toolUse.name, toolUse.input)) {
              const blockedResult = {
                content: `Tool '${toolUse.name}' blocked: run has readOnly constraint`,
                isError: true,
              };
              const blockedRecord: FridayAgentToolCallRecord = {
                toolCallId: toolUse.id,
                toolName: toolUse.name,
                args: toolUse.input,
                result: blockedResult,
                durationMs: 0,
                startedAt: nowIso(),
              };
              allToolCalls.push(blockedRecord);

              handleTrackedEvent("agent.run.tool_start", {
                runId,
                toolName: toolUse.name,
                toolCallId: toolUse.id,
                params: toolUse.input,
              });

              handleTrackedEvent("agent.run.tool_end", {
                runId,
                toolName: toolUse.name,
                toolCallId: toolUse.id,
                durationMs: 0,
                isError: true,
                summary: blockedResult.content.slice(0, 200),
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                routeId: "agent.execute.tool.readonly",
                correlationId: runId,
              });

              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: blockedResult.content,
                is_error: true,
              });
              continue;
            }

            const approvalRequiredReason = getApprovalRequiredReasonForToolCall(toolUse.name, toolUse.input);
            if (approvalRequiredReason) {
              const blockedResult = {
                content: `Tool '${toolUse.name}' blocked pending approval. ${approvalRequiredReason}`,
                isError: true,
              };
              const blockedRecord: FridayAgentToolCallRecord = {
                toolCallId: toolUse.id,
                toolName: toolUse.name,
                args: toolUse.input,
                result: blockedResult,
                durationMs: 0,
                startedAt: nowIso(),
              };
              allToolCalls.push(blockedRecord);

              handleTrackedEvent("agent.run.tool_start", {
                runId,
                toolName: toolUse.name,
                toolCallId: toolUse.id,
                params: toolUse.input,
              });

              handleTrackedEvent("agent.run.tool_end", {
                runId,
                toolName: toolUse.name,
                toolCallId: toolUse.id,
                durationMs: 0,
                isError: true,
                summary: blockedResult.content.slice(0, 200),
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                routeId: "agent.execute.tool.approval_required",
                correlationId: runId,
              });

              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: blockedResult.content,
                is_error: true,
              });
              continue;
            }

            const toolCallRecord = await executeToolCall({
              toolUse,
              toolMap,
              signal: runAbortController.signal,
              runId,
              sessionKey,
              readOnly: isReadOnly,
              timezone: runTimeContext.timezone,
              principalId,
              executionContext,
              nowIso,
              emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
            });

            allToolCalls.push(toolCallRecord);

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: toolCallRecord.result.content,
              is_error: toolCallRecord.result.isError,
            });
          }

          // OC-007: Validate every tool_use has a corresponding tool_result.
          // If execution was interrupted, synthesize error results for missing entries.
          if (toolResultBlocks.length < toolUseBlocks.length) {
            for (let i = toolResultBlocks.length; i < toolUseBlocks.length; i++) {
              const missingUse = toolUseBlocks[i]!;
              const synthesized = {
                content: `Tool result lost for "${missingUse.name}" — execution may have been interrupted.`,
                isError: true,
              };
              allToolCalls.push({
                toolCallId: missingUse.id,
                toolName: missingUse.name,
                args: missingUse.input,
                result: synthesized,
                durationMs: 0,
                startedAt: nowIso(),
              });
              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: missingUse.id,
                content: synthesized.content,
                is_error: true,
              });
            }
          }

          // 7. Add tool results as user message and re-prompt
          messages.push({
            role: "user",
            content: toolResultBlocks,
          });
        }

        // Check if we hit the loop limit
        if (iterations >= FRIDAY_AGENT_MAX_LOOP_ITERATIONS) {
          throw new FridayDomainError(
            FRIDAY_AGENT_ERROR_CODES.LOOP_LIMIT,
            `Agent exceeded maximum loop iterations (${String(FRIDAY_AGENT_MAX_LOOP_ITERATIONS)})`,
            { httpStatus: 500 },
          );
        }

        // Check if we hit the tool call limit
        if (allToolCalls.length >= FRIDAY_AGENT_MAX_TOOL_CALLS) {
          throw new FridayDomainError(
            FRIDAY_AGENT_ERROR_CODES.TOOL_CALL_LIMIT,
            `Agent exceeded maximum tool calls (${String(FRIDAY_AGENT_MAX_TOOL_CALLS)})`,
            { httpStatus: 500 },
          );
        }

        // Check if cancelled
        if (runAbortController.signal.aborted) {
          const durationMs = Date.now() - startedAt;
          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "cancelled",
              completedAt: nowIso(),
              durationMs,
              responseText: responseText || undefined,
            }),
          );

          handleTrackedEvent("agent.run.cancelled", { runId });

          return {
            runId,
            status: "cancelled",
            response: responseText,
            toolCallCount: allToolCalls.length,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
          };
        }

        // ─── Build actual execution metadata (IMPL-2) ───
        const totalCostUsd = actualTurns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
        const lastTurn = actualTurns[actualTurns.length - 1];
        const actualExecution: FridayAgentActualExecution = {
          actualProviderId: lastTurn?.providerId,
          actualModel: lastTurn?.model,
          totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
          turns: actualTurns,
        };
        latestActualExecution = actualExecution;
        latestCostUsd = totalCostUsd > 0 ? totalCostUsd : undefined;

        // ─── IMPL-5: Validation gate (self-test) ───
        let testsPassed = selfTestService ? false : true;
        let testResults: FridayAgentTestResult[] = [];
        const collectedArtifacts: FridayAgentArtifact[] = deriveArtifactsFromToolCalls(allToolCalls);
        latestArtifacts = collectedArtifacts;

        if (selfTestService) {
          // Transition to testing
          db.withWriteTransaction((writer) =>
            repo.update(writer, { id: runId, status: "testing" }),
          );
          currentPhase = "testing";
          emitProgressEvent();

          try {
            testResults = await selfTestService.runTests({
              artifacts: collectedArtifacts,
              workdir,
            });
            testsPassed = testResults.every((t) => t.passed);
          } catch (testError) {
            testsPassed = false;
            testResults = [{
              strategy: "llm_eval" as const,
              passed: false,
              errors: [{
                message: testError instanceof Error ? testError.message : String(testError),
                severity: "error",
              }],
              durationMs: 0,
            }];
          }
          latestTestResults = testResults;

          // Criteria: must have a response
          const hasResponse = responseText.trim().length > 0;

          if (!hasResponse) {
            testsPassed = false;
          }

          if (
            !testsPassed
            && hasSafeDiagnosticCompletionEvidence({
              task: params.task,
              responseText,
              toolCalls: allToolCalls,
            })
          ) {
            testsPassed = true;
          }

          if (!testsPassed) {
            const durationMs = Date.now() - startedAt;
            const summaryText = deriveSummary(responseText);
            const completedAt = nowIso();
            const persistedArtifacts = persistRunArtifacts({
              status: "failed",
              response: responseText || "Validation criteria not met",
              durationMs,
              completedAt,
              testResults,
              artifacts: collectedArtifacts,
              costUsd: latestCostUsd,
            });

            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: "failed",
                completedAt,
                durationMs,
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                errorMessage: "Validation criteria not met",
                usageInput: totalInputTokens,
                usageOutput: totalOutputTokens,
                costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
                actualExecution,
                testResults: testResults as unknown as FridayAgentTestResult[],
                artifacts: persistedArtifacts.artifacts,
                responseText: responseText || undefined,
                summary: summaryText || undefined,
                artifactDir: persistedArtifacts.artifactDir,
              }),
            );

            handleTrackedEvent("agent.run.failed", {
              runId,
              error: {
                code: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                message: "Validation criteria not met",
              },
              durationMs,
              routeId: "agent.execute.run.validation",
              correlationId: runCorrelationId,
            });

            return {
              runId,
              status: "failed",
              response: responseText || "Validation criteria not met",
              toolCallCount: allToolCalls.length,
              durationMs,
              usageInput: totalInputTokens,
              usageOutput: totalOutputTokens,
            };
          }
        }

        const extractedImages = extractImagePathsFromToolCalls(allToolCalls);
        const outputClosureGap = detectOutputClosureGap({
          task: params.task,
          toolCalls: allToolCalls,
          images: extractedImages,
        }) ?? detectEvidenceClosureGap({
          task: params.task,
          responseText,
          toolCalls: allToolCalls,
          toolMap,
          disabledToolNames,
        });

        if (outputClosureGap) {
          const durationMs = Date.now() - startedAt;
          const failureResponse = `${outputClosureGap.userMessage} (${outputClosureGap.errorCode})`;
          const summaryText = deriveSummary(failureResponse);
          const completedAt = nowIso();
          const persistedArtifacts = persistRunArtifacts({
            status: "failed",
            response: failureResponse,
            durationMs,
            completedAt,
            testResults,
            artifacts: collectedArtifacts,
            costUsd: latestCostUsd,
          });

          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "failed",
              completedAt,
              durationMs,
              errorCode: outputClosureGap.errorCode,
              errorMessage: outputClosureGap.developerMessage,
              usageInput: totalInputTokens,
              usageOutput: totalOutputTokens,
              costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
              actualExecution,
              testResults: testResults as unknown as FridayAgentTestResult[],
              artifacts: persistedArtifacts.artifacts,
              responseText: failureResponse,
              summary: summaryText || undefined,
              artifactDir: persistedArtifacts.artifactDir,
            }),
          );

          handleTrackedEvent("agent.run.failed", {
            runId,
            error: {
              code: outputClosureGap.errorCode,
              message: outputClosureGap.developerMessage,
            },
            durationMs,
            outputClosure: {
              attemptedImageToolCalls: outputClosureGap.attemptedImageToolCalls,
              failedImageToolCalls: outputClosureGap.failedImageToolCalls,
            },
            routeId: "agent.execute.run.output_closure",
            correlationId: runCorrelationId,
          });

          return {
            runId,
            status: "failed",
            response: failureResponse,
            toolCallCount: allToolCalls.length,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
          };
        }

        // ─── Derive summary from response (IMPL-6) ───
        const summaryText = deriveSummary(responseText);

        // 8. Finalize — success
        const durationMs = Date.now() - startedAt;
        const completedAt = nowIso();
        const persistedArtifacts = persistRunArtifacts({
          status: "completed",
          response: responseText,
          durationMs,
          completedAt,
          testResults,
          artifacts: collectedArtifacts,
          costUsd: latestCostUsd,
        });
        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "completed",
            completedAt,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
            actualExecution,
            testResults: testResults as unknown as FridayAgentTestResult[],
            artifacts: persistedArtifacts.artifacts,
            responseText: responseText || undefined,
            summary: summaryText || undefined,
            artifactDir: persistedArtifacts.artifactDir,
          }),
        );

        handleTrackedEvent("agent.run.completed", {
          runId,
          durationMs,
          toolCallCount: allToolCalls.length,
          testsPassed,
          artifacts: persistedArtifacts.artifacts.map((a) => ({ type: a.type, path: a.path })),
        });

        // ─── IMPL-6: Session mirror ───
        if (sessionMirror && responseText) {
          try {
            await sessionMirror(sessionKey, {
              role: "assistant",
              content: responseText,
              contentText: responseText,
              idempotencyKey: `agent-run:${runId}:response`,
              toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            });
          } catch (error) {
            // Non-fatal: mirror failure should not kill the run.
            console.warn(
              `[friday][W-AG-SESSION-MIRROR-001] Failed to mirror assistant response for run ${runId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        return {
          runId,
          status: "completed",
          response: responseText,
          toolCallCount: allToolCalls.length,
          durationMs,
          usageInput: totalInputTokens,
          usageOutput: totalOutputTokens,
          images: extractedImages.length > 0 ? extractedImages : undefined,
        };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = error instanceof FridayDomainError
          ? error.code
          : FRIDAY_AGENT_ERROR_CODES.LLM_ERROR;

        const summaryText = deriveSummary(responseText);
        const completedAt = nowIso();
        const persistedArtifacts = persistRunArtifacts({
          status: "failed",
          response: responseText || errorMessage,
          durationMs,
          completedAt,
          testResults: latestTestResults,
          artifacts: latestArtifacts.length > 0 ? latestArtifacts : deriveArtifactsFromToolCalls(allToolCalls),
          costUsd: latestCostUsd,
        });

        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "failed",
            completedAt,
            durationMs,
            errorCode,
            errorMessage,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: latestCostUsd,
            actualExecution: latestActualExecution,
            testResults: latestTestResults,
            artifacts: persistedArtifacts.artifacts,
            responseText: responseText || undefined,
            summary: summaryText || undefined,
            artifactDir: persistedArtifacts.artifactDir,
          }),
        );

        handleTrackedEvent("agent.run.failed", {
          runId,
          error: { code: errorCode, message: errorMessage },
          durationMs,
          routeId: "agent.execute.run.unhandled",
          correlationId: runCorrelationId,
        });

        return {
          runId,
          status: "failed",
          response: responseText || errorMessage,
          toolCallCount: allToolCalls.length,
          durationMs,
          usageInput: totalInputTokens,
          usageOutput: totalOutputTokens,
        };
      } finally {
        clearTimeout(abortTimer);
        params.signal?.removeEventListener("abort", onExternalAbort);
        clearInterval(progressTimer);
        eventEmitter.off("agent.subagent.spawned", onSubagentSpawned);
        eventEmitter.off("agent.subagent.completed", onSubagentCompleted);
        runSeqCounters.delete(runId);
      }
    },
  };
}

function normalizeScopes(scopes: string[] | undefined): string[] | undefined {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return undefined;
  }
  const normalized = scopes
    .filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
    .map((scope) => scope.trim());
  if (normalized.length === 0) {
    return undefined;
  }
  return [...new Set(normalized)];
}

function normalizeToolNameSet(toolNames: string[] | undefined): ReadonlySet<string> {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return new Set<string>();
  }
  const normalized = toolNames
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return new Set<string>(normalized);
}

function withRulesEvaluateScope(scopes: string[] | undefined): string[] {
  const set = new Set<string>(scopes ?? []);
  set.add(RULES_EVALUATE_SCOPE);
  return [...set];
}

function getRuleTargetForTool(
  toolName: string,
): {
  resource: FridayEvaluationContext["resource"];
  action: FridayEvaluationContext["action"];
} {
  if (toolName === "skill_run") {
    return { resource: "skill", action: "execute" };
  }
  if (toolName === "workflow_run") {
    return { resource: "workflow", action: "execute" };
  }
  return { resource: "tool", action: "execute" };
}

async function safeEvaluateRules(
  evaluateRules: (
    context: FridayEvaluationContext,
    signal?: AbortSignal,
  ) => Promise<FridayEvaluationResult>,
  context: FridayEvaluationContext,
  signal?: AbortSignal,
): Promise<FridayEvaluationResult | null> {
  try {
    return await evaluateRules(
      {
        ...context,
        scopes: withRulesEvaluateScope(context.scopes),
      },
      signal,
    );
  } catch {
    return null;
  }
}

function normalizeHistoryMessages(
  historyMessages: FridayAgentMessage[] | undefined,
): FridayAgentMessage[] {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) {
    return [];
  }

  const normalized: FridayAgentMessage[] = [];
  for (const message of historyMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      const content = message.content.trim();
      if (content.length === 0) {
        continue;
      }
      normalized.push({
        role: message.role,
        content,
      });
      continue;
    }

    if (Array.isArray(message.content) && message.content.length > 0) {
      normalized.push({
        role: message.role,
        content: message.content,
      });
    }
  }

  return normalized;
}

function extractImagePathsFromToolCalls(
  toolCalls: FridayAgentToolCallRecord[],
): string[] {
  const images: string[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.result.isError) continue;
    if (call.toolName === "browser" || call.toolName === "canvas") {
      try {
        const parsed = JSON.parse(call.result.content);
        if (typeof parsed.path === "string" && isImageFilePath(parsed.path)) {
          if (!seen.has(parsed.path)) {
            seen.add(parsed.path);
            images.push(parsed.path);
          }
        }
      } catch { /* not JSON or no path */ }
    }
  }
  return images;
}

function isImageFilePath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
    || lower.endsWith(".gif") || lower.endsWith(".webp");
}

interface OutputClosureGap {
  errorCode: string;
  userMessage: string;
  developerMessage: string;
  attemptedImageToolCalls: number;
  failedImageToolCalls: number;
}

const READ_ONLY_DIAGNOSTIC_SKILL_IDS = new Set([
  "repo-health-check",
  "workspace-change-risk-review",
  "release-readiness-check",
  "log-error-triage",
  "local-service-diagnose",
  "incident-brief-generator",
  "system-health-snapshot",
  "review-open-issues",
  "autofix-readiness-review",
  "failed-deploy-recovery-brief",
]);

function normalizeDefaultRouteSentinel(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized === "default") {
    return undefined;
  }
  return normalized;
}

function hasSafeDiagnosticCompletionEvidence(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): boolean {
  if (params.responseText.trim().length === 0) {
    return false;
  }

  return params.toolCalls.some((call) => {
    if (call.result.isError) {
      return false;
    }
    if (call.toolName === "skill_run") {
      const skillId = typeof call.args.skillId === "string" ? call.args.skillId : "";
      return READ_ONLY_DIAGNOSTIC_SKILL_IDS.has(skillId);
    }
    if (call.toolName === "system") {
      return call.args.action === "snapshot";
    }
    if (call.toolName === "skills_list") {
      return true;
    }
    return false;
  });
}

function detectOutputClosureGap(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
  images: string[];
}): OutputClosureGap | null {
  if (params.images.length > 0) return null;

  const imageArtifactCalls = params.toolCalls.filter(isImageArtifactCall);
  if (imageArtifactCalls.length === 0) return null;

  const failedImageCalls = imageArtifactCalls.filter((call) => call.result.isError);
  const failedCount = failedImageCalls.length;
  const attemptedCount = imageArtifactCalls.length;

  // Only enforce hard failure for explicit screenshot artifact routes.
  const requestedScreenshot = imageArtifactCalls.some((call) => isBrowserScreenshotCall(call.args));
  if (!requestedScreenshot) return null;

  const latestFailure = failedImageCalls[failedImageCalls.length - 1];
  const failureDetail = latestFailure?.result.content
    ? latestFailure.result.content.replace(/\s+/g, " ").trim()
    : "unknown screenshot tool failure";

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Output delivery failed: screenshot artifact was not produced. " +
      "Please retry after browser runtime is available.",
    developerMessage:
      `Screenshot closure failed for task "${params.task.slice(0, 120)}": ` +
      `${String(attemptedCount)} screenshot tool call(s), ${String(failedCount)} failed, ` +
      "0 image artifact paths extracted. " +
      `Last failure: ${failureDetail}`,
    attemptedImageToolCalls: attemptedCount,
    failedImageToolCalls: failedCount,
  };
}

function detectEvidenceClosureGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
  toolMap: Map<string, FridayAgentToolDefinition>;
  disabledToolNames?: ReadonlySet<string>;
}): OutputClosureGap | null {
  const normalizedTask = params.task.trim();
  if (normalizedTask.length === 0) return null;

  const category = classifyEvidenceTask(normalizedTask);
  if (!category) return null;

  const hasAttemptedEvidenceTool = params.toolCalls.some((call) => {
    if (category === "desktop") {
      return call.toolName === "system"
        || call.toolName === "desktop"
        || call.toolName === "exec"
        || call.toolName === "read"
        || call.toolName === "browser";
    }
    return call.toolName === "web_fetch"
      || call.toolName === "web_search"
      || call.toolName === "browser";
  });

  if (
    !hasAttemptedEvidenceTool
    && !hasEvidenceCapableTools(params.toolMap, params.disabledToolNames, category)
  ) {
    return null;
  }

  if (hasSuccessfulToolEvidence(params.toolCalls)) return null;

  if (category === "web" && !taskLooksLikeExternalAction(normalizedTask)) {
    return null;
  }

  const failedCalls = params.toolCalls.filter((call) => call.result.isError);
  const latestFailure = failedCalls[failedCalls.length - 1];
  const failureDetail = latestFailure?.result.content
    ? latestFailure.result.content.replace(/\s+/g, " ").trim()
    : "LLM produced no successful evidence-capable tool result";
  const attemptedCount = params.toolCalls.length;
  const failedCount = failedCalls.length;
  const responseSummary = params.responseText.trim().slice(0, 200);

  if (category === "desktop") {
    const desktopUnavailable = hasDesktopRuntimeUnavailableFailure(params.toolCalls);
    const userMessage = desktopUnavailable
      ? "Desktop or system orchestration runtime is not enabled. Set FRIDAY_SYSTEM_ENABLED=true and/or FRIDAY_DESKTOP_ENABLED=true, then restart Friday."
      : "Desktop action could not be completed with verifiable output. " +
        "Retry after checking desktop permissions, then provide selector details only if needed.";

    return {
      errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
      userMessage,
      developerMessage:
        `Desktop evidence closure failed for task "${normalizedTask.slice(0, 120)}": ` +
        `${String(attemptedCount)} tool call(s), ${String(failedCount)} failed, no successful evidence. ` +
        `Last failure: ${failureDetail}. Final response: ${responseSummary}`,
      attemptedImageToolCalls: attemptedCount,
      failedImageToolCalls: failedCount,
    };
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "External task could not be completed with verifiable tool output. " +
      "Please retry after checking network/tool availability.",
    developerMessage:
      `Evidence closure failed for web task "${normalizedTask.slice(0, 120)}": ` +
      `${String(attemptedCount)} tool call(s), ${String(failedCount)} failed, no successful evidence. ` +
      `Last failure: ${failureDetail}. Final response: ${responseSummary}`,
    attemptedImageToolCalls: attemptedCount,
    failedImageToolCalls: failedCount,
  };
}

function isImageArtifactCall(call: FridayAgentToolCallRecord): boolean {
  if (call.toolName === "browser") {
    return isBrowserScreenshotCall(call.args);
  }
  // Canvas may emit images too; keep this broad for future closure coverage.
  if (call.toolName === "canvas") {
    return true;
  }
  return false;
}

function isBrowserScreenshotCall(args: Record<string, unknown>): boolean {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return action === "screenshot";
}

function enforceToolEvidenceForCompletionClaim(
  responseText: string,
  toolCalls: FridayAgentToolCallRecord[],
): string {
  const normalized = responseText.trim();
  if (normalized.length === 0) return responseText;
  if (hasSuccessfulToolEvidence(toolCalls)) return responseText;
  if (!appearsToClaimCompletedExternalAction(normalized)) return responseText;
  return `${normalized}\n\n` +
    "Note: no successful tool call evidence was recorded in this run, so this completion claim is unverified.";
}

function enforceFeedbackPersistenceEvidence(
  responseText: string,
  toolCalls: FridayAgentToolCallRecord[],
): string {
  const normalized = responseText.trim();
  if (normalized.length === 0) return responseText;
  if (!appearsToClaimFeedbackRecorded(normalized)) return responseText;
  if (hasFeedbackPersistenceEvidence(toolCalls)) return responseText;
  return `${normalized}\n\n` +
    "Note: feedback persistence was claimed, but no successful feedback/memory_store tool evidence was recorded in this run.";
}

function hasSuccessfulToolEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  for (const call of toolCalls) {
    if (!call.result.isError) {
      return true;
    }
  }
  return false;
}

function hasFeedbackPersistenceEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  for (const call of toolCalls) {
    if (call.result.isError) continue;
    if (call.toolName === "feedback" || call.toolName === "memory_store") {
      return true;
    }
  }
  return false;
}

function appearsToClaimCompletedExternalAction(text: string): boolean {
  const englishCompletionClaim =
    /\b(i|we)\s+(have|has|'ve)?\s*(already|just|successfully)?\s*(opened|sent|deleted|updated|created|installed|launched|executed|completed|finished)\b/i;
  const englishDirectClaim =
    /\b(successfully|done|completed)\b.*\b(opened|sent|deleted|updated|created|installed|launched|executed)\b/i;
  const chineseCompletionClaim =
    /(我|我们).{0,10}(已|已经|成功|刚刚).{0,8}(打开|发送|删除|更新|创建|安装|启动|执行|完成|处理|修复)/;
  const chineseDirectClaim =
    /(已|已经|成功|完成).{0,8}(打开|发送|删除|更新|创建|安装|启动|执行|处理|修复)/;
  return (
    englishCompletionClaim.test(text)
    || englishDirectClaim.test(text)
    || chineseCompletionClaim.test(text)
    || chineseDirectClaim.test(text)
  );
}

function appearsToClaimFeedbackRecorded(text: string): boolean {
  const englishRecorded =
    /\b(i|we)\s+(have|has|'ve|will|'ll)?\s*(recorded|saved|stored|remembered|log(?:ged)?)\b/i;
  const englishFeedbackPhrase =
    /\b(feedback|preference|correction|memory)\b.{0,20}\b(recorded|saved|stored|remembered)\b/i;
  const chineseRecorded =
    /(我|我们).{0,8}(已|已经|会|将|刚刚).{0,10}(记录|保存|记住|写入|收录).{0,8}(反馈|偏好|意见|记忆)?/;
  return (
    englishRecorded.test(text)
    || englishFeedbackPhrase.test(text)
    || chineseRecorded.test(text)
  );
}

function shouldEnforceToolEvidenceForTask(params: {
  task: string;
  responseText: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  toolCalls: FridayAgentToolCallRecord[];
  disabledToolNames?: ReadonlySet<string>;
}): boolean {
  const { task, responseText, toolMap, toolCalls, disabledToolNames } = params;
  if (hasSuccessfulToolEvidence(toolCalls)) return false;

  const normalizedTask = task.trim();
  if (normalizedTask.length === 0) return false;
  const taskCategory = classifyEvidenceTask(normalizedTask);
  if (toolCalls.length > 0) {
    // If a desktop route attempted tools but all failed, force one more
    // evidence-oriented retry instead of silently accepting the failure text.
    const allFailed = toolCalls.every((call) => call.result.isError);
    if (allFailed && taskCategory === "desktop") {
      // Do not force another LLM/tool round when desktop runtime is explicitly
      // unavailable; this failure is non-recoverable without enablement changes.
      if (hasDesktopRuntimeUnavailableFailure(toolCalls)) {
        return false;
      }
      return hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
    }
    return false;
  }

  if (taskCategory) {
    return hasEvidenceCapableTools(toolMap, disabledToolNames, taskCategory);
  }

  if (!appearsToClaimCompletedExternalAction(responseText)) {
    return false;
  }

  return hasEvidenceCapableTools(toolMap, disabledToolNames, "web")
    || hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
}

function hasDesktopRuntimeUnavailableFailure(
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  return toolCalls.some((call) =>
    call.result.isError === true
      && (call.toolName === "desktop" || call.toolName === "system")
      && typeof call.result.content === "string"
      && (
        call.result.content.includes(FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE)
        || call.result.content.includes(FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE)
      )
  );
}

function hasEvidenceCapableTools(
  toolMap: Map<string, FridayAgentToolDefinition>,
  disabledToolNames?: ReadonlySet<string>,
  category: "web" | "desktop" = "web",
): boolean {
  const isEnabled = (name: string) => !(disabledToolNames?.has(name) ?? false);
  if (category === "desktop") {
    return (
      (toolMap.has("system") && isEnabled("system"))
      || (toolMap.has("desktop") && isEnabled("desktop"))
      || (toolMap.has("exec") && isEnabled("exec"))
      || (toolMap.has("read") && isEnabled("read"))
      || (toolMap.has("browser") && isEnabled("browser"))
    );
  }
  return (
    (toolMap.has("web_fetch") && isEnabled("web_fetch"))
    || (toolMap.has("web_search") && isEnabled("web_search"))
    || (toolMap.has("browser") && isEnabled("browser"))
  );
}

function taskLooksLikeExternalAction(task: string): boolean {
  if (/https?:\/\/\S+/i.test(task)) return true;
  const english =
    /\b(open|visit|browse|search|lookup|check|watch|summari[sz]e|fetch|download|website|youtube|reddit|news|tweet|url|link)\b/i;
  const chinese =
    /(打开|访问|浏览|搜索|查找|查看|抓取|总结|概括|视频|网页|网站|链接|新闻|油管|YouTube)/;
  return english.test(task) || chinese.test(task);
}

function taskLooksLikeDesktopAction(task: string): boolean {
  const english =
    /\b(desktop|screen|screenshot|monitor|display|window|computer|device|mouse|keyboard|local machine)\b/i;
  const chinese =
    /(桌面|屏幕|截图|设备|电脑|本机|本地界面|鼠标|键盘)/;
  return english.test(task) || chinese.test(task);
}

function classifyEvidenceTask(task: string): "web" | "desktop" | null {
  if (taskLooksLikeDesktopAction(task)) return "desktop";
  if (taskLooksLikeExternalAction(task)) return "web";
  return null;
}

function buildEvidenceRetryPrompt(params: {
  task: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  disabledToolNames?: ReadonlySet<string>;
}): string {
  const category = classifyEvidenceTask(params.task.trim()) ?? "web";
  const isEnabled = (name: string) => !(params.disabledToolNames?.has(name) ?? false);
  const preferredTools = category === "desktop"
    ? ["system", "desktop", "exec", "read", "browser"]
    : ["web_fetch", "web_search", "browser"];
  const enabledPreferred = preferredTools.filter((name) => params.toolMap.has(name) && isEnabled(name));
  const toolHint = enabledPreferred.length > 0 ? enabledPreferred.join("/") : "available tools";
  const taskLabel = category === "desktop" ? "this local desktop/device task" : "this external task";
  const approachHint = category === "desktop"
    ? "Start with system snapshot, then use system intents before falling back to desktop session_info or desktop screenshot for visible evidence."
    : "Use web tools to gather evidence before concluding.";

  return (
    `System verification: your previous reply has no successful tool evidence for ${taskLabel}. ` +
    `You must use available tools (${toolHint}) and provide an evidence-backed answer. ` +
    `${approachHint} If all attempts fail, report exact tool errors and what you retried.`
  );
}

interface RunTimeContext {
  nowIso: string;
  timezone: string;
  localDate: string;
}

interface TimeSensitiveResponseDecision {
  responseText: string;
  retryPrompt?: string;
}

interface TimeSensitiveEvidenceSummary {
  latestnessVerified: boolean;
  warnings: string[];
}

interface TimeSensitiveResponseCoverage {
  satisfied: boolean;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}

function buildRunTimeContext(
  now: string,
  requestedTimezone: string | undefined,
  preferredTimezone: string | undefined,
): RunTimeContext {
  const timezone = resolveAgentTimezone(requestedTimezone, preferredTimezone);
  return {
    nowIso: now,
    timezone,
    localDate: formatDateInTimezone(now, timezone),
  };
}

function resolveAgentTimezone(
  requestedTimezone: string | undefined,
  preferredTimezone: string | undefined,
): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const candidates = [
    normalizeIanaTimezone(requestedTimezone),
    normalizeIanaTimezone(preferredTimezone),
    normalizeIanaTimezone(typeof fallback === "string" ? fallback : undefined),
    "UTC",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    return candidate;
  }
  return "UTC";
}

function normalizeIanaTimezone(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const timezone = value.trim();
  if (timezone.length === 0) return undefined;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return undefined;
  }
}

function readPreferredTimezone(preferences: Record<string, unknown>): string | undefined {
  const preferredTimezone = preferences["pref:timezone"];
  return typeof preferredTimezone === "string"
    ? normalizeIanaTimezone(preferredTimezone)
    : undefined;
}

function formatDateInTimezone(nowIso: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(nowIso));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function hasTimeSensitiveNewsIntent(
  task: string,
  historyMessages: FridayAgentMessage[],
): boolean {
  if (textHasTimeSensitiveNewsIntent(task)) {
    return true;
  }

  const recentUserMessages = historyMessages
    .filter((message) => message.role === "user")
    .slice(-3);
  return recentUserMessages.some((message) => textHasTimeSensitiveNewsIntent(extractMessageText(message)));
}

function textHasTimeSensitiveNewsIntent(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const newsTopicWords =
    /\b(news|headline|headlines|article|articles|report|reports|story|stories)\b/i;
  const timelinessWords =
    /\b(latest|current|today'?s|recent|newest|breaking)\b/i;
  const capabilityWords =
    /\b(capabilities?|what can\b|can (?:friday|you)\b.*\bdo\b|runtime facts?|deployment|enabled|disabled|connected|read[- ]?only|desktop companion|provider mutations?|mcp)\b/i;
  const chineseNewsTopicWords =
    /(新闻|头条|报道|文章|快讯|消息)/;
  const chineseTimelinessWords =
    /(最新|当前|目前|今天|最近|快讯)/;
  const chineseCapabilityWords =
    /(能力|能做什么|运行时|部署|启用|禁用|连接|只读|桌面伴侣|提供者修改|MCP)/;
  if (!newsTopicWords.test(normalized) && !chineseNewsTopicWords.test(normalized)) {
    if (capabilityWords.test(normalized) || chineseCapabilityWords.test(normalized)) {
      return false;
    }
  }
  return (
    (timelinessWords.test(normalized) && newsTopicWords.test(normalized))
    || (chineseTimelinessWords.test(normalized) && chineseNewsTopicWords.test(normalized))
  );
}

function evaluateTimeSensitiveResponse(params: {
  required: boolean;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
  localDate: string;
  timezone: string;
}): TimeSensitiveResponseDecision {
  if (!params.required) {
    return { responseText: params.responseText };
  }

  const normalized = params.responseText.trim();
  const explicitCaveat = responseAcknowledgesTimelinessUnverified(
    normalized,
    params.localDate,
    params.timezone,
  );
  const coverage = evaluateTimeSensitiveResponseCoverage(normalized);
  const evidence = summarizeTimeSensitiveEvidence(params.toolCalls);

  if (evidence.latestnessVerified && coverage.satisfied) {
    return { responseText: params.responseText };
  }

  if (explicitCaveat) {
    return { responseText: params.responseText };
  }

  const caveatedResponse = appendTimelinessCaveat({
    responseText: params.responseText,
    localDate: params.localDate,
    timezone: params.timezone,
    evidence,
    missingAbsoluteDate: coverage.missingAbsoluteDate,
    missingDirectUrl: coverage.missingDirectUrl,
    coverageWarning: coverage.coverageWarning,
  });

  return {
    responseText: caveatedResponse,
    retryPrompt: buildTimelinessRetryPrompt({
      localDate: params.localDate,
      timezone: params.timezone,
      evidence,
      missingAbsoluteDate: coverage.missingAbsoluteDate,
      missingDirectUrl: coverage.missingDirectUrl,
      coverageWarning: coverage.coverageWarning,
    }),
  };
}

function summarizeTimeSensitiveEvidence(
  toolCalls: FridayAgentToolCallRecord[],
): TimeSensitiveEvidenceSummary {
  let latestnessVerified = false;
  const warnings = new Set<string>();

  for (const call of toolCalls) {
    if (call.result.isError) continue;

    if (call.toolName === "web_search") {
      const metadata = readWebSearchMetadata(call.result);
      if (metadata?.warning) {
        warnings.add(metadata.warning);
      }
      if (metadata?.freshnessApplied && metadata?.hasDates) {
        latestnessVerified = true;
      }
      continue;
    }
  }

  return {
    latestnessVerified,
    warnings: [...warnings],
  };
}

function readWebSearchMetadata(
  result: FridayAgentToolResult,
): {
  provider?: string;
  freshnessApplied?: boolean;
  hasDates?: boolean;
  warning?: string | null;
} | null {
  const raw = result.metadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as {
    provider?: string;
    freshnessApplied?: boolean;
    hasDates?: boolean;
    warning?: string | null;
  };
}

function appendTimelinessCaveat(params: {
  responseText: string;
  localDate: string;
  timezone: string;
  evidence: TimeSensitiveEvidenceSummary;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}): string {
  const reasons: string[] = [];
  if (!params.evidence.latestnessVerified) {
    reasons.push("the available tool evidence did not verify both recency filtering and publication dates");
  }
  if (params.missingAbsoluteDate) {
    reasons.push("the response omits absolute publication dates");
  }
  if (params.missingDirectUrl) {
    reasons.push("the response omits direct source URLs");
  }
  if (params.coverageWarning) {
    reasons.push(params.coverageWarning);
  }
  for (const warning of params.evidence.warnings) {
    reasons.push(warning);
  }
  const reasonText = reasons.length > 0
    ? reasons.join("; ")
    : "the available evidence is insufficient";
  const caveat =
    `Caveat: I could not verify that these are the latest results as of ${params.localDate} (${params.timezone}) because ${reasonText}. ` +
    "Treat the items above as unverified search results, not confirmed latest news.";
  return params.responseText.trim().length > 0
    ? `${params.responseText.trim()}\n\n${caveat}`
    : caveat;
}

function buildTimelinessRetryPrompt(params: {
  localDate: string;
  timezone: string;
  evidence: TimeSensitiveEvidenceSummary;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}): string {
  const gaps: string[] = [];
  if (!params.evidence.latestnessVerified) {
    gaps.push("your tool evidence did not verify recency plus publication dates");
  }
  if (params.missingAbsoluteDate) {
    gaps.push("your answer is missing absolute publication dates");
  }
  if (params.missingDirectUrl) {
    gaps.push("your answer is missing direct source URLs");
  }
  if (params.coverageWarning) {
    gaps.push(params.coverageWarning);
  }
  const warningText = params.evidence.warnings.length > 0
    ? ` Tool warnings: ${params.evidence.warnings.join(" ")}`
    : "";
  return (
    `System verification: this is a time-sensitive latest/news request. ${gaps.join("; ")}.` +
    ` Use tool evidence to either (1) provide the answer with absolute publication dates and direct source URLs for each item,` +
    ` or (2) explicitly say you cannot verify the latestness as of ${params.localDate} (${params.timezone}).${warningText}`
  );
}

function responseContainsAbsoluteDate(text: string): boolean {
  if (text.trim().length === 0) return false;
  return (
    /\b\d{4}-\d{2}-\d{2}\b/.test(text)
    || /\b\d{4}\/\d{1,2}\/\d{1,2}\b/.test(text)
    || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i.test(text)
    || /\b\d{4}年\d{1,2}月\d{1,2}日\b/.test(text)
  );
}

function responseContainsDirectUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

function evaluateTimeSensitiveResponseCoverage(text: string): TimeSensitiveResponseCoverage {
  const hasAbsoluteDate = responseContainsAbsoluteDate(text);
  const hasDirectUrl = responseContainsDirectUrl(text);
  const items = extractStructuredListItems(text);

  if (items.length >= 2) {
    const missingItemDate = items.some((item) => !responseContainsAbsoluteDate(item));
    const missingItemUrl = items.some((item) => !responseContainsDirectUrl(item));
    return {
      satisfied: !missingItemDate && !missingItemUrl,
      missingAbsoluteDate: missingItemDate,
      missingDirectUrl: missingItemUrl,
      coverageWarning: missingItemDate || missingItemUrl
        ? "not every listed item includes its own absolute publication date and direct source URL"
        : undefined,
    };
  }

  if (responseClaimsMultipleItems(text)) {
    return {
      satisfied: false,
      missingAbsoluteDate: !hasAbsoluteDate,
      missingDirectUrl: !hasDirectUrl,
      coverageWarning: "the response claims multiple items but does not structure them item-by-item",
    };
  }

  return {
    satisfied: hasAbsoluteDate && hasDirectUrl,
    missingAbsoluteDate: !hasAbsoluteDate,
    missingDirectUrl: !hasDirectUrl,
  };
}

function extractStructuredListItems(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const items: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const markerLine = line.replace(/\*\*/g, "").trim();
    if (/^(?:\d+[\.\)\u3001]|[-*•])\s+/.test(markerLine)) {
      if (current.length > 0) {
        items.push(current.join("\n"));
      }
      current = [line];
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    items.push(current.join("\n"));
  }

  return items.length >= 2 ? items : [];
}

function responseClaimsMultipleItems(text: string): boolean {
  return (
    /\b(?:2|3|4|5|two|three|four|five|several)\b.{0,20}\b(?:items?|results?|articles?|stories|news|headlines)\b/i.test(text)
    || /(两条|两则|二条|二则|三条|三则|四条|四则|五条|五则).{0,12}(新闻|结果|报道|消息)/.test(text)
  );
}

function responseAcknowledgesTimelinessUnverified(
  text: string,
  localDate: string,
  timezone: string,
): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const acknowledgesLatestness = (
    /\b(cannot|could not|can't|unable to)\b.{0,40}\b(verify|confirm)\b.{0,40}\b(latest|latestness|current|today)\b/i.test(normalized)
    || /\b(latest|latestness)\b.{0,40}\b(unverified|not verified|could not be verified)\b/i.test(normalized)
    || /(无法|不能|未能).{0,20}(验证|确认).{0,20}(最新|截至|今天)/.test(normalized)
    || /(最新|截至今天).{0,20}(未验证|无法确认|不能确认)/.test(normalized)
  );
  return acknowledgesLatestness
    && normalized.includes(localDate)
    && normalized.includes(timezone);
}

function extractMessageText(message: FridayAgentMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((block): block is Extract<FridayAgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ─── Summary derivation helper ───

function deriveSummary(responseText: string, maxLen = 200): string | undefined {
  if (!responseText || responseText.trim().length === 0) return undefined;
  const firstLine = responseText.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}

// ─── LLM streaming helper ───

interface StreamLlmResponseParams {
  llmClient: CreateFridayAgentRuntimeDeps["llmClient"];
  providerId?: string;
  model: string;
  systemPrompt: string;
  messages: FridayAgentMessage[];
  tools: FridayAgentToolDefinition[];
  signal: AbortSignal;
  eventEmitter: CreateFridayAgentRuntimeDeps["eventEmitter"];
  runId: string;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
}

interface TurnMeta {
  actualProviderId?: string;
  actualModel?: string;
  actualProviderKind?: string;
  actualProviderApi?: string;
  costUsd?: number;
}

interface StreamLlmResponseResult {
  assistantText: string;
  toolUseBlocks: FridayAgentToolUseBlock[];
  inputTokens: number;
  outputTokens: number;
  turnMeta?: TurnMeta;
}

interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

async function streamLlmResponse(
  params: StreamLlmResponseParams,
): Promise<StreamLlmResponseResult> {
  let assistantText = "";
  const toolUseBlocks: FridayAgentToolUseBlock[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turnMeta: TurnMeta | undefined;

  const stream = params.llmClient.stream({
    providerId: params.providerId,
    model: params.model,
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    tools: params.tools,
    signal: params.signal,
  });

  for await (const event of stream as AsyncIterable<FridayAgentLlmStreamEvent>) {
    switch (event.type) {
      case "text_delta":
        assistantText += event.text;
        params.emitRunEvent("agent.run.text_delta", {
          runId: params.runId,
          delta: event.text,
        });
        break;

      case "tool_use":
        toolUseBlocks.push({
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;

      case "message_end":
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        // Capture actual execution metadata (IMPL-2)
        if (event.actualProviderId || event.actualModel || event.costUsd !== undefined) {
          turnMeta = {
            actualProviderId: event.actualProviderId,
            actualModel: event.actualModel,
            actualProviderKind: event.actualProviderKind,
            actualProviderApi: event.actualProviderApi,
            costUsd: event.costUsd,
          };
        }
        break;
    }
  }

  // Some local models emit pseudo function-call JSON as plain text instead of
  // structured tool_use blocks. Recover these calls so the runtime can execute
  // tools instead of returning raw JSON to users.
  if (toolUseBlocks.length === 0 && assistantText.trim().length > 0) {
    const recovered = recoverToolCallsFromAssistantText(assistantText, params.tools);
    if (recovered.length > 0) {
      for (const call of recovered) {
        toolUseBlocks.push({
          type: "tool_use",
          id: call.id ?? `text-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: call.name,
          input: call.input,
        });
      }
      assistantText = "";
    }
  }

  return { assistantText, toolUseBlocks, inputTokens, outputTokens, turnMeta };
}

function recoverToolCallsFromAssistantText(
  assistantText: string,
  tools: FridayAgentToolDefinition[],
): ParsedTextToolCall[] {
  const validToolNames = new Set(tools.map((t) => t.name));
  if (validToolNames.size === 0) return [];

  const normalized = assistantText.trim();
  if (normalized.length === 0) return [];

  const candidates = new Set<string>([normalized]);
  const fenced = unwrapJsonCodeFence(normalized);
  if (fenced) candidates.add(fenced);
  for (const block of extractJsonCodeBlocks(normalized)) {
    candidates.add(block);
  }

  for (const candidate of candidates) {
    if (!looksLikeJson(candidate)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) {
      const calls = parsed
        .map((item) => parseTextToolCall(item, validToolNames))
        .filter((item): item is ParsedTextToolCall => item !== null);
      if (calls.length > 0) return calls;
      continue;
    }

    const single = parseTextToolCall(parsed, validToolNames);
    if (single) return [single];
  }

  return [];
}

function parseTextToolCall(
  value: unknown,
  validToolNames: Set<string>,
): ParsedTextToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name || !validToolNames.has(name)) return null;

  const rawArgs =
    obj.arguments ?? obj.args ?? obj.input;
  const args = normalizeToolCallArgs(rawArgs);
  if (!args) return null;

  const id = typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : undefined;
  return { name, input: args, id };
}

function normalizeToolCallArgs(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    if (!looksLikeJson(trimmed)) return { _raw: value };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw: value };
    } catch {
      return { _raw: value };
    }
  }
  return null;
}

function unwrapJsonCodeFence(value: string): string | null {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match?.[1]?.trim() || null;
}

function extractJsonCodeBlocks(value: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (const match of value.matchAll(regex)) {
    const content = match[1]?.trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

// ─── Artifact derivation from tool calls ───

function deriveArtifactsFromToolCalls(
  toolCalls: FridayAgentToolCallRecord[],
): FridayAgentArtifact[] {
  const artifacts: FridayAgentArtifact[] = [];
  const seen = new Set<string>();

  const add = (artifact: FridayAgentArtifact) => {
    const key = JSON.stringify(artifact);
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push(artifact);
  };

  for (const call of toolCalls) {
    if (call.result.isError) continue;

    if (call.toolName === "write" || call.toolName === "edit") {
      const filePath = typeof call.args.path === "string" ? call.args.path : undefined;
      if (filePath) add({ type: "file", path: filePath });
      continue;
    }

    if (call.toolName === "skill_run") {
      const skillId = typeof call.args.skillId === "string" ? call.args.skillId : undefined;
      if (skillId) add({ type: "skill", skillId });
      continue;
    }

    if (call.toolName === "workflow_run") {
      const workflowId = typeof call.args.workflowId === "string" ? call.args.workflowId : undefined;
      if (workflowId) add({ type: "workflow", workflowId });
      continue;
    }
  }

  return artifacts;
}

// ─── Tool execution helper ───

interface ExecuteToolCallParams {
  toolUse: FridayAgentToolUseBlock;
  toolMap: Map<string, FridayAgentToolDefinition>;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  readOnly: boolean;
  timezone?: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  nowIso: () => string;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
}

function augmentToolArgsForRuntime(params: {
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
}): Record<string, unknown> {
  if (params.toolName === "memory_search" || params.toolName === "memory_store") {
    return { ...params.input, __sessionId: params.sessionKey };
  }
  if (params.toolName === "feedback") {
    return { ...params.input, __principalId: params.principalId };
  }
  if (params.toolName === "browser") {
    return {
      ...params.input,
      ...(params.executionContext?.browserPresentationMode
        ? { __browserPresentationMode: params.executionContext.browserPresentationMode }
        : {}),
      ...(params.executionContext?.surface
        ? { __browserExecutionSource: params.executionContext.surface }
        : {}),
      ...(typeof params.executionContext?.interactive === "boolean"
        ? { __browserInteractive: params.executionContext.interactive }
        : {}),
    };
  }
  return params.input;
}

function readBrowserPresentationPayload(
  result: FridayAgentToolResult,
): Record<string, unknown> | null {
  const raw = result.metadata?.browserPresentation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function deriveToolEventSummary(result: FridayAgentToolResult): string {
  const browserPayload = readBrowserPresentationPayload(result);
  const browserSummary = typeof browserPayload?.presentationSummary === "string"
    ? browserPayload.presentationSummary.trim()
    : "";
  if (browserSummary.length > 0) {
    return browserSummary.slice(0, 200);
  }
  return result.content.slice(0, 200);
}

function buildToolEndEventPayload(params: {
  runId: string;
  toolName: string;
  toolCallId: string;
  durationMs: number;
  result: FridayAgentToolResult;
  routeId: string;
  correlationId: string;
}): Record<string, unknown> {
  const browserPayload = readBrowserPresentationPayload(params.result);
  return {
    runId: params.runId,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    durationMs: params.durationMs,
    isError: params.result.isError ?? false,
    summary: deriveToolEventSummary(params.result),
    ...(params.result.isError
      ? { errorCode: params.result.errorCode ?? FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR }
      : {}),
    routeId: params.result.routeId ?? params.routeId,
    correlationId: params.result.correlationId ?? params.correlationId,
    ...(typeof browserPayload?.presentationMode === "string"
      ? { presentationMode: browserPayload.presentationMode }
      : {}),
    ...(typeof browserPayload?.targetBrowser === "string"
      ? { targetBrowser: browserPayload.targetBrowser }
      : {}),
    ...(typeof browserPayload?.browserTarget === "string"
      ? { browserTarget: browserPayload.browserTarget }
      : typeof browserPayload?.targetBrowser === "string"
        ? { browserTarget: browserPayload.targetBrowser }
        : {}),
    ...(typeof browserPayload?.sessionId === "string"
      ? { sessionId: browserPayload.sessionId }
      : {}),
    ...(typeof browserPayload?.tabId === "string"
      ? { tabId: browserPayload.tabId }
      : {}),
    ...(typeof browserPayload?.fallbackReason === "string"
      ? { fallbackReason: browserPayload.fallbackReason }
      : {}),
  };
}

async function executeToolCall(
  params: ExecuteToolCallParams,
): Promise<FridayAgentToolCallRecord> {
  const { toolUse, toolMap, signal, runId, sessionKey, nowIso, emitRunEvent } = params;
  const routeId = "agent.execute.tool";
  const correlationId = runId;
  const startedAt = Date.now();
  const toolArgs = augmentToolArgsForRuntime({
    toolName: toolUse.name,
    input: toolUse.input,
    sessionKey,
    principalId: params.principalId,
    executionContext: params.executionContext,
  });

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: toolUse.name,
    toolCallId: toolUse.id,
    params: toolUse.input,
  });

  const tool = toolMap.get(toolUse.name);
  if (!tool) {
    const unavailableMessage = buildUnavailableToolMessage(toolUse.name);
    const result = {
      content: unavailableMessage,
      isError: true,
    };
    const durationMs = Date.now() - startedAt;

    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      isError: true,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  }

  // Create a timeout signal for the tool call
  const toolAbortController = new AbortController();
  const toolTimer = setTimeout(() => {
    toolAbortController.abort(new Error("Tool call timed out"));
  }, FRIDAY_AGENT_TOOL_TIMEOUT_MS);

  // Wire run signal to tool signal
  const onRunAbort = () => {
    toolAbortController.abort(signal.reason);
  };
  if (signal.aborted) {
    toolAbortController.abort(signal.reason);
  } else {
    signal.addEventListener("abort", onRunAbort, { once: true });
  }

  try {
    const toolSignal = attachFridayAgentToolExecutionContext(toolAbortController.signal, {
      runId,
      sessionKey,
      readOnly: params.readOnly,
      timezone: params.timezone,
    });
    const rawResult = await tool.execute(toolArgs, toolSignal);
    const durationMs = Date.now() - startedAt;

    // OC-007: Cap oversized tool result content to prevent context bloat
    let result = capToolResultContent(rawResult, FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS);
    if (result.isError) {
      result = await maybeRecoverToolInputError({
        toolUse,
        toolMap,
        signal: toolAbortController.signal,
        runId,
        sessionKey,
        principalId: params.principalId,
        executionContext: params.executionContext,
        emitRunEvent,
        maxResultChars: FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS,
        initialResult: result,
      });
      result = capToolResultContent(result, FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS);
    }
    if (toolUse.name === "web_fetch" && result.isError) {
      result = await maybeFallbackWebFetchWithBrowser({
        toolUse,
        toolMap,
        signal: toolAbortController.signal,
        runId,
        sessionKey,
        principalId: params.principalId,
        executionContext: params.executionContext,
        emitRunEvent,
        maxResultChars: FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS,
        initialResult: result,
      });
      result = capToolResultContent(result, FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS);
    }

    emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      result,
      routeId,
      correlationId,
    }));

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = { content: `Tool error: ${errorMessage}`, isError: true };

    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      isError: true,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  } finally {
    clearTimeout(toolTimer);
    signal.removeEventListener("abort", onRunAbort);
  }
}

function buildUnavailableToolMessage(toolName: string): string {
  if (toolName === "desktop") {
    return FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE;
  }
  if (toolName === "system") {
    return FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE;
  }
  if (toolName === "mcp") {
    return FRIDAY_MCP_UNAVAILABLE_MESSAGE;
  }
  return `Unknown tool: ${toolName}`;
}

const FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE =
  'Tool "desktop" is unavailable because desktop runtime is not enabled. Set FRIDAY_DESKTOP_ENABLED=true and restart Friday.';

const FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE =
  'Tool "system" is unavailable because Friday Agent OS system orchestration is not enabled. Set FRIDAY_SYSTEM_ENABLED=true and restart Friday.';

const FRIDAY_MCP_UNAVAILABLE_MESSAGE =
  'Tool "mcp" is unavailable because MCP servers are not configured. Set FRIDAY_MCP_SERVERS with at least one server and restart Friday.';

interface MaybeRecoverToolInputErrorParams {
  toolUse: FridayAgentToolUseBlock;
  toolMap: Map<string, FridayAgentToolDefinition>;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  maxResultChars: number;
  initialResult: FridayAgentToolResult;
}

interface RecoveryExecutionResult {
  result: FridayAgentToolResult;
  recovered: boolean;
}

async function maybeRecoverToolInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const { toolUse, initialResult } = params;
  if (!initialResult.isError) return initialResult;
  if (!looksLikeToolInputError(initialResult.content)) return initialResult;

  switch (toolUse.name) {
    case "desktop":
      return maybeRecoverDesktopInputError(params);
    case "browser":
      return maybeRecoverBrowserInputError(params);
    case "mcp":
      return maybeRecoverMcpInputError(params);
    default:
      return initialResult;
  }
}

function looksLikeToolInputError(message: string): boolean {
  const normalized = message.trim();
  if (normalized.length === 0) return false;
  return (
    / is required\b/i.test(normalized)
    || /invalid or incomplete/i.test(normalized)
    || /either .+ is required/i.test(normalized)
    || /values array is required/i.test(normalized)
    || /args must be an object/i.test(normalized)
    || /(需要|缺少).{0,16}(参数|字段|策略|选择器)/.test(normalized)
    || /必填/.test(normalized)
  );
}

async function maybeRecoverDesktopInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const desktopTool = toolMap.get("desktop");
  if (!desktopTool) return initialResult;

  const normalizeDesktopActionToken = (value: unknown): string =>
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  const action = normalizeDesktopActionToken(toolUse.input.action);
  const actionType = normalizeDesktopActionToken(toolUse.input.actionType);
  const missingSelector = (
    /strategy is required|selectorvalue is required|selector strategy is required/i.test(initialResult.content)
    || /requires 'selector' field/i.test(initialResult.content)
    || /coordinates or selector/i.test(initialResult.content)
    || /(策略|选择器).{0,8}(必填|需要|缺少)/.test(initialResult.content)
    || /(需要|缺少).{0,8}(策略|选择器)/.test(initialResult.content)
  );
  const missingCoordinates =
    /x is required|y is required|startx is required|starty is required|endx is required|endy is required/i
      .test(initialResult.content);
  const invalidReadElement = /Invalid or incomplete actionType "read_element"/i.test(initialResult.content);

  const shouldFallbackToScreenshot =
    (action === "inspect_element" && missingSelector)
    || (
      action === "execute"
      && (
        missingSelector
        || missingCoordinates
        || (actionType === "read_element" && invalidReadElement)
      )
    );

  if (!shouldFallbackToScreenshot) return initialResult;

  const recovery = await executeToolRecoveryAttempt({
    toolName: "desktop",
    toolUse,
    tool: desktopTool,
    recoveryArgs: { action: "screenshot" },
    recoveryTag: "[auto-recovery:desktop->desktop.screenshot]",
    recoveryReason: initialResult.content,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId: "agent.execute.tool.input_recovery",
  });

  if (recovery.recovered) {
    return recovery.result;
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      "[auto-recovery:desktop->desktop.screenshot] attempted but failed.",
    isError: true,
  };
}

async function maybeRecoverBrowserInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const browserTool = toolMap.get("browser");
  if (!browserTool) return initialResult;

  const action = typeof toolUse.input.action === "string"
    ? toolUse.input.action.trim().toLowerCase()
    : "";
  const missingTarget = /Either selector or elementId is required for act\./i.test(initialResult.content);
  if (!(action === "act" && missingTarget)) {
    return initialResult;
  }

  const recoveryArgs: Record<string, unknown> = { action: "snapshot" };
  const sessionId = typeof toolUse.input.sessionId === "string" ? toolUse.input.sessionId : undefined;
  const tabId = typeof toolUse.input.tabId === "string" ? toolUse.input.tabId : undefined;
  if (sessionId) recoveryArgs.sessionId = sessionId;
  if (tabId) recoveryArgs.tabId = tabId;

  const recovery = await executeToolRecoveryAttempt({
    toolName: "browser",
    toolUse,
    tool: browserTool,
    recoveryArgs,
    recoveryTag: "[auto-recovery:browser.act->browser.snapshot]",
    recoveryReason: initialResult.content,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId: "agent.execute.tool.input_recovery",
  });

  if (recovery.recovered) {
    return recovery.result;
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      "[auto-recovery:browser.act->browser.snapshot] attempted but failed.",
    isError: true,
  };
}

async function maybeRecoverMcpInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const mcpTool = toolMap.get("mcp");
  if (!mcpTool) return initialResult;

  const errorText = initialResult.content;
  let recoveryArgs: Record<string, unknown> | null = null;
  const serverId = typeof toolUse.input.serverId === "string" ? toolUse.input.serverId : undefined;

  if (/action is required|Invalid action/i.test(errorText)) {
    recoveryArgs = { action: "list_servers" };
  } else if (/toolName is required/i.test(errorText) && serverId) {
    recoveryArgs = { action: "list_tools", serverId };
  } else if (/serverId is required|toolName is required/i.test(errorText)) {
    recoveryArgs = { action: "list_servers" };
  }

  if (!recoveryArgs) return initialResult;

  const recovery = await executeToolRecoveryAttempt({
    toolName: "mcp",
    toolUse,
    tool: mcpTool,
    recoveryArgs,
    recoveryTag: "[auto-recovery:mcp->discovery]",
    recoveryReason: initialResult.content,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId: "agent.execute.tool.input_recovery",
  });

  if (recovery.recovered) {
    return recovery.result;
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      "[auto-recovery:mcp->discovery] attempted but failed.",
    isError: true,
  };
}

async function executeToolRecoveryAttempt(params: {
  toolName: string;
  toolUse: FridayAgentToolUseBlock;
  tool: FridayAgentToolDefinition;
  recoveryArgs: Record<string, unknown>;
  recoveryTag: string;
  recoveryReason: string;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  maxResultChars: number;
  routeId: string;
}): Promise<RecoveryExecutionResult> {
  const {
    toolName,
    toolUse,
    tool,
    recoveryArgs,
    recoveryTag,
    recoveryReason,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId,
  } = params;
  const correlationId = runId;
  const recoveryCallId = `${toolUse.id}:input-recovery`;

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName,
    toolCallId: recoveryCallId,
    params: {
      ...recoveryArgs,
      fallback: "tool_input_error",
      fallbackReason: recoveryReason,
      parentToolCallId: toolUse.id,
    },
  });

  const startedAt = Date.now();
  let recoveryResult: FridayAgentToolResult;
  try {
    const toolArgs = augmentToolArgsForRuntime({
      toolName,
      input: recoveryArgs,
      sessionKey,
      principalId,
      executionContext,
    });
    recoveryResult = capToolResultContent(
      await tool.execute(toolArgs, signal),
      maxResultChars,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName,
      toolCallId: recoveryCallId,
      durationMs: Date.now() - startedAt,
      isError: true,
      summary: `${recoveryTag} failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });
    return {
      recovered: false,
      result: {
        content: `${recoveryTag} failed: ${message}`,
        isError: true,
      },
    };
  }

  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName,
    toolCallId: recoveryCallId,
    durationMs: Date.now() - startedAt,
    result: recoveryResult,
    routeId,
    correlationId,
  }));

  if (recoveryResult.isError) {
    return { recovered: false, result: recoveryResult };
  }

  return {
    recovered: true,
    result: {
      content:
        `${recoveryTag} recovered from input error (${recoveryReason}).\n` +
        recoveryResult.content,
      isError: false,
      blocks: recoveryResult.blocks,
      metadata: recoveryResult.metadata,
    },
  };
}

interface MaybeFallbackWebFetchWithBrowserParams {
  toolUse: FridayAgentToolUseBlock;
  toolMap: Map<string, FridayAgentToolDefinition>;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  maxResultChars: number;
  initialResult: FridayAgentToolResult;
}

async function maybeFallbackWebFetchWithBrowser(
  params: MaybeFallbackWebFetchWithBrowserParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const routeId = "agent.execute.tool.web_fetch_fallback";
  const correlationId = runId;
  if (!shouldAttemptWebFetchBrowserFallback(initialResult.content)) {
    return initialResult;
  }
  const url = typeof toolUse.input.url === "string" ? toolUse.input.url.trim() : "";
  if (url.length === 0) return initialResult;

  const browserTool = toolMap.get("browser");
  if (!browserTool) return initialResult;

  const fallbackTag = "[auto-fallback:web_fetch->browser]";
  const openArgs: Record<string, unknown> = { action: "open", url };
  const openCallId = `${toolUse.id}:fallback-browser-open`;
  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: "browser",
    toolCallId: openCallId,
    params: { ...openArgs, fallback: "web_fetch_error" },
  });

  const openStarted = Date.now();
  let openResult: FridayAgentToolResult;
  try {
    const toolArgs = augmentToolArgsForRuntime({
      toolName: "browser",
      input: openArgs,
      sessionKey,
      principalId,
      executionContext,
    });
    openResult = capToolResultContent(
      await browserTool.execute(toolArgs, signal),
      maxResultChars,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: "browser",
      toolCallId: openCallId,
      durationMs: Date.now() - openStarted,
      isError: true,
      summary: `${fallbackTag} open failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open failed: ${message}`,
      isError: true,
    };
  }

  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName: "browser",
    toolCallId: openCallId,
    durationMs: Date.now() - openStarted,
    result: openResult,
    routeId,
    correlationId,
  }));

  if (openResult.isError) {
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open failed: ${openResult.content}`,
      isError: true,
    };
  }

  const openPayload = parseJsonObject(openResult.content);
  const sessionId = typeof openPayload?.sessionId === "string" ? openPayload.sessionId : undefined;
  const tabId = typeof openPayload?.tabId === "string" ? openPayload.tabId : undefined;
  if (!sessionId) {
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} browser open succeeded but session metadata is unavailable.`,
      isError: false,
    };
  }

  const snapshotArgs: Record<string, unknown> = { action: "snapshot", sessionId };
  if (tabId) snapshotArgs.tabId = tabId;
  const snapshotCallId = `${toolUse.id}:fallback-browser-snapshot`;

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: "browser",
    toolCallId: snapshotCallId,
    params: { ...snapshotArgs, fallback: "web_fetch_error" },
  });

  const snapshotStarted = Date.now();
  let snapshotResult: FridayAgentToolResult;
  try {
    const toolArgs = augmentToolArgsForRuntime({
      toolName: "browser",
      input: snapshotArgs,
      sessionKey,
      principalId,
      executionContext,
    });
    snapshotResult = capToolResultContent(
      await browserTool.execute(toolArgs, signal),
      maxResultChars,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: "browser",
      toolCallId: snapshotCallId,
      durationMs: Date.now() - snapshotStarted,
      isError: true,
      summary: `${fallbackTag} snapshot failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open succeeded but snapshot failed: ${message}`,
      isError: false,
    };
  }

  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName: "browser",
    toolCallId: snapshotCallId,
    durationMs: Date.now() - snapshotStarted,
    result: snapshotResult,
    routeId,
    correlationId,
  }));

  if (snapshotResult.isError) {
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open succeeded but snapshot failed: ${snapshotResult.content}`,
      isError: false,
    };
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      `${fallbackTag} browser snapshot succeeded:\n${snapshotResult.content}`,
    isError: false,
  };
}

function shouldAttemptWebFetchBrowserFallback(content: string): boolean {
  const lower = content.toLowerCase();
  // Security block decisions should never be bypassed via browser fallback.
  if (lower.includes("ssrf guard")) return false;
  if (lower.includes("blocked private")) return false;
  if (lower.includes("blocked hostname")) return false;
  if (lower.includes("blocked protocol")) return false;
  if (lower.includes("not in allowlist")) return false;

  if (lower.includes("js-rendered")) return true;
  if (lower.includes("require javascript")) return true;
  if (lower.includes("fetch error:")) return true;
  if (lower.includes("request timed out")) return true;
  return false;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── OC-007: Tool result size capping ───

function capToolResultContent(
  result: FridayAgentToolResult,
  maxChars: number,
): FridayAgentToolResult {
  if (result.content.length <= maxChars) return result;
  const truncated =
    result.content.slice(0, maxChars) +
    `\n\n[truncated: output was ${String(result.content.length)} chars, showing first ${String(maxChars)}]`;
  return { ...result, content: truncated };
}
