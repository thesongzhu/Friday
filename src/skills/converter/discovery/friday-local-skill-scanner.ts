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
import { basename, dirname, extname, join, resolve } from "node:path";

// ─── Types ───

export type LocalSkillSourceTool =
  | "claude-code"
  | "cursor"
  | "n8n"
  | "codex"
  | "openclaw"
  | "friday"
  | "local-project"
  | "unknown";

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

export interface ScanLocalSkillsOptions {
  homeDir?: string;
  cwd?: string;
  projectDirs?: string[];
  fridayRoots?: string[];
  includeCwdSkills?: boolean;
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

function safeParseJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const candidatePath = canonicalPath(candidate);
  const rootPath = canonicalPath(root);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

function looksLikeFridayRoot(dir: string): boolean {
  const packageJson = safeParseJson(join(dir, "package.json"));
  if (packageJson?.name === "@thesongzhu/friday") return true;

  return existsSync(join(dir, "scripts", "ops", "friday-first-run.sh"))
    && existsSync(join(dir, "src", "hub", "friday-hub-bootstrap.ts"))
    && existsSync(join(dir, "ui", "src", "routes", "setup-page.tsx"));
}

function findFridayAncestor(startDir: string): string | null {
  let cursor = resolve(startDir);
  for (;;) {
    if (looksLikeFridayRoot(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function collectFridayRoots(home: string, cwd: string, explicitRoots: string[] = []): string[] {
  const candidates = [
    cwd,
    findFridayAncestor(cwd),
    join(home, "Friday"),
    join(home, "Desktop", "Friday"),
    ...explicitRoots,
  ].filter((value): value is string => Boolean(value));

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const root = looksLikeFridayRoot(candidate) ? candidate : findFridayAncestor(candidate);
    if (!root) continue;
    const canonical = canonicalPath(root);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push(root);
  }
  return roots;
}

function isInsideFridayRoot(path: string, fridayRoots: string[]): boolean {
  return fridayRoots.some((root) => isPathInside(path, root));
}

function looksLikeOpenClawProject(projectPath: string): boolean {
  const projectName = basename(projectPath).toLowerCase();
  if (projectName.includes("openclaw") || projectName.includes("clawdbot")) return true;

  const packageJson = safeParseJson(join(projectPath, "package.json"));
  const packageName = typeof packageJson?.name === "string" ? packageJson.name.toLowerCase() : "";
  if (packageName.includes("openclaw") || packageName.includes("clawdbot")) return true;

  return existsSync(join(projectPath, ".openclaw"))
    || existsSync(join(projectPath, "openclaw.json"))
    || existsSync(join(projectPath, "clawdbot.config.json"))
    || existsSync(join(projectPath, "clawdbot.config.ts"));
}

function appendItems(
  allItems: LocalSkillScanItem[],
  directoriesScanned: string[],
  dir: string,
  items: LocalSkillScanItem[],
): void {
  if (existsSync(dir)) directoriesScanned.push(dir);
  allItems.push(...items);
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
    if (subdir.startsWith(".")) continue;
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
function scanProjectSkills(projectsDir: string, fridayRoots: string[]): LocalSkillScanItem[] {
  const items: LocalSkillScanItem[] = [];
  if (!existsSync(projectsDir)) return items;

  for (const project of safeReadDir(projectsDir)) {
    if (project.startsWith(".")) continue;
    const projectPath = join(projectsDir, project);
    const projectStat = safeStat(projectPath);
    if (!projectStat?.isDir) continue;
    if (looksLikeFridayRoot(projectPath)) continue;
    if (isInsideFridayRoot(projectPath, fridayRoots)) continue;

    const projectSourceTool: LocalSkillSourceTool = looksLikeOpenClawProject(projectPath)
      ? "openclaw"
      : "local-project";

    // Check <project>/skills/
    items.push(...scanSkillSubdirs(join(projectPath, "skills"), projectSourceTool, "clawdbot-skill-md"));

    // Check <project>/.agents/skills/
    items.push(...scanSkillSubdirs(join(projectPath, ".agents", "skills"), projectSourceTool, "clawdbot-skill-md"));

    // Check <project>/extensions/
    items.push(...scanSkillSubdirs(join(projectPath, "extensions"), projectSourceTool, "clawdbot-skill-md"));

    // Check <project>/managed-skills/
    items.push(...scanSkillSubdirs(join(projectPath, "managed-skills"), "friday", "friday-package", { sourcePathMode: "directory" }));
  }
  return items;
}

// ─── Main scanner ───

export function scanLocalSkills(options: ScanLocalSkillsOptions = {}): LocalSkillScanResult {
  const start = Date.now();
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const fridayRoots = collectFridayRoots(home, cwd, options.fridayRoots);
  const allItems: LocalSkillScanItem[] = [];
  const directoriesScanned: string[] = [];

  // ── 1. Claude Code ──
  const claudeDirs = [
    join(home, ".claude", "commands"),
    join(home, ".claude", "skills"),
  ];
  for (const dir of claudeDirs) {
    const items = scanFlatDir(dir, "claude-code", [".md"], "clawdbot-skill-md");
    appendItems(allItems, directoriesScanned, dir, items);
  }
  // Also scan ~/.claude/skills/ as subdirectories (each skill in its own folder)
  const claudeSkillsDir = join(home, ".claude", "skills");
  const claudeSkillSubItems = scanSkillSubdirs(claudeSkillsDir, "claude-code", "clawdbot-skill-md");
  appendItems(allItems, directoriesScanned, claudeSkillsDir, claudeSkillSubItems);

  // ── 2. Cursor ──
  const cursorItems = scanFlatDir(join(home, ".cursor", "rules"), "cursor", [".md", ".mdc"], "clawdbot-skill-md");
  appendItems(allItems, directoriesScanned, join(home, ".cursor", "rules"), cursorItems);

  // ── 3. n8n ──
  const n8nItems = scanFlatDir(join(home, ".n8n"), "n8n", [".json"], "n8n-node", ["nodes", "connections"]);
  appendItems(allItems, directoriesScanned, join(home, ".n8n"), n8nItems);

  // ── 4. Codex ──
  const codexItems = scanFlatDir(join(home, ".codex"), "codex", [".md", ".yaml"], "clawdbot-skill-md");
  appendItems(allItems, directoriesScanned, join(home, ".codex"), codexItems);
  const codexSkillsDir = join(home, ".codex", "skills");
  const codexSkillSubItems = scanSkillSubdirs(codexSkillsDir, "codex", "clawdbot-skill-md");
  appendItems(allItems, directoriesScanned, codexSkillsDir, codexSkillSubItems);

  // ── 5. Projects directory — scan external skill-like repos ──
  const projectsDirs = options.projectDirs ?? [
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "Developer"),
    join(home, "dev"),
  ];
  for (const dir of projectsDirs) {
    if (!existsSync(dir)) continue;
    const projectItems = scanProjectSkills(dir, fridayRoots);
    appendItems(allItems, directoriesScanned, dir, projectItems);
  }

  // ── 6. Current working directory skills — opt-in only for developer use ──
  if (options.includeCwdSkills && !isInsideFridayRoot(cwd, fridayRoots)) {
    const cwdSkillsDir = join(cwd, "skills");
    const cwdSkills = scanSkillSubdirs(cwdSkillsDir, "local-project", "clawdbot-skill-md");
    appendItems(allItems, directoriesScanned, cwdSkillsDir, cwdSkills);
  }

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
