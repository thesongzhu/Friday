import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = () => readFileSync("scripts/ops/check-read-projection-runtime-freshness.mjs", "utf8");

describe("check-read-projection-runtime-freshness CLI", () => {
  it("exposes a read-only hard gate for running runtime freshness", () => {
    const text = source();

    expect(text).toContain("--require-running-current");
    expect(text).toContain("runtime_predates_repo_head");
    expect(text).toContain("process start time versus repo HEAD");
  });

  it("does not start, stop, restart, migrate, or sign", () => {
    const text = source();

    expect(text).toContain("It does not start, stop, restart, migrate, or sign.");
    expect(text).not.toMatch(/launchctl\s+(bootout|bootstrap|kickstart)/);
    expect(text).not.toMatch(/\bkill\b/);
  });
});
