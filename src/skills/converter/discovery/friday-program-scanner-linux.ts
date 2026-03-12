/**
 * Linux Program Scanner.
 *
 * Discovers installed applications by scanning .desktop files in standard
 * XDG locations, and CLI tools from common bin directories.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type {
  FridayDiscoveredProgram,
  FridayDiscoveryPolicy,
  FridayProgramCategory,
  FridayProgramScanner,
} from "./friday-program-discovery.types.js";

// ─── Constants ───

const DESKTOP_FILE_DIRS = [
  "/usr/share/applications",
  "/usr/local/share/applications",
  join(homedir(), ".local", "share", "applications"),
  "/var/lib/flatpak/exports/share/applications",
  join(homedir(), ".local", "share", "flatpak", "exports", "share", "applications"),
  "/var/lib/snapd/desktop/applications",
];

const CLI_DIRS = ["/usr/local/bin", join(homedir(), ".local", "bin")];

// ─── Factory ───

export function createLinuxProgramScanner(): FridayProgramScanner {
  return {
    platform: "linux",
    async scan(policy: FridayDiscoveryPolicy): Promise<FridayDiscoveredProgram[]> {
      const programs: FridayDiscoveredProgram[] = [];
      const now = new Date().toISOString();
      const seen = new Set<string>();

      // Scan .desktop files
      for (const dir of DESKTOP_FILE_DIRS) {
        if (!existsSync(dir)) continue;
        if (isExcluded(dir, policy)) continue;

        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            if (!entry.endsWith(".desktop")) continue;
            const filePath = join(dir, entry);
            if (isExcluded(filePath, policy)) continue;

            const info = parseDesktopFile(filePath);
            if (!info || info.noDisplay) continue;

            const id = info.id || basename(entry, ".desktop");
            if (seen.has(id) || policy.excludedProgramIds.includes(id)) continue;
            seen.add(id);

            programs.push({
              id,
              name: info.name || id,
              version: info.version,
              executablePath: info.exec || "",
              category: categorizeDesktopEntry(info.categories || ""),
              platform: "linux",
              isCli: info.terminal === true,
              metadata: redactMetadata(
                filterUndefined({
                  comment: info.comment,
                  genericName: info.genericName,
                }),
                policy,
              ),
              discoveredAt: now,
            });
          }
        } catch {
          // Directory read failed — skip
        }
      }

      // Scan CLI tools
      for (const dir of CLI_DIRS) {
        if (!existsSync(dir)) continue;
        if (isExcluded(dir, policy)) continue;

        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            const toolPath = join(dir, entry);
            if (isExcluded(toolPath, policy)) continue;

            const id = `cli:${entry}`;
            if (seen.has(id) || policy.excludedProgramIds.includes(id)) continue;
            seen.add(id);

            programs.push({
              id,
              name: entry,
              executablePath: toolPath,
              category: categorizeCliTool(entry),
              platform: "linux",
              isCli: true,
              metadata: redactMetadata({}, policy),
              discoveredAt: now,
            });
          }
        } catch {
          // Skip
        }
      }

      return programs;
    },
  };
}

// ─── Desktop File Parser ───

interface DesktopFileInfo {
  id?: string;
  name?: string;
  genericName?: string;
  comment?: string;
  exec?: string;
  version?: string;
  categories?: string;
  terminal?: boolean;
  noDisplay?: boolean;
}

function parseDesktopFile(path: string): DesktopFileInfo | null {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    const info: DesktopFileInfo = {};
    let inDesktopEntry = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "[Desktop Entry]") {
        inDesktopEntry = true;
        continue;
      }
      if (trimmed.startsWith("[") && trimmed !== "[Desktop Entry]") {
        inDesktopEntry = false;
        continue;
      }
      if (!inDesktopEntry) continue;

      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();

      switch (key) {
        case "Name":
          info.name = value;
          break;
        case "GenericName":
          info.genericName = value;
          break;
        case "Comment":
          info.comment = value;
          break;
        case "Exec":
          info.exec = value.split(" ")[0]; // Strip args
          break;
        case "Version":
          info.version = value;
          break;
        case "Categories":
          info.categories = value;
          break;
        case "Terminal":
          info.terminal = value.toLowerCase() === "true";
          break;
        case "NoDisplay":
          info.noDisplay = value.toLowerCase() === "true";
          break;
        case "StartupWMClass":
          info.id = info.id || value;
          break;
      }
    }

    return info;
  } catch {
    return null;
  }
}

// ─── Categorization ───

const XDG_CATEGORY_MAP: Record<string, FridayProgramCategory> = {
  WebBrowser: "browser",
  TextEditor: "editor",
  Development: "development",
  IDE: "development",
  TerminalEmulator: "terminal",
  InstantMessaging: "communication",
  Email: "communication",
  VideoConference: "communication",
  AudioVideo: "media",
  Player: "media",
  Office: "productivity",
  WordProcessor: "productivity",
  Spreadsheet: "productivity",
  Database: "database",
  Security: "security",
  System: "system",
  Settings: "system",
  Graphics: "design",
  Finance: "finance",
};

function categorizeDesktopEntry(categories: string): FridayProgramCategory {
  const cats = categories.split(";").map((c) => c.trim());
  for (const cat of cats) {
    const mapped = XDG_CATEGORY_MAP[cat];
    if (mapped) return mapped;
  }
  return "other";
}

const CLI_PATTERNS: Array<[RegExp, FridayProgramCategory]> = [
  [/git|node|python|ruby|go|rust|docker|npm|yarn|bun|deno|cargo|pip/i, "development"],
  [/psql|mysql|redis|mongo|sqlite/i, "database"],
  [/curl|wget|ssh|scp|rsync/i, "cloud"],
  [/gpg|openssl|pass/i, "security"],
  [/ffmpeg|mpv|sox/i, "media"],
];

function categorizeCliTool(name: string): FridayProgramCategory {
  for (const [pattern, category] of CLI_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  return "development";
}

// ─── Helpers ───

function isExcluded(path: string, policy: FridayDiscoveryPolicy): boolean {
  return policy.excludedPaths.some((excluded) => path.startsWith(excluded));
}

function redactMetadata(
  meta: Record<string, string>,
  policy: FridayDiscoveryPolicy,
): Record<string, string> {
  if (!policy.redactSensitiveDetails) return meta;
  const redacted: Record<string, string> = {};
  const home = homedir();
  for (const [k, v] of Object.entries(meta)) {
    redacted[k] = v.replace(new RegExp(home, "g"), "~");
  }
  return redacted;
}

function filterUndefined(obj: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}
