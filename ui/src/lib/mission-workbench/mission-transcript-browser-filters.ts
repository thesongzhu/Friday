import type {
  MissionLifecycleState,
  MissionSurfaceKind,
  MissionTranscriptEvent,
  MissionTranscriptGroupKind,
  MissionTranscriptSection,
} from "@/lib/mission-workbench/mission-workbench-contract";

export type MissionTranscriptFacetFilter =
  | "all"
  | "provider"
  | "skill"
  | "channel"
  | "workflow"
  | "surface_thread"
  | "timeline"
  | "proof_receipt"
  | "time";

export interface MissionTranscriptFilterInput {
  query: string;
  surface: MissionSurfaceKind | "all";
  state: MissionLifecycleState | "all";
  group: MissionTranscriptGroupKind | "all";
  facet: MissionTranscriptFacetFilter;
}

export function evidenceRefValues(event: MissionTranscriptEvent): string[] {
  return Object.values(event.evidenceRefs).filter((value): value is string => Boolean(value));
}

export function matchesMissionTranscriptEvidenceFacet(
  event: MissionTranscriptEvent,
  facet: MissionTranscriptFacetFilter,
): boolean {
  if (facet === "all") return true;
  if (facet === "provider") return Boolean(event.evidenceRefs.providerRef);
  if (facet === "skill") return Boolean(event.evidenceRefs.skillRunRef);
  if (facet === "channel") return Boolean(event.evidenceRefs.channelRef);
  if (facet === "workflow") return Boolean(event.evidenceRefs.workflowRef);
  if (facet === "surface_thread") return Boolean(event.evidenceRefs.surfaceThreadRef);
  if (facet === "timeline") return Boolean(event.evidenceRefs.timelineRef);
  if (facet === "proof_receipt") return Boolean(event.evidenceRefs.proofReceiptRef || event.proofRef);
  return Boolean(event.capturedAt);
}

export function matchesMissionTranscriptEventFilter(
  event: MissionTranscriptEvent,
  filter: Omit<MissionTranscriptFilterInput, "group">,
): boolean {
  if (filter.surface !== "all" && event.surface !== filter.surface) return false;
  if (filter.state !== "all" && event.status !== filter.state) return false;
  if (!matchesMissionTranscriptEvidenceFacet(event, filter.facet)) return false;
  if (!filter.query.trim()) return true;

  const haystack = [
    event.id,
    event.missionId,
    event.workItemId ?? "",
    event.surface,
    event.status,
    event.truthLabel,
    event.summary,
    event.proofRef ?? "",
    ...evidenceRefValues(event),
    event.capturedAt,
  ].join(" ").toLowerCase();

  return haystack.includes(filter.query.trim().toLowerCase());
}

export function sectionMatchesMissionTranscriptGroup(
  section: MissionTranscriptSection,
  group: MissionTranscriptGroupKind | "all",
): boolean {
  return group === "all" || section.groupKind === group;
}

export function filterMissionTranscriptSections(
  sections: MissionTranscriptSection[],
  filter: MissionTranscriptFilterInput,
): MissionTranscriptSection[] {
  const noActiveFilters = (
    !filter.query.trim() &&
    filter.surface === "all" &&
    filter.state === "all" &&
    filter.group === "all" &&
    filter.facet === "all"
  );

  return sections
    .filter((section) => sectionMatchesMissionTranscriptGroup(section, filter.group))
    .map((section) => ({
      ...section,
      events: section.events.filter((event) => matchesMissionTranscriptEventFilter(event, filter)),
    }))
    .filter((section) => section.events.length > 0 || noActiveFilters);
}
