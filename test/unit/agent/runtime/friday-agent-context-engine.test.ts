import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createFridayWorkspaceContextEngine,
  notifyFridayContextEngineAfterTurn,
  resolveFridayContextEnginePromptFragment,
} from "#agent";

describe("FridayAgentContextEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-context-engine-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("assembles prompt fragments from the default workspace context loader", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "Follow the repo contract.");
    await fs.writeFile(path.join(tmpDir, "USER.md"), "User prefers concise answers.");

    const engine = createFridayWorkspaceContextEngine({
      workspaceDir: tmpDir,
    });

    const resolved = await resolveFridayContextEnginePromptFragment(engine, {
      task: "How should I write concise answers for the user?",
    });

    expect(resolved.promptFragment).toContain("AGENTS.md");
    expect(resolved.promptFragment).toContain("Follow the repo contract.");
    expect(resolved.promptFragment).toContain("USER.md");
  });

  it("runs ingest, assemble, and compact hooks in order", async () => {
    const calls: string[] = [];

    const resolved = await resolveFridayContextEnginePromptFragment({
      ingest: () => {
        calls.push("ingest");
      },
      assemble: () => {
        calls.push("assemble");
        return { promptFragment: "assembled" };
      },
      compact: ({ assembled }) => {
        calls.push("compact");
        return {
          ...assembled,
          promptFragment: `${assembled.promptFragment ?? ""}-compacted`,
        };
      },
    }, {
      task: "test",
    });

    expect(calls).toEqual(["ingest", "assemble", "compact"]);
    expect(resolved.promptFragment).toBe("assembled-compacted");
  });

  it("swallows preview afterTurn hook failures", async () => {
    const afterTurn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(notifyFridayContextEngineAfterTurn({
      afterTurn,
    }, {
      runId: "run-1",
      sessionKey: "session-1",
      task: "Hello",
      response: "ok",
      status: "completed",
    })).resolves.toBeUndefined();

    expect(afterTurn).toHaveBeenCalledOnce();
  });
});
