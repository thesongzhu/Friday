import chokidar from "chokidar";
import { dirname } from "node:path";
import type { FSWatcher } from "chokidar";

export interface FridaySkillFileChangeEvent {
  skillId: string;
  skillDir: string;
  changedPath: string;
  changeType: "add" | "change" | "unlink";
}

export interface FridaySkillWatcher {
  /** Starts watcher with initial targets. */
  start(targetsBySkillId: Map<string, string[]>): Promise<void>;
  /** Replaces watcher targets after registry refresh. */
  updateTargets(targetsBySkillId: Map<string, string[]>): Promise<void>;
  /** Stops all watchers and releases file descriptors. */
  close(): Promise<void>;
}

/** Creates a debounced chokidar watcher for skill declared files. */
export function createFridaySkillWatcher(options: {
  debounceMs: number;
  onChange: (event: FridaySkillFileChangeEvent) => Promise<void> | void;
}): FridaySkillWatcher {
  const { debounceMs, onChange } = options;

  let watcher: FSWatcher | null = null;
  let fileToSkillMap = new Map<string, { skillId: string; skillDir: string }>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function buildFileMap(targetsBySkillId: Map<string, string[]>): Map<string, { skillId: string; skillDir: string }> {
    const map = new Map<string, { skillId: string; skillDir: string }>();
    for (const [skillId, files] of targetsBySkillId) {
      // Derive skillDir from the first file's parent directory
      // The first file is typically skill.manifest.json or SKILL.md at the skill root
      const skillDir = files.length > 0 ? dirname(files[0]!) : "";
      for (const file of files) {
        map.set(file, { skillId, skillDir });
      }
    }
    return map;
  }

  function handleChange(changedPath: string, changeType: "add" | "change" | "unlink"): void {
    const mapping = fileToSkillMap.get(changedPath);
    if (!mapping) return;

    const { skillId, skillDir } = mapping;
    const timerKey = skillId;

    // Debounce per skill
    const existing = pendingTimers.get(timerKey);
    if (existing) clearTimeout(existing);

    pendingTimers.set(
      timerKey,
      setTimeout(() => {
        pendingTimers.delete(timerKey);
        void onChange({ skillId, skillDir, changedPath, changeType });
      }, debounceMs),
    );
  }

  return {
    async start(targetsBySkillId: Map<string, string[]>): Promise<void> {
      fileToSkillMap = buildFileMap(targetsBySkillId);
      const allFiles = Array.from(fileToSkillMap.keys());

      if (allFiles.length === 0) return;

      watcher = chokidar.watch(allFiles, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100 },
      });

      watcher.on("add", (path) => handleChange(path, "add"));
      watcher.on("change", (path) => handleChange(path, "change"));
      watcher.on("unlink", (path) => handleChange(path, "unlink"));

      // Wait for ready
      await new Promise<void>((resolve) => {
        watcher!.on("ready", resolve);
      });
    },

    async updateTargets(targetsBySkillId: Map<string, string[]>): Promise<void> {
      if (!watcher) {
        return this.start(targetsBySkillId);
      }

      const newFileMap = buildFileMap(targetsBySkillId);
      const newFiles = new Set(newFileMap.keys());
      const oldFiles = new Set(fileToSkillMap.keys());

      // Remove old files
      for (const file of oldFiles) {
        if (!newFiles.has(file)) {
          await watcher.unwatch(file);
        }
      }

      // Add new files
      for (const file of newFiles) {
        if (!oldFiles.has(file)) {
          watcher.add(file);
        }
      }

      fileToSkillMap = newFileMap;
    },

    async close(): Promise<void> {
      // Clear pending timers
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();

      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      fileToSkillMap.clear();
    },
  };
}
