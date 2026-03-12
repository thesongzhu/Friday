import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridaySkillWatcher } from "#skills";

describe("createFridaySkillWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "friday-test-watcher-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("debounces change events to the correct skill ID", async () => {
    const filePath = join(tmpDir, "skill.manifest.json");
    writeFileSync(filePath, "{}");

    const events: Array<{ skillId: string; changeType: string }> = [];
    const onChangeFn = vi.fn(async (event: { skillId: string; changeType: string }) => {
      events.push(event);
    });

    const watcher = createFridaySkillWatcher({
      debounceMs: 50,
      onChange: onChangeFn,
    });

    const targets = new Map<string, string[]>();
    targets.set("test-skill", [filePath]);

    await watcher.start(targets);

    // Small delay to let watcher fully settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Trigger a file change
    writeFileSync(filePath, '{"updated": true}');

    // Wait for chokidar detection + debounce + awaitWriteFinish
    await new Promise((resolve) => setTimeout(resolve, 500));

    await watcher.close();

    expect(onChangeFn).toHaveBeenCalled();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.skillId).toBe("test-skill");
  });

  it("can close without errors", async () => {
    const watcher = createFridaySkillWatcher({
      debounceMs: 50,
      onChange: async () => {},
    });

    await watcher.start(new Map());
    await watcher.close();
  });

  it("can update targets after start", async () => {
    const filePath1 = join(tmpDir, "file1.json");
    const filePath2 = join(tmpDir, "file2.json");
    writeFileSync(filePath1, "{}");
    writeFileSync(filePath2, "{}");

    const watcher = createFridaySkillWatcher({
      debounceMs: 50,
      onChange: async () => {},
    });

    const targets1 = new Map<string, string[]>();
    targets1.set("skill-1", [filePath1]);
    await watcher.start(targets1);

    const targets2 = new Map<string, string[]>();
    targets2.set("skill-2", [filePath2]);
    await watcher.updateTargets(targets2);

    await watcher.close();
  });
});
