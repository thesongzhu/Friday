import { EvidenceSummaryCard, PageScenarioCard } from "../../src/composite/console-composites";
import { pagePreviewFixtures, shellNavItems } from "../../src/fixtures/preview-fixtures";
import { DesktopConsoleShell, MobileConsoleShell } from "../../src/shell/shell-layout";
import { RightRailChatCard } from "../../src/shell/right-rail-chat-contract";
import type { PageId, ShellContextContract } from "../../src/types";

function makeContext(pageId: PageId): ShellContextContract {
  const fixture = pagePreviewFixtures[pageId];

  return {
    sourcePage: pageId,
    objectType: `${pageId}Surface`,
    summary: fixture.title,
    injections: fixture.modules.map((item) => `${item.title}: ${item.value}`),
    quickActions: fixture.rightRailSummary,
  };
}

export function DesktopPagePreview({ pageId }: { pageId: PageId }) {
  const fixture = pagePreviewFixtures[pageId];
  const context = makeContext(pageId);

  return (
    <DesktopConsoleShell title={fixture.title} nav={shellNavItems} context={context} rightRail={<RightRailChatCard context={context} />}>
      <div style={{ display: "grid", gap: 16 }}>
        <PageScenarioCard fixture={fixture} />
        <EvidenceSummaryCard items={fixture.rightRailSummary} />
      </div>
    </DesktopConsoleShell>
  );
}

export function MobilePagePreview({ pageId }: { pageId: PageId }) {
  const fixture = pagePreviewFixtures[pageId];
  const context = makeContext(pageId);

  return (
    <MobileConsoleShell title={fixture.title} nav={shellNavItems} context={context} rightRail={<RightRailChatCard context={context} />}>
      <div style={{ display: "grid", gap: 16 }}>
        <PageScenarioCard fixture={fixture} />
      </div>
    </MobileConsoleShell>
  );
}
