import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("Docker runtime healthcheck", () => {
  it("uses FRIDAY_PORT instead of hard-coding the default port", () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "docker", "Dockerfile"), "utf8");
    const healthcheck = dockerfile
      .split("\n")
      .filter((line, index, lines) => {
        return line.includes("HEALTHCHECK") || lines[index - 1]?.includes("HEALTHCHECK");
      })
      .join("\n");

    expect(healthcheck).toContain("FRIDAY_PORT");
    expect(healthcheck).not.toContain("http://localhost:3141/v1/health");
  });
});
