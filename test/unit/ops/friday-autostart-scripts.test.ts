import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Friday autostart scripts", () => {
  it("ships the launchd runners needed for login start and UI open", () => {
    const serviceMode = statSync("scripts/ops/friday-service-run.sh").mode;
    const companionMode = statSync("scripts/ops/friday-companion-run.sh").mode;
    const uiMode = statSync("scripts/ops/friday-open-ui-on-login.sh").mode;
    const firstRunMode = statSync("scripts/ops/friday-first-run.sh").mode;
    const setupCommandMode = statSync("Friday Setup.command").mode;
    const installMode = statSync("scripts/ops/install-friday-launchagent.sh").mode;

    expect(serviceMode & 0o111).not.toBe(0);
    expect(companionMode & 0o111).not.toBe(0);
    expect(uiMode & 0o111).not.toBe(0);
    expect(firstRunMode & 0o111).not.toBe(0);
    expect(setupCommandMode & 0o111).not.toBe(0);
    expect(installMode & 0o111).not.toBe(0);
  });

  it("provides a first-run entrypoint that opens setup and installs macOS login startup", () => {
    const firstRun = readFileSync("scripts/ops/friday-first-run.sh", "utf8");
    const setupCommand = readFileSync("Friday Setup.command", "utf8");

    expect(firstRun).toContain("npm run build");
    expect(firstRun).toContain("scripts/ops/install-friday-launchagent.sh");
    expect(firstRun).toContain('SETUP_URL="${BASE_URL%/}/setup"');
    expect(firstRun).toContain("relocate_for_launchd_if_needed");
    expect(firstRun).toContain('"${home_dir}/Desktop"');
    expect(firstRun).toContain('install_dir="${HOME}/Friday"');
    expect(firstRun).toContain("FRIDAY_FIRST_RUN_RELOCATED=true");
    expect(setupCommand).toContain("scripts/ops/friday-first-run.sh");
  });

  it("starts Friday at login, keeps it alive, and opens the UI after health is ready", () => {
    const installer = readFileSync("scripts/ops/install-friday-launchagent.sh", "utf8");
    const serviceRunner = readFileSync("scripts/ops/friday-service-run.sh", "utf8");
    const uiRunner = readFileSync("scripts/ops/friday-open-ui-on-login.sh", "utf8");

    expect(installer).toContain("com.friday.hub");
    expect(installer).toContain("com.friday.companion");
    expect(installer).toContain("com.friday.ui-open");
    expect(installer).toContain("<key>RunAtLoad</key>");
    expect(installer).toContain("<key>KeepAlive</key>");
    expect(installer).toContain("FRIDAY_CHANNEL_WAKE_UI");
    expect(installer).toContain("<key>FRIDAY_CHANNEL_WAKE_UI</key>\n    <string>false</string>");
    expect(installer).toContain("FRIDAY_STATE_DIR");
    expect(serviceRunner).toContain('exec "${NODE_BIN}" "${DIST_ENTRY}" start');
    expect(uiRunner).toContain("/v1/health");
    expect(uiRunner).toContain('exec open "${BASE_URL%/}/"');
  });

  it("NEW-31 red: launchd hub plist carries the canonical mutating-action gate marker", () => {
    const installer = readFileSync("scripts/ops/install-friday-launchagent.sh", "utf8");

    expect(installer).toContain("<key>FRIDAY_CANONICAL_GATE</key>\n    <string>true</string>");
  });

  it("NEW-31 red: service runner defaults canonical mutating-action gate to protected", () => {
    const serviceRunner = readFileSync("scripts/ops/friday-service-run.sh", "utf8");

    expect(serviceRunner).toContain('export FRIDAY_CANONICAL_GATE="${FRIDAY_CANONICAL_GATE:-true}"');
    expect(serviceRunner.indexOf('export FRIDAY_CANONICAL_GATE="${FRIDAY_CANONICAL_GATE:-true}"'))
      .toBeLessThan(serviceRunner.indexOf('exec "${NODE_BIN}" "${DIST_ENTRY}" start'));
  });

  it("includes autostart scripts in the npm package file list", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };

    expect(packageJson.files).toContain("scripts/ops/friday-service-run.sh");
    expect(packageJson.files).toContain("scripts/ops/friday-companion-run.sh");
    expect(packageJson.files).toContain("scripts/ops/friday-open-ui-on-login.sh");
    expect(packageJson.files).toContain("scripts/ops/friday-first-run.sh");
    expect(packageJson.files).toContain("scripts/ops/install-friday-launchagent.sh");
    expect(packageJson.files).toContain("Friday Setup.command");
  });

  it("keeps channel UI wake opt-in so channel messages do not spawn browser tabs by default", () => {
    const hubSource = readFileSync("src/hub/friday-hub-bootstrap.ts", "utf8");

    expect(hubSource).toContain("FRIDAY_CHANNEL_WAKE_UI");
    expect(hubSource).toContain("wakeUiForChannelMessage");
    expect(hubSource).toContain('process.env.FRIDAY_CHANNEL_WAKE_UI !== "true"');
    expect(hubSource).toContain("FRIDAY_CHANNEL_WAKE_UI_COOLDOWN_MS");
  });
});
