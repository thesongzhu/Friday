import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCommandPalette,
  fuzzyMatch,
} from "../../../../src/uix/engine/command-palette.js";
import type {
  CommandPalette,
  PaletteCommand,
} from "../../../../src/uix/engine/command-palette.js";

// ─── Fixtures ───

function makeCommand(overrides: Partial<PaletteCommand> = {}): PaletteCommand {
  return {
    id: "cmd-1",
    label: "Go to Dashboard",
    category: "navigation",
    keywords: ["home", "main"],
    enabled: true,
    requiredScopes: [],
    priority: 10,
    action: { type: "navigate", path: "/dashboard" },
    ...overrides,
  };
}

// ─── Tests ───

describe("fuzzyMatch", () => {
  it("returns 1.0 for exact match", () => {
    expect(fuzzyMatch("dashboard", "dashboard")).toBe(1.0);
  });

  it("returns high score for substring match", () => {
    const score = fuzzyMatch("dash", "dashboard");
    expect(score).toBeGreaterThan(0.8);
  });

  it("returns 0 when query characters are not found", () => {
    expect(fuzzyMatch("xyz", "dashboard")).toBe(0);
  });

  it("returns 0 for empty query", () => {
    expect(fuzzyMatch("", "dashboard")).toBe(0);
  });

  it("returns 0 for empty target", () => {
    expect(fuzzyMatch("dash", "")).toBe(0);
  });

  it("is case-insensitive", () => {
    const score = fuzzyMatch("DASH", "dashboard");
    expect(score).toBeGreaterThan(0);
  });

  it("matches subsequences", () => {
    const score = fuzzyMatch("dbd", "dashboard");
    expect(score).toBeGreaterThan(0);
  });

  it("gives higher score to word boundary matches", () => {
    const boundaryScore = fuzzyMatch("gs", "Go to Settings");
    const midScore = fuzzyMatch("gs", "debugging-session");
    expect(boundaryScore).toBeGreaterThanOrEqual(midScore);
  });
});

describe("CommandPalette", () => {
  let palette: CommandPalette;

  beforeEach(() => {
    palette = createCommandPalette();
  });

  describe("registry", () => {
    it("registers and retrieves a command", () => {
      const cmd = makeCommand();
      palette.registerCommand(cmd);
      expect(palette.getCommand("cmd-1")).toEqual(cmd);
    });

    it("returns undefined for unknown command", () => {
      expect(palette.getCommand("unknown")).toBeUndefined();
    });

    it("lists all commands sorted by priority", () => {
      palette.registerCommand(makeCommand({ id: "b", priority: 20 }));
      palette.registerCommand(makeCommand({ id: "a", priority: 5 }));
      const all = palette.getAllCommands();
      expect(all.map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("lists commands by category", () => {
      palette.registerCommand(makeCommand({ id: "nav", category: "navigation" }));
      palette.registerCommand(makeCommand({ id: "act", category: "actions" }));
      const navCmds = palette.getCommandsByCategory("navigation");
      expect(navCmds).toHaveLength(1);
      expect(navCmds[0].id).toBe("nav");
    });

    it("unregisters a command", () => {
      palette.registerCommand(makeCommand());
      expect(palette.unregisterCommand("cmd-1")).toBe(true);
      expect(palette.getCommand("cmd-1")).toBeUndefined();
    });

    it("returns false when unregistering unknown command", () => {
      expect(palette.unregisterCommand("unknown")).toBe(false);
    });
  });

  describe("search", () => {
    it("finds commands by label match", () => {
      palette.registerCommand(makeCommand({ id: "dash", label: "Go to Dashboard" }));
      palette.registerCommand(makeCommand({ id: "settings", label: "Open Settings" }));

      const results = palette.search("dashboard");
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe("dash");
    });

    it("finds commands by keyword match", () => {
      palette.registerCommand(makeCommand({ id: "dash", keywords: ["home", "main"] }));

      const results = palette.search("home");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].command.id).toBe("dash");
    });

    it("finds commands by description match", () => {
      palette.registerCommand(makeCommand({ id: "dash", description: "Navigate to the main dashboard" }));

      const results = palette.search("navigate");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("excludes disabled commands", () => {
      palette.registerCommand(makeCommand({ id: "disabled", enabled: false }));
      const results = palette.search("Dashboard");
      expect(results).toHaveLength(0);
    });

    it("filters by category", () => {
      palette.registerCommand(makeCommand({ id: "nav", category: "navigation" }));
      palette.registerCommand(makeCommand({ id: "act", category: "actions", label: "Go to Dashboard" }));

      const results = palette.search("Dashboard", { category: "navigation" });
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe("nav");
    });

    it("respects maxResults", () => {
      for (let i = 0; i < 5; i++) {
        palette.registerCommand(makeCommand({ id: `cmd-${i}`, label: `Command ${i}` }));
      }
      const results = palette.search("Command", { maxResults: 2 });
      expect(results).toHaveLength(2);
    });

    it("respects minScore", () => {
      palette.registerCommand(makeCommand({ id: "exact", label: "Dashboard" }));
      palette.registerCommand(makeCommand({ id: "weak", label: "Something entirely different" }));

      const results = palette.search("Dashboard", { minScore: 0.5 });
      expect(results.every((r) => r.score >= 0.5)).toBe(true);
    });

    it("filters by user scopes", () => {
      palette.registerCommand(makeCommand({ id: "admin", requiredScopes: ["admin"] }));
      palette.registerCommand(makeCommand({ id: "public", requiredScopes: [] }));

      const results = palette.search("Dashboard", { userScopes: ["user"] });
      expect(results.map((r) => r.command.id)).not.toContain("admin");
    });
  });

  describe("shortcuts", () => {
    it("finds command by shortcut", () => {
      palette.registerCommand(makeCommand({
        id: "search",
        shortcut: { key: "k", modifiers: ["meta"], displayLabel: "⌘K" },
      }));

      const cmd = palette.findByShortcut("k", ["meta"]);
      expect(cmd?.id).toBe("search");
    });

    it("returns undefined for unregistered shortcut", () => {
      expect(palette.findByShortcut("k", ["meta"])).toBeUndefined();
    });

    it("normalizes modifier order for lookup", () => {
      palette.registerCommand(makeCommand({
        id: "cmd",
        shortcut: { key: "p", modifiers: ["shift", "meta"], displayLabel: "⇧⌘P" },
      }));

      // Lookup with different order should still match
      const cmd = palette.findByShortcut("p", ["meta", "shift"]);
      expect(cmd?.id).toBe("cmd");
    });

    it("removes shortcut index on unregister", () => {
      palette.registerCommand(makeCommand({
        id: "cmd",
        shortcut: { key: "k", modifiers: ["meta"], displayLabel: "⌘K" },
      }));
      palette.unregisterCommand("cmd");
      expect(palette.findByShortcut("k", ["meta"])).toBeUndefined();
    });

    it("cleans stale shortcut bindings when re-registering an id with a new shortcut", () => {
      palette.registerCommand(makeCommand({
        id: "cmd",
        shortcut: { key: "k", modifiers: ["ctrl"], displayLabel: "Ctrl+K" },
      }));
      palette.registerCommand(makeCommand({
        id: "cmd",
        shortcut: { key: "j", modifiers: ["ctrl"], displayLabel: "Ctrl+J" },
      }));

      expect(palette.findByShortcut("k", ["ctrl"])).toBeUndefined();
      expect(palette.findByShortcut("j", ["ctrl"])?.id).toBe("cmd");
    });
  });

  describe("execution", () => {
    it("executes a callback command", () => {
      const handler = vi.fn();
      palette.registerCommand(makeCommand({
        id: "test",
        action: { type: "callback", handler },
      }));

      expect(palette.execute("test")).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("returns true for navigate commands without calling handler", () => {
      palette.registerCommand(makeCommand({
        id: "nav",
        action: { type: "navigate", path: "/test" },
      }));
      expect(palette.execute("nav")).toBe(true);
    });

    it("returns false for unknown command", () => {
      expect(palette.execute("unknown")).toBe(false);
    });

    it("returns false for disabled command", () => {
      palette.registerCommand(makeCommand({ id: "disabled", enabled: false }));
      expect(palette.execute("disabled")).toBe(false);
    });
  });

  describe("available commands", () => {
    it("filters by scopes and enabled status", () => {
      palette.registerCommand(makeCommand({ id: "admin", requiredScopes: ["admin"] }));
      palette.registerCommand(makeCommand({ id: "public", requiredScopes: [] }));
      palette.registerCommand(makeCommand({ id: "disabled", enabled: false }));

      const available = palette.getAvailableCommands(["user"]);
      expect(available.map((c) => c.id)).toEqual(["public"]);
    });
  });
});
