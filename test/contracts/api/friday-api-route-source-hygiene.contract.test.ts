import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = path.resolve(process.cwd(), "src/api/http/routes");

describe("API route source hygiene", () => {
  it("keeps public route modules free of TODO placeholders", () => {
    const offenders = readdirSync(ROUTES_DIR)
      .filter((entry) => entry.endsWith(".ts"))
      .flatMap((entry) => {
        const filePath = path.join(ROUTES_DIR, entry);
        const lines = readFileSync(filePath, "utf8")
          .split("\n")
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter(({ line }) => line.includes("TODO:"))
          .map(({ lineNumber }) => `${entry}:${String(lineNumber)}`);
        return lines;
      });

    expect(offenders).toEqual([]);
  });
});
