import { FridayDomainError } from "#errors";

export type SkillSource = "bundled" | "git" | "local";

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

export interface FridaySkillSourceTaxonomyEntry {
  source: SkillSource;
  distribution: "first-party" | "repository" | "local";
  mutableAtRuntime: boolean;
  requiresSignaturePolicy: boolean;
}

export const FRIDAY_SKILL_SOURCE_TAXONOMY: Readonly<Record<SkillSource, FridaySkillSourceTaxonomyEntry>> = Object.freeze({
  bundled: {
    source: "bundled",
    distribution: "first-party",
    mutableAtRuntime: false,
    requiresSignaturePolicy: false,
  },
  git: {
    source: "git",
    distribution: "repository",
    mutableAtRuntime: true,
    requiresSignaturePolicy: true,
  },
  local: {
    source: "local",
    distribution: "local",
    mutableAtRuntime: true,
    requiresSignaturePolicy: false,
  },
});

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

export function classifyFridaySkillSource(source: SkillSource): FridaySkillSourceTaxonomyEntry {
  const entry = FRIDAY_SKILL_SOURCE_TAXONOMY[source];
  if (!entry) {
    throw new FridayDomainError("SKILL_SOURCE_NOT_FOUND", `Unknown skill source: ${String(source)}`, { httpStatus: 400 });
  }
  return entry;
}
