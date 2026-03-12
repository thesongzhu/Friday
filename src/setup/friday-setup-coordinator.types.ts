/**
 * Cross-Tool Coordination Protocol — Type definitions.
 *
 * Defines the protocol for orchestrating handoffs between desktop, browser,
 * and system tools during automated setup workflows. Ensures tools cooperate
 * rather than conflict when performing multi-domain tasks.
 *
 * @module setup
 */

// ─── Foundational Types ───

export type UUID = string;
export type ISODateTime = string;

// ─── Tool Domains ───

/**
 * Tool domain identifiers used in coordination.
 *
 * Each domain represents a family of capabilities. Handoffs between domains
 * follow an explicit protocol to avoid race conditions (e.g., browser focus
 * vs desktop accessibility focus).
 */
export type FridaySetupToolDomain =
  | "desktop"
  | "browser"
  | "exec"
  | "file"
  | "system";

// ─── Coordination Session ───

/**
 * Lifecycle of a coordination session.
 *
 * ```
 * idle → acquired → handoff → acquired → ... → released
 *                                                  ↓
 *                                                failed
 * ```
 */
export type FridaySetupCoordinationPhase =
  | "idle"
  | "acquired"
  | "handoff"
  | "released"
  | "failed";

/**
 * A cross-tool coordination session.
 *
 * Created when a multi-domain setup task begins. Tracks which domain
 * currently holds control and manages handoffs between domains.
 */
export interface FridaySetupCoordinationSession {
  readonly id: UUID;
  readonly recipeId: string;
  readonly executionId: string;
  readonly phase: FridaySetupCoordinationPhase;
  /** The domain that currently holds control. */
  readonly activeDomain: FridaySetupToolDomain | null;
  /** Ordered history of domain handoffs. */
  readonly handoffHistory: readonly FridaySetupHandoffRecord[];
  /** Data shared between domains during the session. */
  readonly sharedContext: Readonly<Record<string, string>>;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/**
 * A record of a handoff between two tool domains.
 */
export interface FridaySetupHandoffRecord {
  readonly from: FridaySetupToolDomain;
  readonly to: FridaySetupToolDomain;
  readonly reason: string;
  readonly timestamp: ISODateTime;
  /** Data passed from one domain to the other. */
  readonly transferredData?: Readonly<Record<string, string>>;
}

// ─── Handoff Instructions ───

/**
 * Instructions for a tool domain handoff.
 *
 * When a step transitions from one domain to another (e.g., "system" launches
 * Chrome, then "browser" navigates to Discord), the coordination protocol
 * generates a handoff instruction.
 */
export interface FridaySetupHandoffInstruction {
  /** Domain relinquishing control. */
  readonly from: FridaySetupToolDomain;
  /** Domain acquiring control. */
  readonly to: FridaySetupToolDomain;
  /** Human-readable reason for the handoff. */
  readonly reason: string;

  /**
   * Pre-conditions that must be met before the handoff can proceed.
   *
   * For example, "browser" → "desktop" might require the browser window
   * to be focused first.
   */
  readonly preconditions?: readonly FridaySetupHandoffPrecondition[];

  /**
   * Actions to perform during the handoff transition.
   *
   * E.g., "take screenshot for context" or "focus target window".
   */
  readonly transitionActions?: readonly FridaySetupTransitionAction[];

  /** Data to pass from the source domain to the target domain. */
  readonly transferData?: Readonly<Record<string, string>>;
}

/**
 * A precondition that must be met for a handoff to proceed.
 */
export interface FridaySetupHandoffPrecondition {
  readonly type: "app_running" | "window_focused" | "url_loaded" | "file_exists" | "process_ready";
  readonly target: string;
  readonly description: string;
}

/**
 * An action to execute during a domain handoff transition.
 */
export interface FridaySetupTransitionAction {
  readonly domain: FridaySetupToolDomain;
  readonly action: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly description: string;
}

// ─── Coordinator Interface ───

/**
 * The cross-tool coordination protocol.
 *
 * Manages tool domain ownership and handoffs during multi-domain setup tasks.
 */
export interface FridaySetupCoordinator {
  /**
   * Create a new coordination session for a recipe execution.
   */
  createSession(recipeId: string, executionId: string): FridaySetupCoordinationSession;

  /**
   * Acquire control for a specific domain.
   *
   * Returns null if another domain holds control and hasn't released it.
   */
  acquireDomain(
    sessionId: UUID,
    domain: FridaySetupToolDomain,
    reason?: string,
  ): FridaySetupCoordinationSession | null;

  /**
   * Perform a handoff from the current domain to a new one.
   *
   * Generates handoff instructions and updates the session state.
   */
  handoff(
    sessionId: UUID,
    instruction: FridaySetupHandoffInstruction,
  ): FridaySetupCoordinationSession | null;

  /**
   * Release the current domain's control.
   */
  releaseDomain(sessionId: UUID): FridaySetupCoordinationSession | null;

  /**
   * Store shared context data visible to all domains.
   */
  setSharedContext(
    sessionId: UUID,
    key: string,
    value: string,
  ): FridaySetupCoordinationSession | null;

  /**
   * Get the current coordination session state.
   */
  getSession(sessionId: UUID): FridaySetupCoordinationSession | null;

  /**
   * Mark the session as failed.
   */
  failSession(sessionId: UUID, reason: string): FridaySetupCoordinationSession | null;

  /**
   * Terminate the coordination session.
   */
  closeSession(sessionId: UUID): FridaySetupCoordinationSession | null;
}

// ─── Coordinator Factory Dependencies ───

export interface CreateFridaySetupCoordinatorDeps {
  readonly idGenerator: () => UUID;
  readonly nowIso: () => ISODateTime;
}
