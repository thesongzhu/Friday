import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Friday API runtime security satellite revoke truth", () => {
  it("fails closed when the security satellite revoke update touches zero rows", () => {
    const source = readFileSync("src/api/runtime/friday-api-runtime.ts", "utf8");

    expect(source).toContain("const satelliteUpdate = db.prepare");
    expect(source).toContain("satelliteUpdate.changes === 0");
    expect(source).toContain("SATELLITE_NOT_FOUND");
    expect(source).toContain("Security satellite revoke did not match any satellite");
    expect(source).not.toContain("return { revoked: true, satelliteId };\n    },\n  }))");
  });
});
