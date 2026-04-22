/**
 * Local Skill Scanner — finds AI tool configs on the local machine.
 *
 * Scans ~/.claude/, ~/.cursor/, ~/.n8n/, ~/.codex/, and ~/Projects/
 * for SKILL.md files, commands, workflows, and other skill-like configs.
 *
 * @module skills/converter/discovery
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

// ─── Types ───

export type LocalSkillSourceTool = "claude-code" | "cursor" | "n8n" | "codex" | "openclaw" | "friday" | "unknown";

export interface LocalSkillScanItem {
  id: string;
  name: string;
  sourceTool: LocalSkillSourceTool;
  sourcePath: string;
  description: string;
  convertible: boolean;
  converterHint?: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocalSkillScanResult {
  items: LocalSkillScanItem[];
  scannedAt: string;
  scanDurationMs: number;
  directoriesScanned: string[];
}

// ─── Helpers ───

function titleCase(raw: string): string {
  return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function makeId(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

function canonicalPath(path: string): string {
  const resolved = (() => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  })();
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

function extractDescriptionMd(content: string): string {
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx);
      const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
      if (descMatch) return descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const headingMatch = /^#+\s+(.+)$/m.exec(content);
  if (headingMatch) return headingMatch[1].trim();
  const firstLine = content.split("\n").find((l) => l.trim().length > 0);
  return firstLine?.trim().slice(0, 120) ?? "";
}

function extractDescriptionJson(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.description === "string") return parsed.description.slice(0, 200);
    if (typeof parsed.name === "string") return parsed.name;
  } catch { /* ignore */ }
  return "";
}

function jsonHasKeys(content: string, keys: string[]): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return keys.every((k) => k in parsed);
  } catch { return false; }
}

function safeReadDir(dir: string): string[] {
  try { return existsSync(dir) ? readdirSync(dir) : []; }
  catch { return []; }
}

function safeReadText(path: string, limit = 2000): string {
  try { return readFileSync(path, { encoding: "utf-8" }).slice(0, limit); }
  catch { return ""; }
}

function safeStat(path: string): { size: number; mtime: Date; isFile: boolean; isDir: boolean } | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtime: s.mtime, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch { return null; }
}

// ─── Core scan logic ───

function scanFlatDir(
  dir: string,
  tool: LocalSkillSourceTool,
  extensions: string[],
  converterHint: string,
  jsonRequiredKeys?: string[],
): LocalSkillScanItem[] {
  const items: LocalSkillScanItem[] = [];
  const resolved = resolve(dir);
  if (!existsSync(resolved)) return items;

  for (const entry of safeReadDir(resolved)) {
    const ext = extname(entry).toLowerCase();
    if (!extensions.includes(ext)) continue;
    const fullPath = join(resolved, entry);
    const stat = safeStat(fullPath);
    if (!stat?.isFile) continue;
    if (stat.size <= 0) continue;

    const content = safeReadText(fullPath);
    if (jsonRequiredKeys && !jsonHasKeys(content, jsonRequiredKeys)) continue;

    const description = ext === ".json" ? extractDescriptionJson(content) : extractDescriptionMd(content);
    items.push({
      id: makeId(fullPath),
      name: titleCase(basename(entry, ext)),
      sourceTool: tool,
      sourcePath: fullPath,
      description,
      convertible: true,
      converterHint,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return items;
}

/**
 * Scan directories where each subdirectory is a skill (contains SKILL.md or skill.yaml).
 * E.g., ~/Projects/openclaw-dev/skills/nano-pdf/SKILL.md
 */
function scanSkillSubdirs(
  parentDir: string,
  tool: LocalSkillSourceTool,
  converterHint: string,
  options?: {
    sourcePathMode?: "skill-file" | "directory";
  },
): LocalSkillScanItem[] {
  const items: LocalSkillScanItem[] = [];
  const resolved = resolve(parentDir);
  if (!existsSync(resolved)) return items;

  for (const subdir of safeReadDir(resolved)) {
    const subdirPath = join(resolved, subdir);
    const subdirStat = safeStat(subdirPath);
    if (!subdirStat?.isDir) continue;

    // Look for SKILL.md or skill.yaml in the subdirectory
    for (const skillFile of ["SKILL.md", "skill.yaml", "skill.yml"]) {
      const skillPath = join(subdirPath, skillFile);
      const stat = safeStat(skillPath);
      if (!stat?.isFile) continue;

      const content = safeReadText(skillPath);
      const description = extractDescriptionMd(content);

      items.push({
        id: makeId(options?.sourcePathMode === "directory" ? subdirPath : skillPath),
        name: titleCase(subdir),
        sourceTool: tool,
        sourcePath: options?.sourcePathMode === "directory" ? subdirPath : skillPath,
        description,
        convertible: true,
        converterHint,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
      break; // Only one skill file per subdir
    }
  }
  return items;
}

/**
 * Find skill directories in ~/Projects/ by looking for known patterns.
 * Scans 2 levels deep: ~/Projects/<project>/skills/ and ~/Projects/<project>/.agents/skills/
 */
function scanProjectSkills(projectsDir: string): LocalSkillScanItem[] {
  const items: LocalSkillScanItem[] = [];
  if (!existsSync(projectsDir)) return items;
  const currentWorkspace = canonicalPath(process.cwd());

  for (const project of safeReadDir(projectsDir)) {
    const projectPath = join(projectsDir, project);
    const projectStat = safeStat(projectPath);
    if (!projectStat?.isDir) continue;
    if (canonicalPath(projectPath) === currentWorkspace) continue;

    // Check <project>/skills/
    items.push(...scanSkillSubdirs(join(projectPath, "skills"), "openclaw", "clawdbot-skill-md"));

    // Check <project>/.agents/skills/
    items.push(...scanSkillSubdirs(join(projectPath, ".agents", "skills"), "openclaw", "clawdbot-skill-md"));

    // Check <project>/extensions/
    items.push(...scanSkillSubdirs(join(projectPath, "extensions"), "openclaw", "clawdbot-skill-md"));

    // Check <project>/managed-skills/
    items.push(...scanSkillSubdirs(join(projectPath, "managed-skills"), "friday", "friday-package", { sourcePathMode: "directory" }));
  }
  return items;
}

// ─── Main scanner ───

export function scanLocalSkills(): LocalSkillScanResult {
  const start = Date.now();
  const home = homedir();
  const cwd = process.cwd();
  const allItems: LocalSkillScanItem[] = [];
  const directoriesScanned: string[] = [];

  // ── 1. Claude Code ──
  const claudeDirs = [
    join(home, ".claude", "commands"),
    join(home, ".claude", "skills"),
    join(cwd, ".claude", "commands"),
  ];
  for (const dir of claudeDirs) {
    const items = scanFlatDir(dir, "claude-code", [".md"], "clawdbot-skill-md");
    if (items.length > 0) directoriesScanned.push(dir);
    allItems.push(...items);
  }
  // Also scan ~/.claude/skills/ as subdirectories (each skill in its own folder)
  const claudeSkillsDir = join(home, ".claude", "skills");
  const claudeSkillSubItems = scanSkillSubdirs(claudeSkillsDir, "claude-code", "clawdbot-skill-md");
  if (claudeSkillSubItems.length > 0) directoriesScanned.push(claudeSkillsDir);
  allItems.push(...claudeSkillSubItems);

  // ── 2. Cursor ──
  const cursorItems = scanFlatDir(join(home, ".cursor", "rules"), "cursor", [".md", ".mdc"], "clawdbot-skill-md");
  if (cursorItems.length > 0) directoriesScanned.push(join(home, ".cursor", "rules"));
  allItems.push(...cursorItems);

  // ── 3. n8n ──
  const n8nItems = scanFlatDir(join(home, ".n8n"), "n8n", [".json"], "n8n-node", ["nodes", "connections"]);
  if (n8nItems.length > 0) directoriesScanned.push(join(home, ".n8n"));
  allItems.push(...n8nItems);

  // ── 4. Codex ──
  const codexItems = scanFlatDir(join(home, ".codex"), "codex", [".md", ".yaml"], "clawdbot-skill-md");
  if (codexItems.length > 0) directoriesScanned.push(join(home, ".codex"));
  allItems.push(...codexItems);

  // ── 5. Projects directory — scan for OpenClaw/skill repos ──
  const projectsDirs = [
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "Developer"),
    join(home, "dev"),
  ];
  for (const dir of projectsDirs) {
    if (!existsSync(dir)) continue;
    directoriesScanned.push(dir);
    allItems.push(...scanProjectSkills(dir));
  }

  // ── 6. Current working directory skills ──
  const cwdSkills = scanSkillSubdirs(join(cwd, "skills"), "openclaw", "clawdbot-skill-md");
  if (cwdSkills.length > 0) directoriesScanned.push(join(cwd, "skills"));
  allItems.push(...cwdSkills);

  // ── Dedup by sourcePath ──
  const seen = new Set<string>();
  const dedupedItems = allItems.filter((item) => {
    const dedupeKey = canonicalPath(item.sourcePath);
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });

  return {
    items: dedupedItems,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - start,
    directoriesScanned: [...new Set(directoriesScanned)],
  };
}
