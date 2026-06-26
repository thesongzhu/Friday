import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-ios-action-accessibility-map.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function writeMinimalRepo(root: string, ids: string[], scripts: string[] = []) {
  writeFile(
    root,
    "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift",
    `enum MobileProductDestinationID {
      case home
      var contract: MobileProductDestinationContract {
        switch self {
        case .home:
          return contract(
            title: "Friday Home",
            systemImage: "house",
            tier: .liveReadProjection,
            runtimeActionIds: ["mobile/home/refresh"],
            blockers: [])
        }
      }
    }`,
  );
  writeFile(
    root,
    "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
    ids.map((id) => `.accessibilityIdentifier("${id}")`).join("\n"),
  );
  for (const path of scripts) {
    writeFile(root, path, "#!/usr/bin/env bash\n");
  }
}

describe("check-friday-ios-action-accessibility-map", () => {
  it("links mobile runtime action ids to accessibility identifiers and evidence wrappers", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-action-map-"));
    try {
      writeMinimalRepo(root, ["friday.mobile.toolbar.refresh"], [
        "scripts/ops/friday-mobile-memory-action-evidence.sh",
      ]);

      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        "--compact",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { mobileRuntimeActionIds?: number; linkedActions?: number };
      };

      expect(report.status).toBe("ios_actions_linked");
      expect(report.counts?.mobileRuntimeActionIds).toBe(1);
      expect(report.counts?.linkedActions).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the mapped Swift accessibility id is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-action-map-gap-"));
    try {
      writeMinimalRepo(root, [], [
        "scripts/ops/friday-mobile-memory-action-evidence.sh",
      ]);

      let error: unknown = null;
      try {
        execFileSync("node", [
          script,
          `--repo-root=${root}`,
          "--compact",
        ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeTruthy();
      const stdout = String((error as { stdout?: Buffer })?.stdout || "");
      const report = JSON.parse(stdout) as {
        status?: string;
        blockers?: Array<{ code?: string; detail?: string }>;
      };
      expect(report.status).toBe("gaps_present");
      expect(report.blockers).toContainEqual(expect.objectContaining({
        code: "accessibility_id_missing",
        detail: "mobile/home/refresh:friday.mobile.toolbar.refresh",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
