import type { SkillCatalogItem, SkillLifecycleDetail, SkillLifecycleSummary } from "@/lib/api/types";

export type FridaySkillFocus = "details" | "install" | "verify" | "sources";

export interface SkillOperatorSections {
  starter: SkillLifecycleSummary[];
  installed: SkillLifecycleSummary[];
  updates: SkillLifecycleSummary[];
  available: SkillCatalogItem[];
}

export function buildSkillHref(skillId?: string | null, focus: FridaySkillFocus = "details"): string {
  const params = new URLSearchParams();
  if (skillId) {
    params.set("skillId", skillId);
  }
  params.set("focus", focus);
  const query = params.toString();
  return query.length > 0 ? `/skills?${query}` : "/skills";
}

export function toneForSkillLifecycle(
  skill: Pick<SkillLifecycleSummary, "status" | "updateAvailable">,
): "neutral" | "success" | "warning" | "danger" {
  if (skill.status === "failed" || skill.status === "error") {
    return "danger";
  }
  if (skill.updateAvailable || skill.status === "upgrade_available") {
    return "warning";
  }
  if (skill.status === "installed" || skill.status === "enabled" || skill.status === "ready") {
    return "success";
  }
  return "neutral";
}

export function summarizeSkillVerification(detail?: SkillLifecycleDetail | null): string {
  const evidence = detail?.verification;
  if (!evidence) {
    return "No verification evidence yet. Friday can validate the manifest, package integrity, runtime dry-run, and trust state.";
  }
  if (evidence.ok) {
    return "Verification passed across manifest validation, runtime dry-run, package integrity, and trust checks.";
  }
  return evidence.runtimeDryRun.reason;
}

export function buildSkillOperatorSections(input: {
  skills: SkillLifecycleSummary[];
  catalog: SkillCatalogItem[];
}): SkillOperatorSections {
  const starter = input.skills
    .filter((skill) => skill.starter)
    .sort((left, right) => left.name.localeCompare(right.name));

  const installed = input.skills
    .filter((skill) => skill.status !== "not_installed" && !skill.starter)
    .sort((left, right) => left.name.localeCompare(right.name));

  const updates = input.skills
    .filter((skill) => skill.updateAvailable)
    .sort((left, right) => left.name.localeCompare(right.name));

  const installedIds = new Set(input.skills.map((skill) => skill.skillId));
  const available = input.catalog
    .filter((item) => !installedIds.has(item.skillId) && !item.starter)
    .sort((left, right) => left.skillName.localeCompare(right.skillName));

  return {
    starter,
    installed,
    updates,
    available,
  };
}

export function chooseInitialSkillId(input: {
  selectedSkillId: string | null;
  skills: SkillLifecycleSummary[];
  catalog: SkillCatalogItem[];
}): string | null {
  if (input.selectedSkillId) {
    return input.selectedSkillId;
  }
  const preferredInstalled = input.skills.find((skill) => skill.updateAvailable)
    ?? input.skills.find((skill) => skill.starter)
    ?? input.skills[0];
  if (preferredInstalled) {
    return preferredInstalled.skillId;
  }
  return input.catalog[0]?.skillId ?? null;
}
