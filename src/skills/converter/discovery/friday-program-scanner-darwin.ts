/**
 * macOS Program Scanner.
 *
 * Discovers installed applications by scanning /Applications,
 * ~/Applications, and Homebrew CLI tools. Uses `mdls` for metadata
 * and `system_profiler` as a fallback.
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

const APP_DIRS = ["/Applications", join(homedir(), "Applications")];
const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

// ─── Factory ───

export function createDarwinProgramScanner(): FridayProgramScanner {
  return {
    platform: "darwin",
    async scan(policy: FridayDiscoveryPolicy): Promise<FridayDiscoveredProgram[]> {
      const programs: FridayDiscoveredProgram[] = [];
      const now = new Date().toISOString();
      const seen = new Set<string>();

      // Scan .app bundles
      for (const dir of APP_DIRS) {
        if (!existsSync(dir)) continue;
        if (isExcluded(dir, policy)) continue;

        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            if (!entry.endsWith(".app")) continue;
            const appPath = join(dir, entry);
            if (isExcluded(appPath, policy)) continue;

            const info = readAppBundleInfo(appPath);
            if (!info) continue;

            const id = info.bundleId || appPath;
            if (seen.has(id) || policy.excludedProgramIds.includes(id)) continue;
            seen.add(id);

            programs.push({
              id,
              name: info.name || basename(entry, ".app"),
              version: info.version,
              executablePath: appPath,
              bundleId: info.bundleId,
              category: categorizeApp(info.name || entry, info.bundleId),
              platform: "darwin",
              isCli: false,
              metadata: redactMetadata(
                filterUndefined({
                  publisher: info.publisher,
                  copyright: info.copyright,
                }),
                policy,
              ),
              discoveredAt: now,
            });
          }
        } catch (err) {
        console.warn("[friday][program-scanner-darwin] operation failed:", err instanceof Error ? err.message : String(err));
          // Directory read failed — skip silently
        }
      }

      // Scan Homebrew CLI tools
      for (const dir of HOMEBREW_DIRS) {
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
              platform: "darwin",
              isCli: true,
              metadata: redactMetadata({}, policy),
              discoveredAt: now,
            });
          }
        } catch (err) {
        console.warn("[friday][program-scanner-darwin] operation failed:", err instanceof Error ? err.message : String(err));
          // Skip
        }
      }

      return programs;
    },
  };
}

// ─── Bundle Info ───

interface AppBundleInfo {
  name?: string;
  version?: string;
  bundleId?: string;
  publisher?: string;
  copyright?: string;
}

function readAppBundleInfo(appPath: string): AppBundleInfo | null {
  try {
    const plistPath = join(appPath, "Contents", "Info.plist");
    if (!existsSync(plistPath)) return null;

    const output = execSync(
      `defaults read "${plistPath.replace(/\.plist$/, "")}" 2>/dev/null || true`,
      { encoding: "utf-8", timeout: 5000 },
    );

    return {
      name: extractPlistValue(output, "CFBundleDisplayName")
        || extractPlistValue(output, "CFBundleName"),
      version: extractPlistValue(output, "CFBundleShortVersionString"),
      bundleId: extractPlistValue(output, "CFBundleIdentifier"),
      publisher: extractPlistValue(output, "NSHumanReadableCopyright"),
    };
  } catch (err) {
        console.warn("[friday][program-scanner-darwin] operation failed:", err instanceof Error ? err.message : String(err));
    // Fall back to basename
    return { name: basename(appPath, ".app") };
  }
}

function extractPlistValue(output: string, key: string): string | undefined {
  const regex = new RegExp(`"?${key}"?\\s*=\\s*"?([^";\\n]+)"?`, "m");
  const match = output.match(regex);
  return match?.[1]?.trim();
}

// ─── Categorization ───

const CATEGORY_PATTERNS: Array<[RegExp, FridayProgramCategory]> = [
  [/safari|chrome|firefox|brave|edge|arc|opera|vivaldi/i, "browser"],
  [/code|vim|neovim|emacs|sublime|atom|jetbrains|idea|webstorm|pycharm|xcode/i, "editor"],
  [/terminal|iterm|warp|alacritty|kitty|hyper|wezterm/i, "terminal"],
  [/slack|discord|teams|zoom|telegram|signal|messages|mail|outlook/i, "communication"],
  [/spotify|vlc|music|quicktime|handbrake|obs|audacity|ffmpeg/i, "media"],
  [/pages|numbers|keynote|word|excel|powerpoint|notion|obsidian|craft/i, "productivity"],
  [/git|node|python|ruby|go|rust|docker|kubectl|npm|yarn|bun|deno|brew/i, "development"],
  [/postgres|mysql|redis|mongo|sequel|datagrip|dbeaver|tableplus/i, "database"],
  [/aws|gcloud|azure|cloudflare|vercel|netlify|heroku/i, "cloud"],
  [/1password|bitwarden|keychain|gpg|openssl|wireshark|burp/i, "security"],
  [/automator|shortcuts|alfred|raycast|keyboard\s*maestro|hazel|hammerspoon/i, "automation"],
  [/figma|sketch|photoshop|illustrator|canva|pixelmator|affinity/i, "design"],
  [/system\s*preferences|activity\s*monitor|disk\s*utility|finder/i, "system"],
];

function categorizeApp(name: string, bundleId?: string): FridayProgramCategory {
  const searchText = `${name} ${bundleId ?? ""}`;
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(searchText)) return category;
  }
  return "other";
}

function categorizeCliTool(name: string): FridayProgramCategory {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  return "development"; // Most CLI tools are development-related
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
  for (const [k, v] of Object.entries(meta)) {
    redacted[k] = v.replace(new RegExp(homedir(), "g"), "~");
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
