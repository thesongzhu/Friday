/**
 * Workspace Context Loader — reads workspace bootstrap files
 * (AGENTS.md, SOUL.md, USER.md, MEMORY.md, etc.) and injects
 * their contents into the agent system prompt.
 *
 * Also reads exported memory items from `.friday/exports/memory/`
 * (written by the memory file sync service) to close the feedback
 * loop: memory_store → SQLite → file sync → workspace context → prompt.
 *
 * This is the key mechanism that gives Friday persistent identity,
 * user knowledge, and long-term memory across sessions — matching
 * the OpenClaw workspace context injection pattern.
 *
 * Files are read fresh on each agent run so edits take effect
 * immediately without restart.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR } from "../../memory/sync/friday-memory-file-sync.constants.js";

// ─── Types ───

export interface FridayWorkspaceContextFile {
  /** Filename (e.g. "AGENTS.md"). */
  name: string;
  /** Absolute path on disk. */
  filePath: string;
  /** File contents (undefined if missing). */
  content?: string;
  /** True if the file does not exist on disk. */
  missing: boolean;
}

export interface FridayWorkspaceContext {
  /** All loaded workspace files (including missing ones). */
  files: FridayWorkspaceContextFile[];
  /** Concatenated context string ready for system prompt injection. */
  promptFragment: string;
}

// ─── Constants ───

/** Standard workspace context filenames, in injection order. */
const WORKSPACE_CONTEXT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "memory.md",
] as const;

/** Maximum size per file to prevent context window exhaustion (32 KB). */
const MAX_FILE_SIZE_CHARS = 32_000;

/** Maximum total workspace context size (64 KB). */
const MAX_TOTAL_CONTEXT_CHARS = 64_000;

/** Maximum memory items to include from exported JSON files. */
const MAX_MEMORY_EXPORT_ITEMS = 100;

// ─── Loader ───

/**
 * Loads workspace context files from disk.
 * Reads each file, deduplicates (MEMORY.md vs memory.md pointing to same inode),
 * and builds a prompt fragment for injection.
 */
export async function loadFridayWorkspaceContext(
  workspaceDir: string,
): Promise<FridayWorkspaceContext> {
  const resolvedDir = path.resolve(workspaceDir);
  const files: FridayWorkspaceContextFile[] = [];
  const seenRealPaths = new Set<string>();

  for (const name of WORKSPACE_CONTEXT_FILES) {
    const filePath = path.join(resolvedDir, name);
    try {
      const content = await fs.readFile(filePath, "utf-8");

      // Deduplicate symlinks (MEMORY.md and memory.md may point to same file)
      let realPath = filePath;
      try {
        realPath = await fs.realpath(filePath);
      } catch {
        // Use lexical path if realpath fails
      }
      if (seenRealPaths.has(realPath)) {
        continue;
      }
      seenRealPaths.add(realPath);

      const truncated = content.length > MAX_FILE_SIZE_CHARS
        ? content.slice(0, MAX_FILE_SIZE_CHARS) + "\n...(truncated)"
        : content;

      files.push({ name, filePath, content: truncated, missing: false });
    } catch {
      files.push({ name, filePath, missing: true });
    }
  }

  // Also load daily memory file (memory/YYYY-MM-DD.md)
  const today = new Date().toISOString().slice(0, 10);
  const dailyMemoryDir = path.join(resolvedDir, "memory");
  const dailyMemoryPath = path.join(dailyMemoryDir, `${today}.md`);
  try {
    const content = await fs.readFile(dailyMemoryPath, "utf-8");
    const truncated = content.length > MAX_FILE_SIZE_CHARS
      ? content.slice(0, MAX_FILE_SIZE_CHARS) + "\n...(truncated)"
      : content;
    files.push({ name: `memory/${today}.md`, filePath: dailyMemoryPath, content: truncated, missing: false });
  } catch {
    // Daily memory file is optional
  }

  // Load exported memory items from .friday/exports/memory/ (feedback loop)
  const memoryExportContent = await loadMemoryExports(resolvedDir);
  if (memoryExportContent) {
    files.push({
      name: "stored-memories",
      filePath: path.join(resolvedDir, FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR, "memory"),
      content: memoryExportContent,
      missing: false,
    });
  }

  // Build prompt fragment from loaded files
  const promptFragment = buildWorkspacePromptFragment(files);

  return { files, promptFragment };
}

/**
 * Loads exported memory items from .friday/exports/memory/*.json.
 * These files are written by the memory file sync service when the
 * agent uses `memory_store`. This closes the feedback loop so stored
 * memories appear in the next run's system prompt.
 */
async function loadMemoryExports(workspaceDir: string): Promise<string | null> {
  const memoryDir = path.join(workspaceDir, FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR, "memory");

  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return null; // Directory doesn't exist yet — no memories exported
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  if (jsonFiles.length === 0) return null;

  const lines: string[] = [];
  let itemCount = 0;

  for (const file of jsonFiles) {
    if (itemCount >= MAX_MEMORY_EXPORT_ITEMS) break;

    try {
      const raw = await fs.readFile(path.join(memoryDir, file), "utf-8");
      const parsed = JSON.parse(raw) as {
        namespace?: string;
        items?: Array<{
          contentText?: string | null;
          value?: unknown;
          tags?: string[];
          createdAt?: string;
        }>;
      };

      if (!parsed.items || !Array.isArray(parsed.items)) continue;

      for (const item of parsed.items) {
        if (itemCount >= MAX_MEMORY_EXPORT_ITEMS) break;

        const text = item.contentText ?? (typeof item.value === "string" ? item.value : null);
        if (!text) continue;

        const tags = item.tags && item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
        const date = item.createdAt ? ` (${item.createdAt.slice(0, 10)})` : "";
        lines.push(`- ${text}${tags}${date}`);
        itemCount++;
      }
    } catch {
      // Skip malformed files
    }
  }

  if (lines.length === 0) return null;
  return `Previously stored memories (from memory_store):\n${lines.join("\n")}`;
}

/**
 * Builds the prompt fragment from loaded workspace files.
 * Only includes files that exist and have content.
 */
function buildWorkspacePromptFragment(
  files: FridayWorkspaceContextFile[],
): string {
  const sections: string[] = [];
  let totalSize = 0;

  for (const file of files) {
    if (file.missing || !file.content) continue;

    const trimmed = file.content.trim();
    if (trimmed.length === 0) continue;

    // Respect total size limit
    if (totalSize + trimmed.length > MAX_TOTAL_CONTEXT_CHARS) {
      const remaining = MAX_TOTAL_CONTEXT_CHARS - totalSize;
      if (remaining > 200) {
        sections.push(`## ${file.name}\n${trimmed.slice(0, remaining)}\n...(truncated)`);
      }
      break;
    }

    sections.push(`## ${file.name}\n${trimmed}`);
    totalSize += trimmed.length;
  }

  if (sections.length === 0) {
    return "";
  }

  return "\n\n# Workspace Context\n\n" + sections.join("\n\n");
}
