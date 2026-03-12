/**
 * Command Palette — Searchable command registry with keyboard shortcuts
 * and fuzzy matching.
 *
 * Provides a registry of executable commands that can be discovered
 * through text search, keyboard shortcuts, or category browsing.
 *
 * @module uix/engine
 */

import type {
  JsonObject,
} from "../model/friday-uix.types.js";

// ─── Types ───

/** A keyboard shortcut definition. */
export interface KeyboardShortcut {
  /** Primary key (e.g., "k", "Enter", "Escape"). */
  key: string;
  /** Modifier keys required. */
  modifiers: ShortcutModifier[];
  /** Human-readable label (e.g., "⌘K"). */
  displayLabel: string;
}

/** Modifier keys for keyboard shortcuts. */
export type ShortcutModifier = "ctrl" | "shift" | "alt" | "meta";

/** A registered command in the palette. */
export interface PaletteCommand {
  /** Unique command identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Short description. */
  description?: string;
  /** Icon identifier. */
  icon?: string;
  /** Category for grouping (e.g., "navigation", "actions", "settings"). */
  category: string;
  /** Search keywords (matched in addition to label/description). */
  keywords: string[];
  /** Keyboard shortcut. */
  shortcut?: KeyboardShortcut;
  /** Whether this command is currently enabled. */
  enabled: boolean;
  /** Required scopes to see/execute this command. Empty = unrestricted. */
  requiredScopes: string[];
  /** Sort priority within search results. Lower = shown first. */
  priority: number;
  /** The action to execute. */
  action: PaletteCommandAction;
}

/** Action payload for a palette command. */
export type PaletteCommandAction =
  | { type: "navigate"; path: string }
  | { type: "callback"; handler: () => void }
  | { type: "dispatch"; event: string; payload?: JsonObject };

/** A search result entry from the command palette. */
export interface PaletteSearchResult {
  /** The matched command. */
  command: PaletteCommand;
  /** Fuzzy match score (0.0–1.0). Higher = better match. */
  score: number;
}

/** Read/write interface for the command palette. */
export interface CommandPalette {
  // ─── Registry ───
  registerCommand(command: PaletteCommand): void;
  unregisterCommand(id: string): boolean;
  getCommand(id: string): PaletteCommand | undefined;
  getAllCommands(): PaletteCommand[];
  getCommandsByCategory(category: string): PaletteCommand[];

  // ─── Search ───
  search(query: string, options?: PaletteSearchOptions): PaletteSearchResult[];

  // ─── Shortcut Lookup ───
  findByShortcut(key: string, modifiers: ShortcutModifier[]): PaletteCommand | undefined;

  // ─── Execution ───
  execute(commandId: string): boolean;

  // ─── Filtering ───
  getAvailableCommands(userScopes: string[]): PaletteCommand[];
}

/** Options for command palette search. */
export interface PaletteSearchOptions {
  /** Maximum results to return. @default 20 */
  maxResults?: number;
  /** Minimum fuzzy match score (0.0–1.0). @default 0.1 */
  minScore?: number;
  /** Filter to a specific category. */
  category?: string;
  /** User scopes for permission filtering. */
  userScopes?: string[];
}

// ─── Fuzzy Matching ───

/**
 * Compute a fuzzy match score for a query against a target string.
 * Returns a score between 0.0 (no match) and 1.0 (exact match).
 *
 * Uses a subsequence matching algorithm with bonuses for:
 * - Consecutive character matches
 * - Matches at word boundaries
 * - Matches at the start of the string
 */
export function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return 0;
  if (t.length === 0) return 0;
  if (q === t) return 1.0;
  if (t.includes(q)) return 0.8 + (q.length / t.length) * 0.2;

  let score = 0;
  let queryIndex = 0;
  let consecutive = 0;
  let firstMatchBonus = false;

  for (let i = 0; i < t.length && queryIndex < q.length; i++) {
    if (t[i] === q[queryIndex]) {
      score += 1;

      // Bonus for consecutive matches
      if (consecutive > 0) {
        score += consecutive * 0.5;
      }
      consecutive++;

      // Bonus for matching at word boundary
      if (i === 0 || t[i - 1] === " " || t[i - 1] === "-" || t[i - 1] === "_") {
        score += 0.5;
      }

      // Bonus for first character match
      if (i === 0 && queryIndex === 0) {
        firstMatchBonus = true;
      }

      queryIndex++;
    } else {
      consecutive = 0;
    }
  }

  // All query characters must match
  if (queryIndex < q.length) return 0;

  // Normalize score
  const maxPossible = q.length + (q.length - 1) * 0.5 * q.length + q.length * 0.5 + 1;
  let normalized = score / maxPossible;

  if (firstMatchBonus) normalized += 0.05;

  return Math.min(1.0, Math.max(0, normalized));
}

// ─── Factory ───

/** Default maximum search results. */
const DEFAULT_MAX_RESULTS = 20;

/** Default minimum fuzzy match score threshold. */
const DEFAULT_MIN_SCORE = 0.1;

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as unknown as T;
  }
  if (typeof value === "object") {
    const cloned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneValue(entry);
    }
    return cloned as T;
  }
  return value;
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
  const cloned = cloneValue(value);
  if (cloned !== null && typeof cloned === "object") {
    deepFreeze(cloned, new WeakSet());
  }
  return cloned;
}

/** Create a command palette instance. */
export function createCommandPalette(): CommandPalette {
  const commands = new Map<string, PaletteCommand>();
  /** Index: shortcut key string → command ID. */
  const shortcutIndex = new Map<string, string>();
  /** Re-registration counter for deterministic shortcut replacement. */
  const registrationOrder = new Map<string, number>();
  let registrationCounter = 0;

  function shortcutKey(key: string, modifiers: ShortcutModifier[]): string {
    const sorted = modifiers.slice().sort();
    return `${sorted.join("+")}+${key.toLowerCase()}`;
  }

  function matchScore(command: PaletteCommand, query: string): number {
    const scores = [
      fuzzyMatch(query, command.label),
      command.description ? fuzzyMatch(query, command.description) * 0.7 : 0,
      ...command.keywords.map((kw) => fuzzyMatch(query, kw) * 0.6),
    ];
    return Math.max(...scores);
  }

  function findLatestCommandIdForShortcut(shortcut: string, excludedId?: string): string | undefined {
    let latestId: string | undefined;
    let latestOrder: number | undefined;

    for (const [id, command] of commands) {
      if (excludedId !== undefined && id === excludedId) continue;
      if (!command.shortcut) continue;
      const currentShortcut = shortcutKey(command.shortcut.key, command.shortcut.modifiers);
      if (currentShortcut !== shortcut) continue;

      const order = registrationOrder.get(id);
      if (order === undefined) continue;
      if (latestOrder === undefined || order > latestOrder) {
        latestOrder = order;
        latestId = id;
      }
    }

    return latestId;
  }

  function reindexShortcut(shortcut: string, excludedId?: string): void {
    const latestId = findLatestCommandIdForShortcut(shortcut, excludedId);
    if (latestId === undefined) {
      shortcutIndex.delete(shortcut);
      return;
    }
    shortcutIndex.set(shortcut, latestId);
  }

  return {
    // ─── Registry ───

    registerCommand(command) {
      const existing = commands.get(command.id);
      if (existing?.shortcut) {
        const oldShortcut = shortcutKey(existing.shortcut.key, existing.shortcut.modifiers);
        if (shortcutIndex.get(oldShortcut) === command.id) {
          shortcutIndex.delete(oldShortcut);
          reindexShortcut(oldShortcut, command.id);
        }
      }

      const storedCommand = cloneValue(command);
      commands.set(storedCommand.id, storedCommand);
      registrationOrder.set(storedCommand.id, ++registrationCounter);

      if (storedCommand.shortcut) {
        const sk = shortcutKey(storedCommand.shortcut.key, storedCommand.shortcut.modifiers);
        shortcutIndex.set(sk, storedCommand.id);
      }
    },

    unregisterCommand(id) {
      const command = commands.get(id);
      if (!command) return false;
      commands.delete(id);
      registrationOrder.delete(id);

      if (command.shortcut) {
        const sk = shortcutKey(command.shortcut.key, command.shortcut.modifiers);
        if (shortcutIndex.get(sk) === id) {
          shortcutIndex.delete(sk);
          reindexShortcut(sk);
        }
      }
      return true;
    },

    getCommand(id) {
      const command = commands.get(id);
      return command !== undefined ? cloneAndFreeze(command) : undefined;
    },

    getAllCommands() {
      return cloneAndFreeze([...commands.values()].sort((a, b) => a.priority - b.priority));
    },

    getCommandsByCategory(category) {
      const result: PaletteCommand[] = [];
      for (const cmd of commands.values()) {
        if (cmd.category === category) result.push(cmd);
      }
      return cloneAndFreeze(result.sort((a, b) => a.priority - b.priority));
    },

    // ─── Search ───

    search(query, options = {}) {
      const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
      const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
      const results: PaletteSearchResult[] = [];

      for (const command of commands.values()) {
        if (!command.enabled) continue;
        if (options.category && command.category !== options.category) continue;
        if (
          options.userScopes &&
          command.requiredScopes.length > 0 &&
          !command.requiredScopes.some((s) => options.userScopes!.includes(s))
        ) {
          continue;
        }

        const score = matchScore(command, query);
        if (score >= minScore) {
          results.push({ command, score });
        }
      }

      results.sort((a, b) => {
        // Primary: score descending
        if (b.score !== a.score) return b.score - a.score;
        // Secondary: priority ascending
        return a.command.priority - b.command.priority;
      });

      return cloneAndFreeze(results.slice(0, maxResults));
    },

    // ─── Shortcut Lookup ───

    findByShortcut(key, modifiers) {
      const sk = shortcutKey(key, modifiers);
      const id = shortcutIndex.get(sk);
      if (id === undefined) return undefined;
      const command = commands.get(id);
      return command !== undefined ? cloneAndFreeze(command) : undefined;
    },

    // ─── Execution ───

    execute(commandId) {
      const command = commands.get(commandId);
      if (!command || !command.enabled) return false;

      if (command.action.type === "callback") {
        command.action.handler();
      }
      // "navigate" and "dispatch" are informational — caller handles them.
      return true;
    },

    // ─── Filtering ───

    getAvailableCommands(userScopes) {
      const result: PaletteCommand[] = [];
      for (const cmd of commands.values()) {
        if (!cmd.enabled) continue;
        if (
          cmd.requiredScopes.length > 0 &&
          !cmd.requiredScopes.some((s) => userScopes.includes(s))
        ) {
          continue;
        }
        result.push(cmd);
      }
      return cloneAndFreeze(result.sort((a, b) => a.priority - b.priority));
    },
  };
}
