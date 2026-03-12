/**
 * Windows Program Scanner.
 *
 * Discovers installed applications by querying the Windows Registry
 * (Uninstall keys), scanning Program Files directories, and checking
 * common CLI tool locations.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type {
  FridayDiscoveredProgram,
  FridayDiscoveryPolicy,
  FridayProgramCategory,
  FridayProgramScanner,
} from "./friday-program-discovery.types.js";

// ─── Constants ───

const REGISTRY_PATHS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

const PROGRAM_DIRS = [
  process.env["ProgramFiles"] ?? "C:\\Program Files",
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  join(homedir(), "AppData", "Local", "Programs"),
];

// ─── Factory ───

export function createWin32ProgramScanner(): FridayProgramScanner {
  return {
    platform: "win32",
    async scan(policy: FridayDiscoveryPolicy): Promise<FridayDiscoveredProgram[]> {
      const programs: FridayDiscoveredProgram[] = [];
      const now = new Date().toISOString();
      const seen = new Set<string>();

      // Query Windows Registry
      for (const regPath of REGISTRY_PATHS) {
        try {
          const entries = queryRegistryUninstallKeys(regPath);
          for (const entry of entries) {
            if (!entry.name) continue;
            const id = entry.id || entry.name;
            if (seen.has(id) || policy.excludedProgramIds.includes(id)) continue;
            if (entry.installLocation && isExcluded(entry.installLocation, policy)) continue;
            seen.add(id);

            programs.push({
              id,
              name: entry.name,
              version: entry.version,
              executablePath: entry.installLocation || "",
              category: categorizeProgram(entry.name),
              platform: "win32",
              isCli: false,
              metadata: redactMetadata(
                filterUndefined({
                  publisher: entry.publisher,
                }),
                policy,
              ),
              discoveredAt: now,
            });
          }
        } catch {
          // Registry query failed — skip
        }
      }

      // Scan Program Files directories for .exe files
      for (const dir of PROGRAM_DIRS) {
        if (!existsSync(dir)) continue;
        if (isExcluded(dir, policy)) continue;

        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            const id = `dir:${entry}`;
            if (seen.has(id) || policy.excludedProgramIds.includes(id)) continue;
            seen.add(id);

            programs.push({
              id,
              name: entry,
              executablePath: fullPath,
              category: categorizeProgram(entry),
              platform: "win32",
              isCli: false,
              metadata: redactMetadata({}, policy),
              discoveredAt: now,
            });
          }
        } catch {
          // Directory read failed — skip
        }
      }

      return programs;
    },
  };
}

// ─── Registry Query ───

interface RegistryEntry {
  id: string;
  name: string;
  version?: string;
  publisher?: string;
  installLocation?: string;
}

function queryRegistryUninstallKeys(regPath: string): RegistryEntry[] {
  try {
    const output = execSync(
      `reg query "${regPath}" /s 2>nul`,
      { encoding: "utf-8", timeout: 10000 },
    );
    return parseRegistryOutput(output);
  } catch {
    return [];
  }
}

function parseRegistryOutput(output: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const blocks = output.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) continue;

    const keyPath = lines[0]?.trim();
    const id = keyPath ? basename(keyPath) : "";

    let name: string | undefined;
    let version: string | undefined;
    let publisher: string | undefined;
    let installLocation: string | undefined;

    for (const line of lines) {
      const match = line.match(/^\s+(\S+)\s+REG_SZ\s+(.+)$/);
      if (!match) continue;
      const [, key, value] = match;
      switch (key) {
        case "DisplayName":
          name = value.trim();
          break;
        case "DisplayVersion":
          version = value.trim();
          break;
        case "Publisher":
          publisher = value.trim();
          break;
        case "InstallLocation":
          installLocation = value.trim();
          break;
      }
    }

    if (name) {
      entries.push({ id, name, version, publisher, installLocation });
    }
  }

  return entries;
}

// ─── Categorization ───

const CATEGORY_PATTERNS: Array<[RegExp, FridayProgramCategory]> = [
  [/chrome|firefox|edge|brave|opera|vivaldi/i, "browser"],
  [/code|vim|notepad\+\+|sublime|jetbrains|idea|webstorm|pycharm/i, "editor"],
  [/terminal|powershell|cmd|conemu|windowsterminal|cmder/i, "terminal"],
  [/slack|discord|teams|zoom|telegram|signal|outlook|thunderbird/i, "communication"],
  [/spotify|vlc|media|player|foobar|audacity|obs/i, "media"],
  [/word|excel|powerpoint|onenote|notion|obsidian|office/i, "productivity"],
  [/git|node|python|ruby|go|rust|docker|npm|yarn|visual studio/i, "development"],
  [/postgres|mysql|redis|mongo|sql server|ssms|dbeaver/i, "database"],
  [/aws|gcloud|azure|cloudflare/i, "cloud"],
  [/keepass|bitwarden|gpg|wireshark|defender/i, "security"],
  [/autohotkey|power automate|task scheduler/i, "automation"],
  [/figma|photoshop|illustrator|gimp|paint/i, "design"],
  [/system|control panel|device manager|registry/i, "system"],
];

function categorizeProgram(name: string): FridayProgramCategory {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  return "other";
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
  const user = basename(home);
  for (const [k, v] of Object.entries(meta)) {
    redacted[k] = v.replace(new RegExp(home.replace(/\\/g, "\\\\"), "g"), "%USERPROFILE%")
      .replace(new RegExp(user, "g"), "[REDACTED]");
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
