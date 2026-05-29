import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const wizardSrc = readFileSync(
  resolve(repoRoot, "ui/src/components/core/skill-import-wizard.tsx"),
  "utf8",
);

// Audit E4 (capability-truthfulness): the skill-import "Desktop Recording" wizard must NOT tell
// users to install/launch a "Friday Recorder" app — no such app ships (apps/macos/FridayCompanion
// is a notification/hotkey companion, not a recorder). The copy must honestly state that desktop
// screen-recording capture is not bundled with Friday. This is a doc/copy truth-label only.
describe("skill-import 'Desktop Recording' copy truthfulness (audit E4)", () => {
  it("does not name a non-existent 'Friday Recorder' app or instruct installing/launching one", () => {
    expect(wizardSrc).not.toContain("Friday Recorder");
    expect(wizardSrc).not.toContain("install and launch");
    expect(wizardSrc).not.toContain("安装并启动");
  });

  it("honestly states desktop screen recording is not bundled (en + zh)", () => {
    expect(wizardSrc).toContain("isn't bundled with Friday");
    expect(wizardSrc).toContain("未内置桌面录屏");
  });
});
