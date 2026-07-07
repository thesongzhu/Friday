import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PR #1495 follow-up contracts", () => {
  it("keeps native UI deferred-option text behind the Rust core constant", () => {
    const repoRoot = process.cwd();
    const files = [
      "rust-core/crates/friday-hub/src/hub_server.rs",
      "rust-core/crates/friday-storage/src/mission.rs",
    ];

    for (const file of files) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      expect(source, `${file} must not duplicate native UI implementation text`).not.toContain(
        "\"native UI implementation\"",
      );
    }
  });
});
