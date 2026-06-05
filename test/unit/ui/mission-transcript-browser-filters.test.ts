import { describe, expect, it } from "vitest";
import type { MissionTranscriptSection } from "../../../ui/src/lib/mission-workbench/mission-workbench-contract";
import {
  evidenceRefValues,
  filterMissionTranscriptSections,
  matchesMissionTranscriptEvidenceFacet,
  matchesMissionTranscriptEventFilter,
  sectionMatchesMissionTranscriptGroup,
} from "../../../ui/src/lib/mission-workbench/mission-transcript-browser-filters";

const sections = [
  {
    id: "section_provider",
    title: "Provider session",
    groupKind: "provider_session",
    missionId: "mission_capture_target",
    workItemId: "work_provider",
    truthLabel: "friday_owned",
    status: "provider_ack",
    events: [
      {
        id: "event_provider_ack",
        missionId: "mission_capture_target",
        workItemId: "work_provider",
        surface: "desktop",
        status: "provider_ack",
        truthLabel: "friday_owned",
        summary: "Provider acknowledged the mission-bound ask; this is not completion.",
        proofRef: "proof://provider/receipt/redacted",
        evidenceRefs: {
          providerRef: "provider://session/redacted",
          proofReceiptRef: "proof://provider/receipt/redacted",
          timelineRef: "timeline://mission/page-1/event-provider-ack",
        },
        capturedAt: "2026-06-05T05:00:00Z",
      },
    ],
  },
  {
    id: "section_skill",
    title: "Skill run candidate",
    groupKind: "skill_run",
    missionId: "mission_capture_target",
    workItemId: "work_skill",
    truthLabel: "observed_only",
    status: "waiting",
    events: [
      {
        id: "event_skill_candidate",
        missionId: "mission_capture_target",
        workItemId: "work_skill",
        surface: "timeline",
        status: "waiting",
        truthLabel: "observed_only",
        summary: "Observed skill remains approval-gated and review-only.",
        evidenceRefs: {
          skillRunRef: "skill://observed/redacted",
          workflowRef: "workflow://candidate/redacted",
          timelineRef: "timeline://mission/page-2/event-skill-candidate",
        },
        capturedAt: "2026-06-05T05:01:00Z",
      },
    ],
  },
  {
    id: "section_channel",
    title: "Channel task",
    groupKind: "channel_task",
    missionId: "mission_capture_target",
    truthLabel: "friday_owned",
    status: "ready",
    events: [
      {
        id: "event_channel_receipt",
        missionId: "mission_capture_target",
        surface: "telegram",
        status: "ready",
        truthLabel: "friday_owned",
        summary: "Channel receipt is redacted and linked to the same Mission.",
        evidenceRefs: {
          channelRef: "channel://telegram/redacted",
          surfaceThreadRef: "surface://telegram/thread/redacted",
          timelineRef: "timeline://mission/page-2/event-channel-receipt",
        },
        capturedAt: "2026-06-05T05:02:00Z",
      },
    ],
  },
] satisfies MissionTranscriptSection[];

describe("Mission Transcript Browser filters", () => {
  it("collects only populated evidence refs", () => {
    expect(evidenceRefValues(sections[0].events[0])).toEqual([
      "provider://session/redacted",
      "proof://provider/receipt/redacted",
      "timeline://mission/page-1/event-provider-ack",
    ]);
  });

  it("matches evidence facets without upgrading provider ack to completion", () => {
    const providerEvent = sections[0].events[0];

    expect(matchesMissionTranscriptEvidenceFacet(providerEvent, "provider")).toBe(true);
    expect(matchesMissionTranscriptEvidenceFacet(providerEvent, "proof_receipt")).toBe(true);
    expect(matchesMissionTranscriptEvidenceFacet(providerEvent, "skill")).toBe(false);
    expect(providerEvent.status).toBe("provider_ack");
  });

  it("matches query text across mission, work item, proof, evidence refs, and capture time", () => {
    const providerEvent = sections[0].events[0];

    expect(matchesMissionTranscriptEventFilter(providerEvent, {
      query: "mission_capture_target",
      surface: "all",
      state: "all",
      facet: "all",
    })).toBe(true);
    expect(matchesMissionTranscriptEventFilter(providerEvent, {
      query: "work_provider",
      surface: "all",
      state: "all",
      facet: "all",
    })).toBe(true);
    expect(matchesMissionTranscriptEventFilter(providerEvent, {
      query: "proof://provider/receipt/redacted",
      surface: "all",
      state: "all",
      facet: "all",
    })).toBe(true);
    expect(matchesMissionTranscriptEventFilter(providerEvent, {
      query: "2026-06-05T05:00:00Z",
      surface: "all",
      state: "all",
      facet: "all",
    })).toBe(true);
  });

  it("applies surface, state, group, and facet filters together", () => {
    const filtered = filterMissionTranscriptSections(sections, {
      query: "",
      surface: "timeline",
      state: "waiting",
      group: "skill_run",
      facet: "skill",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("section_skill");
    expect(filtered[0].events.map((event) => event.id)).toEqual(["event_skill_candidate"]);
  });

  it("keeps no-filter browsing broad and collapses empty filtered groups", () => {
    expect(sectionMatchesMissionTranscriptGroup(sections[2], "channel_task")).toBe(true);
    expect(filterMissionTranscriptSections(sections, {
      query: "",
      surface: "all",
      state: "all",
      group: "all",
      facet: "all",
    }).map((section) => section.id)).toEqual([
      "section_provider",
      "section_skill",
      "section_channel",
    ]);

    expect(filterMissionTranscriptSections(sections, {
      query: "missing-ref",
      surface: "all",
      state: "all",
      group: "all",
      facet: "all",
    })).toEqual([]);
  });
});
