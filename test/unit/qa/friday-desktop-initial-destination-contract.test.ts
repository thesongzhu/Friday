import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("FridayHubConsole initial destination proof seam", () => {
  it("mirrors the iOS initial-destination launch seam without changing live/mock mode", () => {
    const app = readFileSync("apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift", "utf8");
    const shell = readFileSync("apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift", "utf8");
    const capture = readFileSync("scripts/ops/friday-desktop-ax-accessibility-capture.mjs", "utf8");

    expect(app).toContain("FRIDAY_CONSOLE_INITIAL_DESTINATION");
    expect(app).toContain("--initial-destination=");
    expect(app).toContain("FRIDAY_CONSOLE_MISSION_ID");
    expect(app).toContain("--mission-id=");
    expect(app).toContain("RealReadClientFactory.makeLive(missionId: Self.missionId)");
    expect(app).toContain("return .operations");
    expect(shell).toContain("initialDestination: HubDestination = .operations");
    expect(shell).toContain("_destination = State(initialValue: initialDestination)");
    expect(capture).toContain("FRIDAY_CONSOLE_INITIAL_DESTINATION: destination");
    expect(capture).toContain("FRIDAY_CONSOLE_MISSION_ID");
    expect(capture).toContain("--workbench-mission-id");
    expect(capture).toContain("initial_destination");
  });
});
