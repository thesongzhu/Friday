/**
 * Community Skill Catalog.
 *
 * Currently scans local OpenClaw repos for shareable skills.
 * Future: connect to remote skill registries.
 *
 * @module skills/converter/discovery
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

export interface CommunitySkillItem {
  id: string;
  name: string;
  nameZh: string;
  nameEn: string;
  description: string;
  descriptionZh: string;
  descriptionEn: string;
  author: string;
  sourceUrl: string;
  tags: string[];
  category: string;
}

function extractFromSkillMd(content: string): { description: string; tags: string[] } {
  let description = "";
  const tags: string[] = [];

  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx);
      const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      const tagsMatch = /^tags:\s*\[([^\]]*)\]/m.exec(frontmatter);
      if (tagsMatch) {
        tags.push(...tagsMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      }
    }
  }

  if (!description) {
    const headingMatch = /^#+\s+(.+)$/m.exec(content);
    if (headingMatch) description = headingMatch[1].trim();
  }

  return { description, tags };
}

/**
 * Scan local OpenClaw skill repos in ~/Projects/ and return them as community skills.
 * This is a bridge until a remote registry is available.
 */
export function getCommunitySkillCatalog(query?: string): CommunitySkillItem[] {
  const home = homedir();
  const items: CommunitySkillItem[] = [];

  // Scan known OpenClaw/skill repos
  const searchDirs = [
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "Developer"),
  ];

  for (const searchDir of searchDirs) {
    if (!existsSync(searchDir)) continue;

    let projects: string[];
    try { projects = readdirSync(searchDir); } catch { continue; }

    for (const project of projects) {
      const projectPath = join(searchDir, project);
      try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }

      // Look for skills/ directory
      const skillsDir = join(projectPath, "skills");
      if (!existsSync(skillsDir)) continue;

      let skillFolders: string[];
      try { skillFolders = readdirSync(skillsDir); } catch { continue; }

      for (const folder of skillFolders) {
        const skillMdPath = join(skillsDir, folder, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;

        try {
          const content = readFileSync(skillMdPath, "utf-8").slice(0, 2000);
          const { description, tags } = extractFromSkillMd(content);
          const name = folder.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          const id = createHash("sha256").update(skillMdPath).digest("hex").slice(0, 16);

          items.push({
            id: `community-${id}`,
            name,
            nameZh: name,
            nameEn: name,
            description: description || `Skill from ${project}`,
            descriptionZh: description || `来自 ${project} 的技能`,
            descriptionEn: description || `Skill from ${project}`,
            author: project,
            sourceUrl: skillMdPath,
            tags: tags.length > 0 ? tags : [basename(projectPath)],
            category: "community",
          });
        } catch { /* skip */ }
      }
    }
  }

  // Filter by query if provided
  if (query && query.trim().length > 0) {
    const q = query.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return items;
}
