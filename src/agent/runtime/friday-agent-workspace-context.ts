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
import type { Dirent } from "node:fs";
import type { FridayConversationBlock } from "#sessions";
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
  /** Identity blocks are always injected; candidate blocks are relevance-ranked. */
  kind?: "identity" | "candidate";
  /** Whether this block was selected into the prompt fragment. */
  selected?: boolean;
  /** Deterministic relevance score used for candidate selection. */
  selectionScore?: number;
  /** Human-readable explanation for why a block was selected. */
  selectionReason?: string;
  /** Optional path- or extension-scoped rule metadata. */
  ruleScope?: {
    kind: "path" | "extension";
    pattern: string;
    matchedPaths: string[];
  };
}

export interface FridayWorkspaceContextSummary {
  availableFileCount: number;
  selectedFileCount: number;
  selectedPathRuleCount: number;
  pathRuleCount: number;
  promptChars: number;
  selectedChars: number;
  candidatePaths: string[];
}

export interface FridayWorkspaceContext {
  /** All loaded workspace files (including missing ones). */
  files: FridayWorkspaceContextFile[];
  /** Concatenated context string ready for system prompt injection. */
  promptFragment: string;
  /** Deterministic summary for context-cost attribution and debugging. */
  summary: FridayWorkspaceContextSummary;
}

export interface FridayWorkspaceContextSelectionInput {
  task?: string;
  selectedBlocks?: FridayConversationBlock[];
  candidatePaths?: string[];
}

interface FridayStoredMemoryCandidate {
  name: string;
  filePath: string;
  content: string;
}

function isMissingFsError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

// ─── Constants ───

/** Identity files are always injected when present. */
const IDENTITY_WORKSPACE_FILES = [
  "context/AGENTS.md",
  "context/SOUL.md",
 ] as const;

/** Candidate files are injected only when relevant to the current turn. */
const CANDIDATE_WORKSPACE_FILES = [
  "context/USER.md",
  "context/MEMORY.md",
  "context/memory.md",
] as const;

/** Maximum size per file to prevent context window exhaustion (32 KB). */
const MAX_FILE_SIZE_CHARS = 32_000;

/** Maximum total workspace context size (64 KB). */
const MAX_TOTAL_CONTEXT_CHARS = 64_000;

/** Maximum memory items to include from exported JSON files. */
const MAX_MEMORY_EXPORT_ITEMS = 100;

/** Maximum candidate blocks to inject when task-aware selection is active. */
const MAX_SELECTED_CANDIDATE_BLOCKS = 3;
const PATH_RULES_DIR = path.join(".friday", "rules", "path");
const EXTENSION_RULES_DIR = path.join(".friday", "rules", "ext");

const WORKSPACE_CONTEXT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i",
  "if", "in", "is", "it", "me", "my", "of", "on", "or", "please", "that", "the",
  "this", "to", "user", "what", "when", "where", "why", "with", "you", "your",
]);

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  const normalized = normalizeText(text).toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  return normalized
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !WORKSPACE_CONTEXT_STOPWORDS.has(token))
    .flatMap((token) => {
      if (/^[a-z]+ies$/u.test(token) && token.length > 4) {
        return [token, `${token.slice(0, -3)}y`];
      }
      if (/^[a-z]+s$/u.test(token) && token.length > 3) {
        return [token, token.slice(0, -1)];
      }
      return [token];
    });
}

function countOverlap(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  let count = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      count++;
    }
  }
  return count;
}

function deriveSelectionReason(input: {
  file: FridayWorkspaceContextFile;
  taskOverlap: number;
  selectedBlockOverlap: number;
  recencyBonus: number;
  pathRuleBonus: number;
}): string {
  const reasons: string[] = [];
  if (input.pathRuleBonus > 0 && input.file.ruleScope) {
    reasons.push(
      `${input.file.ruleScope.kind} rule matched ${input.file.ruleScope.matchedPaths.join(", ")}`,
    );
  }
  if (input.taskOverlap > 0) {
    reasons.push(`task overlap ${String(input.taskOverlap)}`);
  }
  if (input.selectedBlockOverlap > 0) {
    reasons.push(`session overlap ${String(input.selectedBlockOverlap)}`);
  }
  if (input.recencyBonus > 0) {
    reasons.push(`recency bonus ${String(input.recencyBonus)}`);
  }
  if (reasons.length === 0) {
    return `${input.file.name} retained by default ordering`;
  }
  return `${input.file.name} matched via ${reasons.join(", ")}`;
}

function scoreWorkspaceCandidate(input: {
  file: FridayWorkspaceContextFile;
  taskTokens: readonly string[];
  selectedBlockTokens: readonly string[];
}): { score: number; reason: string } {
  const contentTokens = tokenize(input.file.content ?? "");
  const taskOverlap = countOverlap(input.taskTokens, contentTokens);
  const selectedBlockOverlap = countOverlap(input.selectedBlockTokens, contentTokens);
  const pathRuleBonus = input.file.ruleScope && input.file.ruleScope.matchedPaths.length > 0
    ? 48 + (input.file.ruleScope.matchedPaths.length * 12)
    : 0;
  const recencyBonus = input.file.name.startsWith("memory/")
    ? 6
    : input.file.name === "stored-memories"
      ? 4
      : 0;
  const score = (taskOverlap * 20) + (selectedBlockOverlap * 14) + recencyBonus + pathRuleBonus;
  return {
    score,
    reason: deriveSelectionReason({
      file: input.file,
      taskOverlap,
      selectedBlockOverlap,
      recencyBonus,
      pathRuleBonus,
    }),
  };
}

function selectWorkspaceContextFiles(
  files: FridayWorkspaceContextFile[],
  options?: FridayWorkspaceContextSelectionInput,
): FridayWorkspaceContextFile[] {
  const presentFiles = files.filter((file) => !file.missing && Boolean(file.content?.trim()));
  const identityFiles = presentFiles
    .filter((file) => file.kind === "identity")
    .map((file) => ({ ...file, selected: true, selectionReason: `${file.name} is an identity block` }));
  const candidateFiles = presentFiles.filter((file) => file.kind === "candidate");

  const taskTokens = tokenize(options?.task ?? "");
  const selectedBlockTokens = tokenize((options?.selectedBlocks ?? []).map((block) => block.summary).join(" "));
  const hasSelectionContext = taskTokens.length > 0
    || selectedBlockTokens.length > 0
    || candidateFiles.some((file) => (file.ruleScope?.matchedPaths.length ?? 0) > 0);

  if (!hasSelectionContext) {
    return [
      ...identityFiles,
      ...candidateFiles.map((file) => ({
        ...file,
        selected: true,
        selectionReason: `${file.name} included because no task-aware filtering was requested`,
      })),
    ];
  }

  const rankedCandidates = candidateFiles
    .map((file, index) => {
      const { score, reason } = scoreWorkspaceCandidate({
        file,
        taskTokens,
        selectedBlockTokens,
      });
      return {
        file: {
          ...file,
          selectionScore: score,
          selectionReason: reason,
        },
        index,
      };
    })
    .filter((entry) => (entry.file.selectionScore ?? 0) > 0)
    .sort((left, right) =>
      (right.file.selectionScore ?? 0) - (left.file.selectionScore ?? 0)
      || left.index - right.index)
    .slice(0, MAX_SELECTED_CANDIDATE_BLOCKS)
    .map((entry) => ({ ...entry.file, selected: true }));

  return [...identityFiles, ...rankedCandidates];
}

function normalizeWorkspaceCandidatePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/g, "")
    .replace(/^\/+/g, "")
    .trim();
}

function extractTaskPathCandidates(task?: string): string[] {
  if (!task) {
    return [];
  }
  const candidates = new Set<string>();
  const matches = task.matchAll(/(?:^|[\s("'`])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,8})/g);
  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    const normalized = normalizeWorkspaceCandidatePath(raw);
    if (normalized.length > 0) {
      candidates.add(normalized);
    }
  }
  return [...candidates];
}

async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const discovered: string[] = [];
  async function visit(currentDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      if (!isMissingFsError(err)) {
        console.warn("[friday][workspace-context] readdir:", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        discovered.push(absolutePath);
      }
    }
  }
  await visit(rootDir);
  return discovered.sort();
}

function derivePathRulePattern(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.md$/i, "");
  if (withoutExtension.endsWith("/index")) {
    return withoutExtension.slice(0, -"/index".length);
  }
  return withoutExtension;
}

async function loadPathScopedRules(
  workspaceDir: string,
  candidatePaths: readonly string[],
  seenRealPaths: Set<string>,
): Promise<FridayWorkspaceContextFile[]> {
  const files: FridayWorkspaceContextFile[] = [];
  const normalizedCandidatePaths = candidatePaths
    .map((value) => normalizeWorkspaceCandidatePath(value))
    .filter((value) => value.length > 0);

  const pathRuleRoot = path.join(workspaceDir, PATH_RULES_DIR);
  for (const absoluteRulePath of await collectMarkdownFiles(pathRuleRoot)) {
    const relativeRulePath = path.relative(pathRuleRoot, absoluteRulePath).replace(/\\/g, "/");
    const pattern = derivePathRulePattern(relativeRulePath);
    const matchedPaths = normalizedCandidatePaths.filter((candidate) =>
      candidate === pattern || candidate.startsWith(`${pattern}/`) || pattern.startsWith(`${candidate}/`),
    );
    if (matchedPaths.length === 0) {
      continue;
    }
    try {
      const realPath = await fs.realpath(absoluteRulePath).catch(() => absoluteRulePath);
      if (seenRealPaths.has(realPath)) {
        continue;
      }
      seenRealPaths.add(realPath);
      const content = await fs.readFile(absoluteRulePath, "utf-8");
      const truncated = content.length > MAX_FILE_SIZE_CHARS
        ? content.slice(0, MAX_FILE_SIZE_CHARS) + "\n...(truncated)"
        : content;
      files.push({
        name: `rules/path/${relativeRulePath}`,
        filePath: absoluteRulePath,
        content: truncated,
        missing: false,
        kind: "candidate",
        ruleScope: {
          kind: "path",
          pattern,
          matchedPaths,
        },
      });
    } catch (err) {
      // Skip unreadable rule files.
      if (!isMissingFsError(err)) {
        console.warn("[friday][workspace-context] load-path-rule:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  const extensionRuleRoot = path.join(workspaceDir, EXTENSION_RULES_DIR);
  for (const absoluteRulePath of await collectMarkdownFiles(extensionRuleRoot)) {
    const relativeRulePath = path.relative(extensionRuleRoot, absoluteRulePath).replace(/\\/g, "/");
    const extension = `.${derivePathRulePattern(relativeRulePath).replace(/^\./, "")}`;
    const matchedPaths = normalizedCandidatePaths.filter((candidate) => candidate.endsWith(extension));
    if (matchedPaths.length === 0) {
      continue;
    }
    try {
      const realPath = await fs.realpath(absoluteRulePath).catch(() => absoluteRulePath);
      if (seenRealPaths.has(realPath)) {
        continue;
      }
      seenRealPaths.add(realPath);
      const content = await fs.readFile(absoluteRulePath, "utf-8");
      const truncated = content.length > MAX_FILE_SIZE_CHARS
        ? content.slice(0, MAX_FILE_SIZE_CHARS) + "\n...(truncated)"
        : content;
      files.push({
        name: `rules/ext/${relativeRulePath}`,
        filePath: absoluteRulePath,
        content: truncated,
        missing: false,
        kind: "candidate",
        ruleScope: {
          kind: "extension",
          pattern: extension,
          matchedPaths,
        },
      });
    } catch (err) {
      // Skip unreadable rule files.
      if (!isMissingFsError(err)) {
        console.warn("[friday][workspace-context] load-ext-rule:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  return files;
}

// ─── Loader ───

/**
 * Loads workspace context files from disk.
 * Reads each file, deduplicates (MEMORY.md vs memory.md pointing to same inode),
 * and builds a prompt fragment for injection.
 */
export async function loadFridayWorkspaceContext(
  workspaceDir: string,
  options?: FridayWorkspaceContextSelectionInput,
): Promise<FridayWorkspaceContext> {
  const resolvedDir = path.resolve(workspaceDir);
  const files: FridayWorkspaceContextFile[] = [];
  const seenRealPaths = new Set<string>();
  const candidatePaths = [
    ...(options?.candidatePaths ?? []),
    ...extractTaskPathCandidates(options?.task),
  ].map((value) => normalizeWorkspaceCandidatePath(value))
    .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);

  const loadNamedFile = async (
    name: string,
    kind: "identity" | "candidate",
  ): Promise<void> => {
    const filePath = path.join(resolvedDir, name);
    try {
      const content = await fs.readFile(filePath, "utf-8");

      // Deduplicate symlinks (MEMORY.md and memory.md may point to same file)
      let realPath = filePath;
      try {
        realPath = await fs.realpath(filePath);
      } catch (err) {
        // Use lexical path if realpath fails
        console.warn("[friday][workspace-context] realpath:", err instanceof Error ? err.message : String(err));
      }
      if (seenRealPaths.has(realPath)) {
        return;
      }
      seenRealPaths.add(realPath);

      const truncated = content.length > MAX_FILE_SIZE_CHARS
        ? content.slice(0, MAX_FILE_SIZE_CHARS) + "\n...(truncated)"
        : content;

      files.push({ name, filePath, content: truncated, missing: false, kind });
    } catch (err) {
      if (!isMissingFsError(err)) {
        console.warn("[friday][workspace-context] load-named-file:", err instanceof Error ? err.message : String(err));
      }
      files.push({ name, filePath, missing: true, kind });
    }
  };

  for (const name of IDENTITY_WORKSPACE_FILES) {
    await loadNamedFile(name, "identity");
  }
  for (const name of CANDIDATE_WORKSPACE_FILES) {
    await loadNamedFile(name, "candidate");
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
    files.push({
      name: `memory/${today}.md`,
      filePath: dailyMemoryPath,
      content: truncated,
      missing: false,
      kind: "candidate",
    });
  } catch (err) {
    // Daily memory file is optional
    if (!isMissingFsError(err)) {
      console.warn("[friday][workspace-context] daily-memory:", err instanceof Error ? err.message : String(err));
    }
  }

  // Load exported memory items from .friday/exports/memory/ (feedback loop)
  const memoryExportCandidates = await loadMemoryExports(resolvedDir);
  for (const memoryExportCandidate of memoryExportCandidates) {
    files.push({
      name: memoryExportCandidate.name,
      filePath: memoryExportCandidate.filePath,
      content: memoryExportCandidate.content,
      missing: false,
      kind: "candidate",
    });
  }

  const pathRules = await loadPathScopedRules(resolvedDir, candidatePaths, seenRealPaths);
  files.push(...pathRules);

  const selectedFiles = selectWorkspaceContextFiles(files, options);
  const selectedFileMap = new Map(
    selectedFiles.map((file) => [`${file.filePath}::${file.name}`, file]),
  );
  const hasTaskAwareSelection = Boolean(
    (options?.task && options.task.trim().length > 0)
    || (options?.selectedBlocks && options.selectedBlocks.length > 0),
  );
  const annotatedFiles = files.map((file) => {
    const selected = selectedFileMap.get(`${file.filePath}::${file.name}`);
    if (selected) {
      return {
        ...file,
        selected: true,
        selectionScore: selected.selectionScore,
        selectionReason: selected.selectionReason,
      };
    }
    if (file.missing || !file.content?.trim()) {
      return file;
    }
    if (file.kind === "candidate" && hasTaskAwareSelection) {
      return {
        ...file,
        selected: false,
        selectionScore: 0,
        selectionReason: `${file.name} was not selected for the current task`,
      };
    }
    return file;
  });

  // Build prompt fragment from selected files
  const promptFragment = buildWorkspacePromptFragment(selectedFiles);
  const selectedChars = selectedFiles.reduce((sum, file) => sum + (file.content?.trim().length ?? 0), 0);
  const pathRuleCount = annotatedFiles.filter((file) => Boolean(file.ruleScope)).length;
  const selectedPathRuleCount = annotatedFiles.filter((file) => file.selected && Boolean(file.ruleScope)).length;

  return {
    files: annotatedFiles,
    promptFragment,
    summary: {
      availableFileCount: annotatedFiles.filter((file) => !file.missing && Boolean(file.content?.trim())).length,
      selectedFileCount: annotatedFiles.filter((file) => file.selected).length,
      selectedPathRuleCount,
      pathRuleCount,
      promptChars: promptFragment.length,
      selectedChars,
      candidatePaths,
    },
  };
}

/**
 * Loads exported memory items from .friday/exports/memory/*.json.
 * These files are written by the memory file sync service when the
 * agent uses `memory_store`. This closes the feedback loop so stored
 * memories appear in the next run's system prompt.
 */
async function loadMemoryExports(workspaceDir: string): Promise<FridayStoredMemoryCandidate[]> {
  const memoryDir = path.join(workspaceDir, FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR, "memory");

  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch (err) {
    if (!isMissingFsError(err)) {
      console.warn("[friday][workspace-context] readdir-memory-exports:", err instanceof Error ? err.message : String(err));
    }
    return []; // Directory doesn't exist yet — no memories exported
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  if (jsonFiles.length === 0) return [];

  const candidates: FridayStoredMemoryCandidate[] = [];
  let itemCount = 0;

  for (const file of jsonFiles) {
    if (itemCount >= MAX_MEMORY_EXPORT_ITEMS) break;

    try {
      const raw = await fs.readFile(path.join(memoryDir, file), "utf-8");
      const parsed = JSON.parse(raw) as {
        namespace?: string;
        items?: Array<{
          id?: string;
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
        const safeNamespace = (parsed.namespace ?? "memory").replace(/[^a-z0-9._-]+/gi, "_");
        const safeId = (item.id ?? `${itemCount + 1}`).replace(/[^a-z0-9._-]+/gi, "_");
        candidates.push({
          name: `stored-memories/${safeNamespace}/${safeId}`,
          filePath: path.join(memoryDir, file),
          content: `- ${text}${tags}${date}`,
        });
        itemCount++;
      }
    } catch (err) {
      // Skip malformed files
      console.warn("[friday][workspace-context] parse-memory-export:", err instanceof Error ? err.message : String(err));
    }
  }

  return candidates;
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

    // Respect total size limit — strip "context/" prefix for workspace files
    const displayName = file.name.startsWith("context/") ? path.basename(file.name) : file.name;
    if (totalSize + trimmed.length > MAX_TOTAL_CONTEXT_CHARS) {
      const remaining = MAX_TOTAL_CONTEXT_CHARS - totalSize;
      if (remaining > 200) {
        sections.push(`## ${displayName}\n${trimmed.slice(0, remaining)}\n...(truncated)`);
      }
      break;
    }

    sections.push(`## ${displayName}\n${trimmed}`);
    totalSize += trimmed.length;
  }

  if (sections.length === 0) {
    return "";
  }

  return "\n\n# Workspace Context\n\n" + sections.join("\n\n");
}

// ─── Learning Context Fragment ──────────────────────────────────

/**
 * Builds a compact markdown fragment summarising the user's learned
 * patterns, individuation stage, and satisfaction trend for injection
 * into the agent system prompt.
 */
export function buildFridayLearningContextFragment(input: {
  individuationStage?: string;
  activePatterns?: Array<{ kind: string; key: string; strength: number }>;
  satisfactionTrend?: { average: number; trend: string; recentSessions: number };
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? 1200;
  const parts: string[] = [];

  if (input.individuationStage) {
    parts.push(`**Individuation stage**: ${input.individuationStage}`);
  }

  if (input.satisfactionTrend && input.satisfactionTrend.recentSessions > 0) {
    const t = input.satisfactionTrend;
    parts.push(
      `**Satisfaction**: avg ${t.average.toFixed(2)}, trend ${t.trend} (${t.recentSessions} sessions)`,
    );
  }

  if (input.activePatterns && input.activePatterns.length > 0) {
    const sorted = [...input.activePatterns]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);
    const lines = sorted.map(
      (p) => `- [${p.kind}] ${p.key} (strength ${p.strength.toFixed(2)})`,
    );
    parts.push("**Active patterns**:\n" + lines.join("\n"));
  }

  if (parts.length === 0) return "";

  let fragment =
    "<learning-context>\n" +
    parts.join("\n") +
    "\n</learning-context>";

  if (fragment.length > maxChars) {
    fragment = fragment.slice(0, maxChars - 3) + "...";
  }

  return fragment;
}
