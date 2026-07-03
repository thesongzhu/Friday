import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const writeServerSource = readFileSync("rust-core/crates/friday-hub/src/bin/hub_agent_run_server.rs", "utf8");
const readServerSource = readFileSync("rust-core/crates/friday-hub/src/bin/hub_read_projection_server.rs", "utf8");

describe("Rust bin boot truth labels", () => {
  it("does not label the live agent-run server boot line as dark or callerless", () => {
    const bootLine = extractListeningBootLine(writeServerSource, "hub_agent_run_server");

    expect(bootLine).toContain("listening (loopback-only)");
    expect(bootLine).toContain("S-C");
    expect(bootLine).not.toMatch(/\bDARK\b/);
    expect(bootLine).not.toContain("no production caller");
  });

  it("does not label the live read-projection server boot line as dark, callerless, or launchagent-free", () => {
    const bootLine = extractListeningBootLine(readServerSource, "hub_read_projection_server");

    expect(bootLine).toContain("listening (loopback-only)");
    expect(bootLine).toContain("S-R1");
    expect(bootLine).not.toMatch(/\bDARK\b/);
    expect(bootLine).not.toContain("no production caller");
    expect(bootLine).not.toContain("no LaunchAgent");
  });
});

function extractListeningBootLine(source: string, binName: string): string {
  const line = source
    .split("\n")
    .find((candidate) => candidate.includes(`${binName}: listening (loopback-only)`));
  expect(line, `${binName} listening boot line`).toBeDefined();
  return line ?? "";
}
