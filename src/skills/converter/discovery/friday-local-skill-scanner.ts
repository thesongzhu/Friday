/**
 * Local Skill Scanner — finds AI tool configs on the local machine.
 *
 * Scans known directories for Claude Code, Cursor, n8n, Codex, and
 * project-local command files that can be imported as Friday skills.
 *
 * @module skills/converter/discovery
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

// ─── Types ───

export type LocalSkillSourceTool = "claude-code" | "cursor" | "n8n" | "codex" | "clawdbot" | "friday" | "unknown";

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

// ─── Scan directory descriptors ───

interface ScanDirectoryDescriptor {
  dir: string;
  tool: LocalSkillSourceTool;
  extensions: string[];
  converterHint: string;
  /** For JSON files, require these top-level keys to be present. */
  jsonRequiredKeys?: string[];
}

// ─── Helpers ───

function titleCase(raw: string): string {
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function makeId(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

function extractDescriptionMd(content: string): string {
  // Try YAML frontmatter first
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx);
      const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
      if (descMatch) return descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  // Fall back to first heading line
  const headingMatch = /^#+\s+(.+)$/m.exec(content);
  if (headingMatch) return headingMatch[1].trim();

  // Fall back to first non-empty line
  const firstLine = content.split("\n").find((l) => l.trim().length > 0);
  return firstLine?.trim().slice(0, 120) ?? "";
}

function extractDescriptionJson(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.description === "string") return parsed.description.slice(0, 200);
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // Ignore parse errors
  }
  return "";
}

function jsonHasRequiredKeys(content: string, keys: string[]): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return keys.every((k) => k in parsed);
  } catch {
    return false;
  }
}

// ─── Scanner ───

export function scanLocalSkills(): LocalSkillScanResult {
  const start = Date.now();
  const home = homedir();
  const cwd = process.cwd();

  const descriptors: ScanDirectoryDescriptor[] = [
    {
      dir: join(home, ".claude", "commands"),
      tool: "claude-code",
      extensions: [".md"],
      converterHint: "clawdbot-skill-md",
    },
    {
      dir: join(home, ".cursor", "rules"),
      tool: "cursor",
      extensions: [".md", ".mdc"],
      converterHint: "clawdbot-skill-md",
    },
    {
      dir: join(home, ".n8n"),
      tool: "n8n",
      extensions: [".json"],
      converterHint: "n8n-node",
      jsonRequiredKeys: ["nodes", "connections"],
    },
    {
      dir: join(home, ".codex"),
      tool: "codex",
      extensions: [".md", ".yaml"],
      converterHint: "clawdbot-skill-md",
    },
    {
      dir: join(cwd, ".claude", "commands"),
      tool: "claude-code",
      extensions: [".md"],
      converterHint: "clawdbot-skill-md",
    },
  ];

  const items: LocalSkillScanItem[] = [];
  const directoriesScanned: string[] = [];

  for (const desc of descriptors) {
    try {
      const dir = resolve(desc.dir);
      if (!existsSync(dir)) continue;

      directoriesScanned.push(dir);
      const entries = readdirSync(dir);

      for (const entry of entries) {
        try {
          const ext = extname(entry).toLowerCase();
          if (!desc.extensions.includes(ext)) continue;

          const absolutePath = join(dir, entry);
          const stat = statSync(absolutePath);
          if (!stat.isFile()) continue;

          // Read first 500 bytes for description extraction
          const fd = readFileSync(absolutePath, { encoding: "utf-8", flag: "r" });
          const preview = fd.slice(0, 500);

          // For n8n JSON files, require specific keys
          if (desc.jsonRequiredKeys) {
            if (!jsonHasRequiredKeys(fd, desc.jsonRequiredKeys)) continue;
          }

          const description =
            ext === ".json"
              ? extractDescriptionJson(preview)
              : extractDescriptionMd(preview);

          const rawName = basename(entry, ext);
          const name = titleCase(rawName);

          items.push({
            id: makeId(absolutePath),
            name,
            sourceTool: desc.tool,
            sourcePath: absolutePath,
            description,
            convertible: true,
            converterHint: desc.converterHint,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {
          // Skip individual file errors
        }
      }
    } catch {
      // Skip directories that cannot be read
    }
  }

  return {
    items,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - start,
    directoriesScanned,
  };
}
