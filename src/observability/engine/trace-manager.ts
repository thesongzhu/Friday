import { FridayDomainError } from "#errors";

/**
 * Trace Manager — Distributed tracing with spans, parent-child relationships,
 * and context propagation.
 *
 * Manages the lifecycle of traces and spans using local OTel-shaped conventions.
 * This is in-process tracing, not an OTLP exporter or W3C traceparent wire contract.
 * Supports creating root and child spans, recording events, setting status,
 * and ending spans. Active traces are held in memory; completed traces can be
 * retrieved for persistence or export.
 *
 * @module observability/engine
 */

import type {
  FridayAttributes,
  FridayObservabilityModule,
  FridaySpan,
  FridaySpanContext,
  FridaySpanEvent,
  FridaySpanKind,
  FridaySpanStatus,
  FridayTrace,
  ISODateTime,
} from "../model/friday-observability.types.js";

// ─── ID Generation ───

/** Generate a 128-bit hex trace ID (32 hex chars). */
function generateTraceId(): string {
  return randomHex(16);
}

/** Generate a 64-bit hex span ID (16 hex chars). */
function generateSpanId(): string {
  return randomHex(8);
}

/** Generate random hex string of the given byte length. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recursively freeze objects/arrays to enforce runtime immutability. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") {
      deepFreeze(nested);
    }
  }

  return Object.freeze(value);
}

/** Clone a value and return a deeply frozen copy. */
function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

// ─── Options ───

/** Options for starting a new trace. */
export interface StartTraceOptions {
  /** Human-readable trace name (e.g., "workflow-run:wf-abc"). */
  readonly name: string;
  /** Source module for the root span. */
  readonly module: FridayObservabilityModule;
  /** Operation name for the root span. */
  readonly operationName: string;
  /** Span kind for the root span. */
  readonly kind?: FridaySpanKind;
  /** Trace-level attributes. */
  readonly attributes?: FridayAttributes;
  /** Root span attributes. */
  readonly spanAttributes?: FridayAttributes;
}

/** Options for starting a child span. */
export interface StartSpanOptions {
  /** Operation name. */
  readonly operationName: string;
  /** Source module. */
  readonly module: FridayObservabilityModule;
  /** Span kind. */
  readonly kind?: FridaySpanKind;
  /** Span attributes. */
  readonly attributes?: FridayAttributes;
  /** Parent span context. If omitted, the span is a root span. */
  readonly parentContext?: FridaySpanContext;
}

/** Options for recording a span event. */
export interface SpanEventOptions {
  /** Event name. */
  readonly name: string;
  /** Event attributes. */
  readonly attributes?: FridayAttributes;
}

// ─── Active Span Wrapper ───

/** Result returned when starting a trace, containing the context and trace ID. */
export interface TraceHandle {
  readonly traceId: string;
  readonly rootSpanContext: FridaySpanContext;
}

/** Result returned when starting a span. */
export interface SpanHandle {
  readonly spanContext: FridaySpanContext;
}

// ─── Trace Manager ───

/**
 * Manages distributed traces and spans in memory.
 *
 * Usage:
 * ```ts
 * const manager = new FridayTraceManager();
 * const { traceId, rootSpanContext } = manager.startTrace({
 *   name: "workflow-run:wf-1",
 *   module: "workflows",
 *   operationName: "workflow.execute",
 * });
 * const child = manager.startSpan({
 *   operationName: "rules.evaluate",
 *   module: "rules",
 *   parentContext: rootSpanContext,
 * });
 * manager.endSpan(child.spanContext, "ok");
 * manager.endSpan(rootSpanContext, "ok");
 * const trace = manager.getTrace(traceId);
 * ```
 */
export class FridayTraceManager {
  /** Active (incomplete) spans indexed by traceId → spanId → span. */
  private readonly activeSpans = new Map<string, Map<string, FridaySpan>>();
  /** Completed traces indexed by traceId. */
  private readonly completedTraces = new Map<string, FridayTrace>();
  /** Trace metadata indexed by traceId. */
  private readonly traceMetadata = new Map<string, {
    name: string;
    rootSpanId: string;
    attributes: FridayAttributes;
    startedAt: ISODateTime;
  }>();

  // ─── Trace Lifecycle ───

  /** Start a new trace with a root span. Returns the trace ID and root span context. */
  startTrace(options: StartTraceOptions): TraceHandle {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const now = new Date().toISOString();

    const rootSpan: FridaySpan = {
      spanId,
      traceId,
      operationName: options.operationName,
      kind: options.kind ?? "internal",
      status: "unset",
      module: options.module,
      attributes: { ...options.spanAttributes },
      events: [],
      startedAt: now,
    };

    const spanMap = new Map<string, FridaySpan>();
    spanMap.set(spanId, rootSpan);
    this.activeSpans.set(traceId, spanMap);

    this.traceMetadata.set(traceId, {
      name: options.name,
      rootSpanId: spanId,
      attributes: { ...options.attributes },
      startedAt: now,
    });

    return {
      traceId,
      rootSpanContext: { traceId, spanId, traceFlags: 1 },
    };
  }

  /** Start a child span within an existing trace. */
  startSpan(options: StartSpanOptions): SpanHandle {
    const spanId = generateSpanId();
    const now = new Date().toISOString();

    const parentContext = options.parentContext;
    const traceId = parentContext?.traceId;
    if (!traceId || !parentContext) {
      throw new FridayDomainError("VALIDATION_ERROR", "parentContext with traceId is required to start a child span", { httpStatus: 400 });
    }

    const spanMap = this.activeSpans.get(traceId);
    if (!spanMap) {
      throw new FridayDomainError("NOT_FOUND", `Trace "${traceId}" not found or already completed`, { httpStatus: 404 });
    }

    if (!spanMap.has(parentContext.spanId)) {
      throw new FridayDomainError("NOT_FOUND", `Parent span "${parentContext.spanId}" not found in trace "${traceId}"`, { httpStatus: 404 });
    }

    const span: FridaySpan = {
      spanId,
      traceId,
      parentSpanId: parentContext.spanId,
      operationName: options.operationName,
      kind: options.kind ?? "internal",
      status: "unset",
      module: options.module,
      attributes: { ...options.attributes },
      events: [],
      startedAt: now,
    };

    spanMap.set(spanId, span);

    return {
      spanContext: { traceId, spanId, traceFlags: 1 },
    };
  }

  /** Record an event on an active span. */
  addSpanEvent(context: FridaySpanContext, event: SpanEventOptions): void {
    const span = this.getMutableActiveSpan(context);
    if (!span) return;

    const spanEvent: FridaySpanEvent = {
      name: event.name,
      timestamp: new Date().toISOString(),
      attributes: event.attributes,
    };
    span.events.push(spanEvent);
  }

  /** Set attributes on an active span (merges with existing). */
  setSpanAttributes(context: FridaySpanContext, attributes: FridayAttributes): void {
    const span = this.getMutableActiveSpan(context);
    if (!span) return;
    Object.assign(span.attributes, attributes);
  }

  /** Set the status of an active span. */
  setSpanStatus(context: FridaySpanContext, status: FridaySpanStatus, message?: string): void {
    const span = this.getMutableActiveSpan(context);
    if (!span) return;
    span.status = status;
    if (message !== undefined) {
      span.statusMessage = message;
    }
  }

  /**
   * End a span. Computes duration and checks if the trace is complete.
   * When all spans in a trace are ended, the trace is finalized and moved
   * to the completed traces store.
   */
  endSpan(context: FridaySpanContext, status?: FridaySpanStatus, message?: string): void {
    const spanMap = this.activeSpans.get(context.traceId);
    if (!spanMap) return;

    const span = spanMap.get(context.spanId);
    if (!span) return;

    const now = new Date().toISOString();
    span.endedAt = now;
    span.durationMs = new Date(now).getTime() - new Date(span.startedAt).getTime();

    if (status !== undefined) {
      span.status = status;
    }
    if (message !== undefined) {
      span.statusMessage = message;
    }

    // If status is still unset after ending, default to "ok"
    if (span.status === "unset") {
      span.status = "ok";
    }

    // Check if all spans in this trace are ended
    let allEnded = true;
    for (const s of spanMap.values()) {
      if (!s.endedAt) {
        allEnded = false;
        break;
      }
    }

    if (allEnded) {
      this.finalizeTrace(context.traceId);
    }
  }

  // ─── Query ───

  /** Get a completed trace by ID. Returns null if not found. */
  getTrace(traceId: string): FridayTrace | null {
    const trace = this.completedTraces.get(traceId);
    return trace ? cloneAndFreeze(trace) : null;
  }

  /** Get an active (in-progress) span. Returns null if not found. */
  getActiveSpan(context: FridaySpanContext): FridaySpan | null {
    const span = this.getMutableActiveSpan(context);
    return span ? cloneAndFreeze(span) : null;
  }

  /** Get an active span reference for internal state updates. */
  private getMutableActiveSpan(context: FridaySpanContext): FridaySpan | null {
    const spanMap = this.activeSpans.get(context.traceId);
    if (!spanMap) return null;
    return spanMap.get(context.spanId) ?? null;
  }

  /** Get all completed traces. */
  getCompletedTraces(): FridayTrace[] {
    return cloneAndFreeze(Array.from(this.completedTraces.values()));
  }

  /** Get the number of active (incomplete) traces. */
  getActiveTraceCount(): number {
    return this.activeSpans.size;
  }

  /** Check whether a trace is still active (has unfinished spans). */
  isTraceActive(traceId: string): boolean {
    return this.activeSpans.has(traceId);
  }

  /** Remove a completed trace from the store (after persistence). */
  removeCompletedTrace(traceId: string): boolean {
    return this.completedTraces.delete(traceId);
  }

  /** Clear all state. */
  reset(): void {
    this.activeSpans.clear();
    this.completedTraces.clear();
    this.traceMetadata.clear();
  }

  // ─── Internal ───

  /** Finalize a trace: assemble all spans, compute aggregates, move to completed. */
  private finalizeTrace(traceId: string): void {
    const spanMap = this.activeSpans.get(traceId);
    const metadata = this.traceMetadata.get(traceId);
    if (!spanMap || !metadata) return;

    const spans = Array.from(spanMap.values()).sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );

    const rootSpan = spanMap.get(metadata.rootSpanId);
    const traceStatus: FridaySpanStatus = rootSpan?.status ?? "unset";

    let earliestStart = Infinity;
    let latestEnd = -Infinity;
    for (const span of spans) {
      const start = new Date(span.startedAt).getTime();
      if (start < earliestStart) earliestStart = start;
      if (span.endedAt) {
        const end = new Date(span.endedAt).getTime();
        if (end > latestEnd) latestEnd = end;
      }
    }

    const durationMs = latestEnd !== -Infinity && earliestStart !== Infinity
      ? latestEnd - earliestStart
      : 0;

    const trace: FridayTrace = {
      traceId,
      name: metadata.name,
      rootSpanId: metadata.rootSpanId,
      spans,
      status: traceStatus,
      attributes: metadata.attributes,
      durationMs,
      spanCount: spans.length,
      startedAt: metadata.startedAt,
      endedAt: latestEnd !== -Infinity ? new Date(latestEnd).toISOString() : undefined,
    };

    this.completedTraces.set(traceId, trace);
    this.activeSpans.delete(traceId);
    this.traceMetadata.delete(traceId);
  }
}
