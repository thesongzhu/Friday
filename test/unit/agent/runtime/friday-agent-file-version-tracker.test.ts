import { mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createFridayFileVersionTracker } from "#agent";

describe("friday-agent-file-version-tracker", () => {
  it("detects when a file changes after being read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-file-version-"));
    const filePath = join(dir, "tracked.txt");

    try {
      writeFileSync(filePath, "v1");
      const tracker = createFridayFileVersionTracker();
      tracker.recordRead(filePath);

      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(filePath, "v2");

      const result = tracker.checkBeforeWrite(filePath);
      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(["mtime_changed", "size_changed"]).toContain(result.reason);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
