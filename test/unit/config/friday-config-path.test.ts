import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveFridayConfigPath } from "#config";

describe("friday-config-path", () => {
  it("uses explicit configPath-like stateDir when provided", () => {
    const result = resolveFridayConfigPath({ stateDir: "/custom/state" });
    expect(result).toBe(path.join("/custom/state", "config.json5"));
  });

  it("defaults to ${stateDir}/config.json5", () => {
    const result = resolveFridayConfigPath({
      stateDir: "/tmp/friday-state",
    });
    expect(result).toBe(path.join("/tmp/friday-state", "config.json5"));
  });

  it("uses custom fileName when provided", () => {
    const result = resolveFridayConfigPath({
      stateDir: "/tmp/state",
      fileName: "my-config.json",
    });
    expect(result).toBe(path.join("/tmp/state", "my-config.json"));
  });
});
