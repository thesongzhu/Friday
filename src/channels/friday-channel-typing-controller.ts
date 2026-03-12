/**
 * OC-005: Lifecycle-aware typing indicator controller.
 *
 * Replaces raw setInterval with a controller that:
 * - Emits immediately on start, then pulses at configurable intervals
 * - Has a TTL to auto-stop after a maximum duration
 * - Uses two-gate stop: both run and dispatch must complete before stopping
 * - Sealed state prevents late callbacks from restarting typing
 */

// ─── Types ───

export interface FridayChannelTypingController {
  /** Start emitting typing indicators. Fires immediately then pulses. */
  start(): void;
  /** Mark agent run as complete. Typing stops when dispatch is also done. */
  stopRun(): void;
  /** Mark reply dispatch as complete. Typing stops when run is also done. */
  stopDispatch(): void;
  /** Hard stop — immediately cease all typing. Prevents further start() calls. */
  seal(): void;
}

export interface CreateTypingControllerOptions {
  /** Function to emit a single typing indicator. */
  emitTyping: () => void;
  /** Pulse interval in ms. Default: 6000. */
  pulseMs?: number;
  /** TTL in ms — auto-seal after this duration. Default: 120000 (2 min). */
  ttlMs?: number;
}

// ─── Factory ───

export function createFridayChannelTypingController(
  options: CreateTypingControllerOptions,
): FridayChannelTypingController {
  const { emitTyping } = options;
  const pulseMs = options.pulseMs ?? 6000;
  const ttlMs = options.ttlMs ?? 120_000;

  let sealed = false;
  let runComplete = false;
  let dispatchIdle = false;
  let pulseTimer: ReturnType<typeof setInterval> | undefined;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  function cleanup(): void {
    if (pulseTimer !== undefined) {
      clearInterval(pulseTimer);
      pulseTimer = undefined;
    }
    if (ttlTimer !== undefined) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
    sealed = true;
  }

  function tryStop(): void {
    if (runComplete && dispatchIdle) {
      cleanup();
    }
  }

  return {
    start(): void {
      if (sealed) return;
      emitTyping();
      if (pulseTimer === undefined) {
        pulseTimer = setInterval(() => {
          if (sealed) return;
          emitTyping();
        }, pulseMs);
      }
      if (ttlTimer === undefined) {
        ttlTimer = setTimeout(() => {
          cleanup();
        }, ttlMs);
      }
    },

    stopRun(): void {
      runComplete = true;
      tryStop();
    },

    stopDispatch(): void {
      dispatchIdle = true;
      tryStop();
    },

    seal(): void {
      cleanup();
    },
  };
}
