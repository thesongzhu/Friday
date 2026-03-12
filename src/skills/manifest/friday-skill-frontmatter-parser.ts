import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type ParsedSkillFrontmatter = Record<string, string>;

export interface ParsedFridaySkillMarkdown {
  frontmatter: ParsedSkillFrontmatter;
  body: string;
}

export interface FridaySkillFrontmatterParseError {
  code: "SKILL_MD_READ_FAILED" | "SKILL_MD_FRONTMATTER_INVALID";
  message: string;
  path?: string;
  cause?: unknown;
}

export type ParseFridaySkillFrontmatterResult =
  | { ok: true; value: ParsedFridaySkillMarkdown }
  | { ok: false; error: FridaySkillFrontmatterParseError };

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Extracts YAML frontmatter from markdown (`---` block) using `yaml` package. */
export function parseFridaySkillFrontmatter(
  markdown: string,
): ParseFridaySkillFrontmatterResult {
  const match = FRONTMATTER_REGEX.exec(markdown);
  if (!match) {
    return { ok: true, value: { frontmatter: {}, body: markdown } };
  }

  const yamlBlock = match[1]!;
  const body = match[2]!;

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "SKILL_MD_FRONTMATTER_INVALID",
        message: `Malformed YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      },
    };
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return { ok: true, value: { frontmatter: {}, body } };
  }

  // Coerce all values to strings for the flat frontmatter map
  const frontmatter: ParsedSkillFrontmatter = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    frontmatter[key] = String(value);
  }

  return { ok: true, value: { frontmatter, body } };
}

/** Reads a `SKILL.md` file and parses frontmatter + body content. */
export function loadFridaySkillFrontmatter(
  skillMdPath: string,
): ParseFridaySkillFrontmatterResult {
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf-8");
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "SKILL_MD_READ_FAILED",
        message: `Failed to read SKILL.md: ${skillMdPath}`,
        path: skillMdPath,
        cause,
      },
    };
  }

  const result = parseFridaySkillFrontmatter(content);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        ...result.error,
        path: skillMdPath,
      },
    };
  }

  return result;
}
