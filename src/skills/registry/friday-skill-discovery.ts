import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  FridayDiscoveredSkillCandidate,
  FridaySkillDiscoveryRoot,
} from "./friday-skill-registry.types.js";
import type { FridaySkillRegistrySettings } from "#hub";
import { FRIDAY_SKILL_ORIGIN_PRECEDENCE } from "../model/friday-skill-source.types.js";

/**
 * Builds precedence-ordered roots from config settings.
 * Discovery roots per §2.7.1:
 *   extra < bundled < managed (~/.config/friday/skills/) <
 *   agents-skills-personal (~/.agents/skills/) <
 *   agents-skills-project (<workspaceDir>/.agents/skills/) <
 *   workspace (<workspaceDir>/skills/)
 */
export function resolveFridaySkillDiscoveryRoots(
  settings: FridaySkillRegistrySettings,
): FridaySkillDiscoveryRoot[] {
  const roots: FridaySkillDiscoveryRoot[] = [];

  // Extra dirs (lowest precedence)
  for (const dir of settings.extraSkillDirs) {
    roots.push({ origin: "extra", source: "local", dir });
  }

  // Bundled
  roots.push({
    origin: "bundled",
    source: "bundled",
    dir: settings.bundledSkillsDir,
  });

  // Managed — per §2.7.1: ~/.config/friday/skills/
  roots.push({
    origin: "managed",
    source: "marketplace",
    dir: settings.managedSkillsDir,
  });

  // agents-skills-personal — per §2.7.1: ~/.agents/skills/
  const agentsPersonal = join(homedir(), ".agents", "skills");
  roots.push({
    origin: "agents-skills-personal",
    source: "local",
    dir: agentsPersonal,
  });

  // agents-skills-project — per §2.7.1: <workspaceDir>/.agents/skills/
  const agentsProject = join(settings.workspaceDir, ".agents", "skills");
  roots.push({
    origin: "agents-skills-project",
    source: "local",
    dir: agentsProject,
  });

  // Workspace — per §2.7.1: <workspaceDir>/skills/
  const workspaceSkills = join(settings.workspaceDir, "skills");
  roots.push({
    origin: "workspace",
    source: "local",
    dir: workspaceSkills,
  });

  // Sort by precedence (lowest first so higher precedence overrides in later merge)
  roots.sort((a, b) => {
    const aIdx = FRIDAY_SKILL_ORIGIN_PRECEDENCE.indexOf(a.origin);
    const bIdx = FRIDAY_SKILL_ORIGIN_PRECEDENCE.indexOf(b.origin);
    return aIdx - bIdx;
  });

  return roots;
}

/** Returns true if a directory looks like a skill (has manifest or SKILL.md). */
function isSkillDirectory(dir: string): boolean {
  return (
    existsSync(join(dir, "skill.manifest.json")) ||
    existsSync(join(dir, "SKILL.md"))
  );
}

/** Discovers skill directories (manifest or SKILL.md) under all roots deterministically. */
export function discoverFridaySkillCandidates(
  roots: FridaySkillDiscoveryRoot[],
): FridayDiscoveredSkillCandidate[] {
  const candidates: FridayDiscoveredSkillCandidate[] = [];

  for (const root of roots) {
    if (!existsSync(root.dir)) continue;

    // Check if the root itself is a skill directory
    if (isSkillDirectory(root.dir)) {
      candidates.push({ root, skillDir: root.dir });
      continue;
    }

    // Scan immediate subdirectories
    let entries: string[];
    try {
      entries = readdirSync(root.dir).sort(); // lexical sort for determinism
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidateDir = join(root.dir, entry);
      try {
        if (!statSync(candidateDir).isDirectory()) continue;
      } catch {
        continue;
      }

      if (isSkillDirectory(candidateDir)) {
        candidates.push({ root, skillDir: candidateDir });
      }
    }
  }

  return candidates;
}
