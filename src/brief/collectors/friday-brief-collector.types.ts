/**
 * Daily Brief — collector plugin interface.
 *
 * Each source (friday history, git, slack, mail, calendar, issues) implements
 * this interface. The brief service calls `collect` with the window bounds and
 * the source-scoped config slice.
 */

import type { FridayBriefConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefCollectionResult,
  FridayBriefSourceKind,
} from "../friday-brief.types.js";

export interface FridayBriefCollectorContext {
  /** Inclusive start of the window (ISO). */
  fromIso: string;
  /** Inclusive end of the window (ISO). */
  toIso: string;
  /** Full brief config — collector reads its own slice. */
  config: FridayBriefConfig;
  /** Abort signal — honoured for HTTP calls. */
  signal: AbortSignal;
  /** User id in the Friday core — used to filter Friday history. */
  userId: string;
}

export interface FridayBriefCollector {
  readonly source: FridayBriefSourceKind;
  /** Whether this collector should run given the provided config slice. */
  isEnabled(config: FridayBriefConfig): boolean;
  /** Run the collection. Must NOT throw — capture errors into result.error. */
  collect(ctx: FridayBriefCollectorContext): Promise<FridayBriefCollectionResult>;
}

/** Helper: produce an empty result with `skipped=true` for a given reason. */
export function buildSkippedCollectionResult(
  source: FridayBriefSourceKind,
  skipReason: string,
): FridayBriefCollectionResult {
  return {
    source,
    events: [],
    durationMs: 0,
    skipped: true,
    skipReason,
  };
}

/** Helper: wrap a collector body with timing + error capture. */
export async function runCollectorSafely(
  source: FridayBriefSourceKind,
  runner: () => Promise<{ events: FridayBriefCollectionResult["events"]; skipped?: boolean; skipReason?: string }>,
): Promise<FridayBriefCollectionResult> {
  const started = Date.now();
  try {
    const out = await runner();
    return {
      source,
      events: out.events,
      durationMs: Date.now() - started,
      skipped: Boolean(out.skipped),
      skipReason: out.skipReason,
    };
  } catch (err) {
    const error = err as Error & { code?: string };
    return {
      source,
      events: [],
      durationMs: Date.now() - started,
      skipped: false,
      error: { code: error.code ?? "COLLECTOR_ERROR", message: error.message ?? String(err) },
    };
  }
}
