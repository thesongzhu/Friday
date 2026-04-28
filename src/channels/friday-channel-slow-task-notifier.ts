import type { FridayAgentEventEmitter, FridayAgentEventMap } from "#agent";
import type { FridayChannelRegistry } from "./friday-channel-registry.js";

interface FridaySlowTaskSnapshot {
  elapsedMs: number;
  phase: string;
  activeTool?: string;
  subagentCount: number;
  latestSubagentId?: string;
  eta?: number;
  etaConfidence?: "low" | "medium" | "high" | "unavailable";
}

export interface FridayChannelSlowTaskNotifierOptions {
  eventEmitter: FridayAgentEventEmitter;
  channelRegistry: FridayChannelRegistry;
  channelKind: string;
  chatId: string;
  replyTo?: string;
  runId: string;
  publicRunUrl?: string;
  sourceText?: string;
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface FridayChannelSlowTaskNotifier {
  stop(): void;
}

function formatDuration(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

function formatDurationZh(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function containsChinese(text: string | undefined): boolean {
  return typeof text === "string" && /[\u4e00-\u9fff]/u.test(text);
}

function localizePhaseZh(phase: string): string {
  switch (phase) {
    case "pending":
      return "等待中";
    case "planning":
      return "规划中";
    case "executing":
      return "执行中";
    case "testing":
      return "验证中";
    case "fixing":
      return "修复中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return phase;
  }
}

function localizeConfidenceZh(confidence: FridaySlowTaskSnapshot["etaConfidence"]): string {
  switch (confidence) {
    case "high":
      return "高可信";
    case "medium":
      return "中等可信";
    case "low":
      return "低可信";
    default:
      return "可信度未知";
  }
}

function buildSlowTaskMessage(input: {
  runId: string;
  snapshot: FridaySlowTaskSnapshot;
  publicRunUrl?: string;
  sourceText?: string;
}): string {
  if (containsChinese(input.sourceText)) {
    const etaText = typeof input.snapshot.eta === "number"
      ? `最多 ${formatDurationZh(input.snapshot.eta)}（${localizeConfidenceZh(input.snapshot.etaConfidence)}）`
      : "暂时无法估算";
    const linkLine = input.publicRunUrl
      ? `查看实时进度：${input.publicRunUrl}`
      : `追踪 runId：${input.runId}`;

    return [
      `还在处理你的请求，已运行 ${formatDurationZh(input.snapshot.elapsedMs)}。`,
      `阶段：${localizePhaseZh(input.snapshot.phase)}`,
      `当前工具：${input.snapshot.activeTool ?? "无"}`,
      `子任务：${String(input.snapshot.subagentCount)}`,
      `预计时间：${etaText}`,
      linkLine,
    ].join("\n");
  }

  const etaText = typeof input.snapshot.eta === "number"
    ? `up to ${formatDuration(input.snapshot.eta)} (${input.snapshot.etaConfidence ?? "low"} confidence)`
    : "ETA unavailable";
  const linkLine = input.publicRunUrl
    ? `Watch live: ${input.publicRunUrl}`
    : `Track with runId: ${input.runId}`;

  return [
    `Still working on your request after ${formatDuration(input.snapshot.elapsedMs)}.`,
    `Phase: ${input.snapshot.phase}`,
    `Active tool: ${input.snapshot.activeTool ?? "none"}`,
    `Subagents: ${String(input.snapshot.subagentCount)}`,
    `ETA: ${etaText}`,
    linkLine,
  ].join("\n");
}

export function createFridayChannelSlowTaskNotifier(
  options: FridayChannelSlowTaskNotifierOptions,
): FridayChannelSlowTaskNotifier {
  const nowMs = options.nowMs ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const startedAtMs = nowMs();

  let snapshot: FridaySlowTaskSnapshot = {
    elapsedMs: 0,
    phase: "pending",
    subagentCount: 0,
    etaConfidence: "unavailable",
  };
  let stopped = false;
  let firstNotificationSent = false;
  let lastSentPhase: string | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;

  const sendUpdate = async (): Promise<void> => {
    if (stopped) return;
    firstNotificationSent = true;
    lastSentPhase = snapshot.phase;
    await options.channelRegistry.send(options.channelKind, {
      chatId: options.chatId,
      text: buildSlowTaskMessage({
        runId: options.runId,
        snapshot: {
          ...snapshot,
          elapsedMs: Math.max(snapshot.elapsedMs, nowMs() - startedAtMs),
        },
        publicRunUrl: options.publicRunUrl,
        sourceText: options.sourceText,
      }),
      replyTo: options.replyTo,
    });
  };

  const scheduleHeartbeat = (): void => {
    if (stopped) return;
    heartbeatTimer = setTimeoutFn(() => {
      void sendUpdate()
        .catch(() => undefined)
        .finally(() => {
          scheduleHeartbeat();
        });
    }, 60_000);
  };

  initialTimer = setTimeoutFn(() => {
    void sendUpdate()
      .catch(() => undefined)
      .finally(() => {
        scheduleHeartbeat();
      });
  }, 30_000);

  const onProgress = (payload: FridayAgentEventMap["agent.run.progress"]): void => {
    if (payload.runId !== options.runId) return;
    snapshot = {
      elapsedMs: payload.elapsedMs,
      phase: payload.phase,
      activeTool: payload.activeTool,
      subagentCount: payload.subagentCount,
      latestSubagentId: payload.latestSubagentId,
      eta: payload.eta,
      etaConfidence: payload.etaConfidence,
    };
    if (firstNotificationSent && snapshot.phase !== lastSentPhase) {
      void sendUpdate().catch(() => undefined);
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (initialTimer) clearTimeoutFn(initialTimer);
    if (heartbeatTimer) clearTimeoutFn(heartbeatTimer);
    options.eventEmitter.off("agent.run.progress", onProgress);
    options.eventEmitter.off("agent.run.completed", stopOnTerminal);
    options.eventEmitter.off("agent.run.failed", stopOnTerminal);
    options.eventEmitter.off("agent.run.cancelled", stopOnTerminal);
  };

  const stopOnTerminal = (payload: { runId: string }): void => {
    if (payload.runId !== options.runId) return;
    stop();
  };

  options.eventEmitter.on("agent.run.progress", onProgress);
  options.eventEmitter.on("agent.run.completed", stopOnTerminal);
  options.eventEmitter.on("agent.run.failed", stopOnTerminal);
  options.eventEmitter.on("agent.run.cancelled", stopOnTerminal);

  return { stop };
}
