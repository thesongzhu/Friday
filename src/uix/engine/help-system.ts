/**
 * Help System — Contextual help, tooltips, guided tours,
 * and documentation links.
 *
 * Provides a registry of help content indexed by context keys,
 * guided tour definitions, and tooltip management.
 *
 * @module uix/engine
 */

import type {
  ISODateTime,
} from "../model/friday-uix.types.js";

// ─── Types ───

/** Type of help content. */
export type HelpContentType = "tooltip" | "article" | "video" | "faq" | "walkthrough";

/** A single help content entry. */
export interface HelpArticle {
  /** Unique article identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Short summary (shown in tooltips and previews). */
  summary: string;
  /** Full content body (markdown). */
  body?: string;
  /** Content type. */
  type: HelpContentType;
  /** Context keys this article is relevant for (e.g., "settings.notifications", "workflow.editor"). */
  contextKeys: string[];
  /** External documentation URL. */
  externalUrl?: string;
  /** Tags for search. */
  tags: string[];
  /** Sort priority. Lower = shown first. */
  priority: number;
}

/** A tooltip definition bound to a UI element. */
export interface TooltipDefinition {
  /** Unique tooltip identifier. */
  id: string;
  /** Context key (matches the UI element's data attribute). */
  contextKey: string;
  /** Tooltip title (optional header). */
  title?: string;
  /** Tooltip content text. */
  content: string;
  /** Link to a more detailed help article. */
  articleId?: string;
  /** Preferred tooltip placement. */
  placement: TooltipPlacement;
}

/** Tooltip placement relative to the trigger element. */
export type TooltipPlacement = "top" | "bottom" | "left" | "right" | "auto";

/** A single step in a guided tour. */
export interface TourStep {
  /** Step identifier. */
  id: string;
  /** Target element context key or CSS selector. */
  target: string;
  /** Step title. */
  title: string;
  /** Step content (markdown). */
  content: string;
  /** Tooltip placement for this step's highlight. */
  placement: TooltipPlacement;
  /** Sort order (0-indexed). */
  sortOrder: number;
  /** Optional action the user must perform to advance (e.g., "click", "input"). */
  requiredAction?: string;
}

/** A guided tour definition. */
export interface GuidedTour {
  /** Unique tour identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Ordered steps in the tour. */
  steps: TourStep[];
  /** Whether this tour is currently active/available. */
  enabled: boolean;
  /** Context key prefix — the tour is suggested when the user visits pages matching this prefix. */
  contextPrefix?: string;
  /** Tags for categorization. */
  tags: string[];
}

/** Status of a tour session. */
export type TourSessionStatus = "in_progress" | "completed" | "skipped";

/** Per-user tour session state. */
export interface TourSession {
  /** Tour ID. */
  tourId: string;
  /** User principal ID. */
  principalId: string;
  /** Session status. */
  status: TourSessionStatus;
  /** Current step index. */
  currentStepIndex: number;
  /** When the tour was started. */
  startedAt: ISODateTime;
  /** When the tour was completed or skipped. */
  finishedAt?: ISODateTime;
}

/** Search result for help content. */
export interface HelpSearchResult {
  /** Matched article. */
  article: HelpArticle;
  /** Relevance score (0.0–1.0). */
  score: number;
}

/** Read/write interface for the help system. */
export interface HelpSystem {
  // ─── Articles ───
  registerArticle(article: HelpArticle): void;
  unregisterArticle(id: string): boolean;
  getArticle(id: string): HelpArticle | undefined;
  getArticlesByContext(contextKey: string): HelpArticle[];
  searchArticles(query: string, maxResults?: number): HelpSearchResult[];

  // ─── Tooltips ───
  registerTooltip(tooltip: TooltipDefinition): void;
  unregisterTooltip(id: string): boolean;
  getTooltip(contextKey: string): TooltipDefinition | undefined;
  getAllTooltips(): TooltipDefinition[];

  // ─── Guided Tours ───
  registerTour(tour: GuidedTour): void;
  unregisterTour(id: string): boolean;
  getTour(id: string): GuidedTour | undefined;
  getToursForContext(contextKey: string): GuidedTour[];
  getAllTours(): GuidedTour[];

  // ─── Tour Sessions ───
  startTour(tourId: string, principalId: string): TourSession | undefined;
  advanceTour(tourId: string, principalId: string): TourSession | undefined;
  rewindTour(tourId: string, principalId: string, targetStepIndex: number): TourSession | undefined;
  skipTour(tourId: string, principalId: string): TourSession | undefined;
  getTourSession(tourId: string, principalId: string): TourSession | undefined;
  getCompletedTours(principalId: string): string[];
}

// ─── Helpers ───

function simpleTextScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 1.0;
  if (t.includes(q)) return 0.6 + (q.length / t.length) * 0.3;

  // Word-level matching
  const queryWords = q.split(/\s+/);
  const matchedWords = queryWords.filter((w) => t.includes(w));
  return queryWords.length > 0 ? (matchedWords.length / queryWords.length) * 0.5 : 0;
}

function now(): ISODateTime {
  return new Date().toISOString();
}

function deepFreeze(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) return;
  seen.add(value);

  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      deepFreeze(child, seen);
    }
  }

  Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  if (cloned !== null && typeof cloned === "object") {
    deepFreeze(cloned, new WeakSet());
  }
  return cloned;
}

// ─── Factory ───

/** Create a help system instance. */
export function createHelpSystem(): HelpSystem {
  const articles = new Map<string, HelpArticle>();
  const tooltips = new Map<string, TooltipDefinition>();
  /** Secondary index: context key → tooltip ID. */
  const tooltipByContext = new Map<string, string>();
  /** Registration order index for deterministic context replacement. */
  const tooltipOrderById = new Map<string, number>();
  const tours = new Map<string, GuidedTour>();
  /** Tour sessions: `${tourId}:${principalId}` → TourSession. */
  const tourSessions = new Map<string, TourSession>();
  /** Highest reached step index by session key. */
  const maxVisitedStepBySession = new Map<string, number>();
  let tooltipOrderCounter = 0;

  function tourSessionKey(tourId: string, principalId: string): string {
    return `${tourId}:${principalId}`;
  }

  function findLatestTooltipIdForContext(contextKey: string): string | undefined {
    let latestId: string | undefined;
    let latestOrder: number | undefined;

    for (const [id, tooltip] of tooltips) {
      if (tooltip.contextKey !== contextKey) continue;
      const order = tooltipOrderById.get(id);
      if (order === undefined) continue;
      if (latestOrder === undefined || order > latestOrder) {
        latestOrder = order;
        latestId = id;
      }
    }

    return latestId;
  }

  function reindexTooltipContext(contextKey: string): void {
    const latestId = findLatestTooltipIdForContext(contextKey);
    if (latestId === undefined) {
      tooltipByContext.delete(contextKey);
      return;
    }
    tooltipByContext.set(contextKey, latestId);
  }

  function updateMaxVisitedStep(key: string, stepIndex: number): void {
    const currentMax = maxVisitedStepBySession.get(key);
    if (currentMax === undefined || stepIndex > currentMax) {
      maxVisitedStepBySession.set(key, stepIndex);
    }
  }

  return {
    // ─── Articles ───

    registerArticle(article) {
      articles.set(article.id, structuredClone(article));
    },

    unregisterArticle(id) {
      return articles.delete(id);
    },

    getArticle(id) {
      const article = articles.get(id);
      return article !== undefined ? cloneAndFreeze(article) : undefined;
    },

    getArticlesByContext(contextKey) {
      const result: HelpArticle[] = [];
      for (const article of articles.values()) {
        if (article.contextKeys.some((ck) =>
          contextKey === ck || contextKey.startsWith(ck + ".")
        )) {
          result.push(article);
        }
      }
      return cloneAndFreeze(result.sort((a, b) => a.priority - b.priority));
    },

    searchArticles(query, maxResults = 10) {
      const results: HelpSearchResult[] = [];

      for (const article of articles.values()) {
        const titleScore = simpleTextScore(query, article.title);
        const summaryScore = simpleTextScore(query, article.summary) * 0.7;
        const tagScore = Math.max(
          0,
          ...article.tags.map((t) => simpleTextScore(query, t) * 0.5),
        );
        const score = Math.max(titleScore, summaryScore, tagScore);

        if (score > 0.1) {
          results.push({ article, score });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return cloneAndFreeze(results.slice(0, maxResults));
    },

    // ─── Tooltips ───

    registerTooltip(tooltip) {
      const previous = tooltips.get(tooltip.id);
      tooltips.set(tooltip.id, structuredClone(tooltip));
      tooltipOrderById.set(tooltip.id, ++tooltipOrderCounter);

      if (previous && previous.contextKey !== tooltip.contextKey) {
        if (tooltipByContext.get(previous.contextKey) === tooltip.id) {
          reindexTooltipContext(previous.contextKey);
        }
      }
      tooltipByContext.set(tooltip.contextKey, tooltip.id);
    },

    unregisterTooltip(id) {
      const tooltip = tooltips.get(id);
      if (!tooltip) return false;

      tooltips.delete(id);
      tooltipOrderById.delete(id);

      if (tooltipByContext.get(tooltip.contextKey) === id) {
        reindexTooltipContext(tooltip.contextKey);
      }
      return true;
    },

    getTooltip(contextKey) {
      const id = tooltipByContext.get(contextKey);
      if (id === undefined) return undefined;
      const tooltip = tooltips.get(id);
      return tooltip !== undefined ? cloneAndFreeze(tooltip) : undefined;
    },

    getAllTooltips() {
      return cloneAndFreeze([...tooltips.values()]);
    },

    // ─── Guided Tours ───

    registerTour(tour) {
      tours.set(tour.id, structuredClone(tour));
    },

    unregisterTour(id) {
      return tours.delete(id);
    },

    getTour(id) {
      const tour = tours.get(id);
      return tour !== undefined ? cloneAndFreeze(tour) : undefined;
    },

    getToursForContext(contextKey) {
      const result: GuidedTour[] = [];
      for (const tour of tours.values()) {
        if (!tour.enabled) continue;
        if (tour.contextPrefix && contextKey.startsWith(tour.contextPrefix)) {
          result.push(tour);
        }
      }
      return cloneAndFreeze(result);
    },

    getAllTours() {
      return cloneAndFreeze([...tours.values()]);
    },

    // ─── Tour Sessions ───

    startTour(tourId, principalId) {
      const tour = tours.get(tourId);
      if (!tour || !tour.enabled || tour.steps.length === 0) return undefined;

      const key = tourSessionKey(tourId, principalId);
      const existing = tourSessions.get(key);
      if (existing && existing.status === "in_progress") return cloneAndFreeze(existing);

      const session: TourSession = {
        tourId,
        principalId,
        status: "in_progress",
        currentStepIndex: 0,
        startedAt: now(),
      };
      tourSessions.set(key, session);
      maxVisitedStepBySession.set(key, 0);
      return cloneAndFreeze(session);
    },

    advanceTour(tourId, principalId) {
      const key = tourSessionKey(tourId, principalId);
      const session = tourSessions.get(key);
      if (!session || session.status !== "in_progress") return undefined;

      const tour = tours.get(tourId);
      if (!tour) return undefined;

      const nextIndex = session.currentStepIndex + 1;
      if (nextIndex >= tour.steps.length) {
        session.status = "completed";
        session.finishedAt = now();
      } else {
        session.currentStepIndex = nextIndex;
        updateMaxVisitedStep(key, nextIndex);
      }

      return cloneAndFreeze(session);
    },

    rewindTour(tourId, principalId, targetStepIndex) {
      const key = tourSessionKey(tourId, principalId);
      const session = tourSessions.get(key);
      if (!session || session.status !== "in_progress") return undefined;

      if (!Number.isFinite(targetStepIndex) || !Number.isInteger(targetStepIndex)) return undefined;
      const maxVisited = maxVisitedStepBySession.get(key) ?? session.currentStepIndex;
      if (targetStepIndex < 0) return undefined;
      if (targetStepIndex > session.currentStepIndex) return undefined;
      if (targetStepIndex > maxVisited) return undefined;

      session.currentStepIndex = targetStepIndex;
      return cloneAndFreeze(session);
    },

    skipTour(tourId, principalId) {
      const key = tourSessionKey(tourId, principalId);
      const session = tourSessions.get(key);
      if (!session || session.status !== "in_progress") return undefined;

      session.status = "skipped";
      session.finishedAt = now();
      return cloneAndFreeze(session);
    },

    getTourSession(tourId, principalId) {
      const session = tourSessions.get(tourSessionKey(tourId, principalId));
      return session !== undefined ? cloneAndFreeze(session) : undefined;
    },

    getCompletedTours(principalId) {
      const completed: string[] = [];
      for (const session of tourSessions.values()) {
        if (session.principalId === principalId && session.status === "completed") {
          completed.push(session.tourId);
        }
      }
      return cloneAndFreeze(completed);
    },
  };
}
