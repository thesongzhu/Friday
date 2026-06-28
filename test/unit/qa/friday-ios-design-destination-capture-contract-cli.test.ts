import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-ios-design-destination-capture-contract.mjs";

function writeFileWithParents(root: string, relativePath: string, content: string) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function createFixtureRepo(extraScriptSource = "") {
  const root = mkdtempSync(join(tmpdir(), "friday-ios-design-capture-contract-"));
  writeFileWithParents(root, "package.json", JSON.stringify({
    scripts: {
      "proof:ios:design-destinations": "bash scripts/ops/friday-ios-design-destination-capture.sh --out-dir \"$FRIDAY_IOS_DESIGN_CAPTURE_OUT\"",
    },
  }, null, 2));
  writeFileWithParents(root, "scripts/ops/friday-ios-design-destination-capture.sh", `#!/usr/bin/env bash
destinations_csv="home,missions,session,contextPassport,tokenLedger,shareIntake,voice,pairing,needsMe,memory,platform,providerAuth,activity,workflows,onboarding,settings,petEditor,proofViewer,entrypoints"
truth_label="ios_selected_design_destination_capture_not_live_closure"
design_source="friday-design-handoff-20260602/saved/mobile-selection.json"
mode="design-proof-sample"
negative_control_note="\`offline-truth\` is a negative-control lane only"
caveat="not END-BAR / not GO-LIVE; design-proof-sample is visual comparison only; enabled actions still require separate Hub/DB/ledger/proof closure"
${extraScriptSource}
`);
  return root;
}

describe("friday-ios-design-destination-capture-contract", () => {
  it("passes when the runner covers selected destinations and preserves truth labels", () => {
    const root = createFixtureRepo();
    try {
      const stdout = execFileSync("node", [script, root], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(stdout) as {
        status?: string;
        truthLabel?: string;
        requiredDestinations?: string[];
      };
      expect(report.status).toBe("passed");
      expect(report.truthLabel).toBe("ios_design_destination_capture_contract_static_guard_not_runtime_pass");
      expect(report.requiredDestinations).toContain("providerAuth");
      expect(report.requiredDestinations).toContain("petEditor");
      expect(report.requiredDestinations).toContain("proofViewer");
      expect(report.requiredDestinations).toContain("entrypoints");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the runner drops a selected destination", () => {
    const root = createFixtureRepo();
    try {
      const runner = join(root, "scripts/ops/friday-ios-design-destination-capture.sh");
      writeFileSync(
        runner,
        readFileSync(runner, "utf8").replace(",providerAuth", ""),
        "utf8",
      );
      const failure = execFileSync("node", [script, root], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(failure).toBe("");
    } catch (error) {
      const failure = error as { stdout?: Buffer };
      const report = JSON.parse(failure.stdout?.toString("utf8") ?? "{}") as {
        status?: string;
        checks?: Array<{ missing?: string[] }>;
      };
      expect(report.status).toBe("failed");
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ missing: expect.arrayContaining(["providerAuth"]) }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
