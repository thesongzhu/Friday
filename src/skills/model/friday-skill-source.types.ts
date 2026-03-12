import { FridayDomainError } from "#errors";

export type SkillSource = "bundled" | "marketplace" | "git" | "local";

export type SkillOrigin =
  | "extra"
  | "bundled"
  | "managed"
  | "agents-skills-personal"
  | "agents-skills-project"
  | "workspace";

export const FRIDAY_SKILL_ORIGIN_PRECEDENCE: SkillOrigin[] = [
  "extra",
  "bundled",
  "managed",
  "agents-skills-personal",
  "agents-skills-project",
  "workspace",
];

/** Returns precedence index where larger value means higher collision priority. */
export function getSkillOriginPrecedence(origin: SkillOrigin): number {
  const index = FRIDAY_SKILL_ORIGIN_PRECEDENCE.indexOf(origin);
  if (index === -1) {
    throw new FridayDomainError("SKILL_ORIGIN_NOT_FOUND", `Unknown skill origin: ${origin}`, { httpStatus: 400 });
  }
  return index;
}

/** Returns >0 when left should win collision over right. */
export function compareSkillOrigins(left: SkillOrigin, right: SkillOrigin): number {
  return getSkillOriginPrecedence(left) - getSkillOriginPrecedence(right);
}
