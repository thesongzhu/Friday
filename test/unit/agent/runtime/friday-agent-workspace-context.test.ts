/**
 * Workspace context loader tests — verifies that AGENTS.md, BELIEFS.md,
 * SOUL.md, USER.md, MEMORY.md, daily memory files, and exported memory items
 * are correctly loaded and injected into the system prompt.
 *
 * Also verifies the memory feedback loop: memory_store → SQLite →
 * file sync export → workspace loader → system prompt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { loadFridayWorkspaceContext } from "../../../../src/agent/runtime/friday-agent-workspace-context.js";
import type { FridayConversationBlock } from "../../../../src/sessions/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-ws-ctx-"));
  await fs.mkdir(path.join(tmpDir, "context"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadFridayWorkspaceContext", () => {
  describe("workspace file loading", () => {
    it("loads AGENTS.md when present", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "# Agent Instructions\nDo X, Y, Z.");
      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("AGENTS.md");
      expect(ctx.promptFragment).toContain("Do X, Y, Z.");
    });

    it("loads BELIEFS.md as an identity block when present", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "BELIEFS.md"), "# Engineering Principles\nNo claim without working code.");
      const ctx = await loadFridayWorkspaceContext(tmpDir);
      const beliefsFile = ctx.files.find((file) => file.name === "context/BELIEFS.md");
      expect(beliefsFile).toMatchObject({ missing: false, kind: "identity" });
      expect(ctx.promptFragment).toContain("BELIEFS.md");
      expect(ctx.promptFragment).toContain("No claim without working code.");
    });

    it("loads SOUL.md when present", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "# Personality\nBe helpful and concise.");
      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("SOUL.md");
      expect(ctx.promptFragment).toContain("Be helpful and concise.");
    });

    it("loads USER.md when present", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "USER.md"), "# User\nName: Alex\nLanguage: Chinese");
      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("USER.md");
      expect(ctx.promptFragment).toContain("Alex");
    });

    it("loads MEMORY.md when present", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "MEMORY.md"), "# Memory\n- User prefers dark mode");
      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("MEMORY.md");
      expect(ctx.promptFragment).toContain("dark mode");
    });

    it("returns empty prompt fragment when no workspace files exist", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ctx = await loadFridayWorkspaceContext(tmpDir);
        expect(ctx.promptFragment).toBe("");
        // All files should be marked missing
        const missing = ctx.files.filter((f) => f.missing);
        expect(missing.length).toBeGreaterThanOrEqual(6);
        expect(missing.map((file) => file.name)).toEqual(expect.arrayContaining([
          "context/AGENTS.md",
          "context/BELIEFS.md",
          "context/SOUL.md",
          "context/USER.md",
          "context/MEMORY.md",
          "context/memory.md",
        ]));
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("loads multiple files in injection order", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "agents-content");
      await fs.writeFile(path.join(tmpDir, "context", "BELIEFS.md"), "beliefs-content");
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "soul-content");
      await fs.writeFile(path.join(tmpDir, "context", "USER.md"), "user-content");

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      const agentsIdx = ctx.promptFragment.indexOf("agents-content");
      const beliefsIdx = ctx.promptFragment.indexOf("beliefs-content");
      const soulIdx = ctx.promptFragment.indexOf("soul-content");
      const userIdx = ctx.promptFragment.indexOf("user-content");

      // Identity blocks load before candidate blocks in documented order.
      expect(agentsIdx).toBeLessThan(soulIdx);
      expect(agentsIdx).toBeLessThan(beliefsIdx);
      expect(beliefsIdx).toBeLessThan(soulIdx);
      expect(soulIdx).toBeLessThan(userIdx);
    });

    it("deduplicates MEMORY.md and memory.md pointing to same file", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "MEMORY.md"), "memory content here");
      // Create a symlink from memory.md → MEMORY.md
      try {
        await fs.symlink(
          path.join(tmpDir, "context", "MEMORY.md"),
          path.join(tmpDir, "context", "memory.md"),
        );
      } catch {
        // Symlinks may not be available on all platforms — skip dedup test
        return;
      }

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      // Should only appear once
      const memoryOccurrences = ctx.promptFragment.split("memory content here").length - 1;
      expect(memoryOccurrences).toBe(1);
    });

    it("truncates files larger than 32KB", async () => {
      const largeContent = "x".repeat(40_000);
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), largeContent);

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      const agentsFile = ctx.files.find((f) => f.name === "context/AGENTS.md");
      expect(agentsFile).toBeDefined();
      expect(agentsFile!.content!.length).toBeLessThan(40_000);
      expect(agentsFile!.content).toContain("...(truncated)");
    });

    it("skips empty files", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "");
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "real content");

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      // AGENTS.md content is empty, should not appear in prompt
      expect(ctx.promptFragment).not.toContain("## AGENTS.md");
      expect(ctx.promptFragment).toContain("## SOUL.md");
    });
  });

  describe("daily memory files", () => {
    it("loads today's daily memory file", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const memoryDir = path.join(tmpDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(
        path.join(memoryDir, `${today}.md`),
        "# Today\n- Had a productive meeting\n- Fixed 3 bugs",
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("productive meeting");
      expect(ctx.promptFragment).toContain("Fixed 3 bugs");
    });

    it("does not fail when memory directory does not exist", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ctx = await loadFridayWorkspaceContext(tmpDir);
        // Should not throw
        expect(ctx.promptFragment).toBeDefined();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("memory export feedback loop", () => {
    it("skips exported compaction memory items because context replay owns compaction recovery", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });

      const exported = {
        namespace: "compaction.summary",
        exportedAt: "2026-03-03T10:00:00Z",
        items: [
          {
            id: "mem-1",
            contentText: "Compaction summary says the deployment wiring was already validated.",
            tags: ["compaction", "summary"],
            createdAt: "2026-03-01T08:00:00Z",
          },
          {
            id: "mem-2",
            contentText: "Compaction summary says the rollback path was tested.",
            tags: ["compaction"],
            createdAt: "2026-03-02T14:30:00Z",
          },
        ],
      };

      await fs.writeFile(
        path.join(exportDir, "agent_session_123_abc.json"),
        JSON.stringify(exported),
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).not.toContain("deployment wiring was already validated");
      expect(ctx.promptFragment).not.toContain("rollback path was tested");
      expect(ctx.promptFragment).not.toContain("[compaction, summary]");
      expect(ctx.promptFragment).not.toContain("stored-memories");
    });

    it("skips multiple exported compaction memory files", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });

      const ns1 = {
        namespace: "compaction.summary",
        items: [{ id: "1", contentText: "Compaction memory from export 1", tags: [], createdAt: "2026-03-01" }],
      };
      const ns2 = {
        namespace: "compaction.summary",
        items: [{ id: "2", contentText: "Compaction memory from export 2", tags: [], createdAt: "2026-03-02" }],
      };

      await fs.writeFile(path.join(exportDir, "ns1_abc.json"), JSON.stringify(ns1));
      await fs.writeFile(path.join(exportDir, "ns2_def.json"), JSON.stringify(ns2));

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).not.toContain("Compaction memory from export 1");
      expect(ctx.promptFragment).not.toContain("Compaction memory from export 2");
    });

    it("skips all exported memories so durable user facts stay behind explicit memory APIs", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });

      await fs.writeFile(
        path.join(exportDir, "agent_memory_blocked.json"),
        JSON.stringify({
          namespace: "agent:session:123",
          items: [
            {
              id: "pref-1",
              contentText: "User prefers to be called MemoryAuditName-leak",
              tags: ["user_preference", "name"],
              createdAt: "2026-03-02",
            },
          ],
        }),
      );
      await fs.writeFile(
        path.join(exportDir, "allowed.json"),
        JSON.stringify({
          namespace: "compaction.summary",
          items: [{ id: "2", contentText: "Visible exported memory", tags: [], createdAt: "2026-03-02" }],
        }),
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).not.toContain("Visible exported memory");
      expect(ctx.promptFragment).not.toContain("MemoryAuditName-leak");
    });

    it("skips malformed JSON files gracefully", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });

      await fs.writeFile(path.join(exportDir, "bad.json"), "not valid json{{{");
      await fs.writeFile(
        path.join(exportDir, "good.json"),
        JSON.stringify({
          namespace: "compaction.summary",
          items: [{ id: "1", contentText: "Valid memory", tags: [], createdAt: "2026-03-03" }],
        }),
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).not.toContain("Valid memory");
    });

    it("skips items without contentText or value", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });

      const exported = {
        namespace: "compaction.summary",
        items: [
          { id: "1", contentText: null, value: null, tags: [] },
          { id: "2", contentText: "Has content", tags: [], createdAt: "2026-03-03" },
        ],
      };

      await fs.writeFile(path.join(exportDir, "test.json"), JSON.stringify(exported));

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).not.toContain("Has content");
    });

    it("returns empty when no exports directory exists", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // No .friday/exports/memory/ directory
        const ctx = await loadFridayWorkspaceContext(tmpDir);
        // Should not fail
        expect(ctx.promptFragment).toBeDefined();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("respects max 100 memory items limit", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });

      const items = Array.from({ length: 150 }, (_, i) => ({
        id: `mem-${String(i)}`,
        contentText: `Memory item number ${String(i)}`,
        tags: [],
        createdAt: "2026-03-03",
      }));

      await fs.writeFile(
        path.join(exportDir, "big_ns.json"),
        JSON.stringify({ namespace: "compaction.summary", items }),
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      // Should have no exported memory prompt items while the allowlist is empty.
      const lines = ctx.promptFragment.split("\n").filter((l) => l.startsWith("- Memory item number"));
      expect(lines.length).toBe(0);
    });
  });

  describe("prompt fragment structure", () => {
    it("wraps content in Workspace Context header", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "test content");
      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("# Workspace Context");
    });

    it("uses ## headers for each file section", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "agents");
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "soul");

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      expect(ctx.promptFragment).toContain("## AGENTS.md");
      expect(ctx.promptFragment).toContain("## SOUL.md");
    });

    it("respects total context size limit of 64KB", async () => {
      // Write large files that together exceed 64KB
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "a".repeat(30_000));
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "b".repeat(30_000));
      await fs.writeFile(path.join(tmpDir, "context", "USER.md"), "c".repeat(30_000));

      const ctx = await loadFridayWorkspaceContext(tmpDir);
      // Total should be capped
      expect(ctx.promptFragment.length).toBeLessThan(70_000); // Some overhead for headers
      expect(ctx.summary.promptChars).toBe(ctx.promptFragment.length);
    });
  });

  describe("task-aware relevant block selection", () => {
    it("annotates identity and candidate files with selection metadata", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "Always follow repository instructions.");
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "Stay concise.");
      await fs.writeFile(path.join(tmpDir, "context", "USER.md"), "User likes sourdough recipes.");
      await fs.writeFile(path.join(tmpDir, "context", "MEMORY.md"), "User prefers dark mode in editors.");

      const ctx = await loadFridayWorkspaceContext(tmpDir, {
        task: "How do I bake sourdough bread?",
      });

      const agentsFile = ctx.files.find((file) => file.name === "context/AGENTS.md");
      const soulFile = ctx.files.find((file) => file.name === "context/SOUL.md");
      const userFile = ctx.files.find((file) => file.name === "context/USER.md");
      const memoryFile = ctx.files.find((file) => file.name === "context/MEMORY.md");

      expect(agentsFile?.kind).toBe("identity");
      expect(agentsFile?.selected).toBe(true);
      expect(agentsFile?.selectionReason).toContain("identity block");

      expect(soulFile?.kind).toBe("identity");
      expect(soulFile?.selected).toBe(true);
      expect(soulFile?.selectionReason).toContain("identity block");

      expect(userFile?.kind).toBe("candidate");
      expect(userFile?.selected).toBe(true);
      expect(userFile?.selectionReason).toContain("task overlap");

      expect(memoryFile?.kind).toBe("candidate");
      expect(memoryFile?.selected).toBe(false);
      expect(memoryFile?.selectionReason).toContain("not selected for the current task");
    });

    it("keeps identity blocks and filters candidate blocks by task relevance", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "AGENTS.md"), "Always follow repository instructions.");
      await fs.writeFile(path.join(tmpDir, "context", "SOUL.md"), "Stay concise.");
      await fs.writeFile(path.join(tmpDir, "context", "USER.md"), "User likes sourdough recipes.");
      await fs.writeFile(path.join(tmpDir, "context", "MEMORY.md"), "User prefers dark mode in editors.");

      const ctx = await loadFridayWorkspaceContext(tmpDir, {
        task: "How do I bake sourdough bread?",
      });

      expect(ctx.promptFragment).toContain("## AGENTS.md");
      expect(ctx.promptFragment).toContain("## SOUL.md");
      expect(ctx.promptFragment).toContain("sourdough recipes");
      expect(ctx.promptFragment).not.toContain("dark mode in editors");
    });

    it("does not use selected session blocks to pull exported compaction memory into generic follow-ups", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(
        path.join(exportDir, "session.json"),
        JSON.stringify({
          namespace: "compaction.summary",
          items: [
            {
              id: "mem-1",
              contentText: "Compaction summary: GitHub browser issue was caused by browser not connected",
              tags: ["incident"],
              createdAt: "2026-03-16T10:00:00Z",
            },
            {
              id: "mem-2",
              contentText: "Compaction summary: unrelated note about sourdough hydration",
              tags: ["recipe"],
              createdAt: "2026-03-15T10:00:00Z",
            },
          ],
        }),
      );

      const selectedBlocks: FridayConversationBlock[] = [
        {
          id: "reply:1",
          source: "reply_anchor",
          summary: "The GitHub issue was browser not connected.",
          score: 100,
          reason: "Explicit reply anchor",
          messageIds: ["assistant-1"],
        },
      ];

      const ctx = await loadFridayWorkspaceContext(tmpDir, {
        task: "Why did that fail?",
        selectedBlocks,
      });

      expect(ctx.promptFragment).not.toContain("browser not connected");
      expect(ctx.promptFragment).not.toContain("sourdough hydration");
    });

    it("does not select exported compaction memory through singular/plural matching", async () => {
      const exportDir = path.join(tmpDir, ".friday", "exports", "memory");
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(
        path.join(exportDir, "session.json"),
        JSON.stringify({
          namespace: "compaction.summary",
          items: [
            {
              id: "mem-1",
              contentText: "Compaction summary: the user likes matcha drinks",
              tags: ["preference"],
              createdAt: "2026-03-17T00:00:00Z",
            },
          ],
        }),
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir, {
        task: "What drink do I like?",
      });

      expect(ctx.promptFragment).not.toContain("matcha drinks");
    });

    it("includes all candidate blocks when no task-aware filtering input is provided", async () => {
      await fs.writeFile(path.join(tmpDir, "context", "USER.md"), "User likes sourdough recipes.");
      await fs.writeFile(path.join(tmpDir, "context", "MEMORY.md"), "User prefers dark mode in editors.");

      const ctx = await loadFridayWorkspaceContext(tmpDir);

      expect(ctx.promptFragment).toContain("sourdough recipes");
      expect(ctx.promptFragment).toContain("dark mode in editors");
    });

    it("loads path-scoped rules only when task paths match", async () => {
      const ruleDir = path.join(tmpDir, ".friday", "rules", "path", "src");
      await fs.mkdir(ruleDir, { recursive: true });
      await fs.writeFile(
        path.join(ruleDir, "agent.md"),
        "Only use the agent runtime edit path for src/agent work.",
      );

      const ctx = await loadFridayWorkspaceContext(tmpDir, {
        task: "Please update src/agent/runtime/friday-agent-runtime.ts to add task profile support.",
      });

      expect(ctx.promptFragment).toContain("agent runtime edit path");
      expect(ctx.summary.pathRuleCount).toBe(1);
      expect(ctx.summary.selectedPathRuleCount).toBe(1);
      expect(ctx.summary.candidatePaths).toContain("src/agent/runtime/friday-agent-runtime.ts");
    });
  });
});
