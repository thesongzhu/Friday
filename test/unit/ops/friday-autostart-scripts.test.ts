import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Friday autostart scripts", () => {
  it("ships the launchd runners needed for login start and UI open", () => {
    const serviceMode = statSync("scripts/ops/friday-service-run.sh").mode;
    const companionMode = statSync("scripts/ops/friday-companion-run.sh").mode;
    const uiMode = statSync("scripts/ops/friday-open-ui-on-login.sh").mode;
    const installMode = statSync("scripts/ops/install-friday-launchagent.sh").mode;

    expect(serviceMode & 0o111).not.toBe(0);
    expect(companionMode & 0o111).not.toBe(0);
    expect(uiMode & 0o111).not.toBe(0);
    expect(installMode & 0o111).not.toBe(0);
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
    expect(installer).toContain("FRIDAY_STATE_DIR");
    expect(serviceRunner).toContain('exec "${NODE_BIN}" "${DIST_ENTRY}" start');
    expect(uiRunner).toContain("/v1/health");
    expect(uiRunner).toContain('exec open "${BASE_URL%/}/"');
  });

  it("includes autostart scripts in the npm package file list", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };

    expect(packageJson.files).toContain("scripts/ops/friday-service-run.sh");
    expect(packageJson.files).toContain("scripts/ops/friday-companion-run.sh");
    expect(packageJson.files).toContain("scripts/ops/friday-open-ui-on-login.sh");
    expect(packageJson.files).toContain("scripts/ops/install-friday-launchagent.sh");
  });

  it("wakes the local UI when a configured channel receives a message", () => {
    const hubSource = readFileSync("src/hub/friday-hub-bootstrap.ts", "utf8");

    expect(hubSource).toContain("FRIDAY_CHANNEL_WAKE_UI");
    expect(hubSource).toContain("wakeUiForChannelMessage");
    expect(hubSource).toContain('new URL("/channels"');
    expect(hubSource).toContain("FRIDAY_CHANNEL_WAKE_UI_COOLDOWN_MS");
  });
});
