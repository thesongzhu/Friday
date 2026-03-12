/**
 * Cross-Tool Coordination Protocol — Implementation.
 *
 * Manages tool domain ownership and handoffs during multi-domain setup tasks.
 * Prevents tool conflicts (e.g., desktop accessibility grab vs. browser focus)
 * by enforcing single-domain ownership with explicit handoff protocol.
 *
 * @module setup
 */

import type {
  CreateFridaySetupCoordinatorDeps,
  FridaySetupCoordinationSession,
  FridaySetupCoordinator,
  FridaySetupHandoffInstruction,
  FridaySetupToolDomain,
  UUID,
} from "./friday-setup-coordinator.types.js";

// ─── Factory ───

export function createFridaySetupCoordinator(
  deps: CreateFridaySetupCoordinatorDeps,
): FridaySetupCoordinator {
  const { idGenerator, nowIso } = deps;

  /** Mutable session store keyed by session ID. */
  const sessions = new Map<UUID, MutableSession>();

  /** Internal mutable version of the session for in-place updates. */
  interface MutableSession {
    id: UUID;
    recipeId: string;
    executionId: string;
    phase: FridaySetupCoordinationSession["phase"];
    activeDomain: FridaySetupToolDomain | null;
    handoffHistory: FridaySetupCoordinationSession["handoffHistory"][number][];
    sharedContext: Record<string, string>;
    createdAt: string;
    updatedAt: string;
  }

  function toReadonly(session: MutableSession): FridaySetupCoordinationSession {
    return {
      id: session.id,
      recipeId: session.recipeId,
      executionId: session.executionId,
      phase: session.phase,
      activeDomain: session.activeDomain,
      handoffHistory: [...session.handoffHistory],
      sharedContext: { ...session.sharedContext },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  function touch(session: MutableSession): void {
    session.updatedAt = nowIso();
  }

  return {
    createSession(recipeId, executionId) {
      const id = idGenerator();
      const now = nowIso();
      const session: MutableSession = {
        id,
        recipeId,
        executionId,
        phase: "idle",
        activeDomain: null,
        handoffHistory: [],
        sharedContext: {},
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(id, session);
      return toReadonly(session);
    },

    acquireDomain(sessionId, domain, reason) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.phase === "released" || session.phase === "failed") return null;

      // If another domain holds control, refuse
      if (session.activeDomain !== null && session.activeDomain !== domain) {
        return null;
      }

      session.phase = "acquired";
      session.activeDomain = domain;
      touch(session);

      // Record as a handoff from null if this is the first acquisition
      if (session.handoffHistory.length === 0 || session.handoffHistory[session.handoffHistory.length - 1].to !== domain) {
        session.handoffHistory.push({
          from: session.handoffHistory.length > 0
            ? session.handoffHistory[session.handoffHistory.length - 1].to
            : domain,
          to: domain,
          reason: reason ?? `Acquired ${domain} domain`,
          timestamp: nowIso(),
        });
      }

      return toReadonly(session);
    },

    handoff(sessionId, instruction) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.phase === "released" || session.phase === "failed") return null;

      // Verify the "from" domain matches current active domain
      if (session.activeDomain !== null && session.activeDomain !== instruction.from) {
        return null;
      }

      // Record the handoff
      session.handoffHistory.push({
        from: instruction.from,
        to: instruction.to,
        reason: instruction.reason,
        timestamp: nowIso(),
        transferredData: instruction.transferData ? { ...instruction.transferData } : undefined,
      });

      // Merge transferred data into shared context
      if (instruction.transferData) {
        for (const [key, value] of Object.entries(instruction.transferData)) {
          session.sharedContext[key] = value;
        }
      }

      // Update domain ownership
      session.phase = "acquired";
      session.activeDomain = instruction.to;
      touch(session);

      return toReadonly(session);
    },

    releaseDomain(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;

      session.activeDomain = null;
      session.phase = "idle";
      touch(session);

      return toReadonly(session);
    },

    setSharedContext(sessionId, key, value) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.phase === "released" || session.phase === "failed") return null;

      session.sharedContext[key] = value;
      touch(session);

      return toReadonly(session);
    },

    getSession(sessionId) {
      const session = sessions.get(sessionId);
      return session ? toReadonly(session) : null;
    },

    failSession(sessionId, _reason) {
      const session = sessions.get(sessionId);
      if (!session) return null;

      session.phase = "failed";
      session.activeDomain = null;
      touch(session);

      return toReadonly(session);
    },

    closeSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;

      session.phase = "released";
      session.activeDomain = null;
      touch(session);

      return toReadonly(session);
    },
  };
}
