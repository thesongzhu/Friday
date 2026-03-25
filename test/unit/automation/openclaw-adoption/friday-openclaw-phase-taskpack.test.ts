import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadFridayOpenClawPhaseTaskpack,
  parseFridayOpenClawPhaseTaskpack,
} from "../../../../src/automation/openclaw-adoption/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("friday openclaw taskpack loader", () => {
  it("parses a valid committed taskpack", () => {
    const parsed = parseFridayOpenClawPhaseTaskpack({
      schemaVersion: "1.0",
      phaseId: "phase0",
      title: "Automation Bootstrap",
      executionMode: "automated",
      goal: "Bootstrap automation.",
      allowedPaths: ["src/automation/openclaw-adoption"],
      implementationWorkers: [
        {
          id: "worker",
          title: "Worker",
          runner: "command",
          steps: [{ label: "step", command: "echo", args: ["ok"] }],
        },
      ],
      successCriteria: ["controller exists"],
      forbiddenBoundaries: [
        {
          id: "no-api-routes",
          description: "Do not edit API routes.",
          pathPrefixes: ["src/api/http/routes"],
          verdict: "blocked",
        },
      ],
    });

    expect(parsed.executionMode).toBe("automated");
    expect(parsed.implementationWorkers[0]?.id).toBe("worker");
  });

  it("loads a committed taskpack from disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-taskpack-test-"));
    tempDirs.push(dir);
    const taskpackPath = path.join(dir, "phase-0.json");
    fs.writeFileSync(taskpackPath, `${JSON.stringify({
      schemaVersion: "1.0",
      phaseId: "phase0",
      title: "Automation Bootstrap",
      executionMode: "spec_only",
      goal: "Describe automation.",
      allowedPaths: ["src/automation/openclaw-adoption"],
      implementationWorkers: [
        {
          id: "worker",
          title: "Worker",
          runner: "command",
          steps: [{ label: "step", command: "echo", args: ["ok"] }],
        },
      ],
      successCriteria: ["controller exists"],
      forbiddenBoundaries: [
        {
          id: "no-api-routes",
          description: "Do not edit API routes.",
          pathPrefixes: ["src/api/http/routes"],
          verdict: "blocked",
        },
      ],
    }, null, 2)}\n`, "utf-8");

    const taskpack = loadFridayOpenClawPhaseTaskpack(taskpackPath);
    expect(taskpack.phaseId).toBe("phase0");
    expect(taskpack.executionMode).toBe("spec_only");
  });
});
