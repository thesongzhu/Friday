import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

type ExecFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

async function writeFileWithParents(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function touch(root: string, relativePath: string, date: Date) {
  const target = path.join(root, relativePath);
  await fs.utimes(target, date, date);
}

async function createFixtureRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-desktop-release-pipeline-"));
  await writeFileWithParents(root, "package.json", JSON.stringify({
    name: "friday-fixture",
    version: "1.0.0",
    scripts: {
      "check:companion:release-env": "bash scripts/ops/check-friday-companion-release-env.sh",
      "check:client-ship-gate": "node scripts/ops/check-friday-desktop-release-pipeline.mjs",
      "check:cross-platform-client-ship-gate": "node scripts/ops/check-friday-desktop-release-pipeline.mjs",
      "check:client-design-contract": "node scripts/ops/check-friday-client-design-contract.mjs",
      "check:native-action-closure": "node scripts/ops/check-friday-native-action-closure.mjs",
      "check:ios-t2-surface-contract": "node scripts/ops/check-friday-ios-t2-surface-contract.mjs",
      "check:ios-action-accessibility-map": "node scripts/ops/check-friday-ios-action-accessibility-map.mjs",
      "check:ios-design-destination-capture-contract": "node scripts/ops/check-friday-ios-design-destination-capture-contract.mjs",
      "proof:ios:design-destinations": "bash scripts/ops/friday-ios-design-destination-capture.sh --out-dir \"${FRIDAY_IOS_DESIGN_CAPTURE_OUT:-/tmp/friday-ios-design-destination-capture}\"",
      "proof:action-runtime:evidence-bundle": "bash scripts/ops/friday-action-runtime-evidence-bundle.sh --out-dir \"${FRIDAY_ACTION_RUNTIME_EVIDENCE_BUNDLE_OUT:-/tmp/friday-action-runtime-evidence-bundle}\"",
      "check:desktop-gui-smoke-contract": "node scripts/ops/check-friday-desktop-gui-smoke-contract.mjs",
      "proof:desktop:gui-smoke": "bash scripts/ops/friday-desktop-gui-smoke-proof.sh --out-dir \"${FRIDAY_DESKTOP_GUI_SMOKE_OUT_DIR:-/tmp/friday-desktop-gui-smoke-proof}\"",
      "proof:desktop:live-write-read": "bash scripts/ops/friday-macos-live-write-read-capture.sh --out-dir \"${FRIDAY_DESKTOP_LIVE_WRITE_READ_CAPTURE_OUT:-/tmp/friday-desktop-live-write-read-capture}\"",
      "proof:ui-device:live-write-read-bundle": "bash scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh --out-dir \"${FRIDAY_UI_DEVICE_LIVE_WRITE_READ_BUNDLE_OUT:-/tmp/friday-ui-device-live-write-read-bundle}\"",
      "check:product-auto-followup-contract": "node scripts/ops/check-friday-product-auto-followup-contract.mjs",
      "proof:product:auto-followup": "bash scripts/ops/friday-product-auto-followup-proof.sh",
      "check:desktop-approval-relay-contract": "node scripts/ops/check-friday-desktop-approval-relay-contract.mjs",
      "proof:desktop:approval-relay": "bash scripts/ops/friday-desktop-approval-relay-proof.sh",
      "proof:mobile:approval-approve": "bash scripts/ops/friday-mobile-approval-approve-proof.sh",
      "build:companion:native": "bash scripts/ops/build-friday-companion-app.sh",
      "build:hub-console:native": "bash scripts/ops/build-friday-hub-console-app.sh",
      "build:ios:sim": "bash apps/friday-ios/build-sim.sh",
      "build:android:emu": "bash apps/friday-android/build-emu.sh",
      "build:companion:dmg": "bash scripts/ops/build-friday-companion-dmg.sh",
      "build:companion:appcast": "bash scripts/ops/build-friday-sparkle-appcast.sh",
      "publish:homebrew:cask": "bash scripts/ops/publish-friday-homebrew-cask.sh",
      "release:manifest": "node scripts/ops/write-friday-release-manifest.mjs",
      "release:companion:local": "bash scripts/ops/release-friday-companion-app.sh",
      "release:companion:notarize": "FRIDAY_MACOS_RELEASE_MODE=notarize bash scripts/ops/release-friday-companion-app.sh",
      "verify:hub-console:native": "bash scripts/ops/verify-friday-hub-console-app.sh",
    },
  }, null, 2));

  for (const relativePath of [
    "apps/macos/FridayCompanion/Package.swift",
    "apps/macos/FridayHubConsole/Package.swift",
    "apps/macos/FridayHubConsole/Info.plist",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift",
    "scripts/ops/release-friday-companion-app.sh",
    "scripts/ops/build-friday-hub-console-app.sh",
    "scripts/ops/verify-friday-hub-console-app.sh",
    "scripts/ops/check-friday-client-design-contract.mjs",
    "scripts/ops/check-friday-native-action-closure.mjs",
    "scripts/ops/check-friday-ios-t2-surface-contract.mjs",
    "scripts/ops/check-friday-ios-action-accessibility-map.mjs",
    "scripts/ops/check-friday-ios-design-destination-capture-contract.mjs",
    "scripts/ops/friday-ios-design-destination-capture.sh",
    "scripts/ops/friday-action-runtime-evidence-bundle.sh",
    "scripts/ops/check-friday-desktop-gui-smoke-contract.mjs",
    "scripts/ops/friday-desktop-gui-smoke-proof.sh",
    "scripts/ops/friday-macos-live-write-read-capture.sh",
    "scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh",
    "scripts/ops/check-friday-product-auto-followup-contract.mjs",
    "scripts/ops/friday-product-auto-followup-proof.sh",
    "scripts/ops/check-friday-desktop-approval-relay-contract.mjs",
    "scripts/ops/friday-desktop-approval-relay-proof.sh",
    "scripts/ops/friday-mobile-approval-approve-proof.sh",
    "apps/friday-ios/Package.swift",
    "apps/friday-ios/Info.plist",
    "apps/friday-ios/build-sim.sh",
    "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
    "apps/friday-android/settings.gradle.kts",
    "apps/friday-android/app/build.gradle.kts",
    "apps/friday-android/app/src/main/AndroidManifest.xml",
    "apps/friday-android/build-emu.sh",
    "scripts/ops/build-friday-companion-dmg.sh",
    "scripts/ops/build-friday-sparkle-appcast.sh",
    "scripts/ops/publish-friday-homebrew-cask.sh",
    "scripts/ops/write-friday-release-manifest.mjs",
    "packaging/homebrew/Casks/friday.rb.template",
    "docs/ops/friday-companion-release-macos.md",
  ]) {
    await writeFileWithParents(root, relativePath, "placeholder\n");
  }

  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-companion-release-env.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture env ok\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-client-design-contract.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_design_contract\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-native-action-closure.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_native_action_closure\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-ios-t2-surface-contract.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_ios_t2_surface_contract\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-ios-action-accessibility-map.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"ios_actions_linked\", truth_label:\"fixture_ios_action_accessibility_map\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-ios-design-destination-capture-contract.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_ios_design_destination_capture_contract\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-ios-design-destination-capture.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture ios design destination capture\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-action-runtime-evidence-bundle.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture action-runtime evidence bundle\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-desktop-gui-smoke-contract.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_desktop_gui_smoke_contract\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-desktop-gui-smoke-proof.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture desktop GUI smoke proof\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-macos-live-write-read-capture.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture desktop live write-read capture\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture ui device live write-read bundle\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-product-auto-followup-contract.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_product_auto_followup_contract\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-product-auto-followup-proof.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture product auto-followup proof\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-desktop-approval-relay-contract.mjs",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:\"passed\", truthLabel:\"fixture_desktop_approval_relay_contract\"}));\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-desktop-approval-relay-proof.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture desktop approval relay proof\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/friday-mobile-approval-approve-proof.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture mobile approval approve proof\"\n",
  );

  // CORE-A round-3 Lane C (finding #4): the Rust agent-run WS server packaging contract now
  // asserts the DMG + source distribution stage the server payload and the installer launches +
  // enrolls it. Populate the fixture with files whose content satisfies the `containsAll` tokens
  // (a placeholder alone would fail the new stronger contract).
  await writeFileWithParents(
    root,
    "scripts/ops/build-friday-companion-dmg.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\n# fixture DMG build\n" +
      "bash \"scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh\" --repo-dir \"$PWD\" --dest-dir \"$STAGING_DIR\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/build-friday-source-distribution.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\n# fixture source distribution build\n" +
      "bash \"scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh\" --repo-dir \"$PWD\" --dest-dir \"$OUTPUT_DIR\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\n# fixture staging helper\n" +
      "PLIST_TEMPLATE=\"scripts/ops/launchd/com.friday.rust-agent-run-ws-server.plist\"\n" +
      "cargo build --release --bin hub_agent_run_server --bin hub_agent_run_enroll\n" +
      "# stages both bins + the plist template and writes payload-manifest.json\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/launchd/com.friday.rust-agent-run-ws-server.plist",
    "<?xml version=\"1.0\"?>\n<!-- fixture Rust agent-run WS server plist -->\n" +
      "<string>__RUST_SERVER_BIN__</string>\n<string>--workspace</string>\n<string>--db</string>\n" +
      "<string>--port</string>\n<string>--owner</string>\n<string>--store-dir</string>\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/launchd/build-and-install-rust-agent-run-ws-server.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture Rust agent-run cutover tool\"\n",
  );
  await writeFileWithParents(
    root,
    "scripts/ops/install-friday-launchagent.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\n# fixture installer\n" +
      "# provision ~/.friday/master.key\n# plutil -lint the filled plist\n" +
      "# hub_agent_run_enroll into the store dir\n" +
      "# launchctl bootstrap com.friday.rust-agent-run-ws-server\n",
  );
  return root;
}

describe("client ship gate pipeline check", () => {
  it("passes when desktop, iOS, and Android packaging hooks are present", async () => {
    const repoRoot = await createFixtureRepo();
    const result = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const report = JSON.parse(result.stdout) as {
      status: string;
      summary: { failed: number };
      checks: Array<{ target: string; status: string }>;
    };

    expect(report.status).toBe("passed");
    expect(report.summary.failed).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
          status: "passed",
        }),
        expect.objectContaining({
          target: "apps/friday-android/app/src/main/AndroidManifest.xml",
          status: "passed",
        }),
        expect.objectContaining({
          target: "check:cross-platform-client-ship-gate",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-client-design-contract.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "check:client-design-contract",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-native-action-closure.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "check:native-action-closure",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-ios-t2-surface-contract.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "check:ios-t2-surface-contract",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-ios-action-accessibility-map.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "check:ios-action-accessibility-map",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-ios-design-destination-capture-contract.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:ios:design-destinations",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/friday-action-runtime-evidence-bundle.sh",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:action-runtime:evidence-bundle",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-desktop-gui-smoke-contract.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "check:desktop-gui-smoke-contract",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/friday-desktop-gui-smoke-proof.sh",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:desktop:gui-smoke",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:desktop:live-write-read",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:ui-device:live-write-read-bundle",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-product-auto-followup-contract.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:product:auto-followup",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/check-friday-desktop-approval-relay-contract.mjs",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:desktop:approval-relay",
          status: "passed",
        }),
        expect.objectContaining({
          target: "scripts/ops/friday-mobile-approval-approve-proof.sh",
          status: "passed",
        }),
        expect.objectContaining({
          target: "proof:mobile:approval-approve",
          status: "passed",
        }),
        // CORE-A round-3 Lane C (finding #4): the Rust agent-run WS server packaging contract.
        expect.objectContaining({
          kind: "rust-agent-run-packaging-contract",
          target: "scripts/ops/launchd/com.friday.rust-agent-run-ws-server.plist",
          status: "passed",
        }),
        expect.objectContaining({
          kind: "rust-agent-run-packaging-contract",
          target: "scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh",
          status: "passed",
        }),
        expect.objectContaining({
          kind: "rust-agent-run-packaging-contract",
          target: "scripts/ops/build-friday-companion-dmg.sh",
          status: "passed",
        }),
        expect.objectContaining({
          kind: "rust-agent-run-packaging-contract",
          target: "scripts/ops/build-friday-source-distribution.sh",
          status: "passed",
        }),
        expect.objectContaining({
          kind: "rust-agent-run-packaging-contract",
          target: "scripts/ops/install-friday-launchagent.sh",
          status: "passed",
        }),
      ]),
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact-freshness",
          target: "FRIDAY_CLIENT_SHIP_ARTIFACTS_JSON",
          status: "skipped",
        }),
      ]),
    );
  });

  it("fails when a required release input is missing", async () => {
    const repoRoot = await createFixtureRepo();
    await fs.rm(path.join(repoRoot, "packaging", "homebrew", "Casks", "friday.rb.template"));

    const error = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    const report = JSON.parse(error!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ target: string; status: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "packaging/homebrew/Casks/friday.rb.template",
          status: "failed",
        }),
      ]),
    );
  });

  it("fails when a mobile client hook drifts out of the gate", async () => {
    const repoRoot = await createFixtureRepo();
    await fs.rm(path.join(repoRoot, "apps", "friday-android", "app", "src", "main", "AndroidManifest.xml"));

    const error = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    const report = JSON.parse(error!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ target: string; status: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "apps/friday-android/app/src/main/AndroidManifest.xml",
          status: "failed",
        }),
      ]),
    );
  });

  it("passes fresh artifact checks when declared artifacts are newer than sources", async () => {
    const repoRoot = await createFixtureRepo();
    await writeFileWithParents(repoRoot, "dist/macos/FridayHubConsole.app/Contents/MacOS/FridayHubConsole", "binary\n");
    await writeFileWithParents(repoRoot, "client-artifacts.json", JSON.stringify([{
      name: "hub-console-app",
      artifact: "dist/macos/FridayHubConsole.app",
      sources: [
        "apps/macos/FridayHubConsole/Sources",
        "apps/macos/FridayHubConsole/Package.swift",
      ],
    }], null, 2));

    await touch(repoRoot, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift", new Date("2026-06-22T00:00:00Z"));
    await touch(repoRoot, "apps/macos/FridayHubConsole/Package.swift", new Date("2026-06-22T00:00:00Z"));
    await touch(repoRoot, "dist/macos/FridayHubConsole.app/Contents/MacOS/FridayHubConsole", new Date("2026-06-23T00:00:00Z"));

    const result = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_CLIENT_SHIP_REQUIRE_FRESH_ARTIFACTS: "1",
          FRIDAY_CLIENT_SHIP_ARTIFACTS_JSON: "client-artifacts.json",
        },
      },
    );

    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ kind: string; target: string; status: string }>;
    };
    expect(report.status).toBe("passed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact-freshness",
          target: "dist/macos/FridayHubConsole.app",
          status: "passed",
        }),
      ]),
    );
  });

  it("fails fresh artifact checks when a client source is newer than the artifact", async () => {
    const repoRoot = await createFixtureRepo();
    await writeFileWithParents(repoRoot, "dist/macos/FridayHubConsole.app/Contents/MacOS/FridayHubConsole", "binary\n");
    await writeFileWithParents(repoRoot, "client-artifacts.json", JSON.stringify([{
      name: "hub-console-app",
      artifact: "dist/macos/FridayHubConsole.app",
      sources: [
        "apps/macos/FridayHubConsole/Sources",
        "apps/macos/FridayHubConsole/Package.swift",
      ],
    }], null, 2));

    await touch(repoRoot, "dist/macos/FridayHubConsole.app/Contents/MacOS/FridayHubConsole", new Date("2026-06-22T00:00:00Z"));
    await touch(repoRoot, "apps/macos/FridayHubConsole/Package.swift", new Date("2026-06-22T00:00:00Z"));
    await touch(repoRoot, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift", new Date("2026-06-23T00:00:00Z"));

    const error = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_CLIENT_SHIP_REQUIRE_FRESH_ARTIFACTS: "1",
          FRIDAY_CLIENT_SHIP_ARTIFACTS_JSON: "client-artifacts.json",
        },
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    const report = JSON.parse(error!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ kind: string; target: string; status: string; stderr?: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact-freshness",
          target: "dist/macos/FridayHubConsole.app",
          status: "failed",
          stderr: "source newer than artifact: apps/macos/FridayHubConsole/Sources",
        }),
      ]),
    );
  });
});
